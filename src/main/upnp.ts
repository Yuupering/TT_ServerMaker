import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { APP_NAME } from '@shared/meta'

/**
 * 공유기 UPnP로 포트를 여는 최소 구현.
 * 라이브러리를 쓰지 않는 이유는, 실패했을 때 왜 실패했는지를 그대로 보여줘야
 * 직접 포트포워딩을 할지 회선 문제인지 사용자가 판단할 수 있기 때문이다.
 */

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const DESC = `${APP_NAME} Minecraft`

export interface Gateway {
  /** SOAP 요청을 보낼 주소 */
  controlUrl: string
  /** urn:schemas-upnp-org:service:WANIPConnection:1 등 */
  serviceType: string
  /** 공유기 IP */
  host: string
}

function searchPacket(st: string): Buffer {
  return Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 2',
      `ST: ${st}`,
      '',
      ''
    ].join('\r\n')
  )
}

/** SSDP로 공유기를 찾는다 */
function discoverLocations(timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Set<string>()

    const finish = (): void => {
      try {
        socket.close()
      } catch {
        // 이미 닫힘
      }
      resolve([...found])
    }

    socket.on('error', finish)

    socket.on('message', (msg) => {
      const text = msg.toString('utf8')
      const m = /^location:\s*(.+)$/im.exec(text)
      if (m) found.add(m[1].trim())
    })

    socket.bind(() => {
      const targets = [
        'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        'urn:schemas-upnp-org:service:WANIPConnection:1',
        'urn:schemas-upnp-org:service:WANPPPConnection:1'
      ]
      for (const st of targets) {
        socket.send(searchPacket(st), SSDP_PORT, SSDP_ADDR)
      }
    })

    setTimeout(finish, timeoutMs)
  })
}

/** 공유기 설명 XML에서 포트 매핑 서비스의 제어 주소를 찾는다 */
async function readGateway(location: string): Promise<Gateway | null> {
  let xml: string
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    xml = await res.text()
  } catch {
    return null
  }

  const base = new URL(location)

  for (const type of [
    'urn:schemas-upnp-org:service:WANIPConnection:1',
    'urn:schemas-upnp-org:service:WANPPPConnection:1',
    'urn:schemas-upnp-org:service:WANIPConnection:2'
  ]) {
    // 해당 serviceType 블록 안의 controlURL을 찾는다
    const idx = xml.indexOf(type)
    if (idx < 0) continue

    const after = xml.slice(idx)
    const m = /<controlURL>\s*([^<]+)\s*<\/controlURL>/i.exec(after)
    if (!m) continue

    const controlUrl = new URL(m[1].trim(), base).toString()
    return { controlUrl, serviceType: type, host: base.hostname }
  }

  return null
}

export async function findGateway(): Promise<Gateway | null> {
  const locations = await discoverLocations()
  for (const loc of locations) {
    const gw = await readGateway(loc)
    if (gw) return gw
  }
  return null
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function soap(
  gw: Gateway,
  action: string,
  params: Record<string, string>
): Promise<string | null> {
  const body =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${gw.serviceType}">` +
    Object.entries(params)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`

  try {
    const res = await fetch(gw.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${gw.serviceType}#${action}"`
      },
      body,
      signal: AbortSignal.timeout(6000)
    })
    const text = await res.text()
    if (!res.ok) return null
    return text
  } catch {
    return null
  }
}

/**
 * 인터넷으로 나갈 때 실제로 쓰이는 이 PC의 주소.
 *
 * 요즘 PC에는 VPN이나 가상 머신이 만든 어댑터가 여럿 붙어 있어서, 목록에서 아무거나 고르면
 * 아무도 접속할 수 없는 주소가 잡힌다. UDP 소켓을 바깥으로 향하게만 해두면 (실제로 보내지는
 * 않는다) 운영체제가 라우팅 표를 보고 진짜 나가는 주소를 알려준다.
 */
export function outboundIp(timeoutMs = 800): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    let settled = false

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // 이미 닫힘
      }
      resolve(value)
    }

    socket.once('error', () => finish(null))
    setTimeout(() => finish(null), timeoutMs)

    try {
      // 공개 DNS 주소를 향하게만 한다. 패킷은 나가지 않는다
      socket.connect(53, '8.8.8.8', () => {
        try {
          finish(socket.address().address)
        } catch {
          finish(null)
        }
      })
    } catch {
      finish(null)
    }
  })
}

/** 어댑터 목록에서 고를 때 쓰는 순위. 가정용 공유기가 주는 대역을 우선한다 */
function addressScore(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  // 172.16~31은 도커나 가상 네트워크가 즐겨 쓰는 대역이라 뒤로 미룬다
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 3
  return 2
}

/** 이 PC의 랜 IP. 공유기와 같은 대역에 있는 주소를 고른다 */
export function localIp(gatewayHost?: string): string | null {
  const prefix = gatewayHost ? gatewayHost.split('.').slice(0, 3).join('.') + '.' : null
  const candidates: string[] = []

  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (prefix && addr.address.startsWith(prefix)) return addr.address
      candidates.push(addr.address)
    }
  }

  return candidates.sort((a, b) => addressScore(a) - addressScore(b))[0] ?? null
}

/** 접속에 쓸 이 PC의 주소. 나가는 경로를 먼저 보고, 안 되면 목록에서 고른다 */
export async function bestLocalIp(gatewayHost?: string): Promise<string | null> {
  const outbound = await outboundIp()
  if (outbound && outbound !== '0.0.0.0') return outbound
  return localIp(gatewayHost)
}

/** 공인 IP처럼 보이지만 실제로는 통신사 내부망인 대역 (이 경우 포트를 열어도 외부에서 못 들어온다) */
export function isPrivateIp(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true

  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  // CGNAT: 통신사가 공인 IP를 주지 않는 환경
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  return false
}

export async function getExternalIp(gw: Gateway): Promise<string | null> {
  const res = await soap(gw, 'GetExternalIPAddress', {})
  if (!res) return null
  const m = /<NewExternalIPAddress>\s*([\d.]+)\s*<\/NewExternalIPAddress>/i.exec(res)
  return m?.[1] ?? null
}

export interface MapResult {
  ok: boolean
  externalIp: string | null
  localIp: string | null
  reason?: string
}

export async function addMapping(port: number): Promise<MapResult> {
  const gw = await findGateway()
  if (!gw) {
    return {
      ok: false,
      externalIp: null,
      localIp: localIp(),
      reason: '공유기에서 자동 포트 열기(UPnP)를 찾지 못했습니다'
    }
  }

  const internal = localIp(gw.host)
  if (!internal) {
    return { ok: false, externalIp: null, localIp: null, reason: '이 PC의 네트워크 주소를 찾지 못했습니다' }
  }

  for (const protocol of ['TCP', 'UDP'] as const) {
    const res = await soap(gw, 'AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: String(port),
      NewProtocol: protocol,
      NewInternalPort: String(port),
      NewInternalClient: internal,
      NewEnabled: '1',
      NewPortMappingDescription: DESC,
      NewLeaseDuration: '0'
    })

    // TCP가 실패하면 마인크래프트 자바 접속 자체가 안 되므로 여기서 끝낸다
    if (!res && protocol === 'TCP') {
      return {
        ok: false,
        externalIp: null,
        localIp: internal,
        reason: '공유기가 자동 포트 열기를 거부했습니다'
      }
    }
  }

  const externalIp = await getExternalIp(gw)
  if (!externalIp) {
    return { ok: false, externalIp: null, localIp: internal, reason: '공인 IP를 확인하지 못했습니다' }
  }

  if (isPrivateIp(externalIp)) {
    return {
      ok: false,
      externalIp,
      localIp: internal,
      reason: '인터넷 회선이 공인 IP를 주지 않는 환경입니다 (통신사 내부망)'
    }
  }

  return { ok: true, externalIp, localIp: internal }
}

export async function removeMapping(port: number): Promise<void> {
  const gw = await findGateway()
  if (!gw) return

  for (const protocol of ['TCP', 'UDP'] as const) {
    await soap(gw, 'DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: String(port),
      NewProtocol: protocol
    })
  }
}
