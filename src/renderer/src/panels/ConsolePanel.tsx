import { useEffect, useRef, useState } from 'react'
import type { LogLine } from '@shared/types'

interface Props {
  running: boolean
  players: string[]
}

export default function ConsolePanel({ running, players }: Props): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [input, setInput] = useState('')
  const [stickToBottom, setStickToBottom] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.server.logs().then(setLines).catch(() => undefined)
    return window.api.events.onLog((line) => {
      setLines((prev) => {
        const next = [...prev, line]
        return next.length > 2000 ? next.slice(next.length - 2000) : next
      })
    })
  }, [])

  // 사용자가 위로 올려 로그를 보고 있으면 자동 스크롤하지 않는다
  useEffect(() => {
    if (!stickToBottom || !boxRef.current) return
    boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, stickToBottom])

  const send = (): void => {
    const text = input.trim()
    if (!text) return
    window.api.server.command(text).catch(() => undefined)
    setInput('')
  }

  return (
    <div className="content no-pad" style={{ display: 'flex', flexDirection: 'column', padding: 20, gap: 12 }}>
      {players.length > 0 && (
        <div className="row wrap small">
          <span className="muted">접속 중:</span>
          {players.map((p) => (
            <span key={p} className="badge">
              {p}
            </span>
          ))}
        </div>
      )}

      <div
        className="console"
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
        }}
      >
        {lines.length === 0 ? (
          <span className="muted">서버를 켜면 여기에 진행 상황이 표시됩니다.</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`line ${line.level}`}>
              {line.text}
            </div>
          ))
        )}
      </div>

      <div className="row">
        <input
          type="text"
          className="grow"
          placeholder={running ? '명령어 입력 (예: op 닉네임)' : '서버가 꺼져 있습니다'}
          value={input}
          disabled={!running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button className="btn" disabled={!running || !input.trim()} onClick={send}>
          보내기
        </button>
      </div>
    </div>
  )
}
