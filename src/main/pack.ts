import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { LoaderType, PackSearchResult, PackVersion } from '@shared/types'
import { assertPackHost, downloadFile, fetchJson } from './util/download'
import { CorruptArchiveError, extractZip, listZipTop, readZipText } from './util/archive'
import type { ProgressReporter } from './events'

const MODRINTH_API = 'https://api.modrinth.com/v2'

export interface PackInfo {
  mcVersion: string
  loader: LoaderType
  loaderVersion: string | null
  /** 팩 이름 (있으면) */
  name?: string
  /**
   * CurseForge 클라이언트 팩처럼 모드 파일이 들어있지 않아 그대로는 못 쓰는 경우
   * 사용자에게 안내할 메시지
   */
  warning?: string
}

/* ---------- Modrinth ---------- */

interface ModrinthSearchResponse {
  hits: {
    project_id: string
    slug: string
    title: string
    description: string
    icon_url: string | null
    downloads: number
    categories: string[]
  }[]
  total_hits: number
}

export async function searchModrinth(query: string, offset = 0): Promise<PackSearchResult[]> {
  const url =
    `${MODRINTH_API}/search?query=${encodeURIComponent(query)}` +
    `&facets=${encodeURIComponent('[["project_type:modpack"]]')}` +
    `&limit=20&offset=${offset}&index=${query.trim() ? 'relevance' : 'downloads'}`

  const res = await fetchJson<ModrinthSearchResponse>(url)
  return res.hits.map((h) => ({
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    iconUrl: h.icon_url,
    downloads: h.downloads,
    categories: h.categories
  }))
}

interface ModrinthVersion {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  date_published: string
  version_type: string
  files: {
    url: string
    filename: string
    primary: boolean
    hashes: { sha1?: string; sha512?: string }
    size: number
  }[]
}

export async function modrinthVersions(projectId: string): Promise<PackVersion[]> {
  const list = await fetchJson<ModrinthVersion[]>(
    `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`
  )
  return list.map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    mcVersions: v.game_versions,
    loaders: v.loaders,
    datePublished: v.date_published,
    channel: v.version_type
  }))
}

/* ---------- .mrpack ---------- */

interface MrpackIndex {
  formatVersion: number
  name?: string
  versionId?: string
  dependencies: Record<string, string>
  files: {
    path: string
    hashes: { sha1?: string; sha512?: string }
    env?: { client?: string; server?: string }
    downloads: string[]
    fileSize?: number
  }[]
}

function loaderFromDependencies(deps: Record<string, string>): {
  loader: LoaderType
  version: string | null
} {
  if (deps['fabric-loader']) return { loader: 'fabric', version: deps['fabric-loader'] }
  if (deps['quilt-loader']) return { loader: 'quilt', version: deps['quilt-loader'] }
  if (deps['neoforge']) return { loader: 'neoforge', version: deps['neoforge'] }
  if (deps['forge']) return { loader: 'forge', version: deps['forge'] }
  return { loader: 'vanilla', version: null }
}

/** .mrpack 파일을 서버 폴더에 설치한다 */
export async function installMrpack(
  mrpackPath: string,
  dir: string,
  progress?: ProgressReporter
): Promise<PackInfo> {
  const indexRaw = await readZipText(mrpackPath, 'modrinth.index.json')
  if (!indexRaw) throw new Error('모드팩 파일이 올바르지 않습니다 (modrinth.index.json 없음)')

  const index = JSON.parse(indexRaw) as MrpackIndex
  const mcVersion = index.dependencies['minecraft']
  if (!mcVersion) throw new Error('모드팩에 마인크래프트 버전 정보가 없습니다')

  const { loader, version: loaderVersion } = loaderFromDependencies(index.dependencies)

  // 클라이언트 전용으로 표시된 파일은 서버에 넣지 않는다
  const targets = index.files.filter((f) => (f.env?.server ?? 'required') !== 'unsupported')

  progress?.detail(`모드 ${targets.length}개 내려받는 중`, 0)

  let done = 0
  const concurrency = 6
  let cursor = 0
  const errors: string[] = []

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= targets.length) return
      const file = targets[i]

      // 경로 탈출 방지
      const rel = file.path.replace(/\\/g, '/')
      if (rel.split('/').some((s) => s === '..') || rel.startsWith('/')) {
        errors.push(`잘못된 경로: ${file.path}`)
        continue
      }

      const dest = join(dir, rel)
      await mkdir(join(dest, '..'), { recursive: true })

      const url = file.downloads[0]
      if (!url) {
        errors.push(`받을 주소가 없는 파일: ${file.path}`)
        continue
      }

      try {
        assertPackHost(url)
        await downloadFile(url, dest, {
          sha1: file.hashes.sha1,
          sha512: file.hashes.sha512
        })
      } catch (err) {
        errors.push(`${basename(rel)}: ${(err as Error).message}`)
      }

      done++
      progress?.detail(`모드 내려받는 중 (${done}/${targets.length})`, done / targets.length)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  progress?.detail('모드팩 설정 파일 적용 중', null)

  // overrides -> server-overrides 순서로 덮어쓴다
  await extractZip(mrpackPath, dir, { subdir: 'overrides', strip: true })
  await extractZip(mrpackPath, dir, { subdir: 'server-overrides', strip: true })

  /*
   * 모드가 하나라도 빠지면 서버는 켜지더라도 접속 실패나 크래시로 이어진다.
   * "설치 완료"로 넘겨버리면 나중에 원인을 찾을 수 없으므로 여기서 멈춘다.
   */
  if (errors.length > 0) {
    const preview = errors.slice(0, 3).join('\n')
    throw new Error(
      `모드팩 파일 ${errors.length}개를 받지 못했습니다.\n${preview}` +
        (errors.length > 3 ? `\n… 외 ${errors.length - 3}개` : '') +
        '\n\n인터넷 연결을 확인하고 다시 시도해 주세요.'
    )
  }

  return {
    mcVersion,
    loader,
    loaderVersion,
    name: index.name
  }
}

/** Modrinth에서 팩을 받아 설치한다 */
export async function installFromModrinth(
  projectId: string,
  versionId: string,
  dir: string,
  progress?: ProgressReporter
): Promise<PackInfo> {
  progress?.detail('모드팩 정보를 확인하는 중', null)

  const version = await fetchJson<ModrinthVersion>(`${MODRINTH_API}/version/${encodeURIComponent(versionId)}`)
  const file = version.files.find((f) => f.primary) ?? version.files[0]
  if (!file) throw new Error('모드팩 파일을 찾지 못했습니다')

  const tmp = join(dir, '.pack.mrpack')
  await downloadFile(file.url, tmp, {
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512,
    onProgress: (received, total) =>
      progress?.detail('모드팩 내려받는 중', total ? received / total : null)
  })

  const info = await installMrpack(tmp, dir, progress)
  return { ...info, name: info.name ?? version.name }
}

/* ---------- CurseForge / 일반 zip / 폴더 ---------- */

interface CurseManifest {
  minecraft: {
    version: string
    modLoaders: { id: string; primary?: boolean }[]
  }
  name?: string
  files?: { projectID: number; fileID: number; required?: boolean }[]
}

function loaderFromCurseId(id: string): { loader: LoaderType; version: string | null } {
  const lower = id.toLowerCase()
  if (lower.startsWith('fabric')) return { loader: 'fabric', version: lower.split('-')[1] ?? null }
  if (lower.startsWith('quilt')) return { loader: 'quilt', version: lower.split('-')[1] ?? null }
  if (lower.startsWith('neoforge')) return { loader: 'neoforge', version: lower.split('-')[1] ?? null }
  if (lower.startsWith('forge')) return { loader: 'forge', version: lower.split('-')[1] ?? null }
  return { loader: 'vanilla', version: null }
}

/**
 * 이미 풀려 있는 서버 폴더에서 마인크래프트/로더 버전을 추정한다.
 * CurseForge 서버팩은 형식이 제각각이라 단서를 여러 군데서 찾는다.
 */
async function detectFromFolder(dir: string): Promise<PackInfo | null> {
  const files = await readdir(dir).catch(() => [] as string[])

  // forge-1.20.1-47.2.0.jar / neoforge 설치 폴더
  for (const f of files) {
    const m = /^(forge|neoforge)-(\d+\.\d+(?:\.\d+)?)-([\w.]+?)(?:-universal)?\.jar$/i.exec(f)
    if (m) {
      return {
        mcVersion: m[2],
        loader: m[1].toLowerCase() as LoaderType,
        loaderVersion: m[3]
      }
    }
  }

  // libraries/net/minecraftforge/forge/<mc>-<ver>/
  for (const [vendor, loader] of [
    ['minecraftforge', 'forge'],
    ['neoforged', 'neoforge']
  ] as const) {
    const base = join(dir, 'libraries', 'net', vendor, loader)
    const versions = await readdir(base).catch(() => [] as string[])
    if (versions.length > 0) {
      const v = versions[0]
      const m = /^(\d+\.\d+(?:\.\d+)?)-(.+)$/.exec(v)
      if (m) return { mcVersion: m[1], loader, loaderVersion: m[2] }
      // NeoForge 1.20.2+ 는 폴더명이 21.1.72 형태다
      const nm = /^(\d+)\.(\d+)\./.exec(v)
      if (nm) return { mcVersion: `1.${nm[1]}.${nm[2]}`, loader, loaderVersion: v }
    }
  }

  // Fabric: fabric-server-launcher.properties 안에 serverJar=server-1.20.1.jar
  const fabricProps = await readFile(join(dir, 'fabric-server-launcher.properties'), 'utf8').catch(
    () => null
  )
  if (fabricProps) {
    const m = /server-(\d+\.\d+(?:\.\d+)?)\.jar/.exec(fabricProps)
    if (m) return { mcVersion: m[1], loader: 'fabric', loaderVersion: null }
  }

  // run.bat / start.bat 안의 경로에서 추출
  for (const script of ['run.bat', 'start.bat', 'ServerStart.bat', 'run.sh']) {
    const content = await readFile(join(dir, script), 'utf8').catch(() => null)
    if (!content) continue
    const m = /(forge|neoforge)[/\\-](\d+\.\d+(?:\.\d+)?)-([\w.]+)/i.exec(content)
    if (m) {
      return {
        mcVersion: m[2],
        loader: m[1].toLowerCase() as LoaderType,
        loaderVersion: m[3]
      }
    }
  }

  return null
}

/** 파일/폴더를 서버 폴더로 가져온다 */
export async function importFromPath(
  srcPath: string,
  dir: string,
  progress?: ProgressReporter
): Promise<PackInfo> {
  try {
    return await importInner(srcPath, dir, progress)
  } catch (err) {
    if (err instanceof CorruptArchiveError) {
      throw new Error(
        `${err.message}\n파일을 받다가 중간에 끊겼을 수 있습니다. 다시 내려받아 시도해 주세요.`
      )
    }
    throw err
  }
}

async function importInner(
  srcPath: string,
  dir: string,
  progress?: ProgressReporter
): Promise<PackInfo> {
  const st = await stat(srcPath)

  if (st.isDirectory()) {
    /*
     * 목적지가 원본 안에 있으면 복사하는 동안 자기 자신을 계속 다시 복사한다.
     * 앱 데이터 폴더나 서버 목록 폴더를 고르면 실제로 일어나며 디스크가 순식간에 찬다.
     */
    const src = resolve(srcPath)
    const target = resolve(dir)
    const rel = relative(src, target)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new Error(
        '이 폴더는 가져올 수 없습니다.\n' +
          '서버가 저장되는 폴더나 그 상위 폴더는 고를 수 없습니다. 모드팩 폴더를 골라 주세요.'
      )
    }

    progress?.detail('폴더 복사 중', null)
    await cp(srcPath, dir, { recursive: true })
    const detected = await detectFromFolder(dir)
    if (!detected) {
      throw new Error(
        '폴더에서 마인크래프트 버전과 로더를 찾지 못했습니다. 버전을 직접 골라주세요.'
      )
    }
    return { ...detected, name: basename(srcPath) }
  }

  const lower = srcPath.toLowerCase()

  if (lower.endsWith('.mrpack')) {
    return installMrpack(srcPath, dir, progress)
  }

  if (!lower.endsWith('.zip')) {
    throw new Error('지원하지 않는 파일 형식입니다 (.mrpack 또는 .zip)')
  }

  // CurseForge 클라이언트 팩인지 먼저 확인한다
  const manifestRaw = await readZipText(srcPath, 'manifest.json')
  if (manifestRaw) {
    const manifest = JSON.parse(manifestRaw) as CurseManifest
    const primary =
      manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0]
    const { loader, version } = loaderFromCurseId(primary?.id ?? '')

    progress?.detail('설정 파일 적용 중', null)
    await extractZip(srcPath, dir, { subdir: 'overrides', strip: true })

    const modCount = manifest.files?.length ?? 0
    const modsDir = join(dir, 'mods')
    const modFiles = await readdir(modsDir).catch(() => [] as string[])

    return {
      mcVersion: manifest.minecraft.version,
      loader,
      loaderVersion: version,
      name: manifest.name,
      warning:
        modFiles.length === 0 && modCount > 0
          ? `이 파일은 CurseForge 클라이언트용 팩이라 모드 ${modCount}개가 들어있지 않습니다. ` +
            'CurseForge 페이지에서 "Server Pack"을 받아 다시 시도해 주세요.'
          : undefined
    }
  }

  // 서버팩 zip: 통째로 풀고 폴더에서 버전을 추정한다
  progress?.detail('압축 푸는 중', null)

  const top = await listZipTop(srcPath)
  const realTop = top.filter((t) => t !== '__MACOSX/')
  // zip 안에 폴더 하나만 있고 그 안에 내용물이 있는 형태면 한 겹 벗긴다
  const singleRoot =
    realTop.length === 1 && realTop[0].endsWith('/') ? realTop[0].replace(/\/$/, '') : null

  await extractZip(srcPath, dir, {
    subdir: singleRoot ?? undefined,
    strip: Boolean(singleRoot),
    onProgress: (done, total) => progress?.detail(`압축 푸는 중 (${done}/${total})`, done / total)
  })

  const detected = await detectFromFolder(dir)
  if (!detected) {
    throw new Error(
      '압축 파일에서 마인크래프트 버전과 로더를 찾지 못했습니다. 서버팩이 맞는지 확인해 주세요.'
    )
  }

  return { ...detected, name: basename(srcPath, '.zip') }
}

/** 설치 중 받아둔 임시 팩 파일을 지운다 */
export async function cleanupInstallLeftovers(dir: string): Promise<void> {
  await rm(join(dir, '.pack.mrpack'), { force: true })
}
