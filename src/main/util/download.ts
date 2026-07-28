import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { paths } from '../paths'
import { curlAvailable, curlDownload } from './fetchFile'

import { USER_AGENT } from '@shared/meta'

const UA = USER_AGENT

export interface DownloadOptions {
  sha1?: string
  sha256?: string
  sha512?: string
  headers?: Record<string, string>
  onProgress?: (received: number, total: number | null) => void
  signal?: AbortSignal
  /** 기본 3회 */
  retries?: number
}

export class DownloadError extends Error {
  /** 저장된 뒤에 파일 내용이 바뀐 경우 (다시 받아도 같은 일이 반복된다) */
  tampered = false

  constructor(
    message: string,
    readonly url: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

/**
 * 모드팩이 지정한 파일을 받아도 되는 곳.
 *
 * .mrpack 안에는 파일마다 받을 주소가 적혀 있는데, 그 주소는 팩을 만든 사람이 정한다.
 * 해시도 같은 파일에 함께 적혀 있어서 "주소와 해시가 맞다"는 건 아무것도 보장하지 못한다.
 * 그래서 Modrinth가 정한 것과 같은 목록으로 받는 곳 자체를 제한한다.
 */
const PACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']

export function assertPackHost(url: string): void {
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      throw new Error(`모드팩이 https가 아닌 주소를 가리킵니다: ${url}`)
    }
    host = parsed.hostname.toLowerCase()
  } catch (err) {
    throw new Error(`모드팩에 적힌 주소를 읽지 못했습니다: ${(err as Error).message}`)
  }

  const ok = PACK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  if (!ok) {
    throw new Error(
      `모드팩이 허용되지 않은 곳에서 파일을 받으려고 합니다: ${host}\n` +
        '정상적인 모드팩은 Modrinth나 GitHub에서만 파일을 받습니다. 이 팩은 설치하지 않는 것이 좋습니다.'
    )
  }
}

/** 응답이 시작되기까지 기다리는 한도 */
const CONNECT_TIMEOUT_MS = 30_000
/** 받는 도중 아무것도 오지 않을 때 포기하는 한도 */
const STALL_TIMEOUT_MS = 90_000

/**
 * 바깥에서 준 중단 신호와 시간 제한을 하나로 묶는다.
 * 시간 제한이 없으면 서버가 연결만 열어두고 응답을 멈출 때 화면이 영영 멈춘다.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): {
  signal: AbortSignal
  cancel: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('시간 초과')), ms)

  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function once(url: string, dest: string, opts: DownloadOptions): Promise<void> {
  const connect = withTimeout(opts.signal, CONNECT_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, ...(opts.headers ?? {}) },
      signal: connect.signal,
      redirect: 'follow'
    })
  } catch (err) {
    connect.cancel()
    if (connect.signal.aborted && !opts.signal?.aborted) {
      throw new DownloadError('서버가 응답하지 않습니다 (연결 시간 초과)', url)
    }
    throw err
  }
  connect.cancel()

  if (!res.ok || !res.body) {
    throw new DownloadError(`다운로드 실패 (HTTP ${res.status})`, url, res.status)
  }

  const lenHeader = res.headers.get('content-length')
  const total = lenHeader ? Number(lenHeader) : null
  let received = 0

  const sha1 = opts.sha1 ? createHash('sha1') : null
  const sha256 = opts.sha256 ? createHash('sha256') : null
  const sha512 = opts.sha512 ? createHash('sha512') : null

  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])

  /*
   * 연결은 살아 있는데 데이터만 오지 않는 경우가 있다.
   * 마지막으로 받은 시각을 보고 너무 오래 조용하면 끊는다.
   */
  let lastChunkAt = Date.now()
  const stallTimer = setInterval(() => {
    if (Date.now() - lastChunkAt > STALL_TIMEOUT_MS) {
      source.destroy(new DownloadError('내려받는 중 응답이 끊겼습니다', url))
    }
  }, 5000)

  source.on('data', (chunk: Buffer) => {
    lastChunkAt = Date.now()
    received += chunk.length
    sha1?.update(chunk)
    sha256?.update(chunk)
    sha512?.update(chunk)
    opts.onProgress?.(received, total)
  })

  try {
    await pipeline(source, createWriteStream(tmp), { signal: opts.signal })
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  } finally {
    clearInterval(stallTimer)
  }

  /**
   * 연결이 중간에 끊겨도 스트림이 정상 종료된 것처럼 끝나는 경우가 있다.
   * 그대로 두면 잘린 파일이 캐시에 남아 압축을 풀 때가 되어서야 터지므로,
   * 서버가 알려준 크기와 실제로 받은 크기를 여기서 대조한다.
   */
  if (total !== null && received !== total) {
    await rm(tmp, { force: true })
    throw new DownloadError(
      `파일을 끝까지 받지 못했습니다 (${received} / ${total} 바이트)`,
      url
    )
  }

  if (sha1 && opts.sha1 && sha1.digest('hex') !== opts.sha1.toLowerCase()) {
    await rm(tmp, { force: true })
    throw new DownloadError('파일 무결성 검사 실패 (sha1 불일치)', url)
  }
  if (sha256 && opts.sha256 && sha256.digest('hex') !== opts.sha256.toLowerCase()) {
    await rm(tmp, { force: true })
    throw new DownloadError('파일 무결성 검사 실패 (sha256 불일치)', url)
  }
  if (sha512 && opts.sha512 && sha512.digest('hex') !== opts.sha512.toLowerCase()) {
    await rm(tmp, { force: true })
    throw new DownloadError('파일 무결성 검사 실패 (sha512 불일치)', url)
  }

  await rm(dest, { force: true })
  await rename(tmp, dest)

  /*
   * 여기까지의 검사는 "네트워크로 받은 바이트"에 대한 것이다.
   * 디스크에 자리잡은 뒤에 내용이 바뀌는 경우가 실제로 있어서(백신이 실행 파일이나
   * jar를 검사하며 손대는 경우), 최종 파일을 다시 읽어 한 번 더 확인한다.
   * 이걸 안 하면 한참 뒤 서버를 실행할 때가 되어서야 정체 모를 오류로 터진다.
   */
  if (!(await cacheContentOk(dest, opts))) {
    await rm(dest, { force: true })
    const err = new DownloadError(
      '내려받은 파일이 저장 직후에 내용이 바뀌었습니다.\n' +
        '백신이 이 앱이 쓰는 파일을 검사하며 손대는 경우입니다. ' +
        '설정 탭의 백신 예외 안내를 따라 폴더를 예외로 등록한 뒤 다시 시도해 주세요.',
      url
    )
    err.tampered = true
    throw err
  }
}

export async function downloadFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {}
): Promise<void> {
  try {
    await downloadWithFetch(url, dest, opts)
  } catch (err) {
    /*
     * 저장한 파일이 곧바로 바뀌는 환경(백신이 이 앱이 쓴 파일을 검사하는 경우)에서는
     * 몇 번을 다시 받아도 같은 일이 반복된다. 이럴 때는 윈도우에 딸려오는 curl에
     * 쓰는 일을 넘긴다. 서명된 시스템 프로그램이 쓰면 손대지 않는 경우가 많다.
     */
    if (err instanceof DownloadError && err.tampered && curlAvailable()) {
      await curlDownload(url, dest, { onProgress: opts.onProgress, signal: opts.signal })

      if (!(await cacheContentOk(dest, opts))) {
        await rm(dest, { force: true })
        const failed = new DownloadError(
          '내려받은 파일이 저장 직후에 내용이 바뀝니다.\n' +
            '백신이 이 앱이 쓰는 파일을 검사하며 손대고 있습니다. ' +
            '설정 탭의 백신 예외 안내를 따라 폴더를 예외로 등록해 주세요.',
          url
        )
        failed.tampered = true
        throw failed
      }
      return
    }
    throw err
  }
}

async function downloadWithFetch(
  url: string,
  dest: string,
  opts: DownloadOptions = {}
): Promise<void> {
  const retries = opts.retries ?? 3
  let lastErr: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await once(url, dest, opts)
      return
    } catch (err) {
      lastErr = err
      if (opts.signal?.aborted) throw err
      // 4xx는 재시도해도 소용없다 (404, 401 등)
      if (err instanceof DownloadError && err.status && err.status >= 400 && err.status < 500) {
        throw err
      }
      // 저장된 파일이 바뀌는 상황은 다시 받아도 똑같으므로 시간만 버린다
      if (err instanceof DownloadError && err.tampered) {
        throw err
      }
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      }
    }
  }
  throw lastErr
}

export async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<T> {
  // 목록·버전 조회는 금방 끝나야 한다. 응답이 없으면 화면이 멈추므로 짧게 끊는다
  const guard = withTimeout(signal, 20_000)

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      signal: guard.signal
    })
    if (!res.ok) {
      throw new DownloadError(`요청 실패 (HTTP ${res.status})`, url, res.status)
    }
    return (await res.json()) as T
  } catch (err) {
    if (guard.signal.aborted && !signal?.aborted) {
      throw new DownloadError('서버가 응답하지 않습니다 (시간 초과)', url)
    }
    throw err
  } finally {
    guard.cancel()
  }
}

/**
 * 캐시 폴더에 받아두고 경로를 돌려준다.
 * 같은 키로 이미 받아둔 파일이 있으면 재사용한다 (인스톨러/서버 jar 재다운로드 방지).
 *
 * expectedSize를 넘기면 캐시 파일이 그 크기와 다를 때 버리고 다시 받는다.
 * 크기를 모르는 경우에는 재사용하되, 쓰는 쪽에서 파일이 깨졌다고 판단하면
 * discardCached로 버리고 다시 요청할 수 있다.
 */
/**
 * 캐시 파일 이름으로 쓸 수 있게 다듬는다.
 * 버전 문자열 같은 값이 그대로 들어오므로, 경로 구분자가 섞이면 캐시 폴더 밖을 가리킬 수 있다.
 */
function safeCacheKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '_')
  return cleaned.slice(0, 180) || 'cache'
}

export async function downloadCached(
  url: string,
  cacheKey: string,
  opts: DownloadOptions & { expectedSize?: number } = {}
): Promise<string> {
  const dest = join(paths.cache, safeCacheKey(cacheKey))
  try {
    const st = await stat(dest)
    const sizeOk = opts.expectedSize ? st.size === opts.expectedSize : st.size > 0
    if (sizeOk && (await cacheContentOk(dest, opts))) return dest
    await rm(dest, { force: true })
  } catch {
    // 없으면 받는다
  }
  await downloadFile(url, dest, opts)
  return dest
}

/**
 * 받아둔 파일이 그 사이에 변하지 않았는지 확인한다.
 * 백신이 압축 파일 안의 실행 파일(jvm.dll 등)을 손대면 크기는 그대로인데 내용만 바뀌어서,
 * 크기 비교만으로는 걸러지지 않고 압축을 풀 때가 되어서야 터진다.
 */
async function cacheContentOk(path: string, opts: DownloadOptions): Promise<boolean> {
  const algo = opts.sha256 ? 'sha256' : opts.sha1 ? 'sha1' : opts.sha512 ? 'sha512' : null
  if (!algo) return true

  const expected = (opts.sha256 ?? opts.sha1 ?? opts.sha512 ?? '').toLowerCase()
  try {
    const hash = createHash(algo)
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex') === expected
  } catch {
    return false
  }
}

/** 캐시에 받아둔 파일이 깨진 것으로 확인됐을 때 버린다 */
export async function discardCached(path: string): Promise<void> {
  await rm(path, { force: true })
}
