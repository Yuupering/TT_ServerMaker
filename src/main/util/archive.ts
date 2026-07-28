import { createWriteStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import yazl from 'yazl'

type ZipFile = yauzl.ZipFile
type Entry = yauzl.Entry

/** 압축 파일이 깨졌을 때. 호출한 쪽이 받아둔 파일을 버리고 다시 받을지 판단한다 */
export class CorruptArchiveError extends Error {
  constructor(
    readonly file: string,
    readonly cause: unknown
  ) {
    super(
      `압축 파일이 손상됐거나 올바른 zip이 아닙니다 (${(cause as Error)?.message ?? '알 수 없는 오류'})`
    )
    this.name = 'CorruptArchiveError'
  }
}

/** zip을 다루다 난 오류는 원인을 알아볼 수 있는 형태로 바꿔서 올린다 */
async function guard<T>(file: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof CorruptArchiveError) throw err
    throw new CorruptArchiveError(file, err)
  }
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((res, rej) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) rej(err ?? new Error('zip 열기 실패'))
      else res(zip)
    })
  })
}

function openReadStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((res, rej) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) rej(err ?? new Error('zip 엔트리 읽기 실패'))
      else res(stream)
    })
  })
}

/**
 * zip 내부 경로가 대상 폴더 밖으로 빠져나가지 않는지 확인한다.
 * 모드팩 zip은 외부에서 받은 신뢰할 수 없는 입력이므로 반드시 거른다.
 */
function safeJoin(destDir: string, entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, '/')
  if (normalized.split('/').some((seg) => seg === '..')) return null
  const target = resolve(destDir, normalized)
  const rel = relative(resolve(destDir), target)
  if (rel.startsWith('..') || (rel !== '' && resolve(destDir, rel) !== target)) return null
  return target
}

export interface ExtractOptions {
  /** zip 안의 이 접두 경로에 해당하는 것만 꺼낸다 (예: 'overrides/') */
  subdir?: string
  /** subdir 접두를 떼고 푼다 */
  strip?: boolean
  /** true를 반환한 엔트리만 푼다. 경로는 strip 적용 후 값 */
  filter?: (entryPath: string) => boolean
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

async function extractZipInner(
  zipPath: string,
  destDir: string,
  opts: ExtractOptions = {}
): Promise<number> {
  const zip = await openZip(zipPath)
  const total = zip.entryCount
  let done = 0
  let written = 0

  const prefix = opts.subdir ? opts.subdir.replace(/\\/g, '/').replace(/\/?$/, '/') : null

  try {
    await new Promise<void>((res, rej) => {
      zip.on('error', rej)
      zip.on('end', res)

      zip.on('entry', (entry: Entry) => {
        void (async () => {
          try {
            if (opts.signal?.aborted) {
              rej(new Error('작업이 취소되었습니다'))
              return
            }

            done++
            opts.onProgress?.(done, total)

            let name = entry.fileName.replace(/\\/g, '/')

            if (prefix) {
              if (!name.startsWith(prefix)) {
                zip.readEntry()
                return
              }
              if (opts.strip) name = name.slice(prefix.length)
            }

            if (name === '' || name.endsWith('/')) {
              if (name !== '') {
                const dir = safeJoin(destDir, name)
                if (dir) await mkdir(dir, { recursive: true })
              }
              zip.readEntry()
              return
            }

            if (opts.filter && !opts.filter(name)) {
              zip.readEntry()
              return
            }

            const target = safeJoin(destDir, name)
            if (!target) {
              // 경로 탈출 시도는 조용히 건너뛴다
              zip.readEntry()
              return
            }

            await mkdir(dirname(target), { recursive: true })
            const stream = await openReadStream(zip, entry)
            await pipeline(stream, createWriteStream(target))
            written++
            zip.readEntry()
          } catch (err) {
            rej(err)
          }
        })()
      })

      zip.readEntry()
    })
  } finally {
    zip.close()
  }

  return written
}

async function readZipTextInner(zipPath: string, entryName: string): Promise<string | null> {
  const zip = await openZip(zipPath)
  const wanted = entryName.replace(/\\/g, '/').toLowerCase()

  try {
    return await new Promise<string | null>((res, rej) => {
      zip.on('error', rej)
      zip.on('end', () => res(null))

      zip.on('entry', (entry: Entry) => {
        void (async () => {
          try {
            if (entry.fileName.replace(/\\/g, '/').toLowerCase() !== wanted) {
              zip.readEntry()
              return
            }
            const stream = await openReadStream(zip, entry)
            const chunks: Buffer[] = []
            for await (const c of stream) chunks.push(c as Buffer)
            res(Buffer.concat(chunks).toString('utf8'))
          } catch (err) {
            rej(err)
          }
        })()
      })

      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

async function listZipTopInner(zipPath: string, limit = 400): Promise<string[]> {
  const zip = await openZip(zipPath)
  const out = new Set<string>()

  try {
    await new Promise<void>((res, rej) => {
      zip.on('error', rej)
      zip.on('end', res)
      zip.on('entry', (entry: Entry) => {
        const name = entry.fileName.replace(/\\/g, '/')
        out.add(name.includes('/') ? `${name.split('/')[0]}/` : name)
        if (out.size >= limit) {
          res()
          return
        }
        zip.readEntry()
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }

  return [...out]
}

/** zip을 destDir에 스트리밍으로 푼다 (메모리에 통째로 올리지 않는다) */
export async function extractZip(
  zipPath: string,
  destDir: string,
  opts: ExtractOptions = {}
): Promise<number> {
  return guard(zipPath, () => extractZipInner(zipPath, destDir, opts))
}

/** zip 안의 텍스트 파일 하나를 읽는다. 없으면 null */
export async function readZipText(zipPath: string, entryName: string): Promise<string | null> {
  return guard(zipPath, () => readZipTextInner(zipPath, entryName))
}

/** zip 안의 최상위 항목 목록 (팩 종류 판별용) */
export async function listZipTop(zipPath: string, limit = 400): Promise<string[]> {
  return guard(zipPath, () => listZipTopInner(zipPath, limit))
}

export interface ZipDirOptions {
  /** 제외할 상대 경로 판별 */
  exclude?: (relPath: string) => boolean
  onProgress?: (added: number) => void
}

/** 폴더를 zip으로 묶는다 (백업용) */
export async function zipDirectory(
  srcDir: string,
  destZip: string,
  opts: ZipDirOptions = {}
): Promise<void> {
  const zipfile = new yazl.ZipFile()
  let added = 0

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(dir, e.name)
      const rel = relative(srcDir, full).split(sep).join('/')
      if (opts.exclude?.(rel)) continue
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        zipfile.addFile(full, rel)
        added++
        opts.onProgress?.(added)
      }
    }
  }

  await walk(srcDir)
  await mkdir(dirname(destZip), { recursive: true })

  await new Promise<void>((res, rej) => {
    const out = createWriteStream(destZip)
    out.on('close', res)
    out.on('error', rej)
    zipfile.outputStream.on('error', rej)
    zipfile.outputStream.pipe(out)
    zipfile.end()
  })
}

/** 폴더 용량 합계 (백업 크기 표시용) */
export async function dirSize(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(full)
    else if (e.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size
  }
  return total
}
