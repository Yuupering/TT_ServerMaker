import { existsSync } from 'node:fs'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_TITLE } from '@shared/meta'
import { hasOfficialLauncher, minecraftRoot } from '../paths'
import { run } from '../util/proc'

/**
 * 공식 마인크래프트 런처에 프로필을 등록한다.
 *
 * 정품 로그인을 우리가 직접 하려면 마이크로소프트 승인 절차가 필요한데,
 * 공식 런처는 이미 로그인돼 있으니 준비만 우리가 하고 실행은 그쪽에 맡기는 편이 낫다.
 * 참가자는 런처에서 프로필만 고르면 된다.
 */

interface LauncherProfile {
  name: string
  type?: string
  created?: string
  lastUsed?: string
  lastVersionId: string
  gameDir?: string
  javaArgs?: string
  icon?: string
}

interface LauncherProfiles {
  profiles: Record<string, LauncherProfile>
  version?: number
  [key: string]: unknown
}

function profilesFile(): string {
  return join(minecraftRoot(), 'launcher_profiles.json')
}

/** 같은 서버는 같은 프로필을 갱신하도록 고정된 키를 쓴다 */
function profileKey(serverId: string): string {
  return `ttjoiner-${serverId}`
}

export interface RegisterArgs {
  serverId: string
  /** 화면에 보일 프로필 이름 */
  name: string
  /** 실행할 버전 (로더를 깔았다면 그 id) */
  versionId: string
  /** 이 서버 전용 게임 폴더 */
  gameDir: string
  memoryMb: number
}

export class NoLauncherError extends Error {
  constructor() {
    super(
      '공식 마인크래프트 런처를 찾지 못했습니다.\n' +
        '런처를 설치하고 한 번 실행한 뒤 다시 시도해 주세요.'
    )
  }
}

const LAUNCHER_PROCESSES = ['MinecraftLauncher.exe', 'Minecraft.exe']

/**
 * 공식 런처가 지금 켜져 있는지.
 *
 * 런처는 자기가 들고 있는 프로필 목록을 종료할 때 통째로 다시 쓴다.
 * 켜둔 채로 우리가 파일을 고치면 그 내용이 나중에 사라져서,
 * 사용자는 "준비 완료라더니 런처에 아무것도 없다"는 상황을 겪는다.
 */
export async function isLauncherRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false

  const result = await run('tasklist', ['/fo', 'csv', '/nh'], { timeoutMs: 10_000 }).catch(
    () => null
  )
  if (!result || result.code !== 0) return false

  const text = result.output.toLowerCase()
  return LAUNCHER_PROCESSES.some((name) => text.includes(`"${name.toLowerCase()}"`))
}

/** 남의 설정 파일이라 쓰다 말면 그 사람 프로필이 전부 날아간다 */
async function writeProfilesSafely(file: string, data: LauncherProfiles): Promise<void> {
  // 우리가 처음 손대기 전 상태를 한 번 남겨둔다
  const backup = `${file}.ttjoiner-backup`
  if (!existsSync(backup)) {
    await copyFile(file, backup).catch(() => undefined)
  }

  const tmp = `${file}.ttjoiner.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function registerProfile(args: RegisterArgs): Promise<string> {
  if (!hasOfficialLauncher()) throw new NoLauncherError()

  if (await isLauncherRunning()) {
    throw new Error(
      '공식 마인크래프트 런처가 켜져 있습니다.\n' +
        '런처를 완전히 끈 뒤 다시 시도해 주세요. 켜둔 채로는 등록한 프로필이 사라집니다.'
    )
  }

  const file = profilesFile()
  const raw = await readFile(file, 'utf8').catch(() => null)

  let data: LauncherProfiles
  try {
    data = raw ? (JSON.parse(raw) as LauncherProfiles) : { profiles: {}, version: 3 }
  } catch {
    // 런처 설정이 깨져 있으면 덮어쓰지 않고 멈춘다
    throw new Error('공식 런처 설정 파일을 읽지 못했습니다. 런처를 한 번 실행해 주세요.')
  }

  if (!data.profiles) data.profiles = {}

  const key = profileKey(args.serverId)
  const now = new Date().toISOString()
  const existing = data.profiles[key]

  data.profiles[key] = {
    ...existing,
    name: `${args.name} (${APP_TITLE})`,
    type: 'custom',
    created: existing?.created ?? now,
    lastUsed: now,
    lastVersionId: args.versionId,
    gameDir: args.gameDir,
    javaArgs: [
      `-Xmx${args.memoryMb}M`,
      `-Xms${Math.min(args.memoryMb, 1024)}M`,
      '-XX:+UseG1GC',
      '-XX:G1NewSizePercent=20',
      '-XX:MaxGCPauseMillis=50',
      '-Dfile.encoding=UTF-8'
    ].join(' ')
  }

  await writeProfilesSafely(file, data)
  return data.profiles[key].name
}

export async function isProfileRegistered(serverId: string): Promise<boolean> {
  const raw = await readFile(profilesFile(), 'utf8').catch(() => null)
  if (!raw) return false
  try {
    const data = JSON.parse(raw) as LauncherProfiles
    return Boolean(data.profiles?.[profileKey(serverId)])
  } catch {
    return false
  }
}

export async function removeProfile(serverId: string): Promise<void> {
  const file = profilesFile()
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (!raw) return

  try {
    const data = JSON.parse(raw) as LauncherProfiles
    if (data.profiles?.[profileKey(serverId)]) {
      delete data.profiles[profileKey(serverId)]
      await writeProfilesSafely(file, data)
    }
  } catch {
    // 읽지 못하면 그대로 둔다
  }
}

/** 공식 런처 실행 파일을 찾는다 (없으면 null) */
export function findOfficialLauncherExe(): string | null {
  const candidates = [
    join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Minecraft Launcher',
      'MinecraftLauncher.exe'
    ),
    join(
      process.env['ProgramFiles'] ?? 'C:\\Program Files',
      'Minecraft Launcher',
      'MinecraftLauncher.exe'
    )
  ]

  return candidates.find((path) => existsSync(path)) ?? null
}
