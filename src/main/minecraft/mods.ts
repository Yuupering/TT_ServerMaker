import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
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

/** 서버가 바뀌면 예전 모드가 남아 충돌하므로 비우고 시작한다 */
async function clearMods(gameDir: string): Promise<void> {
  const modsDir = join(gameDir, 'mods')
  const files = await readdir(modsDir).catch(() => [] as string[])
  await Promise.all(
    files
      .filter((f) => f.toLowerCase().endsWith('.jar'))
      .map((f) => rm(join(modsDir, f), { force: true }).catch(() => undefined))
  )
}

export async function installModpackFromModrinth(
  projectId: string,
  versionId: string,
  gameDir: string,
  onProgress?: ProgressFn
): Promise<PackResult> {
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

  return { ...result, name: result.name ?? version.name }
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

  await clearMods(gameDir)

  let done = 0
  const total = targets.length
  onProgress?.(0, total, `모드 ${total}개 내려받는 중`)

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

  onProgress?.(total, total, '모드팩 설정 적용 중')

  // overrides가 클라이언트 설정, client-overrides가 클라이언트 전용 덮어쓰기다
  await extractZip(packPath, gameDir, { subdir: 'overrides', strip: true })
  await extractZip(packPath, gameDir, { subdir: 'client-overrides', strip: true })

  return { mcVersion, loader, loaderVersion, name: index.name }
}
