import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PLUGIN_LOADERS } from '@shared/types'
import { decodeInvite, encodeInvite } from '@shared/invite'
import type {
  AppSettings,
  Invite,
  CreateFromFileArgs,
  CreateFromModrinthArgs,
  CreateVanillaArgs,
  Instance,
  LoaderType,
  ServerProperties
} from '@shared/types'
import {
  createFromFile,
  createFromModrinth,
  createVanilla,
  deleteInstance,
  findOrphans,
  instanceSizes,
  removeOrphan,
  updateInstance
} from './instance'
import { checkJavaFor, detectSystemJava, javaStatus } from './java'
import { listPaperVersions, listVanillaVersions, serverFileInfo } from './loader'
import { modrinthVersions, searchModrinth } from './pack'
import { hasOfficialLauncher, pathHasNonAscii, paths } from './paths'
import {
  PROPERTY_CHOICES,
  readProperties,
  readRawProperties,
  writeProperties,
  writeRawProperties
} from './properties'
import { serverManager } from './server'
import {
  addJoined,
  getInstance,
  getInstances,
  getJoined,
  getSettings,
  markJoinedPlayed,
  removeJoined,
  maxMemoryMb,
  recommendMemoryMb,
  saveSettings
} from './store'
import { netManager } from './network'
import { createBackup, deleteBackup, listBackups, restoreBackup, startAutoBackup } from './backup'
import {
  addOp,
  addWhitelist,
  listOps,
  listWhitelist,
  removeOp,
  removeWhitelist
} from './players'
import { addAddons, addonDir, addonKindFor, listAddons, removeAddon, toggleAddon } from './addons'
import { DEFAULT_GUARD, guard } from './guard'
import { isJoining, joinId, prepareJoin } from './join'
import { findOfficialLauncherExe } from './minecraft/profile'
import { emit, joinLog } from './events'

/**
 * 백신이 손댔을 때 지워두면 다시 받아 복구되는 것들.
 * 받아둔 자바 압축본과 풀어둔 자바, 그리고 서버가 자기 안에서 꺼내 쓰는 라이브러리 폴더다.
 */
async function damagedCandidates(instanceDir: string | null): Promise<string[]> {
  const targets = [paths.cache, paths.java]
  if (instanceDir) targets.push(join(instanceDir, 'libraries'))
  return targets
}

/** renderer에서 온 요청은 실패해도 앱이 죽지 않게 감싼다 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, data: await fn(...(args as never[])) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /* 설정 */
  handle('app:settings:get', () => getSettings())
  handle('app:settings:set', async (patch: Partial<AppSettings>) => {
    const next = await saveSettings(patch)
    // 백업 주기를 바꿨으면 돌고 있는 타이머도 새 주기로 다시 건다
    if (patch.backupIntervalMin !== undefined) await startAutoBackup()
    return next
  })
  handle('app:memory', () => ({
    recommended: recommendMemoryMb(),
    max: maxMemoryMb()
  }))
  handle('app:paths', () => ({
    root: paths.root,
    nonAscii: pathHasNonAscii(paths.root)
  }))
  handle('app:java', () => javaStatus())
  handle('java:check', (mcVersion: string) => checkJavaFor(mcVersion))
  handle('java:detect', () => detectSystemJava(true))
  handle('app:antivirusHint', () => ({
    dataRoot: paths.root,
    // 관리자 PowerShell에서 실행하면 Windows Defender 검사에서 이 폴더가 빠진다
    command: `Add-MpPreference -ExclusionPath "${paths.root}"`
  }))

  /** 백신이 건드려 망가진 파일을 지워 다시 받게 한다 */
  handle('app:clearDamaged', async (id: string) => {
    const instance = await getInstance(id)
    const removed: string[] = []

    for (const target of await damagedCandidates(instance?.dir ?? null)) {
      const ok = await rm(target, { recursive: true, force: true })
        .then(() => true)
        .catch(() => false)
      if (ok) removed.push(target)
    }
    return removed
  })
  /*
   * 탐색기로 여는 것은 앱이 만든 폴더 안으로만 허용한다.
   * openPath는 폴더가 아니라 실행 파일을 주면 그걸 실행까지 하기 때문에,
   * 경로를 그대로 받아 넘기면 renderer가 뚫렸을 때 실행 통로가 된다.
   */
  handle('app:openFolder', async (target: string) => {
    const root = resolve(paths.root)
    const wanted = resolve(target)
    const rel = relative(root, wanted)

    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new Error('앱이 관리하는 폴더만 열 수 있습니다')
    }

    const reason = await shell.openPath(wanted)
    if (reason) throw new Error(`폴더를 열지 못했습니다: ${reason}`)
  })
  handle('app:openExternal', (url: string) => {
    // 앱이 여는 링크는 https, 또는 공유기 설정 페이지(사설망 http)만 허용한다
    const privateHttp =
      /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)[\d.]+(:\d+)?\/?$/i
    if (!/^https:\/\//i.test(url) && !privateHttp.test(url)) {
      throw new Error('허용되지 않은 주소입니다')
    }
    return shell.openExternal(url)
  })

  /* 인스턴스 */
  handle('instance:list', () => getInstances())
  handle('instance:sizes', () => instanceSizes())
  handle('instance:orphans', () => findOrphans())
  handle('instance:removeOrphan', (name: string) => removeOrphan(name))
  handle('instance:get', (id: string) => getInstance(id))
  handle('instance:delete', (id: string, deleteFiles: boolean) => deleteInstance(id, deleteFiles))
  handle('instance:update', (id: string, patch: Partial<Instance>) => updateInstance(id, patch))
  handle('instance:create:modrinth', (args: CreateFromModrinthArgs) => createFromModrinth(args))
  handle('instance:create:file', (args: CreateFromFileArgs) => createFromFile(args))
  handle('instance:create:vanilla', (args: CreateVanillaArgs) => createVanilla(args))

  /* 모드팩 검색 */
  handle('pack:search', (query: string, offset: number) => searchModrinth(query, offset))
  handle('pack:versions', (projectId: string) => modrinthVersions(projectId))
  handle('pack:vanillaVersions', () => listVanillaVersions())
  handle('pack:paperVersions', () => listPaperVersions())
  handle('loader:fileInfo', (loader: LoaderType, mcVersion: string) =>
    serverFileInfo(loader, mcVersion)
  )

  handle('pack:pickServerFile', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '받아둔 서버 파일 선택',
      properties: ['openFile'],
      filters: [{ name: '서버 파일', extensions: ['jar'] }]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  handle('pack:pickFile', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '모드팩 파일 선택',
      properties: ['openFile'],
      filters: [
        { name: '모드팩 / 서버팩', extensions: ['mrpack', 'zip'] },
        { name: '모든 파일', extensions: ['*'] }
      ]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  handle('pack:pickFolder', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '서버 폴더 선택',
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  /* 서버 제어 */
  handle('server:start', async (id: string) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    await serverManager.start(instance)
    return serverManager.getStatus()
  })
  handle('server:stop', () => serverManager.stop())
  handle('server:command', (text: string) => serverManager.command(text))
  handle('server:status', () => serverManager.getStatus())
  handle('server:logs', () => serverManager.getLogs())

  /* server.properties */
  handle('props:get', async (id: string) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    return readProperties(instance.dir)
  })
  handle('props:set', async (id: string, props: ServerProperties) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    await writeProperties(instance.dir, props)
  })
  handle('props:choices', () => PROPERTY_CHOICES)
  handle('props:raw:get', async (id: string) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    return readRawProperties(instance.dir)
  })
  handle('props:raw:set', async (id: string, text: string) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    await writeRawProperties(instance.dir, text)
  })

  /* 관리자 / 화이트리스트 */
  const withDir = async <T>(id: string, fn: (dir: string) => Promise<T>): Promise<T> => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    return fn(instance.dir)
  }

  handle('players:ops', (id: string) => withDir(id, listOps))
  handle('players:whitelist', (id: string) => withDir(id, listWhitelist))
  handle('players:addOp', (id: string, name: string) => withDir(id, (d) => addOp(d, name)))
  handle('players:removeOp', (id: string, uuid: string) => withDir(id, (d) => removeOp(d, uuid)))
  handle('players:addWhitelist', (id: string, name: string) =>
    withDir(id, (d) => addWhitelist(d, name))
  )
  handle('players:removeWhitelist', (id: string, uuid: string) =>
    withDir(id, (d) => removeWhitelist(d, uuid))
  )

  /* 모드 / 플러그인 */
  const withInstance = async <T>(id: string, fn: (i: Instance) => Promise<T>): Promise<T> => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    return fn(instance)
  }

  handle('addons:list', (id: string) => withInstance(id, listAddons))
  handle('addons:kind', (id: string) =>
    withInstance(id, async (i) => ({ kind: addonKindFor(i), dir: addonDir(i) }))
  )
  handle('addons:add', (id: string, paths: string[]) =>
    withInstance(id, (i) => addAddons(i, paths))
  )
  handle('addons:remove', (id: string, file: string) =>
    withInstance(id, (i) => removeAddon(i, file))
  )
  handle('addons:toggle', (id: string, file: string) =>
    withInstance(id, (i) => toggleAddon(i, file))
  )
  handle('addons:pick', async () => {
    const win = getWindow()
    if (!win) return []
    const res = await dialog.showOpenDialog(win, {
      title: '모드 / 플러그인 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '모드 / 플러그인', extensions: ['jar'] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  /* 참가자 초대 */
  handle('invite:create', async (id: string) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')

    const net = netManager.getStatus()
    const address = net.address ?? net.localAddress
    if (!address) {
      throw new Error(
        '아직 접속 주소가 없습니다.\n접속 주소 탭에서 먼저 외부 접속을 열어 주세요.'
      )
    }

    /*
     * 플러그인 서버(Paper 등)는 참가자가 모드를 맞출 필요가 없다.
     * 그래서 초대 코드에는 "순정으로 접속하면 된다"고 적어 보낸다.
     */
    const pluginServer = PLUGIN_LOADERS.includes(instance.loader.type)

    const invite: Invite = {
      name: instance.name,
      address,
      mcVersion: instance.mcVersion,
      loader: pluginServer ? 'vanilla' : instance.loader.type,
      loaderVersion: pluginServer ? null : instance.loader.version,
      pack:
        !pluginServer && instance.source.kind === 'modrinth' && instance.source.ref && instance.source.versionRef
          ? {
              source: 'modrinth',
              projectId: instance.source.ref,
              versionId: instance.source.versionRef,
              title: instance.source.label
            }
          : null
    }

    return { invite, code: encodeInvite(invite) }
  })

  /* 참가 — 남이 연 서버에 들어갈 준비 */
  handle('invite:decode', (code: string) => decodeInvite(code))
  handle('joined:list', () => getJoined())
  handle('joined:remove', async (id: string) => {
    await removeJoined(id)
    emit.joinedChanged()
  })
  handle('launcher:available', () => hasOfficialLauncher())
  handle('launcher:open', () => openOfficialLauncher())
  handle('join:running', () => isJoining())

  handle('join:prepare', async (invite: Invite) => {
    const settings = await getSettings()
    const id = joinId(invite)
    await addJoined(invite, id)

    // 클라이언트에 줄 메모리는 이 PC 사양을 보고 정한다 (서버와 달리 인스턴스 설정이 없다)
    const result = await prepareJoin({ invite, memoryMb: recommendMemoryMb() })
    await markJoinedPlayed(id)
    emit.joinedChanged()

    /*
     * 준비가 끝났으면 런처를 대신 띄워준다.
     *
     * 여기까지 왔다는 건 런처가 꺼져 있었다는 뜻이다(켜져 있으면 프로필 등록에서 멈춘다).
     * 방금 등록한 프로필이 가장 최근에 쓴 것으로 기록돼 목록 맨 위에 오므로,
     * 받는 사람은 뜬 창에서 플레이만 누르면 된다.
     */
    let launcherOpened = false
    if (settings.autoOpenLauncher) {
      launcherOpened = await openOfficialLauncher()
        .then(() => true)
        .catch((err: Error) => {
          // 못 열어도 준비 자체는 끝났다. 화면의 버튼으로 직접 열 수 있다
          joinLog(`런처를 자동으로 열지 못했습니다: ${err.message}`, 'warn')
          return false
        })
    }

    return { ...result, launcherOpened }
  })

  /* 접속 보호 */
  handle('guard:status', () => guard.getStatus())
  handle('guard:unblock', (ip: string) => guard.unblock(ip))
  handle('guard:defaults', () => DEFAULT_GUARD)

  /* 외부 접속 */
  handle('net:status', () => netManager.getStatus())
  handle('net:open', (port: number) => netManager.open(port))
  handle('net:close', () => netManager.close())
  handle('net:manual', (port: number) => netManager.useManual(port))

  /* 백업 */
  handle('backup:list', (id: string) => listBackups(id))
  handle('backup:create', async (id: string) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    return createBackup(instance)
  })
  handle('backup:restore', async (id: string, file: string) => {
    const instance = await getInstance(id)
    if (!instance) throw new Error('서버를 찾을 수 없습니다')
    return restoreBackup(instance, file)
  })
  handle('backup:delete', (id: string, file: string) => deleteBackup(id, file))
}

/**
 * 공식 마인크래프트 런처를 띄운다.
 *
 * openPath는 실패해도 예외 대신 사유 문자열을 돌려준다.
 * 그냥 흘려보내면 버튼을 눌러도 아무 일이 없는 것처럼 보인다.
 */
async function openOfficialLauncher(): Promise<void> {
  const exe = findOfficialLauncherExe()
  if (exe) {
    const reason = await shell.openPath(exe)
    if (!reason) return
  }

  // 설치 경로를 못 찾으면 윈도우에 등록된 minecraft:// 연결에 맡긴다
  try {
    await shell.openExternal('minecraft://')
  } catch {
    throw new Error('공식 마인크래프트 런처를 열지 못했습니다.\n시작 메뉴에서 직접 실행해 주세요.')
  }
}
