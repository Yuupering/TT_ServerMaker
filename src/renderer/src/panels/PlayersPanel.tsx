import { useCallback, useEffect, useState } from 'react'
import type { Instance, PlayerEntry } from '@shared/types'

interface Props {
  instance: Instance
}

interface ListState {
  entries: PlayerEntry[]
  input: string
}

export default function PlayersPanel({ instance }: Props): React.JSX.Element {
  const [ops, setOps] = useState<ListState>({ entries: [], input: '' })
  const [white, setWhite] = useState<ListState>({ entries: [], input: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const [o, w] = await Promise.all([
      window.api.players.ops(instance.id).catch(() => []),
      window.api.players.whitelist(instance.id).catch(() => [])
    ])
    setOps((s) => ({ ...s, entries: o }))
    setWhite((s) => ({ ...s, entries: w }))
  }, [instance.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = useCallback(
    async (fn: () => Promise<PlayerEntry[]>, apply: (list: PlayerEntry[]) => void) => {
      setBusy(true)
      setError(null)
      try {
        apply(await fn())
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const renderList = (
    title: string,
    hint: string,
    state: ListState,
    setState: (s: ListState) => void,
    add: (name: string) => Promise<PlayerEntry[]>,
    remove: (uuid: string) => Promise<PlayerEntry[]>
  ): React.JSX.Element => (
    <div className="card">
      <h2>
        {title} <span className="sub">{hint}</span>
      </h2>

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          type="text"
          className="grow"
          placeholder="마인크래프트 닉네임"
          value={state.input}
          disabled={busy}
          onChange={(e) => setState({ ...state, input: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && state.input.trim()) {
              const name = state.input.trim()
              void act(
                () => add(name),
                (list) => setState({ entries: list, input: '' })
              )
            }
          }}
        />
        <button
          className="btn"
          disabled={busy || !state.input.trim()}
          onClick={() => {
            const name = state.input.trim()
            void act(
              () => add(name),
              (list) => setState({ entries: list, input: '' })
            )
          }}
        >
          추가
        </button>
      </div>

      {state.entries.length === 0 ? (
        <div className="muted small">아직 없습니다.</div>
      ) : (
        state.entries.map((entry) => (
          <div key={entry.uuid} className="row" style={{ padding: '6px 0' }}>
            <div className="grow">{entry.name}</div>
            <button
              className="btn ghost danger"
              disabled={busy}
              onClick={() =>
                void act(
                  () => remove(entry.uuid),
                  (list) => setState({ ...state, entries: list })
                )
              }
            >
              제거
            </button>
          </div>
        ))
      )}
    </div>
  )

  return (
    <div className="content">
      {error && <div className="notice error">{error}</div>}

      {renderList(
        '관리자',
        '명령어를 쓸 수 있는 사람',
        ops,
        setOps,
        (name) => window.api.players.addOp(instance.id, name),
        (uuid) => window.api.players.removeOp(instance.id, uuid)
      )}

      {renderList(
        '화이트리스트',
        '설정에서 화이트리스트를 켜야 적용됩니다',
        white,
        setWhite,
        (name) => window.api.players.addWhitelist(instance.id, name),
        (uuid) => window.api.players.removeWhitelist(instance.id, uuid)
      )}

      <div className="muted small">
        서버가 켜져 있으면 바로 적용되고, 꺼져 있으면 다음 실행부터 적용됩니다.
      </div>
    </div>
  )
}
