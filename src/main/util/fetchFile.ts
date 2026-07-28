import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './proc'
import { USER_AGENT } from '@shared/meta'

/**
 * 파일 내려받기를 윈도우에 딸려오는 curl에 맡긴다.
 *
 * 서명 없는 프로그램이 받아서 저장한 파일은 백신이 검사하며 내용을 바꿔놓는 일이 있다.
 * 같은 파일을 브라우저나 시스템 도구로 받으면 멀쩡한데, 파일을 디스크에 쓰는 주체가
 * 마이크로소프트가 서명한 프로그램이기 때문이다. 그래서 쓰는 일만 넘긴다.
 */

const CURL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe')

let available: boolean | null = null

export function curlAvailable(): boolean {
  if (available === null) available = existsSync(CURL)
  return available
}

export interface CurlOptions {
  onProgress?: (received: number, total: number | null) => void
  signal?: AbortSignal
  headers?: Record<string, string>
}

/**
 * curl로 받는다. 실패하면 예외를 던지므로 호출한 쪽에서 기존 방식으로 넘어가면 된다.
 * 진행률은 받는 파일 크기를 주기적으로 재서 계산한다.
 */
export async function curlDownload(
  url: string,
  dest: string,
  opts: CurlOptions = {}
): Promise<void> {
  if (!curlAvailable()) throw new Error('curl을 찾지 못했습니다')

  const headerArgs = Object.entries(opts.headers ?? {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`])

  let total: number | null = null
  let timer: NodeJS.Timeout | null = null

  if (opts.onProgress) {
    timer = setInterval(() => {
      void stat(dest)
        .then((st) => opts.onProgress?.(st.size, total))
        .catch(() => undefined)
    }, 400)
  }

  try {
    const result = await run(
      CURL,
      [
        '--location', // 리다이렉트 따라가기
        '--fail', // 4xx·5xx면 실패로 처리
        '--silent',
        '--show-error',
        '--connect-timeout',
        '20',
        // 60초 동안 사실상 진행이 없으면 포기한다 (느린 회선은 살리되 멈춤은 끊는다)
        '--speed-limit',
        '512',
        '--speed-time',
        '60',
        '--retry',
        '2',
        '-A',
        USER_AGENT,
        ...headerArgs,
        '-o',
        dest,
        url
      ],
      { signal: opts.signal }
    )

    if (result.code !== 0) {
      throw new Error(result.output.trim() || `curl 종료 코드 ${result.code}`)
    }

    const st = await stat(dest)
    total = st.size
    opts.onProgress?.(st.size, st.size)
  } finally {
    if (timer) clearInterval(timer)
  }
}
