import { BrowserWindow } from 'electron'
import type {
  GuardStatus,
  LogLine,
  NetStatus,
  ProgressEvent,
  ServerStatus
} from '@shared/types'

let target: BrowserWindow | null = null

export function bindWindow(win: BrowserWindow): void {
  target = win
}

function send(channel: string, payload: unknown): void {
  if (target && !target.isDestroyed()) {
    target.webContents.send(channel, payload)
  }
}

export const emit = {
  progress(e: ProgressEvent): void {
    send('evt:progress', e)
  },
  log(line: LogLine): void {
    send('evt:log', line)
  },
  status(s: ServerStatus): void {
    send('evt:status', s)
  },
  net(s: NetStatus): void {
    send('evt:net', s)
  },
  guard(s: GuardStatus): void {
    send('evt:guard', s)
  },
  instancesChanged(): void {
    send('evt:instances', null)
  }
}

/**
 * 설치처럼 여러 단계를 거치는 작업의 진행률을 renderer에 흘려보낸다.
 * step()으로 전체 단계 중 현재 위치를 잡고, detail()로 그 안의 세부 진행을 갱신한다.
 */
export class ProgressReporter {
  private stepIndex = 0
  private lastSent = 0

  constructor(
    private readonly id: string,
    private readonly totalSteps: number
  ) {}

  step(phase: string, message: string): void {
    this.stepIndex++
    this.phase = phase
    emit.progress({
      id: this.id,
      phase,
      message,
      ratio: Math.min(1, (this.stepIndex - 1) / this.totalSteps),
      done: false
    })
  }

  private phase = ''

  /** 현재 단계 내부의 진행률 (0~1). 너무 잦은 전송은 스로틀한다 */
  detail(message: string, inner: number | null = null): void {
    const now = Date.now()
    if (now - this.lastSent < 100) return
    this.lastSent = now

    const base = (this.stepIndex - 1) / this.totalSteps
    const ratio = inner === null ? null : base + (Math.max(0, Math.min(1, inner)) / this.totalSteps)

    emit.progress({
      id: this.id,
      phase: this.phase,
      message,
      ratio,
      done: false
    })
  }

  done(message: string): void {
    emit.progress({ id: this.id, phase: 'done', message, ratio: 1, done: true })
  }

  fail(error: string): void {
    emit.progress({ id: this.id, phase: 'error', message: error, ratio: null, done: true, error })
  }
}
