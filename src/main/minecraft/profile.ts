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
  /** 자바에 줄 메모리 (Xms / Xmx) */
  minMemoryMb: number
  maxMemoryMb: number
}

export class NoLauncherError extends Error {
  constructor() {
    super(
      '공식 마인크래프트 런처를 찾지 못했습니다.\n' +
        '런처를 설치하고 한 번 실행한 뒤 다시 시도해 주세요.'
    )
  }
}

const LAUNCHER_PROCESSES = ['minecraftlauncher.exe', 'minecraft.exe']

/** 창이 아니라 내부용으로 만들어지는 숨은 창들. 켜져 있다는 근거가 못 된다 */
const HIDDEN_WINDOWS = ['n/a', 'olemainthreadwndname', 'default ime', 'msctfime ui']

/**
 * 공식 런처 창이 지금 열려 있는지.
 *
 * 런처가 켜진 채로 프로필 파일을 고치면, 런처가 들고 있던 목록으로 나중에 덮어써서
 * 우리가 등록한 프로필이 사라질 수 있다.
 *
 * 다만 프로세스가 있다는 것만으로는 판단할 수 없다. 스토어(Xbox 앱)로 설치한 런처는
 * 창을 닫아도 프로세스 여러 개가 계속 남기 때문에, 그걸 켜져 있다고 보면
 * 다시는 프로필을 등록할 수 없게 된다. 그래서 실제로 보이는 창이 있는지를 본다.
 */
export async function isLauncherWindowOpen(): Promise<boolean> {
  if (process.platform !== 'win32') return false

  const result = await run('tasklist', ['/v', '/fo', 'csv', '/nh'], {
    timeoutMs: 10_000,
    maxOutputChars: 4 * 1024 * 1024
  }).catch(() => null)
  if (!result || result.code !== 0) return false

  return result.output.split(/\r?\n/).some((line) => {
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, '').toLowerCase())
    if (!LAUNCHER_PROCESSES.includes(cols[0])) return false

    const title = cols[cols.length - 1]?.trim() ?? ''
    return title !== '' && !HIDDEN_WINDOWS.includes(title)
  })
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
    /*
     * 공식 런처가 기본으로 쓰는 인자 구성을 그대로 따른다.
     *
     * G1NewSizePercent와 G1ReservePercent는 실험용 옵션이라 반드시 앞에
     * UnlockExperimentalVMOptions가 있어야 한다. 없으면 자바가 아예 뜨지 않고
     * "Could not create the Java Virtual Machine"으로 끝난다.
     */
    javaArgs: [
      `-Xmx${args.maxMemoryMb}M`,
      `-Xms${Math.min(args.minMemoryMb, args.maxMemoryMb)}M`,
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1HeapRegionSize=32M'
    ].join(' ')
  }

  await writeProfilesSafely(file, data)

  /*
   * 정말 남았는지 확인한다.
   *
   * 런처가 켜져 있으면 자기가 들고 있던 목록으로 파일을 다시 쓸 수 있다.
   * "켜져 있으면 거절"로 막으려 했더니, 스토어판 런처는 창을 닫아도 프로세스가 남아서
   * 영영 등록을 못 하게 됐다. 그래서 미리 막지 않고 쓴 결과를 직접 확인한다.
   */
  const after = await readFile(file, 'utf8').catch(() => null)
  const survived = after ? Boolean((JSON.parse(after) as LauncherProfiles).profiles?.[key]) : false

  if (!survived) {
    throw new Error(
      '런처에 프로필을 등록했지만 곧바로 사라졌습니다.\n' +
        '공식 런처가 켜져 있으면 자기 목록으로 덮어씁니다. 런처를 끄고 다시 시도해 주세요.'
    )
  }

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

/**
 * 공식 런처 실행 파일을 찾는다 (없으면 null).
 *
 * 설치 방식마다 자리가 다르다. 예전 설치본은 Program Files에 MinecraftLauncher.exe로 들어가고,
 * 마이크로소프트 스토어(Xbox 앱)로 받으면 XboxGames 폴더에 Minecraft.exe로 들어간다.
 * 스토어판을 놓치면 minecraft:// 로 넘어가는데, 그 연결이 스토어 앱에 걸려 있으면
 * 런처 대신 스토어 페이지가 열린다.
 */
export function findOfficialLauncherExe(userPath?: string | null): string | null {
  // 사용자가 직접 지정한 경로가 있으면 그게 최우선이다
  if (userPath && existsSync(userPath)) return userPath

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
    ),
    // 스토어·Xbox 앱 설치본. 설치 드라이브를 바꿀 수 있어 흔한 것들을 훑는다
    ...['C', 'D', 'E', 'F'].map((drive) =>
      join(`${drive}:\\`, 'XboxGames', 'Minecraft Launcher', 'Content', 'Minecraft.exe')
    )
  ]

  return candidates.find((path) => existsSync(path)) ?? null
}
