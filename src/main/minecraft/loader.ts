import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { LoaderType } from '@shared/types'
import { downloadCached, fetchJson } from '../util/download'
import { run } from '../util/proc'
import { paths } from '../paths'
import { versionDir, versionJsonPath, type VersionJson } from './version'

/**
 * 클라이언트 쪽 모드 로더를 깐다.
 *
 * 로더는 자기 이름의 버전 폴더와 version.json을 만들고, 그 안에서 바닐라를 상속한다.
 * 그래서 여기서 할 일은 "그 version.json을 만들어 두는 것"까지다.
 */

/** 이 조합으로 실행할 때 쓸 버전 id */
export async function ensureLoader(
  loader: LoaderType,
  mcVersion: string,
  loaderVersion: string | null,
  javaExe: string,
  onStep?: (message: string) => void
): Promise<string> {
  switch (loader) {
    case 'vanilla':
      return mcVersion
    case 'fabric':
      return installFabricClient(mcVersion, loaderVersion, onStep)
    case 'quilt':
      return installQuiltClient(mcVersion, loaderVersion, onStep)
    case 'forge':
      return installForgeClient('forge', mcVersion, loaderVersion, javaExe, onStep)
    case 'neoforge':
      return installForgeClient('neoforge', mcVersion, loaderVersion, javaExe, onStep)
    default:
      throw new Error(`지원하지 않는 로더입니다: ${loader}`)
  }
}

/* ---------- Fabric ---------- */

interface FabricLoaderEntry {
  loader: { version: string; stable: boolean }
}

async function latestFabricLoader(mcVersion: string): Promise<string> {
  const list = await fetchJson<FabricLoaderEntry[]>(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`
  )
  const stable = list.find((l) => l.loader.stable) ?? list[0]
  if (!stable) throw new Error(`Fabric이 마인크래프트 ${mcVersion}을 지원하지 않습니다`)
  return stable.loader.version
}

/**
 * Fabric은 완성된 version.json을 그대로 내려준다.
 * 인스톨러를 돌릴 필요 없이 그 파일만 저장하면 끝난다.
 */
async function installFabricClient(
  mcVersion: string,
  loaderVersion: string | null,
  onStep?: (message: string) => void
): Promise<string> {
  const version = loaderVersion ?? (await latestFabricLoader(mcVersion))
  onStep?.(`Fabric ${version} 준비 중`)

  const profile = await fetchJson<VersionJson>(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}` +
      `/${encodeURIComponent(version)}/profile/json`
  )

  const id = profile.id ?? `fabric-loader-${version}-${mcVersion}`
  await mkdir(versionDir(id), { recursive: true })
  await writeFile(versionJsonPath(id), JSON.stringify(profile, null, 2), 'utf8')
  return id
}

/* ---------- Quilt ---------- */

async function installQuiltClient(
  mcVersion: string,
  loaderVersion: string | null,
  onStep?: (message: string) => void
): Promise<string> {
  const list = await fetchJson<{ loader: { version: string } }[]>(
    `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`
  )
  const version = loaderVersion ?? list[0]?.loader.version
  if (!version) throw new Error(`Quilt가 마인크래프트 ${mcVersion}을 지원하지 않습니다`)

  onStep?.(`Quilt ${version} 준비 중`)

  const profile = await fetchJson<VersionJson>(
    `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}` +
      `/${encodeURIComponent(version)}/profile/json`
  )

  const id = profile.id ?? `quilt-loader-${version}-${mcVersion}`
  await mkdir(versionDir(id), { recursive: true })
  await writeFile(versionJsonPath(id), JSON.stringify(profile, null, 2), 'utf8')
  return id
}

/* ---------- Forge / NeoForge ---------- */

/**
 * 이미 설치된 버전 폴더를 찾는다.
 *
 * 설치 프로그램이 만드는 폴더 이름은 버전마다 규칙이 조금씩 달라서
 * 정확한 이름을 미리 만들 수 없다. 그래서 종류·마크 버전·로더 버전이 모두 들어간
 * 폴더 중에 version.json이 있는 것을 찾는다.
 */
async function findInstalledVersion(
  kind: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string
): Promise<string | null> {
  const entries = await readdir(paths.versions).catch(() => [] as string[])

  const match = entries
    .filter((e) => {
      const lower = e.toLowerCase()
      return lower.includes(kind) && e.includes(mcVersion) && e.includes(loaderVersion)
    })
    .sort()
    .pop()

  if (!match) return null

  // 폴더만 있고 version.json이 없으면 설치가 중간에 끊긴 것이다
  const ok = await access(versionJsonPath(match), constants.R_OK)
    .then(() => true)
    .catch(() => false)

  return ok ? match : null
}

interface ForgePromos {
  promos: Record<string, string>
}

async function latestForge(mcVersion: string): Promise<string> {
  const data = await fetchJson<ForgePromos>(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
  )
  const rec = data.promos[`${mcVersion}-recommended`] ?? data.promos[`${mcVersion}-latest`]
  if (!rec) throw new Error(`Forge가 마인크래프트 ${mcVersion}을 지원하지 않습니다`)
  return rec
}

async function latestNeoForge(mcVersion: string): Promise<string> {
  const data = await fetchJson<{ versions: string[] }>(
    'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
  )
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion)
  if (!m) throw new Error(`NeoForge 버전 규칙에 맞지 않는 마인크래프트 버전입니다: ${mcVersion}`)
  const prefix = `${m[1]}.${m[2] ?? '0'}.`

  const matching = data.versions.filter((v) => v.startsWith(prefix) && !v.includes('beta'))
  const chosen = matching[matching.length - 1]
  if (!chosen) throw new Error(`NeoForge가 마인크래프트 ${mcVersion}을 지원하지 않습니다`)
  return chosen
}

/**
 * Forge 계열은 설치 프로그램을 돌려야 한다.
 * 화면 없이 설치하려면 --installClient에 게임 폴더를 넘긴다.
 */
async function installForgeClient(
  kind: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string | null,
  javaExe: string,
  onStep?: (message: string) => void
): Promise<string> {
  const label = kind === 'forge' ? 'Forge' : 'NeoForge'

  let version = loaderVersion
  let installerUrl: string

  if (kind === 'forge') {
    version ??= await latestForge(mcVersion)
    const full = `${mcVersion}-${version}`
    installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
  } else {
    version ??= await latestNeoForge(mcVersion)
    installerUrl = version.startsWith('1.20.1-')
      ? `https://maven.neoforged.net/releases/net/neoforged/forge/${version}/forge-${version}-installer.jar`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
  }

  /*
   * 이미 깔아둔 버전이면 설치 프로그램을 다시 돌리지 않는다.
   * Forge 설치는 몇 분씩 걸리는데, 준비하기를 누를 때마다 그걸 반복할 이유가 없다.
   */
  const installed = await findInstalledVersion(kind, mcVersion, version)
  if (installed) {
    onStep?.(`${label} ${version}은 이미 준비돼 있습니다`)
    return installed
  }

  onStep?.(`${label} ${version} 내려받는 중`)
  const installer = await downloadCached(installerUrl, `${kind}-${version}-client-installer.jar`)

  /*
   * 설치 프로그램은 공식 런처가 쓰는 폴더 구조를 기대한다.
   * launcher_profiles.json이 없으면 설치를 거부하므로 빈 파일을 만들어 둔다.
   */
  const profileFile = join(paths.clientShared, 'launcher_profiles.json')
  await writeFile(profileFile, JSON.stringify({ profiles: {}, version: 3 }), 'utf8').catch(
    () => undefined
  )

  onStep?.(`${label} 설치 중`)
  const result = await run(javaExe, ['-jar', installer, '--installClient', paths.clientShared], {
    cwd: paths.clientShared,
    // 설치가 멈춰도 화면이 영원히 돌지 않게 상한을 둔다
    timeoutMs: 15 * 60_000,
    onLine: (line) => {
      if (line.trim()) onStep?.(line.slice(0, 100))
    }
  })

  if (result.code !== 0) {
    throw new Error(
      result.timedOut
        ? `${label} 설치가 너무 오래 걸려 중단했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.`
        : `${label} 설치에 실패했습니다 (종료 코드 ${result.code})`
    )
  }

  // 설치 프로그램이 만든 버전 폴더를 찾는다 (이름 규칙이 버전마다 조금씩 다르다)
  const entries = await readdir(paths.versions).catch(() => [] as string[])
  const found = entries
    .filter((e) => e.toLowerCase().includes(kind) && e.includes(mcVersion))
    .sort()
    .pop()

  if (!found) {
    throw new Error(`${label} 설치는 끝났지만 버전 폴더를 찾지 못했습니다`)
  }

  return found
}
