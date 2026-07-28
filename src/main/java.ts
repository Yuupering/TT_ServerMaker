import { access, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { JavaAvailability, JavaInfo } from '@shared/types'
import { paths } from './paths'
import { discardCached, downloadCached, fetchJson } from './util/download'
import { extractZip } from './util/archive'
import { run } from './util/proc'
import type { ProgressReporter } from './events'

/**
 * 마인크래프트 버전이 요구하는 자바 메이저 버전.
 * 여기가 틀리면 서버가 아예 안 뜨거나 알 수 없는 에러를 뱉는데,
 * 지인 입장에서 원인 파악이 가장 어려운 지점이라 보수적으로 잡는다.
 */
export function javaMajorFor(mcVersion: string): number {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mcVersion.trim())
  if (!m) return 21

  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3] ?? 0)

  // 1.x 체계를 벗어난 새 버전(26.2 등)은 항상 최신 자바를 쓴다
  if (major !== 1) return 21

  if (minor >= 21) return 21
  if (minor === 20) return patch >= 5 ? 21 : 17
  if (minor >= 17) return 17
  // 1.16 이하는 자바 8이 아니면 Forge가 뜨지 않는다
  return 8
}

interface VersionManifestEntry {
  versions: { id: string; url: string }[]
}

/**
 * 모장이 배포 정보에 어떤 자바를 쓰라고 적어뒀는지 직접 확인한다.
 * 버전 이름만 보고 추측하면 새 버전 체계가 나올 때마다 틀리기 때문에,
 * 공식 값이 있으면 그것을 우선한다.
 */
export async function resolveJavaMajor(mcVersion: string): Promise<number> {
  try {
    const manifest = await fetchJson<VersionManifestEntry>(
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    )
    const entry = manifest.versions.find((v) => v.id === mcVersion)
    if (entry) {
      const meta = await fetchJson<{ javaVersion?: { majorVersion?: number } }>(entry.url)
      const major = meta.javaVersion?.majorVersion
      if (typeof major === 'number' && major >= 8) return major
    }
  } catch {
    // 네트워크가 막혀 있으면 아래 추정값으로 넘어간다
  }
  return javaMajorFor(mcVersion)
}

interface AdoptiumAsset {
  binary: {
    image_type: string
    package: {
      link: string
      name: string
      checksum: string
      size: number
    }
  }
  release_name: string
}

function javaHome(major: number): string {
  return join(paths.java, `jre-${major}`)
}

/** 설치된 자바의 java.exe 경로를 찾는다 (압축 해제 시 최상위 폴더명이 버전마다 달라서 탐색한다) */
async function findJavaExe(dir: string): Promise<string | null> {
  const direct = join(dir, 'bin', 'java.exe')
  try {
    await access(direct, constants.X_OK)
    return direct
  } catch {
    // 한 단계 아래에 jdk-21.0.5+11-jre 같은 폴더가 있는 구조
  }

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }

  for (const e of entries) {
    const candidate = join(dir, e, 'bin', 'java.exe')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

export async function findInstalledJava(major: number): Promise<string | null> {
  return findJavaExe(javaHome(major))
}

/* ---------- 이미 설치된 자바 찾기 ---------- */

/**
 * 앱이 자바를 직접 받아서 풀면 백신이 jvm.dll을 건드려 설치가 깨지는 경우가 있다.
 * 정식 설치된 자바는 서명돼 있고 Program Files에 있어서 그런 일이 없으므로,
 * 시스템에 이미 있는 자바를 먼저 찾아 쓴다.
 */
function javaSearchPaths(): string[] {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env['LOCALAPPDATA'] ?? ''

  return [
    join(pf, 'Eclipse Adoptium'),
    join(pf, 'Java'),
    join(pf, 'Microsoft'),
    join(pf, 'Amazon Corretto'),
    join(pf, 'Zulu'),
    join(pf, 'BellSoft'),
    join(pf, 'Eclipse Foundation'),
    join(pf86, 'Java'),
    // 마인크래프트 런처가 깔아둔 자바 (게임을 하는 PC라면 대개 있다)
    join(pf86, 'Minecraft Launcher', 'runtime'),
    join(local, 'Packages'),
    join(local, 'Programs', 'Eclipse Adoptium')
  ].filter((p) => p && !p.startsWith('undefined'))
}

/** 폴더 아래에서 java.exe를 찾는다 (런처 런타임은 몇 단계 더 들어가 있다) */
async function collectJavaExes(root: string, depth = 4): Promise<string[]> {
  if (depth <= 0) return []

  const direct = join(root, 'bin', 'java.exe')
  const found: string[] = []
  try {
    await access(direct, constants.X_OK)
    found.push(direct)
  } catch {
    // 이 단계에는 없다
  }

  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'bin') continue
    found.push(...(await collectJavaExes(join(root, e.name), depth - 1)))
    if (found.length > 40) break
  }

  return found
}

/** java -version 출력에서 메이저 버전을 읽는다 */
async function javaMajorOf(exe: string): Promise<number | null> {
  const result = await run(exe, ['-version'], {}).catch(() => null)
  if (!result) return null

  // 8 이하는 1.8.0 형태, 9부터는 그냥 숫자로 나온다
  const m = /version "(\d+)(?:\.(\d+))?/.exec(result.output)
  if (!m) return null

  const first = Number(m[1])
  if (first === 1) return Number(m[2] ?? 0)
  return first
}

let systemJavaCache: { major: number; path: string }[] | null = null

export async function detectSystemJava(refresh = false): Promise<{ major: number; path: string }[]> {
  if (systemJavaCache && !refresh) return systemJavaCache

  const candidates = new Set<string>()

  const javaHomeEnv = process.env['JAVA_HOME']
  if (javaHomeEnv) {
    const exe = join(javaHomeEnv, 'bin', 'java.exe')
    if (await access(exe, constants.X_OK).then(() => true).catch(() => false)) {
      candidates.add(exe)
    }
  }

  for (const root of javaSearchPaths()) {
    for (const exe of await collectJavaExes(root)) candidates.add(exe)
  }

  const found: { major: number; path: string }[] = []
  for (const exe of candidates) {
    const major = await javaMajorOf(exe)
    if (major && !found.some((f) => f.major === major)) {
      found.push({ major, path: exe })
    }
  }

  systemJavaCache = found.sort((a, b) => a.major - b.major)
  return systemJavaCache
}

/** 공식 설치 파일 주소 (사용자가 직접 설치할 때 안내한다) */
export function javaInstallerUrl(major: number): string {
  return (
    `https://api.adoptium.net/v3/installer/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse` +
    '?project=jdk'
  )
}

/** 이 마인크래프트 버전을 돌리는 데 필요한 자바가 준비돼 있는지 확인한다 */
export async function checkJavaFor(mcVersion: string): Promise<JavaAvailability> {
  const major = await resolveJavaMajor(mcVersion)

  const appJava = await findInstalledJava(major)
  if (appJava) {
    return { major, ready: true, source: 'app', path: appJava, installerUrl: javaInstallerUrl(major) }
  }

  const system = await detectSystemJava(true)
  const match = system.find((s) => s.major === major)
  if (match) {
    return {
      major,
      ready: true,
      source: 'system',
      path: match.path,
      installerUrl: javaInstallerUrl(major)
    }
  }

  return { major, ready: false, source: 'none', path: null, installerUrl: javaInstallerUrl(major) }
}

/**
 * 해당 메이저 버전의 자바를 확보한다.
 * 시스템에 설치된 자바는 버전이 섞여 있고 PATH가 꼬여 있는 경우가 많아 아예 쓰지 않고,
 * 앱 전용 폴더에 받아둔 것만 사용한다.
 */
export async function ensureJava(
  major: number,
  progress?: ProgressReporter,
  allowDownload = true
): Promise<string> {
  const existing = await findInstalledJava(major)
  if (existing) return existing

  // 시스템에 정식 설치된 자바가 있으면 그걸 쓴다.
  // 직접 받아 푸는 것보다 훨씬 안전하다 (백신이 건드리지 않는다)
  const system = await detectSystemJava()
  const match = system.find((s) => s.major === major)
  if (match) {
    progress?.detail(`설치된 자바 ${major}을 사용합니다`, null)
    return match.path
  }

  if (!allowDownload) {
    throw new Error(
      `자바 ${major}이 설치돼 있지 않습니다.\n` +
        '설치 파일을 받아 설치한 뒤 다시 시도해 주세요.'
    )
  }

  progress?.detail(`자바 ${major} 정보를 확인하는 중`, 0)

  const api =
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    `?architecture=x64&image_type=jre&os=windows&vendor=eclipse`

  const assets = await fetchJson<AdoptiumAsset[]>(api)
  const asset = assets.find((a) => a.binary.image_type === 'jre') ?? assets[0]
  if (!asset) {
    throw new Error(`자바 ${major}를 받을 수 있는 곳을 찾지 못했습니다`)
  }

  const pkg = asset.binary.package
  const home = javaHome(major)

  // 받아둔 파일이 깨져 있을 수 있으므로, 압축을 풀다 실패하면 버리고 한 번 더 받는다
  for (let attempt = 0; attempt < 2; attempt++) {
    // Adoptium 체크섬은 sha256
    const zipPath = await downloadCached(pkg.link, `java-${major}-${pkg.name}`, {
      sha256: pkg.checksum,
      expectedSize: pkg.size,
      onProgress: (received, total) => {
        const mb = (received / 1024 / 1024).toFixed(0)
        const totalMb = total ? (total / 1024 / 1024).toFixed(0) : '?'
        progress?.detail(
          `자바 ${major} 내려받는 중 (${mb}MB / ${totalMb}MB)`,
          total ? received / total : null
        )
      }
    })

    await rm(home, { recursive: true, force: true })
    progress?.detail(`자바 ${major} 설치 중`, null)

    try {
      await extractZip(zipPath, home, {
        onProgress: (done, total) => {
          progress?.detail(`자바 ${major} 설치 중 (${done}/${total})`, done / total)
        }
      })
    } catch (err) {
      await discardCached(zipPath)
      await rm(home, { recursive: true, force: true })
      if (attempt === 0) {
        progress?.detail('받아둔 파일이 손상돼 다시 받는 중', null)
        continue
      }
      throw new Error(
        `자바 ${major} 설치 파일의 압축을 푸는 데 실패했습니다.\n\n` +
          '내려받은 파일은 무결성 검사를 통과했는데 푸는 도중에 내용이 바뀌었습니다. ' +
          '백신이 자바 실행 파일(jvm.dll)을 검사하면서 건드리는 경우에 이렇게 됩니다.\n\n' +
          '설정 탭의 "백신이 서버 파일을 막을 때" 항목에서 안내대로 폴더를 검사 예외로 ' +
          '등록한 뒤 다시 시도해 주세요.\n' +
          `대상 폴더: ${paths.root}\n\n` +
          `원인: ${(err as Error).message}`
      )
    }

    const exe = await findJavaExe(home)
    if (exe) return exe

    await discardCached(zipPath)
    if (attempt === 0) continue
    throw new Error(`자바 ${major} 설치에 실패했습니다 (java.exe를 찾지 못함)`)
  }

  throw new Error(`자바 ${major}를 준비하지 못했습니다`)
}

export async function javaStatus(majors: number[] = [8, 17, 21, 25]): Promise<JavaInfo[]> {
  const system = await detectSystemJava()

  return Promise.all(
    majors.map(async (major) => {
      const appPath = await findInstalledJava(major)
      if (appPath) return { major, path: appPath, ready: true, source: 'app' as const }

      const sys = system.find((s) => s.major === major)
      if (sys) return { major, path: sys.path, ready: true, source: 'system' as const }

      return { major, path: '', ready: false, source: 'none' as const }
    })
  )
}
