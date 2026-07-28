import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import type { LoaderType, ServerFileInfo } from '@shared/types'
import { APP_TITLE } from '@shared/meta'
import { downloadCached, downloadFile, fetchJson } from './util/download'
import { run } from './util/proc'
import type { ProgressReporter } from './events'

export interface LaunchPlan {
  /** java 뒤에 붙일 인자. 메모리 인자는 server.ts가 앞에 붙인다 */
  args: string[]
  /**
   * Forge/NeoForge는 user_jvm_args.txt로 JVM 옵션을 받는다.
   * 이 경우 메모리를 argv가 아니라 그 파일에 써야 우리가 지정한 값이 최종적으로 이긴다.
   */
  memoryViaArgsFile: boolean
}

export interface InstallLoaderArgs {
  dir: string
  mcVersion: string
  loader: LoaderType
  loaderVersion: string | null
  javaExe: string
  progress?: ProgressReporter
  /**
   * 사용자가 직접 받아서 넣은 파일. 있으면 앱이 내려받지 않고 이걸 쓴다.
   * 백신이 앱의 다운로드를 손대는 환경을 위한 우회로다.
   */
  providedFile?: string | null
}

/* ---------- 바닐라 ---------- */

interface VersionManifest {
  versions: { id: string; type: string; url: string }[]
}

interface VersionMeta {
  downloads?: { server?: { url: string; sha1: string } }
}

export async function listVanillaVersions(): Promise<string[]> {
  const manifest = await fetchJson<VersionManifest>(
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  )
  return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id)
}

async function installVanilla(a: InstallLoaderArgs): Promise<LaunchPlan> {
  a.progress?.detail('마인크래프트 서버 파일을 확인하는 중', null)

  const manifest = await fetchJson<VersionManifest>(
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  )
  const entry = manifest.versions.find((v) => v.id === a.mcVersion)
  if (!entry) throw new Error(`마인크래프트 ${a.mcVersion} 버전 정보를 찾지 못했습니다`)

  const meta = await fetchJson<VersionMeta>(entry.url)
  const server = meta.downloads?.server
  if (!server) throw new Error(`마인크래프트 ${a.mcVersion}은 서버 파일을 제공하지 않습니다`)

  const dest = join(a.dir, 'server.jar')

  if (a.providedFile) {
    await useProvidedFile(a, dest, { sha1: server.sha1 })
  } else {
    await downloadFile(server.url, dest, {
      sha1: server.sha1,
      onProgress: (received, total) =>
        a.progress?.detail('서버 파일 내려받는 중', total ? received / total : null)
    })
  }

  return { args: ['-jar', 'server.jar', 'nogui'], memoryViaArgsFile: false }
}

/**
 * 사용자가 넣어준 파일을 서버 폴더에 놓는다.
 * 공식 해시를 아는 경우에는 대조해서, 엉뚱하거나 망가진 파일을 넣었으면 여기서 잡는다.
 */
async function useProvidedFile(
  a: InstallLoaderArgs,
  dest: string,
  expect: { sha1?: string; sha256?: string } = {}
): Promise<void> {
  const src = a.providedFile as string
  a.progress?.detail('넣어주신 파일을 확인하는 중', null)

  const algo = expect.sha256 ? 'sha256' : expect.sha1 ? 'sha1' : null
  if (algo) {
    const expected = (expect.sha256 ?? expect.sha1 ?? '').toLowerCase()
    const hash = createHash(algo)
    await pipeline(createReadStream(src), hash)
    if (hash.digest('hex') !== expected) {
      throw new Error(
        '넣어주신 파일이 공식 파일과 다릅니다.\n' +
          '다른 버전을 받았거나 받는 도중 손상됐을 수 있습니다. 다시 받아서 넣어 주세요.'
      )
    }
  }

  await copyFile(src, dest)
}

/* ---------- Fabric ---------- */

interface FabricLoaderEntry {
  loader: { version: string; stable: boolean }
}

export async function latestFabricLoader(mcVersion: string): Promise<string> {
  const list = await fetchJson<FabricLoaderEntry[]>(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`
  )
  const stable = list.find((l) => l.loader.stable) ?? list[0]
  if (!stable) throw new Error(`Fabric이 마인크래프트 ${mcVersion}을 지원하지 않습니다`)
  return stable.loader.version
}

async function latestFabricInstaller(): Promise<string> {
  const list = await fetchJson<{ version: string; stable: boolean }[]>(
    'https://meta.fabricmc.net/v2/versions/installer'
  )
  const stable = list.find((l) => l.stable) ?? list[0]
  if (!stable) throw new Error('Fabric 설치 도구 정보를 찾지 못했습니다')
  return stable.version
}

async function installFabric(a: InstallLoaderArgs): Promise<LaunchPlan> {
  const loaderVersion = a.loaderVersion ?? (await latestFabricLoader(a.mcVersion))
  const installerVersion = await latestFabricInstaller()

  a.progress?.detail(`Fabric ${loaderVersion} 설치 중`, null)

  // Fabric은 실행 시 필요한 라이브러리를 스스로 받는 런처 jar를 제공한다
  const url =
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(a.mcVersion)}` +
    `/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`

  const dest = join(a.dir, 'fabric-server-launch.jar')

  if (a.providedFile) {
    await useProvidedFile(a, dest)
  } else {
    await downloadFile(url, dest, {
      onProgress: (received, total) =>
        a.progress?.detail('Fabric 서버 파일 내려받는 중', total ? received / total : null)
    })
  }

  return { args: ['-jar', 'fabric-server-launch.jar', 'nogui'], memoryViaArgsFile: false }
}

/* ---------- Quilt ---------- */

async function installQuilt(a: InstallLoaderArgs): Promise<LaunchPlan> {
  const loaderVersion =
    a.loaderVersion ??
    (
      await fetchJson<{ loader: { version: string } }[]>(
        `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(a.mcVersion)}`
      )
    )[0]?.loader.version

  if (!loaderVersion) throw new Error(`Quilt가 마인크래프트 ${a.mcVersion}을 지원하지 않습니다`)

  a.progress?.detail(`Quilt ${loaderVersion} 설치 중`, null)

  const installerVersions = await fetchJson<string[]>(
    'https://meta.quiltmc.org/v3/versions/installer'
  ).catch(() => [] as string[])
  const installerVersion =
    (installerVersions as unknown as { version?: string }[])[0]?.version ??
    (installerVersions[0] as unknown as string)

  if (!installerVersion) throw new Error('Quilt 설치 도구 정보를 찾지 못했습니다')

  const installerUrl =
    `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/` +
    `${installerVersion}/quilt-installer-${installerVersion}.jar`

  const installer = await downloadCached(installerUrl, `quilt-installer-${installerVersion}.jar`)

  const result = await run(
    a.javaExe,
    [
      '-jar',
      installer,
      'install',
      'server',
      a.mcVersion,
      loaderVersion,
      `--install-dir=${a.dir}`,
      '--download-server'
    ],
    {
      cwd: a.dir,
      timeoutMs: 15 * 60_000,
      onLine: (line) => a.progress?.detail(line.slice(0, 120), null)
    }
  )

  if (result.code !== 0) {
    throw new Error(
      result.timedOut
        ? 'Quilt 설치가 너무 오래 걸려 중단했습니다.'
        : `Quilt 설치에 실패했습니다 (종료 코드 ${result.code})`
    )
  }

  return { args: ['-jar', 'quilt-server-launch.jar', 'nogui'], memoryViaArgsFile: false }
}

/* ---------- Forge / NeoForge ---------- */

interface ForgePromos {
  promos: Record<string, string>
}

export async function latestForge(mcVersion: string): Promise<string> {
  const data = await fetchJson<ForgePromos>(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
  )
  const rec = data.promos[`${mcVersion}-recommended`] ?? data.promos[`${mcVersion}-latest`]
  if (!rec) throw new Error(`Forge가 마인크래프트 ${mcVersion}을 지원하지 않습니다`)
  return rec
}

export async function latestNeoForge(mcVersion: string): Promise<string> {
  const data = await fetchJson<{ versions: string[] }>(
    'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
  )
  // NeoForge 버전 21.1.x 는 마인크래프트 1.21.1 에 대응한다
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion)
  if (!m) throw new Error(`NeoForge 버전 규칙에 맞지 않는 마인크래프트 버전입니다: ${mcVersion}`)
  const prefix = `${m[1]}.${m[2] ?? '0'}.`

  const matching = data.versions.filter((v) => v.startsWith(prefix) && !v.includes('beta'))
  const chosen = matching[matching.length - 1] ?? null
  if (!chosen) throw new Error(`NeoForge가 마인크래프트 ${mcVersion}을 지원하지 않습니다`)
  return chosen
}

/**
 * 1.17 이상 Forge/NeoForge는 인스톨러가 run.bat과 인자 파일을 만든다.
 * 실행 커맨드가 버전마다 달라서, 생성된 run.bat에서 인자 파일 경로를 뽑아 쓰는 게 가장 안전하다.
 */
async function launchPlanFromRunBat(dir: string): Promise<LaunchPlan | null> {
  const runBat = join(dir, 'run.bat')
  try {
    await access(runBat, constants.R_OK)
  } catch {
    return null
  }

  const content = await readFile(runBat, 'utf8')
  const tokens = [...content.matchAll(/@[^\s"']+/g)].map((m) => m[0])
  const argFiles = tokens.filter((t) => t.toLowerCase() !== '@echo')
  if (argFiles.length === 0) return null

  return { args: [...argFiles, 'nogui'], memoryViaArgsFile: true }
}

/** 1.16 이하 Forge는 실행 가능한 jar가 폴더에 그대로 놓인다 */
async function findForgeJar(dir: string): Promise<string | null> {
  const files = await readdir(dir)
  const candidates = files.filter(
    (f) =>
      f.toLowerCase().endsWith('.jar') &&
      (f.toLowerCase().startsWith('forge-') || f.toLowerCase().startsWith('neoforge-')) &&
      !f.toLowerCase().includes('installer')
  )
  return candidates[0] ?? null
}

async function installForgeLike(a: InstallLoaderArgs, kind: 'forge' | 'neoforge'): Promise<LaunchPlan> {
  let version = a.loaderVersion
  let installerUrl: string

  if (kind === 'forge') {
    version ??= await latestForge(a.mcVersion)
    const full = `${a.mcVersion}-${version}`
    installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
  } else {
    version ??= await latestNeoForge(a.mcVersion)
    // 1.20.1용 NeoForge만 예전 좌표(net/neoforged/forge)를 쓴다
    if (version.startsWith('1.20.1-')) {
      installerUrl = `https://maven.neoforged.net/releases/net/neoforged/forge/${version}/forge-${version}-installer.jar`
    } else {
      installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
    }
  }

  a.progress?.detail(`${kind === 'forge' ? 'Forge' : 'NeoForge'} ${version} 준비 중`, null)

  // 사용자가 인스톨러를 직접 받아 넣었으면 그걸 그대로 실행한다
  const installer = a.providedFile
    ? a.providedFile
    : await downloadCached(installerUrl, `${kind}-${version}-installer.jar`, {
        onProgress: (received, total) =>
          a.progress?.detail('설치 파일 내려받는 중', total ? received / total : null)
      })

  a.progress?.detail(`${kind === 'forge' ? 'Forge' : 'NeoForge'} 설치 중 (몇 분 걸릴 수 있습니다)`, null)

  const result = await run(a.javaExe, ['-jar', installer, '--installServer', a.dir], {
    cwd: a.dir,
    // 설치가 멈춰도 화면이 영원히 돌지 않게 상한을 둔다
    timeoutMs: 15 * 60_000,
    onLine: (line) => {
      if (line.trim()) a.progress?.detail(line.slice(0, 120), null)
    }
  })

  if (result.code !== 0) {
    const label2 = kind === 'forge' ? 'Forge' : 'NeoForge'
    throw new Error(
      result.timedOut
        ? `${label2} 설치가 너무 오래 걸려 중단했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.`
        : `${label2} 설치에 실패했습니다 (종료 코드 ${result.code})`
    )
  }

  const fromRunBat = await launchPlanFromRunBat(a.dir)
  if (fromRunBat) return fromRunBat

  const jar = await findForgeJar(a.dir)
  if (jar) return { args: ['-jar', jar, 'nogui'], memoryViaArgsFile: false }

  throw new Error('설치는 끝났지만 서버 실행 파일을 찾지 못했습니다')
}

/* ---------- Paper ---------- */

interface PaperProject {
  versions: Record<string, string[]>
}

interface PaperBuild {
  id: number
  channel: string
  downloads: Record<
    string,
    { name: string; size: number; url: string; checksums: { sha256?: string } }
  >
}

const PAPER_API = 'https://fill.papermc.io/v3/projects'

/** Paper가 서버를 내주는 마인크래프트 버전 목록 (최신순) */
export async function listPaperVersions(): Promise<string[]> {
  const project = await fetchJson<PaperProject>(`${PAPER_API}/paper`)
  // { "1.21": ["1.21.11", ...] } 형태라 펼쳐서 정식 버전만 남긴다
  return Object.values(project.versions)
    .flat()
    .filter((v) => !/-(rc|pre)/i.test(v))
}

/**
 * 실제로 돌릴 서버라서 실험 빌드는 피한다.
 * PaperMC도 운영 환경에서는 안정 빌드만 쓰라고 안내한다.
 */
async function latestStablePaperBuild(mcVersion: string): Promise<PaperBuild> {
  const version = encodeURIComponent(mcVersion)

  const latest = await fetchJson<PaperBuild>(`${PAPER_API}/paper/versions/${version}/builds/latest`)
  if (latest.channel?.toUpperCase() === 'STABLE') return latest

  // 최신이 실험 빌드면 목록에서 가장 최근의 안정 빌드를 고른다
  const all = await fetchJson<PaperBuild[]>(`${PAPER_API}/paper/versions/${version}/builds`)
  const stable = [...all].reverse().find((b) => b.channel?.toUpperCase() === 'STABLE')
  return stable ?? latest
}

async function installPaper(a: InstallLoaderArgs): Promise<LaunchPlan> {
  a.progress?.detail(`Paper ${a.mcVersion} 정보를 확인하는 중`, null)

  const build = await latestStablePaperBuild(a.mcVersion).catch(() => {
    throw new Error(`Paper가 마인크래프트 ${a.mcVersion}을 지원하지 않습니다`)
  })

  const download = build.downloads['server:default']
  if (!download) throw new Error('Paper 서버 파일을 찾지 못했습니다')

  const dest = join(a.dir, 'server.jar')

  if (a.providedFile) {
    await useProvidedFile(a, dest, { sha256: download.checksums.sha256 })
  } else {
    await downloadFile(download.url, dest, {
      sha256: download.checksums.sha256,
      onProgress: (received, total) =>
        a.progress?.detail(`Paper 빌드 ${build.id} 내려받는 중`, total ? received / total : null)
    })
  }

  return { args: ['-jar', 'server.jar', 'nogui'], memoryViaArgsFile: false }
}

/* ---------- Spigot / CraftBukkit ---------- */

const BUILDTOOLS_URL =
  'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar'

/**
 * Spigot과 CraftBukkit은 라이선스 때문에 완성된 서버 파일을 배포하지 않는다.
 * 공식 BuildTools로 이 PC에서 직접 빌드해야 하고, 10~20분쯤 걸린다.
 */
async function installSpigotLike(
  a: InstallLoaderArgs,
  kind: 'spigot' | 'craftbukkit'
): Promise<LaunchPlan> {
  const label = kind === 'spigot' ? 'Spigot' : 'CraftBukkit'
  a.progress?.detail(`${label} 빌드 도구를 준비하는 중`, null)

  const buildDir = join(a.dir, '.buildtools')
  await mkdir(buildDir, { recursive: true })

  // BuildTools는 자주 갱신되므로 캐시하지 않고 매번 받는다
  const tool = join(buildDir, 'BuildTools.jar')
  if (a.providedFile) {
    await copyFile(a.providedFile, tool)
  } else {
    await downloadFile(BUILDTOOLS_URL, tool, {
      onProgress: (received, total) =>
        a.progress?.detail('빌드 도구 내려받는 중', total ? received / total : null)
    })
  }

  a.progress?.detail(
    `${label} ${a.mcVersion} 빌드 중 — 10~20분 걸립니다. 창을 닫지 마세요.`,
    null
  )

  const result = await run(
    a.javaExe,
    ['-jar', 'BuildTools.jar', '--rev', a.mcVersion, '--compile', kind],
    {
      cwd: buildDir,
      // 빌드는 오래 걸리지만 한 시간을 넘기면 뭔가 잘못된 것이다
      timeoutMs: 60 * 60_000,
      onLine: (line) => {
        const trimmed = line.trim()
        if (trimmed) a.progress?.detail(`${label} 빌드 중: ${trimmed.slice(0, 100)}`, null)
      }
    }
  )

  if (result.code !== 0) {
    throw new Error(
      `${label} 빌드에 실패했습니다 (종료 코드 ${result.code}).\n` +
        '인터넷 연결이 끊겼거나 이 버전을 빌드할 수 없는 경우입니다. Paper를 대신 쓰는 것을 권합니다.'
    )
  }

  // BuildTools는 spigot-1.20.4.jar 같은 이름으로 결과물을 남긴다
  const produced = (await readdir(buildDir)).find(
    (f) => f.toLowerCase().startsWith(kind) && f.toLowerCase().endsWith('.jar')
  )
  if (!produced) {
    throw new Error(`${label} 빌드는 끝났지만 결과 파일을 찾지 못했습니다`)
  }

  await copyFile(join(buildDir, produced), join(a.dir, 'server.jar'))
  // 빌드 찌꺼기는 수 GB라 지운다
  await rm(buildDir, { recursive: true, force: true })

  return { args: ['-jar', 'server.jar', 'nogui'], memoryViaArgsFile: false }
}

/* ---------- 직접 받아서 넣기 ---------- */

/**
 * 이 서버를 열려면 어떤 파일이 필요하고 어디서 받는지 알려준다.
 *
 * 서명 없는 앱이 파일을 내려받으면 백신이 내용을 손대는 경우가 있는데,
 * 브라우저로 받은 파일은 그런 일이 없다. 그 우회로를 위한 정보다.
 */
export async function serverFileInfo(
  loader: LoaderType,
  mcVersion: string
): Promise<ServerFileInfo> {
  const base = { size: null as number | null, sha256: null as string | null, supported: true }

  switch (loader) {
    case 'vanilla': {
      const manifest = await fetchJson<VersionManifest>(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
      )
      const entry = manifest.versions.find((v) => v.id === mcVersion)
      if (!entry) throw new Error(`마인크래프트 ${mcVersion} 정보를 찾지 못했습니다`)
      const meta = await fetchJson<VersionMeta>(entry.url)
      const server = meta.downloads?.server
      if (!server) throw new Error(`마인크래프트 ${mcVersion}은 서버 파일을 제공하지 않습니다`)

      return {
        ...base,
        label: `마인크래프트 ${mcVersion} 서버 파일`,
        filename: `server-${mcVersion}.jar`,
        url: server.url,
        hint: '모장 공식 파일입니다. 받은 jar를 그대로 넣어 주세요.'
      }
    }

    case 'paper': {
      const build = await latestStablePaperBuild(mcVersion)
      const dl = build.downloads['server:default']
      if (!dl) throw new Error('Paper 서버 파일을 찾지 못했습니다')

      return {
        ...base,
        label: `Paper ${mcVersion} (빌드 ${build.id})`,
        filename: dl.name,
        url: dl.url,
        size: dl.size,
        sha256: dl.checksums.sha256 ?? null,
        hint: '받은 jar를 그대로 넣어 주세요. 파일이 올바른지 앱이 확인합니다.'
      }
    }

    case 'fabric': {
      const loaderVersion = await latestFabricLoader(mcVersion)
      const installerVersion = await latestFabricInstaller()
      const url =
        `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}` +
        `/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`

      return {
        ...base,
        label: `Fabric ${loaderVersion} 서버 파일`,
        filename: 'fabric-server-launch.jar',
        url,
        hint: '받은 jar를 그대로 넣어 주세요.'
      }
    }

    case 'forge':
    case 'neoforge': {
      let version: string
      let url: string

      if (loader === 'forge') {
        version = await latestForge(mcVersion)
        const full = `${mcVersion}-${version}`
        url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
      } else {
        version = await latestNeoForge(mcVersion)
        url = version.startsWith('1.20.1-')
          ? `https://maven.neoforged.net/releases/net/neoforged/forge/${version}/forge-${version}-installer.jar`
          : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
      }

      return {
        ...base,
        label: `${loader === 'forge' ? 'Forge' : 'NeoForge'} ${version} 설치 파일`,
        filename: url.split('/').pop() ?? 'installer.jar',
        url,
        hint: '설치 프로그램입니다. 직접 실행하지 말고 받은 그대로 넣어 주세요. 설치는 앱이 합니다.'
      }
    }

    case 'spigot':
    case 'craftbukkit':
      return {
        ...base,
        label: 'BuildTools',
        filename: 'BuildTools.jar',
        url: BUILDTOOLS_URL,
        hint:
          '받은 BuildTools.jar를 넣으면 이 PC에서 서버를 빌드합니다. 10~20분 걸립니다.'
      }

    default:
      return {
        ...base,
        supported: false,
        label: '',
        filename: '',
        url: '',
        hint: '이 서버 종류는 파일을 직접 넣는 방식을 지원하지 않습니다.'
      }
  }
}

/* ---------- 진입점 ---------- */

export async function installLoader(a: InstallLoaderArgs): Promise<LaunchPlan> {
  switch (a.loader) {
    case 'vanilla':
      return installVanilla(a)
    case 'fabric':
      return installFabric(a)
    case 'quilt':
      return installQuilt(a)
    case 'forge':
      return installForgeLike(a, 'forge')
    case 'neoforge':
      return installForgeLike(a, 'neoforge')
    case 'paper':
      return installPaper(a)
    case 'spigot':
      return installSpigotLike(a, 'spigot')
    case 'craftbukkit':
      return installSpigotLike(a, 'craftbukkit')
    default:
      throw new Error(`지원하지 않는 서버 종류입니다: ${a.loader}`)
  }
}

/** Forge/NeoForge용 JVM 인자 파일을 우리 설정값으로 덮어쓴다 */
export async function writeUserJvmArgs(dir: string, memoryMb: number): Promise<void> {
  const lines = [
    `# ${APP_TITLE}가 관리하는 파일입니다. 직접 고치면 다음 실행 때 덮어써집니다.`,
    ...jvmArgsFor(memoryMb)
  ]
  await writeFile(join(dir, 'user_jvm_args.txt'), lines.join('\n'), 'utf8')
}

/**
 * 모드팩 서버에서 널리 쓰이는 G1GC 튜닝값.
 * 기본 GC 설정으로 두면 메모리를 많이 준 서버일수록 끊김이 심해진다.
 */
export function aikarFlags(): string[] {
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
    /*
     * 자바는 윈도우에서 콘솔 출력을 시스템 코드페이지로 내보낸다.
     * 그대로 두면 서버 로그의 한글이 전부 깨져서 읽을 수 없다.
     * 자바 버전에 따라 보는 이름이 달라 둘 다 지정한다.
     */
    '-Dfile.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8'
  ]
}

/** 메모리 크기에 따라 달라지는 G1 힙 영역 설정까지 포함한 최종 JVM 인자 */
export function jvmArgsFor(memoryMb: number): string[] {
  const large = memoryMb >= 12288
  return [
    `-Xms${Math.min(memoryMb, 2048)}M`,
    `-Xmx${memoryMb}M`,
    ...aikarFlags(),
    `-XX:G1NewSizePercent=${large ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${large ? '16M' : '8M'}`,
    `-XX:G1ReservePercent=${large ? 15 : 20}`
  ]
}
