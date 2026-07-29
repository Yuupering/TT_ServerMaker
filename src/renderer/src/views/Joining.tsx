import { useEffect, useRef, useState } from 'react'
import type { JoinStatus, LogLine } from '@shared/types'

interface Props {
  status: JoinStatus
}

const STEP_LABEL: Record<string, string> = {
  mods: '모드팩 맞추기',
  java: '자바 준비',
  loader: '모드 로더 설치',
  ready: '런처에 등록'
}

const ORDER = ['mods', 'java', 'loader', 'ready']

export default function Joining({ status }: Props): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [showLog, setShowLog] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return window.api.events.onJoinLog((line) => {
      setLines((prev) => {
        const next = [...prev, line]
        return next.length > 500 ? next.slice(next.length - 500) : next
      })
    })
  }, [])

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines])

  const currentIndex = ORDER.indexOf(status.step)

  return (
    <div className="app">
      <div className="topbar">
        <h1>모드팩을 맞추는 중</h1>
      </div>

      <div className="content">
        <div className="card">
          <h2>{STEP_LABEL[status.step] ?? '준비 중'}</h2>

          <div className={`progress ${status.ratio === null ? 'indeterminate' : ''}`}>
            <div style={{ width: `${Math.round((status.ratio ?? 0) * 100)}%` }} />
          </div>

          <div className="muted small" style={{ marginTop: 10 }}>
            {status.message}
          </div>

          <div className="steps">
            {ORDER.map((step, i) => (
              <div
                key={step}
                className={`step ${i < currentIndex ? 'done' : i === currentIndex ? 'active' : ''}`}
              >
                {STEP_LABEL[step]}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="row">
            <div className="grow muted small">자세한 진행 기록</div>
            <button className="btn ghost" onClick={() => setShowLog((v) => !v)}>
              {showLog ? '접기' : '펼치기'}
            </button>
          </div>

          {showLog && (
            <div className="console" ref={boxRef} style={{ marginTop: 12, maxHeight: 260 }}>
              {lines.length === 0 ? (
                <span className="muted">아직 기록이 없습니다.</span>
              ) : (
                lines.map((line, i) => (
                  <div key={i} className={`line ${line.level}`}>
                    {line.text}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
