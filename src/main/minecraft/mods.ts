import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { LoaderType } from '@shared/types'
import { assertPackHost, downloadFile, fetchJson } from '../util/download'
import { extractZip, readZipText } from '../util/archive'

/** 받는 진행 상황을 알리는 콜백 */
export type ProgressFn = (done: number, total: number, label: string) => void

/**
 * 모드팩을 클라이언트 기준으로 설치한다.
 *
 * 같은 모드팩이라도 서버용과 클라이언트용에 들어가는 모드가 다르다.
 * 팩 안에 모드마다 "클라이언트에 필요/불필요" 표시가 있어서 그걸 보고 고른다.
 */

const MODRINTH_API = 'https://api.modrinth.com/v2'

interface MrpackIndex {
  name?: string
  dependencies: Record<string, string>
  files: {
    path: string
    hashes: { sha1?: string; sha512?: string }
    env?: { client?: string; server?: string }
    downloads: string[]
    fileSize?: number
  }[]
}

interface ModrinthVersion {
  id: string
  name: string
  files: {
    url: string
    filename: string
    primary: boolean
    hashes: { sha1?: string; sha512?: string }
  }[]
}

export interface PackResult {
  mcVersion: string
  loader: LoaderType
  loaderVersion: string | null
  name?: string
  /** 이 팩이 요구하는 파일들. 표시를 남기는 데 쓴다 */
  files?: MrpackIndex['files']
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

/**
 * 이 폴더에 어떤 팩을 깔아뒀는지 적어두는 표시.
 *
 * 이게 없으면 "준비하기"를 누를 때마다 모드를 전부 지우고 처음부터 다시 받는다.
 * 팩이 그대로인데 수백 MB를 다시 받는 건 기다릴 이유가 없는 시간이다.
 */
const MARKER = '.tt-pack.json'

interface PackMarker {
  projectId: string
  versionId: string
  mcVersion: string
  loader: LoaderType
  loaderVersion: string | null
  name?: string
  /** 팩이 요구하는 파일들. 그대로 남아 있는지 확인하는 데 쓴다 */
  files: { path: string; size?: number }[]
}

async function readMarker(gameDir: string): Promise<PackMarker | null> {
  try {
    return JSON.parse(await readFile(join(gameDir, MARKER), 'utf8')) as PackMarker
  } catch {
    return null
  }
}

/**
 * 표시해둔 팩이 지금도 그대로인지 확인한다.
 * 크기만 본다. 해시까지 다 돌리면 수백 MB를 매번 읽어야 해서 빨리 끝나는 의미가 없다.
 */
async function markerStillValid(gameDir: string, marker: PackMarker): Promise<boolean> {
  for (const f of marker.files) {
    const st = await stat(join(gameDir, f.path)).catch(() => null)
    if (!st) return false
    if (f.size !== undefined && st.size !== f.size) return false
  }
  return true
}

/** 파일이 이미 팩이 원하는 그것인지 (다시 받지 않아도 되는지) */
async function alreadyCorrect(
  path: string,
  hashes: { sha1?: string; sha512?: string },
  size?: number
): Promise<boolean> {
  const st = await stat(path).catch(() => null)
  if (!st) return false
  if (size !== undefined && st.size !== size) return false

  const algo = hashes.sha512 ? 'sha512' : hashes.sha1 ? 'sha1' : null
  if (!algo) return size !== undefined

  const expected = (hashes.sha512 ?? hashes.sha1 ?? '').toLowerCase()
  try {
    const hash = createHash(algo)
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex') === expected
  } catch {
    return false
  }
}

/**
 * 새 팩에 없는 모드만 지운다.
 *
 * 예전에는 통째로 비우고 시작했는데, 그러면 팩이 그대로여도 전부 다시 받아야 했다.
 * 서버를 바꿔 끼웠을 때 예전 모드가 남아 충돌하는 것만 막으면 된다.
 */
async function pruneMods(gameDir: string, keep: Set<string>): Promise<void> {
  const modsDir = join(gameDir, 'mods')
  const files = await readdir(modsDir).catch(() => [] as string[])
  await Promise.all(
    files
      .filter((f) => f.toLowerCase().endsWith('.jar'))
      .filter((f) => !keep.has(`mods/${f}`))
      .map((f) => rm(join(modsDir, f), { force: true }).catch(() => undefined))
  )
}

export async function installModpackFromModrinth(
  projectId: string,
  versionId: string,
  gameDir: string,
  onProgress?: ProgressFn
): Promise<PackResult> {
  /*
   * 같은 팩을 이미 깔아둔 폴더면 아무것도 하지 않는다.
   * 준비하기를 다시 누르는 이유는 대개 런처를 띄우려는 것이지 팩을 새로 받으려는 게 아니다.
   */
  const marker = await readMarker(gameDir)
  if (marker && marker.projectId === projectId && marker.versionId === versionId) {
    onProgress?.(0, 1, '이미 맞춰둔 모드팩을 확인하는 중')
    if (await markerStillValid(gameDir, marker)) {
      onProgress?.(1, 1, '모드팩은 이미 맞춰져 있습니다')
      return {
        mcVersion: marker.mcVersion,
        loader: marker.loader,
        loaderVersion: marker.loaderVersion,
        name: marker.name
      }
    }
  }

  onProgress?.(0, 1, '모드팩 정보를 확인하는 중')

  const version = await fetchJson<ModrinthVersion>(
    `${MODRINTH_API}/version/${encodeURIComponent(versionId)}`
  )
  const file = version.files.find((f) => f.primary) ?? version.files[0]
  if (!file) throw new Error('모드팩 파일을 찾지 못했습니다')

  await mkdir(gameDir, { recursive: true })
  const packPath = join(gameDir, '.pack.mrpack')

  onProgress?.(0, 1, '모드팩 내려받는 중')
  await downloadFile(file.url, packPath, {
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512
  })

  const result = await installMrpack(packPath, gameDir, onProgress)
  await rm(packPath, { force: true })

  const name = result.name ?? version.name

  // 다음에 같은 팩으로 다시 누르면 이 표시를 보고 통째로 건너뛴다
  const record: PackMarker = {
    projectId,
    versionId,
    mcVersion: result.mcVersion,
    loader: result.loader,
    loaderVersion: result.loaderVersion,
    name,
    files: (result.files ?? []).map((f) => ({
      path: f.path.replace(/\\/g, '/'),
      size: f.fileSize
    }))
  }
  await writeFile(join(gameDir, MARKER), JSON.stringify(record, null, 2), 'utf8').catch(
    () => undefined
  )

  return { mcVersion: result.mcVersion, loader: result.loader, loaderVersion: result.loaderVersion, name }
}

export async function installMrpack(
  packPath: string,
  gameDir: string,
  onProgress?: ProgressFn
): Promise<PackResult> {
  const raw = await readZipText(packPath, 'modrinth.index.json')
  if (!raw) throw new Error('모드팩 파일이 올바르지 않습니다')

  const index = JSON.parse(raw) as MrpackIndex
  const mcVersion = index.dependencies['minecraft']
  if (!mcVersion) throw new Error('모드팩에 마인크래프트 버전 정보가 없습니다')

  const { loader, version: loaderVersion } = loaderFromDependencies(index.dependencies)

  // 서버 전용으로 표시된 모드는 클라이언트에 넣지 않는다
  const targets = index.files.filter((f) => (f.env?.client ?? 'required') !== 'unsupported')
  const wanted = new Set(targets.map((f) => f.path.replace(/\\/g, '/')))

  // 이 팩에 없는 예전 모드만 걷어낸다. 그대로 쓸 수 있는 건 남겨서 다시 받지 않는다
  await pruneMods(gameDir, wanted)

  let done = 0
  let reused = 0
  const total = targets.length
  onProgress?.(0, total, `모드 ${total}개 확인 중`)

  let cursor = 0
  const errors: string[] = []

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= targets.length) return
      const entry = targets[i]

      const rel = entry.path.replace(/\\/g, '/')
      if (rel.split('/').some((s) => s === '..') || rel.startsWith('/')) {
        errors.push(`잘못된 경로: ${entry.path}`)
        continue
      }

      const dest = join(gameDir, rel)
      await mkdir(join(dest, '..'), { recursive: true })

      // 이미 같은 파일이 있으면 건너뛴다. 팩을 갱신해도 대개 대부분은 그대로다
      if (await alreadyCorrect(dest, entry.hashes, entry.fileSize)) {
        reused++
        done++
        onProgress?.(done, total, `모드 확인 중 (${done}/${total})`)
        continue
      }

      const url = entry.downloads[0]
      if (!url) {
        errors.push(`받을 주소가 없는 파일: ${entry.path}`)
        continue
      }

      try {
        assertPackHost(url)
        await downloadFile(url, dest, {
          sha1: entry.hashes.sha1,
          sha512: entry.hashes.sha512
        })
      } catch (err) {
        errors.push(`${basename(rel)}: ${(err as Error).message}`)
      }

      done++
      onProgress?.(done, total, `모드 내려받는 중 (${done}/${total})`)
    }
  }

  await Promise.all(Array.from({ length: 6 }, worker))

  /*
   * 모드는 하나만 빠져도 서버와 구성이 달라 접속하는 순간 튕긴다.
   * 그때 나오는 오류는 원인을 알아볼 수 없으므로, 여기서 못 받은 걸 그대로 알린다.
   */
  if (errors.length > 0) {
    const shown = errors.slice(0, 3).join('\n')
    const more = errors.length > 3 ? `\n… 그 외 ${errors.length - 3}개` : ''
    throw new Error(
      `모드팩의 파일 ${errors.length}개를 받지 못했습니다.\n${shown}${more}\n` +
        '인터넷 연결을 확인하고 다시 시도해 주세요.'
    )
  }

  onProgress?.(
    total,
    total,
    reused === total ? '모드는 그대로 쓸 수 있습니다' : '모드팩 설정 적용 중'
  )

  // overrides가 클라이언트 설정, client-overrides가 클라이언트 전용 덮어쓰기다
  await extractZip(packPath, gameDir, { subdir: 'overrides', strip: true })
  await extractZip(packPath, gameDir, { subdir: 'client-overrides', strip: true })

  return { mcVersion, loader, loaderVersion, name: index.name, files: targets }
}
