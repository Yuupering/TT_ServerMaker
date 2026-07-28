import { createServer, connect, type Server, type Socket } from 'node:net'
import type { GuardSettings, GuardStatus } from '@shared/types'
import { emit } from './events'

/**
 * 서버 앞에 앉아 접속을 걸러주는 TCP 프록시.
 *
 * 마인크래프트 서버는 포트를 열어두면 스캐너 봇이 찾아내고, 접속만 반복해서
 * 밀어넣는 것만으로도 서버 스레드가 마비된다. 화이트리스트는 로그인 단계라
 * 그 앞에서 막지 못하므로, 아예 연결 수준에서 걸러낸다.
 */

/**
 * 거부한 연결은 곧바로 끊어버린다.
 * 정상 종료 절차를 밟으면 소켓이 잠시 남아 있어서, 대량으로 밀려들 때 그 자체가 부담이 된다.
 */
function reject(socket: Socket): void {
  try {
    if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy()
    else socket.destroy()
  } catch {
    socket.destroy()
  }
}

export const DEFAULT_GUARD: GuardSettings = {
  enabled: false,
  maxPerIp: 3,
  ratePerMinute: 12,
  blockMinutes: 5,
  idleTimeoutSec: 10
}

interface IpState {
  /** 최근 연결 시도 시각들 (1분 창) */
  attempts: number[]
  active: number
  blockedUntil: number
  reason: string
}

export interface StartGuardArgs {
  publicPort: number
  backendPort: number
  settings: GuardSettings
  /** Paper 계열이면 실제 접속 IP를 PROXY 헤더로 넘긴다 */
  forwardIp: boolean
}

class Guard {
  private server: Server | null = null
  private ips = new Map<string, IpState>()
  private sockets = new Set<Socket>()
  private rejected = 0
  private args: StartGuardArgs | null = null
  private sweepTimer: NodeJS.Timeout | null = null

  getStatus(): GuardStatus {
    const now = Date.now()
    return {
      running: this.server !== null,
      publicPort: this.args?.publicPort ?? null,
      backendPort: this.args?.backendPort ?? null,
      forwardingIp: this.args?.forwardIp ?? false,
      activeConnections: this.sockets.size,
      blocked: [...this.ips.entries()]
        .filter(([, s]) => s.blockedUntil > now)
        .map(([ip, s]) => ({ ip, until: s.blockedUntil, reason: s.reason })),
      rejected: this.rejected
    }
  }

  private state(ip: string): IpState {
    let s = this.ips.get(ip)
    if (!s) {
      s = { attempts: [], active: 0, blockedUntil: 0, reason: '' }
      this.ips.set(ip, s)
    }
    return s
  }

  private block(ip: string, reason: string, minutes: number): void {
    const s = this.state(ip)
    s.blockedUntil = Date.now() + minutes * 60_000
    s.reason = reason
    emit.log({
      ts: Date.now(),
      level: 'system',
      text: `접속 차단: ${ip} (${reason}, ${minutes}분)`
    })
    emit.guard(this.getStatus())
  }

  /** 연결을 받아줄지 판단한다 */
  private allow(ip: string, settings: GuardSettings): { ok: boolean; reason?: string } {
    const now = Date.now()
    const s = this.state(ip)

    // 1분 창 밖의 기록은 버린다
    s.attempts = s.attempts.filter((t) => now - t < 60_000)

    /*
     * 거부된 연결도 "시도"로 센다.
     * 동시 접속 한도에 걸려 거부된 것만 세지 않으면, 봇이 연결을 잔뜩 열어둔 채
     * 계속 두드려도 차단 목록에 오르지 않고 무한정 재시도할 수 있다.
     */
    s.attempts.push(now)

    if (s.blockedUntil > now) {
      return { ok: false, reason: '차단된 주소' }
    }

    if (s.attempts.length > settings.ratePerMinute) {
      this.block(ip, '짧은 시간에 너무 많이 접속 시도', settings.blockMinutes)
      return { ok: false, reason: '접속 시도 과다' }
    }

    if (s.active >= settings.maxPerIp) {
      return { ok: false, reason: '동시 접속 수 초과' }
    }

    return { ok: true }
  }

  /**
   * PROXY protocol v1 헤더.
   * 이게 없으면 서버에는 모든 접속이 127.0.0.1로 보여서 밴이나 접속 기록이 무의미해진다.
   */
  private proxyHeader(src: Socket, backendPort: number): string {
    const family = src.remoteFamily === 'IPv6' ? 'TCP6' : 'TCP4'
    const srcIp = (src.remoteAddress ?? '0.0.0.0').replace(/^::ffff:/, '')
    const dstIp = family === 'TCP6' ? '::1' : '127.0.0.1'
    return `PROXY ${family} ${srcIp} ${dstIp} ${src.remotePort ?? 0} ${backendPort}\r\n`
  }

  async start(args: StartGuardArgs): Promise<void> {
    await this.stop()
    this.args = args
    this.rejected = 0

    const { settings, backendPort, publicPort, forwardIp } = args

    const server = createServer({ pauseOnConnect: true }, (client) => {
      const ip = (client.remoteAddress ?? '').replace(/^::ffff:/, '')
      const verdict = this.allow(ip, settings)

      if (!verdict.ok) {
        this.rejected++
        reject(client)
        return
      }

      const state = this.state(ip)
      state.active++
      this.sockets.add(client)

      let sawData = false
      const idleTimer = setTimeout(() => {
        // 연결만 걸어두고 아무것도 보내지 않는 연결은 봇일 확률이 높다
        if (!sawData) {
          this.rejected++
          reject(client)
          cleanup()
        }
      }, settings.idleTimeoutSec * 1000)

      const upstream = connect({ host: '127.0.0.1', port: backendPort })

      // 양쪽 소켓의 close/error가 모두 걸려 있어 여러 번 불린다.
      // 그대로 두면 동시 접속 카운트가 실제보다 작아져 제한이 헐거워진다.
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        clearTimeout(idleTimer)
        this.sockets.delete(client)
        state.active = Math.max(0, state.active - 1)
        client.destroy()
        upstream.destroy()
      }

      client.once('data', () => {
        sawData = true
      })

      upstream.on('connect', () => {
        if (forwardIp) {
          upstream.write(this.proxyHeader(client, backendPort))
        }
        client.pipe(upstream)
        upstream.pipe(client)
        client.resume()
      })

      client.on('error', cleanup)
      upstream.on('error', cleanup)
      client.on('close', cleanup)
      upstream.on('close', cleanup)
    })

    server.on('error', (err) => {
      emit.log({
        ts: Date.now(),
        level: 'error',
        text: `접속 보호를 시작하지 못했습니다: ${err.message}`
      })
    })

    await new Promise<void>((res, rej) => {
      server.once('error', rej)
      server.listen(publicPort, '0.0.0.0', () => {
        server.removeListener('error', rej)
        res()
      })
    })

    this.server = server

    // 오래된 IP 기록을 주기적으로 비운다 (메모리 누수 방지)
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [ip, s] of this.ips) {
        const idle = s.attempts.length === 0 && s.active === 0 && s.blockedUntil < now
        if (idle) this.ips.delete(ip)
      }
    }, 60_000)

    emit.log({
      ts: Date.now(),
      level: 'system',
      text:
        `접속 보호를 켰습니다 (공개 ${publicPort} → 서버 ${backendPort}` +
        `${forwardIp ? ', 접속 IP 전달' : ''})`
    })
    emit.guard(this.getStatus())
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }

    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    this.ips.clear()

    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((res) => server.close(() => res()))
    }

    this.args = null
    emit.guard(this.getStatus())
  }

  /** 사용자가 직접 차단을 푼다 */
  unblock(ip: string): void {
    const s = this.ips.get(ip)
    if (s) {
      s.blockedUntil = 0
      s.attempts = []
    }
    emit.guard(this.getStatus())
  }

  isRunning(): boolean {
    return this.server !== null
  }
}

export const guard = new Guard()
