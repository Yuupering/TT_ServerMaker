import type { Invite } from './types'

/**
 * 초대 코드.
 *
 * 서버를 연 사람이 코드를 복사해 카톡 등으로 보내면, 참가자는 런처에 붙여넣기만 하면 된다.
 * 안에는 접속 주소와 어떤 버전·로더·모드팩이 필요한지가 들어 있다.
 * 비밀 정보는 담지 않는다 (누가 봐도 접속 주소 이상은 알 수 없다).
 */

const PREFIX = 'TTSM1'

function toBase64Url(text: string): string {
  const base64 =
    typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(text)))
      : Buffer.from(text, 'utf8').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(code: string): string {
  const base64 = code.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return typeof atob === 'function'
    ? decodeURIComponent(escape(atob(padded)))
    : Buffer.from(padded, 'base64').toString('utf8')
}

/** 붙여넣다 한 글자 빠지는 일이 잦아서 짧은 검사값을 붙인다 */
function checksum(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36).slice(-4)
}

export function encodeInvite(invite: Invite): string {
  const body = toBase64Url(JSON.stringify(invite))
  return `${PREFIX}.${body}.${checksum(body)}`
}

export class InviteError extends Error {}

/*
 * 참가자 쪽에서 설치할 수 있는 로더만 받는다.
 * Paper·Spigot 같은 플러그인 서버는 클라이언트가 순정이므로,
 * 코드를 만드는 쪽에서 이미 vanilla로 바꿔 담는다.
 */
const LOADERS: readonly string[] = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']

/** 주소·버전 같은 값은 나중에 폴더 이름과 주소 조립에 쓰인다 */
const ADDRESS_RE = /^([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/
const MODRINTH_ID_RE = /^[A-Za-z0-9]{6,16}$/

/**
 * 초대 코드는 카톡 등을 거쳐 들어오는 남의 입력이다.
 *
 * 여기 담긴 값은 그대로 폴더 이름(버전 폴더)과 API 주소를 만드는 데 쓰이므로,
 * 검사 없이 받으면 경로 구분자나 `..`가 섞인 코드 하나로 엉뚱한 위치에 파일을 쓰게 할 수 있다.
 * 그래서 형식을 하나씩 확인하고, 어긋나면 아예 거절한다.
 */
function validate(invite: Invite): Invite {
  const bad = (what: string): never => {
    throw new InviteError(`초대 코드의 ${what} 값이 올바르지 않습니다. 코드를 다시 받아 주세요.`)
  }

  if (typeof invite.address !== 'string' || !ADDRESS_RE.test(invite.address.trim())) {
    bad('접속 주소')
  }
  if (typeof invite.mcVersion !== 'string' || !VERSION_RE.test(invite.mcVersion)) {
    bad('마인크래프트 버전')
  }
  if (!LOADERS.includes(invite.loader)) bad('모드 로더')

  if (invite.loaderVersion != null) {
    if (typeof invite.loaderVersion !== 'string' || !VERSION_RE.test(invite.loaderVersion)) {
      bad('로더 버전')
    }
  }

  if (invite.pack != null) {
    const pack = invite.pack
    if (pack.source !== 'modrinth') bad('모드팩 정보')
    if (!MODRINTH_ID_RE.test(String(pack.projectId))) bad('모드팩 번호')
    if (!MODRINTH_ID_RE.test(String(pack.versionId))) bad('모드팩 버전 번호')
    if (pack.title != null && typeof pack.title !== 'string') bad('모드팩 이름')
  }

  return {
    // 이름은 화면에만 쓰지만 길이는 잘라둔다
    name: typeof invite.name === 'string' ? invite.name.slice(0, 64) : '',
    address: invite.address.trim(),
    mcVersion: invite.mcVersion,
    loader: invite.loader,
    loaderVersion: invite.loaderVersion ?? null,
    pack: invite.pack
      ? {
          source: 'modrinth',
          projectId: invite.pack.projectId,
          versionId: invite.pack.versionId,
          title:
            typeof invite.pack.title === 'string' ? invite.pack.title.slice(0, 100) : undefined
        }
      : null
  }
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim().replace(/\s+/g, '')
  const parts = trimmed.split('.')

  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new InviteError('초대 코드 형식이 아닙니다. 받은 코드를 통째로 붙여넣어 주세요.')
  }

  const [, body, sum] = parts
  if (checksum(body) !== sum) {
    throw new InviteError('초대 코드가 일부 빠졌거나 잘못 복사됐습니다. 다시 받아 주세요.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(body))
  } catch {
    throw new InviteError('초대 코드를 읽지 못했습니다.')
  }

  const invite = parsed as Invite
  if (!invite?.address || !invite?.mcVersion || !invite?.loader) {
    throw new InviteError('초대 코드에 필요한 정보가 없습니다.')
  }

  return validate(invite)
}
