import type { NetStatus } from '@shared/types'
import { emit } from './events'
import {
  addMapping,
  bestLocalIp,
  findGateway,
  getExternalIp,
  isPrivateIp,
  localIp,
  removeMapping
} from './upnp'

/**
 * 외부 접속은 공유기 자동 포트 열기(UPnP)만 쓴다.
 * 제3자 터널 서비스는 계정과 대역폭 제한에 묶이고 연결이 들쭉날쭉해서 걷어냈다.
 * 자동으로 못 열면 직접 설정할 수 있는 정보를 최대한 채워서 보여준다.
 */
class NetManager {
  private status: NetStatus = {
    mode: 'none',
    address: null,
    localAddress: null,
    detail: '아직 외부 접속을 열지 않았습니다',
    busy: false,
    manual: null
  }

  private mappedPort: number | null = null

  getStatus(): NetStatus {
    return this.status
  }

  private update(patch: Partial<NetStatus>): void {
    this.status = { ...this.status, ...patch }
    emit.net(this.status)
  }

  /** 공유기 자동 포트 열기를 시도한다 */
  async open(port: number): Promise<NetStatus> {
    if (this.status.busy) return this.status

    this.update({ busy: true, detail: '네트워크를 확인하는 중입니다' })

    /*
     * 포트를 바꿔 다시 열면 예전 매핑이 공유기에 그대로 남는다.
     * 쓰지도 않는 포트가 열린 채 방치되므로 먼저 걷어낸다.
     */
    if (this.mappedPort !== null && this.mappedPort !== port) {
      const old = this.mappedPort
      this.mappedPort = null
      await removeMapping(old).catch(() => undefined)
    }

    const ip = await bestLocalIp()
    this.update({ localAddress: ip ? `${ip}:${port}` : null })

    /*
     * 공유기 없이 공인 IP를 직접 받는 회선이 있다.
     * 이 경우 포트를 열 공유기가 없으니 UPnP를 시도할 이유가 없고,
     * 이 PC 주소가 곧 접속 주소가 된다.
     */
    if (ip && !isPrivateIp(ip)) {
      this.update({
        mode: 'manual',
        address: port === 25565 ? ip : `${ip}:${port}`,
        detail:
          '이 컴퓨터가 인터넷 주소를 직접 쓰고 있어 공유기 설정이 필요 없습니다. ' +
          '방화벽에서 마인크래프트 서버를 허용하면 바로 접속됩니다.',
        busy: false,
        manual: null
      })
      return this.status
    }

    this.update({ detail: '공유기에 포트 열기를 요청하는 중입니다' })

    try {
      const result = await addMapping(port)

      if (result.ok && result.externalIp) {
        this.mappedPort = port
        this.update({
          mode: 'upnp',
          address: port === 25565 ? result.externalIp : `${result.externalIp}:${port}`,
          detail: '공유기에서 포트를 열었습니다. 친구들이 바로 접속할 수 있습니다.',
          busy: false,
          manual: null
        })
        return this.status
      }

      // 자동으로 못 열었으면 직접 설정에 필요한 것들을 모아 준다
      const manual = await this.collectManualInfo(port, result.localIp ?? ip)

      this.update({
        mode: 'none',
        address: null,
        detail: result.reason ?? '포트를 열지 못했습니다',
        busy: false,
        manual
      })
    } catch (err) {
      this.update({
        mode: 'none',
        address: null,
        detail: `포트 열기 실패: ${(err as Error).message}`,
        busy: false,
        manual: await this.collectManualInfo(port, ip)
      })
    }

    return this.status
  }

  /** 직접 포트포워딩할 때 필요한 값들 */
  private async collectManualInfo(
    port: number,
    knownLocalIp: string | null
  ): Promise<NetStatus['manual']> {
    const gateway = await findGateway().catch(() => null)
    const externalIp = gateway ? await getExternalIp(gateway).catch(() => null) : null
    const mine = knownLocalIp ?? (await bestLocalIp(gateway?.host)) ?? localIp(gateway?.host)

    return {
      gatewayUrl: gateway ? `http://${gateway.host}` : null,
      localIp: mine,
      port,
      // 공유기를 못 찾았어도 이 PC가 공인 주소를 쓰고 있으면 그게 접속 주소다
      externalIp: externalIp ?? (mine && !isPrivateIp(mine) ? mine : null)
    }
  }

  /**
   * 공인 IP만 따로 확인한다.
   * 직접 포트포워딩을 마친 뒤 친구에게 알려줄 주소를 만들 때 쓴다.
   */
  async useManual(port: number): Promise<NetStatus> {
    this.update({ busy: true, detail: '공인 IP를 확인하는 중입니다' })

    const manual = await this.collectManualInfo(port, await bestLocalIp())

    if (manual?.externalIp) {
      this.update({
        mode: 'manual',
        address: port === 25565 ? manual.externalIp : `${manual.externalIp}:${port}`,
        detail: '직접 설정한 포트로 접속하는 주소입니다. 공유기 설정이 끝났는지 확인해 주세요.',
        busy: false,
        manual
      })
    } else {
      this.update({
        mode: 'none',
        address: null,
        detail:
          '공인 IP를 확인하지 못했습니다. 브라우저에서 "내 아이피"를 검색하면 나오는 주소를 쓰면 됩니다.',
        busy: false,
        manual
      })
    }

    return this.status
  }

  /** 열어둔 포트를 정리한다 */
  async close(): Promise<NetStatus> {
    if (this.mappedPort !== null) {
      const port = this.mappedPort
      this.mappedPort = null
      await removeMapping(port).catch(() => undefined)
    }

    this.update({
      mode: 'none',
      address: null,
      detail: '외부 접속을 닫았습니다',
      busy: false,
      manual: null
    })

    return this.status
  }

  /** 앱 종료 시 뒷정리 */
  async shutdown(): Promise<void> {
    if (this.mappedPort !== null) {
      await removeMapping(this.mappedPort).catch(() => undefined)
      this.mappedPort = null
    }
  }
}

export const netManager = new NetManager()
