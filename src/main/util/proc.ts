import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface RunOptions {
  cwd?: string
  onLine?: (line: string, stream: 'out' | 'err') => void
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** 이 시간을 넘기면 강제로 끝낸다 (밀리초). 없으면 무제한 */
  timeoutMs?: number
  /** 실패 메시지에 담아둘 출력 최대 길이 */
  maxOutputChars?: number
}

export interface RunResult {
  code: number
  output: string
  /** 시간이 다 되어 강제로 끝냈는지 */
  timedOut: boolean
}

export interface LineReader {
  (chunk: Buffer): void
  /** 스트림이 끝났을 때 남은 내용을 흘려보낸다 */
  flush: () => void
}

/**
 * 줄 단위로 잘라 콜백에 넘기는 스트림 리더.
 *
 * 조각이 도착하는 위치는 글자 경계와 무관해서, 한글처럼 여러 바이트로 된 글자가
 * 조각 사이에서 잘릴 수 있다. 그냥 문자열로 바꾸면 그 자리가 깨지므로
 * 남은 바이트를 다음 조각까지 들고 있는 디코더를 쓴다.
 *
 * 마지막 줄에 개행이 없는 경우가 많아(특히 오류 메시지) flush로 마저 내보내야 한다.
 */
export function lineReader(onLine: (line: string) => void): LineReader {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const reader = ((chunk: Buffer) => {
    buffer += decoder.write(chunk)
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      onLine(line)
    }
    // 프롬프트처럼 개행 없이 끝나는 출력이 너무 길어지면 잘라서 흘린다
    if (buffer.length > 8192) {
      onLine(buffer)
      buffer = ''
    }
  }) as LineReader

  reader.flush = () => {
    buffer += decoder.end()
    if (buffer.length > 0) {
      onLine(buffer.replace(/\r$/, ''))
      buffer = ''
    }
  }

  return reader
}

/**
 * 프로세스가 정말 끝날 때까지 기다린다.
 * 종료 신호를 무시하는 프로그램이 있어 일정 시간 뒤 강제 종료로 올린다.
 */
export function killTree(child: ChildProcessWithoutNullStreams, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise((resolve) => {
    let done = false
    // kill이 곧바로 실패하면 타이머를 걸기 전에 finish가 불린다
    let timer: NodeJS.Timeout | null = null

    const finish = (): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve()
    }

    child.once('close', finish)

    try {
      child.kill()
    } catch {
      finish()
      return
    }

    timer = setTimeout(() => {
      try {
        // 윈도우에서는 자식까지 확실히 끊으려면 taskkill이 필요하다
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        // 이미 죽었으면 무시
      }
      setTimeout(finish, 2000)
    }, graceMs)
  })
}

/**
 * 지금 돌고 있는 보조 프로세스들.
 * 설치나 빌드 도중 앱을 닫으면 자바나 빌드 도구가 계속 남기 때문에 모아두고 정리한다.
 */
const liveChildren = new Set<ChildProcessWithoutNullStreams>()

export async function killAllChildren(): Promise<void> {
  const children = [...liveChildren]
  liveChildren.clear()
  await Promise.all(children.map((child) => killTree(child, 2000)))
}

/** 자식 프로세스를 끝까지 돌리고 종료 코드를 돌려준다 (인스톨러 실행용) */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const limit = opts.maxOutputChars ?? 64 * 1024

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true
    })
    liveChildren.add(child)

    let output = ''
    let truncated = false
    let timedOut = false

    const append = (line: string): void => {
      /*
       * 빌드 도구는 몇 만 줄을 뱉기도 한다. 실패 메시지에 쓰려고 전부 들고 있으면
       * 메모리가 계속 늘어나므로, 넘치면 앞쪽을 버리고 뒤쪽(대개 오류가 있는 곳)을 남긴다.
       */
      output += line + '\n'
      if (output.length > limit) {
        output = output.slice(output.length - limit)
        truncated = true
      }
    }

    const outReader = lineReader((line) => {
      append(line)
      opts.onLine?.(line, 'out')
    })
    const errReader = lineReader((line) => {
      append(line)
      opts.onLine?.(line, 'err')
    })

    child.stdout.on('data', outReader)
    child.stderr.on('data', errReader)
    child.stdout.on('end', () => outReader.flush())
    child.stderr.on('end', () => errReader.flush())

    let timer: NodeJS.Timeout | null = null
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        void killTree(child)
      }, opts.timeoutMs)
    }

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      liveChildren.delete(child)
      if (opts.signal) opts.signal.removeEventListener('abort', abort)
    }

    const abort = (): void => {
      void killTree(child)
    }

    child.on('error', (err) => {
      cleanup()
      reject(err)
    })

    child.on('close', (code) => {
      cleanup()
      outReader.flush()
      errReader.flush()
      resolve({
        code: code ?? -1,
        output: truncated ? `…(앞부분 생략)\n${output}` : output,
        timedOut
      })
    })

    if (opts.signal) {
      if (opts.signal.aborted) abort()
      else opts.signal.addEventListener('abort', abort, { once: true })
    }
  })
}

export type LiveProcess = ChildProcessWithoutNullStreams

/** 서버처럼 계속 살아있는 프로세스를 띄운다 */
export function spawnLive(
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): LiveProcess {
  return spawn(cmd, args, {
    cwd,
    env: env ?? process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}
