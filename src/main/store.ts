import { readFile, writeFile, rename } from 'node:fs/promises'
import { totalmem } from 'node:os'
import type { AppSettings, Instance, Invite, JoinedServer } from '@shared/types'
import { dataRoot, paths } from './paths'

const DEFAULT_SETTINGS: Omit<AppSettings, 'dataRoot'> = {
  autoRestart: true,
  backupIntervalMin: 60,
  backupKeep: 10,
  autoOpenLauncher: true
}

let settingsCache: AppSettings | null = null
let instancesCache: Instance[] | null = null

export class DataFileError extends Error {
  constructor(
    readonly file: string,
    cause: string
  ) {
    super(
      `설정 파일을 읽지 못했습니다: ${file}\n` +
        `${cause}\n` +
        '파일이 손상됐습니다. 원본은 .broken 파일로 남겨뒀습니다.'
    )
    this.name = 'DataFileError'
  }
}

/**
 * 파일이 아직 없는 것과 내용이 깨진 것은 다르게 다뤄야 한다.
 * 깨진 걸 빈 값으로 넘겨버리면 "서버가 하나도 없다"처럼 보여서,
 * 사용자가 멀쩡한 서버 폴더를 쓸모없는 것으로 오해하고 지울 수 있다.
 */
async function readJson<T>(file: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return fallback
  }

  if (raw.trim() === '') return fallback

  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // 손상된 원본을 남겨두면 나중에 손으로라도 되살릴 수 있다
    await rename(file, `${file}.broken`).catch(() => undefined)
    throw new DataFileError(file, (err as Error).message)
  }
}

/*
 * 설정 저장이 동시에 여러 번 들어오면 임시 파일이 서로 덮여
 * 한쪽이 실패하거나 앞선 변경이 사라진다. 한 줄로 세워 처리한다.
 */
let writeQueue: Promise<unknown> = Promise.resolve()
let tmpCounter = 0

/** 쓰다 만 파일이 남지 않도록 임시 파일에 쓴 뒤 교체한다 */
function writeJson(file: string, value: unknown): Promise<void> {
  const task = writeQueue.then(async () => {
    const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, file)
  })

  // 한 번 실패해도 뒤따르는 저장이 막히지 않게 한다
  writeQueue = task.catch(() => undefined)
  return task
}

export async function getSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache
  const stored = await readJson<Partial<AppSettings>>(paths.settingsFile, {})
  settingsCache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    dataRoot: stored.dataRoot ?? dataRoot()
  }
  return settingsCache
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings()
  settingsCache = { ...current, ...patch }
  await writeJson(paths.settingsFile, settingsCache)
  return settingsCache
}

export async function getInstances(): Promise<Instance[]> {
  if (instancesCache) return instancesCache
  instancesCache = await readJson<Instance[]>(paths.instancesFile, [])
  return instancesCache
}

export async function getInstance(id: string): Promise<Instance | null> {
  const list = await getInstances()
  return list.find((i) => i.id === id) ?? null
}

export async function upsertInstance(inst: Instance): Promise<void> {
  const list = await getInstances()
  const idx = list.findIndex((i) => i.id === inst.id)
  if (idx >= 0) list[idx] = inst
  else list.push(inst)
  instancesCache = list
  await writeJson(paths.instancesFile, list)
}

export async function removeInstance(id: string): Promise<void> {
  const list = await getInstances()
  instancesCache = list.filter((i) => i.id !== id)
  await writeJson(paths.instancesFile, instancesCache)
}

/**
 * 이 PC에 맞는 서버 메모리 추천값.
 * 전체 메모리에서 OS와 다른 프로그램 몫을 빼고 남는 만큼만 준다.
 * 모드팩 서버는 4~8GB 사이가 대부분이라 그 범위로 자른다.
 */
export function recommendMemoryMb(): number {
  const totalMb = Math.floor(totalmem() / 1024 / 1024)
  // OS + 여유분으로 4GB 확보 (지인이 같은 PC에서 게임도 돌릴 수 있다)
  const usable = totalMb - 4096
  if (usable <= 0) return 2048
  const half = Math.floor(usable / 2)
  const clamped = Math.max(2048, Math.min(8192, half))
  // 512MB 단위로 정리
  return Math.floor(clamped / 512) * 512
}

/** 이 PC에 줄 수 있는 최대 메모리 (슬라이더 상한) */
export function maxMemoryMb(): number {
  const totalMb = Math.floor(totalmem() / 1024 / 1024)
  return Math.max(2048, Math.floor((totalMb - 2048) / 512) * 512)
}

/* ---------- 참가해둔 서버 ---------- */

let joinedCache: JoinedServer[] | null = null

export async function getJoined(): Promise<JoinedServer[]> {
  if (joinedCache) return joinedCache
  joinedCache = await readJson<JoinedServer[]>(paths.joinedFile, [])
  return joinedCache
}

/** 같은 주소는 같은 항목으로 본다 (초대 코드를 다시 받아도 하나로 유지) */
export async function addJoined(invite: Invite, id: string): Promise<JoinedServer> {
  const list = await getJoined()
  const existing = list.find((s) => s.id === id)
  const entry: JoinedServer = existing
    ? { ...existing, ...invite, id }
    : { ...invite, id, addedAt: Date.now() }

  joinedCache = existing ? list.map((s) => (s.id === id ? entry : s)) : [...list, entry]
  await writeJson(paths.joinedFile, joinedCache)
  return entry
}

export async function removeJoined(id: string): Promise<void> {
  const list = await getJoined()
  joinedCache = list.filter((s) => s.id !== id)
  await writeJson(paths.joinedFile, joinedCache)
}

export async function markJoinedPlayed(id: string): Promise<void> {
  const list = await getJoined()
  joinedCache = list.map((s) => (s.id === id ? { ...s, lastPlayedAt: Date.now() } : s))
  await writeJson(paths.joinedFile, joinedCache)
}
