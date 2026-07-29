import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AddonEntry,
  AddonKind,
  AppSettings,
  BackupEntry,
  GuardSettings,
  GuardStatus,
  CreateFromFileArgs,
  CreateFromModrinthArgs,
  CreateVanillaArgs,
  Instance,
  Invite,
  JavaAvailability,
  JavaInfo,
  JoinedServer,
  JoinResult,
  JoinStatus,
  LoaderType,
  ServerFileInfo,
  LogLine,
  NetStatus,
  PackSearchResult,
  PackVersion,
  PlayerEntry,
  ProgressEvent,
  ServerProperties,
  ServerStatus
} from '@shared/types'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

/** main에서 온 실패 응답을 예외로 바꿔 renderer에서 try/catch로 다루게 한다 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  settings: {
    get: () => invoke<AppSettings>('app:settings:get'),
    set: (patch: Partial<AppSettings>) => invoke<AppSettings>('app:settings:set', patch)
  },
  system: {
    memory: () => invoke<{ recommended: number; max: number }>('app:memory'),
    paths: () => invoke<{ root: string; nonAscii: boolean }>('app:paths'),
    java: () => invoke<JavaInfo[]>('app:java'),
    javaCheck: (mcVersion: string) => invoke<JavaAvailability>('java:check', mcVersion),
    javaDetect: () => invoke<{ major: number; path: string }[]>('java:detect'),
    antivirusHint: () => invoke<{ dataRoot: string; command: string }>('app:antivirusHint'),
    clearDamaged: (instanceId: string) => invoke<string[]>('app:clearDamaged', instanceId),
    openFolder: (target: string) => invoke<string>('app:openFolder', target),
    openExternal: (url: string) => invoke<void>('app:openExternal', url)
  },
  instances: {
    list: () => invoke<Instance[]>('instance:list'),
    sizes: () => invoke<Record<string, number>>('instance:sizes'),
    orphans: () => invoke<{ name: string; path: string; size: number }[]>('instance:orphans'),
    removeOrphan: (name: string) => invoke<void>('instance:removeOrphan', name),
    get: (id: string) => invoke<Instance | null>('instance:get', id),
    remove: (id: string, deleteFiles: boolean) => invoke<void>('instance:delete', id, deleteFiles),
    update: (id: string, patch: Partial<Instance>) => invoke<Instance>('instance:update', id, patch),
    createFromModrinth: (args: CreateFromModrinthArgs) =>
      invoke<Instance>('instance:create:modrinth', args),
    createFromFile: (args: CreateFromFileArgs) => invoke<Instance>('instance:create:file', args),
    createVanilla: (args: CreateVanillaArgs) => invoke<Instance>('instance:create:vanilla', args)
  },
  packs: {
    search: (query: string, offset = 0) => invoke<PackSearchResult[]>('pack:search', query, offset),
    versions: (projectId: string) => invoke<PackVersion[]>('pack:versions', projectId),
    vanillaVersions: () => invoke<string[]>('pack:vanillaVersions'),
    paperVersions: () => invoke<string[]>('pack:paperVersions'),
    serverFileInfo: (loader: LoaderType, mcVersion: string) =>
      invoke<ServerFileInfo>('loader:fileInfo', loader, mcVersion),
    pickServerFile: () => invoke<string | null>('pack:pickServerFile'),
    pickFile: () => invoke<string | null>('pack:pickFile'),
    pickFolder: () => invoke<string | null>('pack:pickFolder')
  },
  server: {
    start: (id: string) => invoke<ServerStatus>('server:start', id),
    stop: () => invoke<void>('server:stop'),
    command: (text: string) => invoke<void>('server:command', text),
    status: () => invoke<ServerStatus>('server:status'),
    logs: () => invoke<LogLine[]>('server:logs')
  },
  props: {
    get: (id: string) => invoke<ServerProperties>('props:get', id),
    set: (id: string, props: ServerProperties) => invoke<void>('props:set', id, props),
    choices: () => invoke<Partial<Record<keyof ServerProperties, string[]>>>('props:choices'),
    rawGet: (id: string) => invoke<string>('props:raw:get', id),
    rawSet: (id: string, text: string) => invoke<void>('props:raw:set', id, text)
  },
  addons: {
    list: (id: string) => invoke<AddonEntry[]>('addons:list', id),
    kind: (id: string) => invoke<{ kind: AddonKind; dir: string }>('addons:kind', id),
    add: (id: string, paths: string[]) =>
      invoke<{ added: string[]; skipped: { name: string; reason: string }[] }>(
        'addons:add',
        id,
        paths
      ),
    remove: (id: string, file: string) => invoke<void>('addons:remove', id, file),
    toggle: (id: string, file: string) => invoke<void>('addons:toggle', id, file),
    pick: () => invoke<string[]>('addons:pick'),
    /**
     * 끌어다 놓은 File 객체에서 실제 경로를 얻는다.
     * Electron 32부터 File.path가 사라져서 이 방법을 써야 한다.
     */
    pathOf: (file: File) => webUtils.getPathForFile(file)
  },
  players: {
    ops: (id: string) => invoke<PlayerEntry[]>('players:ops', id),
    whitelist: (id: string) => invoke<PlayerEntry[]>('players:whitelist', id),
    addOp: (id: string, name: string) => invoke<PlayerEntry[]>('players:addOp', id, name),
    removeOp: (id: string, uuid: string) => invoke<PlayerEntry[]>('players:removeOp', id, uuid),
    addWhitelist: (id: string, name: string) =>
      invoke<PlayerEntry[]>('players:addWhitelist', id, name),
    removeWhitelist: (id: string, uuid: string) =>
      invoke<PlayerEntry[]>('players:removeWhitelist', id, uuid)
  },
  invite: {
    create: (id: string) => invoke<{ invite: Invite; code: string }>('invite:create', id)
  },
  guard: {
    status: () => invoke<GuardStatus>('guard:status'),
    unblock: (ip: string) => invoke<void>('guard:unblock', ip),
    defaults: () => invoke<GuardSettings>('guard:defaults')
  },
  net: {
    status: () => invoke<NetStatus>('net:status'),
    open: (port: number) => invoke<NetStatus>('net:open', port),
    manual: (port: number) => invoke<NetStatus>('net:manual', port),
    close: () => invoke<NetStatus>('net:close')
  },
  backups: {
    list: (id: string) => invoke<BackupEntry[]>('backup:list', id),
    create: (id: string) => invoke<BackupEntry>('backup:create', id),
    restore: (id: string, file: string) => invoke<void>('backup:restore', id, file),
    remove: (id: string, file: string) => invoke<void>('backup:delete', id, file)
  },
  /* 참가 — 남이 연 서버에 들어갈 준비 */
  join: {
    decode: (code: string) => invoke<Invite>('invite:decode', code),
    list: () => invoke<JoinedServer[]>('joined:list'),
    remove: (id: string) => invoke<void>('joined:remove', id),
    prepare: (invite: Invite) => invoke<JoinResult>('join:prepare', invite),
    running: () => invoke<boolean>('join:running'),
    launcherAvailable: () => invoke<boolean>('launcher:available'),
    openLauncher: () => invoke<void>('launcher:open')
  },

  events: {
    onProgress: (cb: (e: ProgressEvent) => void) => on<ProgressEvent>('evt:progress', cb),
    onLog: (cb: (e: LogLine) => void) => on<LogLine>('evt:log', cb),
    onStatus: (cb: (e: ServerStatus) => void) => on<ServerStatus>('evt:status', cb),
    onNet: (cb: (e: NetStatus) => void) => on<NetStatus>('evt:net', cb),
    onGuard: (cb: (e: GuardStatus) => void) => on<GuardStatus>('evt:guard', cb),
    onInstancesChanged: (cb: () => void) => on<null>('evt:instances', cb),
    onJoinStatus: (cb: (e: JoinStatus) => void) => on<JoinStatus>('evt:join', cb),
    onJoinLog: (cb: (e: LogLine) => void) => on<LogLine>('evt:joinlog', cb),
    onJoinedChanged: (cb: () => void) => on<null>('evt:joined', cb)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type HostApi = typeof api
