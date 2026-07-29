/** main <-> renderer 공유 타입. 양쪽에서 같은 파일을 참조한다. */

export type LoaderType =
  | 'vanilla'
  | 'fabric'
  | 'quilt'
  | 'forge'
  | 'neoforge'
  | 'paper'
  | 'spigot'
  | 'craftbukkit'

/** 플러그인을 쓰는 서버인지 (모드 서버와 설치 방식이 다르다) */
export const PLUGIN_LOADERS: LoaderType[] = ['paper', 'spigot', 'craftbukkit']

export type PackSourceKind = 'modrinth' | 'curseforge' | 'local' | 'vanilla'

export interface PackSource {
  kind: PackSourceKind
  /** modrinth: project id, curseforge: 파일 경로, local: 원본 경로 */
  ref?: string
  /** 사람이 읽는 원본 이름 (팩 이름, 파일명 등) */
  label?: string
  /** modrinth version id 등 재설치에 필요한 값 */
  versionRef?: string
}

export interface Instance {
  id: string
  name: string
  dir: string
  mcVersion: string
  loader: { type: LoaderType; version: string | null }
  /** 이 인스턴스가 요구하는 자바 메이저 버전 */
  javaMajor: number
  memoryMb: number
  source: PackSource
  createdAt: number
  /** 마지막으로 확인된 접속 주소 */
  lastAddress?: string
  /** 설치 때 확정된 실행 방법. 로더마다 실행 커맨드가 달라 저장해 둔다 */
  launch?: {
    args: string[]
    memoryViaArgsFile: boolean
  }
  /** 친구들이 접속하는 포트. 보호가 켜져 있으면 서버는 다른 내부 포트에서 돈다 */
  publicPort?: number
  guard?: GuardSettings
}

export interface GuardSettings {
  enabled: boolean
  /** 같은 IP에서 동시에 유지할 수 있는 연결 수 */
  maxPerIp: number
  /** 같은 IP가 1분 동안 시도할 수 있는 연결 수 */
  ratePerMinute: number
  /** 제한을 넘긴 IP를 막아두는 시간(분) */
  blockMinutes: number
  /** 연결만 걸고 아무것도 안 보내는 연결을 끊기까지의 시간(초) */
  idleTimeoutSec: number
}

export interface GuardStatus {
  running: boolean
  publicPort: number | null
  backendPort: number | null
  /** 실제 접속 IP를 서버에 전달하고 있는지 (Paper 계열만 가능) */
  forwardingIp: boolean
  activeConnections: number
  blocked: { ip: string; until: number; reason: string }[]
  /** 앱을 켠 뒤로 막아낸 연결 수 */
  rejected: number
}

export type ServerState = 'stopped' | 'installing' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface ServerStatus {
  instanceId: string | null
  state: ServerState
  /** 서버가 붙은 로컬 포트 */
  port: number | null
  pid: number | null
  startedAt: number | null
  players: string[]
  /** 마지막 종료 코드 (crashed 판단용) */
  exitCode: number | null
}

export type LogLevel = 'info' | 'warn' | 'error' | 'command' | 'system'

export interface LogLine {
  ts: number
  level: LogLevel
  text: string
}

export interface ProgressEvent {
  /** 진행 중인 작업 묶음 id. 완료 시 done=true */
  id: string
  phase: string
  message: string
  /** 0~1. 알 수 없으면 null */
  ratio: number | null
  done: boolean
  error?: string
}

/* ---------- 모드팩 검색 ---------- */

export interface PackSearchResult {
  id: string
  slug: string
  title: string
  description: string
  iconUrl: string | null
  downloads: number
  categories: string[]
}

export interface PackVersion {
  id: string
  name: string
  versionNumber: string
  mcVersions: string[]
  loaders: string[]
  datePublished: string
  /** release / beta / alpha */
  channel: string
}

/* ---------- 네트워크 ---------- */

export type NetMode = 'none' | 'upnp' | 'manual'

/** 공유기가 자동 포트 열기를 지원하지 않을 때 직접 설정하는 데 필요한 정보 */
export interface ManualPortInfo {
  /** 공유기 설정 페이지 주소 (예: http://192.168.0.1) */
  gatewayUrl: string | null
  /** 이 PC의 랜 IP — 공유기에서 이 주소로 포트를 넘겨야 한다 */
  localIp: string | null
  port: number
  /** 확인된 공인 IP (모르면 null) */
  externalIp: string | null
}

export interface NetStatus {
  mode: NetMode
  /** 친구에게 알려줄 주소 */
  address: string | null
  /** 로컬 네트워크 주소 */
  localAddress: string | null
  detail: string
  busy: boolean
  /** 자동으로 열지 못했을 때 직접 설정할 수 있도록 주는 정보 */
  manual?: ManualPortInfo | null
}

/* ---------- 설정 ---------- */

export interface ServerProperties {
  port: number
  /** 서버 목록 미리보기 응답. 끄면 스캐너에 정보를 안 준다 */
  enableStatus: boolean
  motd: string
  maxPlayers: number
  difficulty: string
  gamemode: string
  pvp: boolean
  onlineMode: boolean
  viewDistance: number
  simulationDistance: number
  allowFlight: boolean
  spawnProtection: number
  whitelist: boolean

  /* 게임 진행 */
  hardcore: boolean
  forceGamemode: boolean
  allowNether: boolean
  enableCommandBlock: boolean
  playerIdleTimeout: number

  /* 월드 */
  levelName: string
  levelSeed: string
  levelType: string
  generateStructures: boolean
  maxWorldSize: number
  spawnMonsters: boolean
  spawnAnimals: boolean
  spawnNpcs: boolean

  /* 리소스팩 */
  resourcePack: string
  resourcePackSha1: string
  requireResourcePack: boolean

  /* 성능 */
  maxTickTime: number
  networkCompressionThreshold: number
  syncChunkWrites: boolean
  entityBroadcastRangePercentage: number
}

export interface AppSettings {
  dataRoot: string
  /** 서버가 죽으면 자동 재시작 */
  autoRestart: boolean
  /** 자동 백업 주기(분). 0이면 끔 */
  backupIntervalMin: number
  backupKeep: number
  /** 참가 준비가 끝나면 공식 마인크래프트 런처를 알아서 띄울지 */
  autoOpenLauncher: boolean
}

export interface PlayerEntry {
  uuid: string
  name: string
}

/**
 * 참가자에게 건네는 초대 정보.
 * 이 코드 하나면 참가자 런처가 필요한 것을 알아서 맞춘다.
 */
export interface Invite {
  name: string
  address: string
  mcVersion: string
  loader: LoaderType
  loaderVersion: string | null
  pack?: {
    source: 'modrinth'
    projectId: string
    versionId: string
    title?: string
  } | null
}

/* ---------- 참가 (초대 코드로 남의 서버 들어가기) ---------- */

export type JoinStep = 'idle' | 'java' | 'loader' | 'mods' | 'ready' | 'error'

export interface JoinStatus {
  step: JoinStep
  message: string
  /** 0~1, 모르면 null */
  ratio: number | null
  error?: string | null
}

/** 공식 런처에서 고를 수 있게 준비를 마친 결과 */
export interface JoinResult {
  /** 공식 런처에서 고를 프로필 이름 */
  profileName: string
  versionId: string
  gameDir: string
  /** 준비를 마치고 공식 런처를 실제로 띄웠는지 */
  launcherOpened?: boolean
}

/** 참가해둔 서버 (다음에 다시 들어갈 때 목록에서 고른다) */
export interface JoinedServer extends Invite {
  id: string
  addedAt: number
  lastPlayedAt?: number
}

export type AddonKind = 'mod' | 'plugin'

export interface AddonEntry {
  /** 실제 파일명 (.disabled가 붙어 있을 수 있다) */
  file: string
  /** 화면에 보여줄 이름 */
  name: string
  size: number
  enabled: boolean
  kind: AddonKind
}

export interface BackupEntry {
  file: string
  name: string
  size: number
  createdAt: number
}

/* ---------- IPC 페이로드 ---------- */

export interface CreateFromModrinthArgs {
  projectId: string
  versionId: string
  name: string
}

export interface CreateFromFileArgs {
  /** .mrpack, CurseForge 서버팩 zip, 일반 zip, 또는 폴더 */
  path: string
  name: string
}

export interface CreateVanillaArgs {
  mcVersion: string
  loader: LoaderType
  name: string
  /**
   * 사용자가 직접 받아서 넣은 서버 파일 경로.
   * 백신이 앱의 다운로드를 건드리는 환경에서 이 경로로 우회한다.
   */
  serverFile?: string | null
}

/** 서버를 열려면 어떤 파일이 필요한지, 어디서 받는지 */
export interface ServerFileInfo {
  /** 화면에 보여줄 파일 종류 (예: Paper 서버 파일) */
  label: string
  filename: string
  url: string
  size: number | null
  sha256: string | null
  /** 받은 뒤 무엇을 하면 되는지 */
  hint: string
  /** 이 종류는 파일 하나로 끝나지 않아 직접 넣기를 지원하지 않는다 */
  supported: boolean
}

export interface JavaInfo {
  major: number
  path: string
  ready: boolean
  /** app = 앱이 받아둔 것, system = 이 PC에 설치된 것 */
  source: 'app' | 'system' | 'none'
}

export interface JavaAvailability {
  major: number
  ready: boolean
  source: 'app' | 'system' | 'none'
  path: string | null
  /** 사용자가 직접 설치할 때 열어줄 공식 설치 파일 주소 */
  installerUrl: string
}
