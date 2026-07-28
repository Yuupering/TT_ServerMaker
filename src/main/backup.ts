import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BackupEntry, Instance } from '@shared/types'
import { extractZip, zipDirectory } from './util/archive'
import { paths } from './paths'
import { getSettings } from './store'
import { serverManager } from './server'
import { emit } from './events'

function backupDir(instanceId: string): string {
  return join(paths.backups, instanceId)
}

/**
 * server.properties의 level-name (기본 world).
 *
 * 이 값은 서버팩이 들고 오거나 사용자가 원본 편집기로 직접 고칠 수 있다.
 * 경로 구분자나 `..`가 들어오면 백업·복원이 서버 폴더 밖을 건드리게 되므로 이름만 받는다.
 */
async function worldName(dir: string): Promise<string> {
  const text = await readFile(join(dir, 'server.properties'), 'utf8').catch(() => '')
  const m = /^level-name=(.*)$/m.exec(text)
  const raw = m?.[1]?.trim()

  if (!raw) return 'world'

  const name = basename(raw.replace(/[\\/]+$/, ''))
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
    throw new Error(
      `server.properties의 월드 이름(level-name)이 올바르지 않습니다: ${raw}\n` +
        '폴더 이름만 넣어 주세요.'
    )
  }
  return name
}

function stamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export async function listBackups(instanceId: string): Promise<BackupEntry[]> {
  const dir = backupDir(instanceId)
  const files = await readdir(dir).catch(() => [] as string[])

  const entries = await Promise.all(
    files
      .filter((f) => f.toLowerCase().endsWith('.zip'))
      .map(async (f) => {
        const st = await stat(join(dir, f)).catch(() => null)
        return st
          ? { file: f, name: f.replace(/\.zip$/i, ''), size: st.size, createdAt: st.mtimeMs }
          : null
      })
  )

  return entries.filter((e): e is BackupEntry => e !== null).sort((a, b) => b.createdAt - a.createdAt)
}

/** 월드 폴더를 zip으로 묶는다. 서버가 켜져 있어도 동작하지만 저장 직후에 하는 편이 안전하다 */
export async function createBackup(instance: Instance): Promise<BackupEntry> {
  const world = await worldName(instance.dir)
  const src = join(instance.dir, world)

  const exists = await stat(src).catch(() => null)
  if (!exists?.isDirectory()) {
    throw new Error('백업할 월드 폴더가 없습니다. 서버를 한 번 실행해 주세요.')
  }

  const dir = backupDir(instance.id)
  await mkdir(dir, { recursive: true })

  const file = `${stamp(Date.now())}.zip`
  const dest = join(dir, file)

  await zipDirectory(src, dest, {
    // 세션 잠금 파일은 복원 시 오히려 방해가 된다
    exclude: (rel) => rel === 'session.lock'
  })

  await pruneBackups(instance.id)

  const st = await stat(dest)
  return { file, name: file.replace(/\.zip$/i, ''), size: st.size, createdAt: st.mtimeMs }
}

/** 보관 개수를 넘으면 오래된 것부터 지운다 */
async function pruneBackups(instanceId: string): Promise<void> {
  const settings = await getSettings()
  const list = await listBackups(instanceId)
  const excess = list.slice(settings.backupKeep)
  await Promise.all(
    excess.map((e) => rm(join(backupDir(instanceId), e.file), { force: true }).catch(() => undefined))
  )
}

export async function deleteBackup(instanceId: string, file: string): Promise<void> {
  // 경로 조작 방지: 파일명만 허용한다
  if (file.includes('/') || file.includes('\\') || file.includes('..')) {
    throw new Error('잘못된 백업 파일명입니다')
  }
  await rm(join(backupDir(instanceId), file), { force: true })
}

/**
 * 백업을 되돌린다.
 * 지금 월드는 지우지 않고 한쪽으로 치워두므로, 잘못 복원해도 되돌릴 수 있다.
 */
export async function restoreBackup(instance: Instance, file: string): Promise<void> {
  if (file.includes('/') || file.includes('\\') || file.includes('..')) {
    throw new Error('잘못된 백업 파일명입니다')
  }

  const status = serverManager.getStatus()
  if (status.instanceId === instance.id && status.state !== 'stopped' && status.state !== 'crashed') {
    throw new Error('서버가 실행 중입니다. 먼저 서버를 꺼주세요.')
  }

  const src = join(backupDir(instance.id), file)
  const exists = await stat(src).catch(() => null)
  if (!exists) throw new Error('백업 파일을 찾을 수 없습니다')

  const world = await worldName(instance.dir)
  const worldPath = join(instance.dir, world)

  const current = await stat(worldPath).catch(() => null)
  if (current?.isDirectory()) {
    const parked = join(instance.dir, `${world}.before-restore-${stamp(Date.now())}`)
    await rename(worldPath, parked)
  }

  await mkdir(worldPath, { recursive: true })
  await extractZip(src, worldPath)

  emit.log({
    ts: Date.now(),
    level: 'system',
    text: `백업 ${file}을 복원했습니다. 이전 월드는 ${world}.before-restore-* 폴더에 남겨뒀습니다.`
  })
}

let autoTimer: NodeJS.Timeout | null = null
let autoGetRunning: (() => Instance | null) | null = null

/**
 * 설정한 주기마다 실행 중인 서버의 월드를 백업한다.
 * 주기를 바꾸면 다시 불러야 하므로, 마지막에 쓴 조회 함수를 기억해 둔다.
 */
export async function startAutoBackup(getRunning?: () => Instance | null): Promise<void> {
  if (getRunning) autoGetRunning = getRunning
  const source = autoGetRunning
  if (!source) return

  stopAutoBackup()
  const settings = await getSettings()
  if (settings.backupIntervalMin <= 0) return

  autoTimer = setInterval(
    () => {
      const instance = source()
      if (!instance) return
      void createBackup(instance)
        .then((entry) =>
          emit.log({
            ts: Date.now(),
            level: 'system',
            text: `자동 백업 완료 (${entry.name})`
          })
        )
        .catch((err: Error) =>
          emit.log({ ts: Date.now(), level: 'system', text: `자동 백업 실패: ${err.message}` })
        )
    },
    settings.backupIntervalMin * 60_000
  )
}

export function stopAutoBackup(): void {
  if (autoTimer) {
    clearInterval(autoTimer)
    autoTimer = null
  }
}
