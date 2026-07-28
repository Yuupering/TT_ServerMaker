import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { PLUGIN_LOADERS } from '@shared/types'
import type { Instance, LogLine, LogLevel, ServerState, ServerStatus } from '@shared/types'
import { emit } from './events'
import { DEFAULT_GUARD, guard } from './guard'
import { ensureJava } from './java'
import { jvmArgsFor, writeUserJvmArgs } from './loader'
import { setProxyProtocol } from './paperConfig'
import { readPort, setRawProperties } from './properties'
import { killTree, lineReader, spawnLive, type LiveProcess } from './util/proc'
import { getSettings } from './store'

/** 보호 프록시가 쓸 내부 포트를 찾는다 */
function findFreePort(from: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      if (port > 65535) {
        reject(new Error('쓸 수 있는 포트를 찾지 못했습니다'))
        return
      }
      const probe = createServer()
      probe.once('error', () => tryPort(port + 1))
      probe.once('listening', () => {
        probe.close(() => resolve(port))
      })
      probe.listen(port, '127.0.0.1')
    }
    tryPort(from)
  })
}

const MAX_LOG_LINES = 2000
/** 이 시간 안에 연속으로 죽으면 자동 재시작을 멈춘다 */
const CRASH_WINDOW_MS = 90_000
const CRASH_LIMIT = 3

class ServerManager {
  private proc: LiveProcess | null = null
  private instance: Instance | null = null
  private state: ServerState = 'stopped'
  private port: number | null = null
  private startedAt: number | null = null
  private exitCode: number | null = null
  private players = new Set<string>()
  private logs: LogLine[] = []
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private recentCrashes: number[] = []

  getStatus(): ServerStatus {
    return {
      instanceId: this.instance?.id ?? null,
      state: this.state,
      port: this.port,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      players: [...this.players],
      exitCode: this.exitCode
    }
  }

  getLogs(): LogLine[] {
    return this.logs
  }

  /** 지금 돌고 있는 서버의 폴더 (실행 중일 때만) */
  getRunningDir(): string | null {
    return this.state === 'running' ? (this.instance?.dir ?? null) : null
  }

  isBusy(): boolean {
    return this.state !== 'stopped' && this.state !== 'crashed'
  }

  private setState(state: ServerState): void {
    this.state = state
    emit.status(this.getStatus())
  }

  private push(text: string, level: LogLevel = 'info'): void {
    const line: LogLine = { ts: Date.now(), level, text }
    this.logs.push(line)
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    }
    emit.log(line)
  }

  /** 서버 로그에서 상태 변화를 읽어낸다 */
  private handleLine(text: string, stream: 'out' | 'err'): void {
    let level: LogLevel = stream === 'err' ? 'error' : 'info'
    if (/\/WARN\]|WARNING/i.test(text)) level = 'warn'
    if (/\/ERROR\]|Exception|at [\w.$]+\(/.test(text)) level = 'error'

    this.push(text, level)

    const done = /Done \([\d.]+s\)!/.exec(text)
    if (done && this.state === 'starting') {
      this.setState('running')
      this.push('서버가 준비됐습니다. 이제 친구들이 접속할 수 있습니다.', 'system')
    }

    const portMatch = /Starting Minecraft server on (?:[\d.]+|\*):(\d+)/.exec(text)
    if (portMatch) {
      this.port = Number(portMatch[1])
    }

    const joined = /: ([A-Za-z0-9_]{2,16}) joined the game/.exec(text)
    if (joined) {
      this.players.add(joined[1])
      emit.status(this.getStatus())
    }

    const left = /: ([A-Za-z0-9_]{2,16}) left the game/.exec(text)
    if (left) {
      this.players.delete(left[1])
      emit.status(this.getStatus())
    }

    if (/You need to agree to the EULA/i.test(text)) {
      this.push(
        '마인크래프트 이용약관 동의가 필요합니다. 설정 화면에서 동의를 켜고 다시 시작해 주세요.',
        'system'
      )
    }

    if (/There is insufficient memory|OutOfMemoryError/i.test(text)) {
      this.push(
        '메모리가 부족합니다. 설정에서 서버 메모리를 줄이거나 다른 프로그램을 종료해 주세요.',
        'system'
      )
    }

    /*
     * Paperclip이 서버 파일에서 라이브러리를 꺼내 디스크에 쓴 뒤 해시를 확인하는데,
     * 백신이 그 사이에 파일을 건드리면 여기서 걸린다. 원인을 짐작하기 어려운 오류라
     * 로그에 보이는 즉시 무엇을 해야 하는지 알려준다.
     */
    if (/Hash check failed for extract/i.test(text)) {
      this.push(
        '백신이 서버 파일을 건드려 실행이 막혔습니다. 설정 탭의 백신 예외 안내를 따라 폴더를 ' +
          '예외로 등록한 뒤, libraries 폴더를 지우고 다시 시작해 주세요.',
        'system'
      )
    }
  }

  async start(instance: Instance): Promise<void> {
    if (this.isBusy()) {
      throw new Error('이미 서버가 실행 중입니다')
    }

    this.cancelRestart()
    this.instance = instance
    this.players.clear()
    this.exitCode = null
    this.setState('starting')
    this.push(`${instance.name} 서버를 시작합니다.`, 'system')

    try {
      const javaExe = await ensureJava(instance.javaMajor)
      await this.ensureEula(instance.dir)
      const net = await this.prepareNetworking(instance)
      this.port = net.publicPort

      const launch = instance.launch
      if (!launch) {
        throw new Error('실행 정보가 없습니다. 모드팩을 다시 설치해 주세요.')
      }

      let args: string[]
      if (launch.memoryViaArgsFile) {
        // Forge/NeoForge: JVM 옵션은 user_jvm_args.txt로 넘어간다
        await writeUserJvmArgs(instance.dir, instance.memoryMb)
        args = launch.args
      } else {
        args = [...jvmArgsFor(instance.memoryMb), ...launch.args]
      }

      /*
       * 보호를 켜면 서버가 루프백에만 묶이므로, 프록시가 뜨지 않으면 아무도 접속할 수 없다.
       * 서버를 띄우기 전에 프록시부터 열어서 포트를 못 잡으면 아예 시작하지 않는다.
       */
      if (net.guardOn) {
        try {
          await guard.start({
            publicPort: net.publicPort,
            backendPort: net.backendPort,
            settings: instance.guard ?? DEFAULT_GUARD,
            forwardIp: net.forwardIp
          })
        } catch (err) {
          throw new Error(
            `접속 보호를 켜지 못해 서버를 시작하지 않았습니다.\n` +
              `${(err as Error).message}\n` +
              `${net.publicPort}번 포트를 다른 프로그램이 쓰고 있는지 확인하거나, ` +
              '봇 차단 탭에서 접속 보호를 꺼 주세요.'
          )
        }
      }

      const proc = spawnLive(javaExe, args, instance.dir, {
        ...process.env,
        JAVA_TOOL_OPTIONS: undefined as unknown as string
      })
      this.proc = proc
      this.startedAt = Date.now()
      emit.status(this.getStatus())

      // 마지막 줄에 개행이 없는 오류 메시지가 사라지지 않도록 스트림 종료 시 남은 내용을 흘린다
      const outReader = lineReader((line) => this.handleLine(line, 'out'))
      const errReader = lineReader((line) => this.handleLine(line, 'err'))

      proc.stdout.on('data', outReader)
      proc.stderr.on('data', errReader)
      proc.stdout.on('end', () => outReader.flush())
      proc.stderr.on('end', () => errReader.flush())

      proc.on('error', (err) => {
        this.push(`서버를 실행하지 못했습니다: ${err.message}`, 'error')
        this.onExit(-1)
      })

      proc.on('close', (code) => this.onExit(code ?? -1))
    } catch (err) {
      await guard.stop().catch(() => undefined)
      this.setState('crashed')
      this.push(`시작 실패: ${(err as Error).message}`, 'error')
      throw err
    }
  }

  /**
   * 보호 프록시 사용 여부에 따라 포트 구성을 맞춘다.
   * 보호를 켜면 서버는 루프백에만 묶여서, 프록시를 거치지 않은 접속은 아예 닿지 않는다.
   */
  private async prepareNetworking(instance: Instance): Promise<{
    publicPort: number
    backendPort: number
    guardOn: boolean
    forwardIp: boolean
  }> {
    const publicPort = instance.publicPort ?? (await readPort(instance.dir))
    const guardOn = instance.guard?.enabled ?? false
    const isPaper = PLUGIN_LOADERS.includes(instance.loader.type)

    if (!guardOn) {
      await setRawProperties(instance.dir, {
        'server-port': String(publicPort),
        'server-ip': ''
      })
      if (instance.loader.type === 'paper') {
        /*
         * 이 설정을 끄지 못하면 Paper는 계속 프록시가 붙여주던 정보를 기다린다.
         * 보호를 끈 채로 실행하면 모든 접속이 실패하는데 원인이 드러나지 않으므로 알려준다.
         */
        await setProxyProtocol(instance.dir, false).catch((err: Error) => {
          this.push(
            '이전에 켜둔 접속 IP 전달 설정을 되돌리지 못했습니다. ' +
              `접속이 안 되면 서버 폴더의 config/paper-global.yml에서 proxy-protocol을 false로 ` +
              `바꿔 주세요. (${err.message})`,
            'system'
          )
          return false
        })
      }
      return { publicPort, backendPort: publicPort, guardOn: false, forwardIp: false }
    }

    const backendPort = await findFreePort(publicPort + 1)
    await setRawProperties(instance.dir, {
      'server-port': String(backendPort),
      'server-ip': '127.0.0.1'
    })

    // 실제 접속 IP를 넘겨받을 수 있는 건 Paper 계열뿐이다
    let forwardIp = false
    if (instance.loader.type === 'paper') {
      forwardIp = await setProxyProtocol(instance.dir, true).catch(() => false)
    } else if (isPaper) {
      this.push(
        'Spigot·CraftBukkit은 접속 IP 전달을 지원하지 않아, 서버에는 접속자가 모두 로컬로 보입니다.',
        'system'
      )
    }

    return { publicPort, backendPort, guardOn: true, forwardIp }
  }

  private onExit(code: number): void {
    this.proc = null
    void guard.stop()
    this.exitCode = code
    this.players.clear()

    const wasStopping = this.stopping
    this.stopping = false

    if (wasStopping || code === 0) {
      this.setState('stopped')
      this.push('서버가 종료됐습니다.', 'system')
      return
    }

    this.setState('crashed')
    this.push(`서버가 예기치 않게 종료됐습니다 (종료 코드 ${code}).`, 'error')
    void this.maybeRestart()
  }

  private async maybeRestart(): Promise<void> {
    const settings = await getSettings()
    if (!settings.autoRestart || !this.instance) return

    const now = Date.now()
    this.recentCrashes = this.recentCrashes.filter((t) => now - t < CRASH_WINDOW_MS)
    this.recentCrashes.push(now)

    if (this.recentCrashes.length >= CRASH_LIMIT) {
      this.push(
        '짧은 시간에 여러 번 종료돼서 자동 재시작을 멈춥니다. 로그를 확인해 주세요.',
        'system'
      )
      this.recentCrashes = []
      return
    }

    const instance = this.instance
    this.push('10초 뒤 자동으로 다시 시작합니다.', 'system')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start(instance).catch(() => undefined)
    }, 10_000)
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  async stop(): Promise<void> {
    this.cancelRestart()

    if (!this.proc) {
      this.setState('stopped')
      return
    }

    this.stopping = true
    this.setState('stopping')
    this.push('서버를 종료하는 중입니다. 월드 저장을 기다려 주세요.', 'system')

    const proc = this.proc
    try {
      proc.stdin.write('stop\n')
    } catch {
      // stdin이 이미 닫힌 경우
    }

    /*
     * 월드 저장에 시간이 걸리므로 넉넉히 기다리되, 응답이 없으면 강제로 끝낸다.
     * 강제 종료 뒤에도 프로세스가 실제로 사라질 때까지 기다려야
     * 앱을 닫았을 때 자바가 남지 않는다.
     */
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.push('응답이 없어 강제로 종료합니다.', 'system')
        void killTree(proc).then(resolve)
      }, 60_000)

      proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  command(text: string): void {
    if (!this.proc || this.state !== 'running') {
      throw new Error('서버가 실행 중이 아닙니다')
    }
    this.push(`> ${text}`, 'command')
    this.proc.stdin.write(`${text}\n`)
  }

  /** eula.txt가 없거나 false면 동의 상태로 만든다 (동의 여부는 UI에서 이미 받았다) */
  private async ensureEula(dir: string): Promise<void> {
    const file = join(dir, 'eula.txt')
    const current = await readFile(file, 'utf8').catch(() => '')
    if (/^eula\s*=\s*true/m.test(current)) return
    await writeFile(
      file,
      ['# https://aka.ms/MinecraftEULA', 'eula=true'].join('\n'),
      'utf8'
    )
  }

  /** 앱 종료 시 서버가 남지 않게 정리 */
  async shutdown(): Promise<void> {
    this.cancelRestart()
    if (this.proc) {
      await this.stop()
    }
    await guard.stop()
  }
}

export const serverManager = new ServerManager()
