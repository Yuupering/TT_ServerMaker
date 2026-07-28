import { useCallback, useEffect, useState } from 'react'
import type { AddonEntry, AddonKind, Instance } from '@shared/types'

interface Props {
  instance: Instance
  running: boolean
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

export default function AddonsPanel({ instance, running }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<AddonEntry[]>([])
  const [kind, setKind] = useState<AddonKind>('mod')
  const [dir, setDir] = useState('')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const label = kind === 'plugin' ? '플러그인' : '모드'

  const refresh = useCallback(async () => {
    const [list, info] = await Promise.all([
      window.api.addons.list(instance.id).catch(() => []),
      window.api.addons.kind(instance.id).catch(() => null)
    ])
    setEntries(list)
    if (info) {
      setKind(info.kind)
      setDir(info.dir)
    }
  }, [instance.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      setBusy(true)
      setError(null)
      setNotice(null)

      try {
        const result = await window.api.addons.add(instance.id, paths)
        await refresh()

        const parts: string[] = []
        if (result.added.length) parts.push(`${result.added.length}개 넣었습니다`)
        if (result.skipped.length) {
          parts.push(
            `건너뜀: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`
          )
        }
        setNotice(parts.join(' · '))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [instance.id, refresh]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)

      const paths = Array.from(e.dataTransfer.files)
        .map((f) => {
          try {
            return window.api.addons.pathOf(f)
          } catch {
            return ''
          }
        })
        .filter(Boolean)

      void addPaths(paths)
    },
    [addPaths]
  )

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true)
      setError(null)
      try {
        await fn()
        await refresh()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  return (
    <div className="content">
      <div
        className={`dropzone ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="dropzone-title">{label} 파일을 여기에 끌어다 놓으세요</div>
        <div className="muted small">jar 파일만 들어갑니다</div>
        <button
          className="btn"
          style={{ marginTop: 12 }}
          disabled={busy}
          onClick={() => {
            void window.api.addons
              .pick()
              .then(addPaths)
              .catch((e: Error) => setError(e.message))
          }}
        >
          파일 골라서 넣기
        </button>
      </div>

      {notice && <div className="notice info">{notice}</div>}
      {error && <div className="notice error">{error}</div>}

      {running && entries.length > 0 && (
        <div className="notice warn">
          서버가 켜져 있습니다. 새로 넣은 {label}은 서버를 껐다 켜야 적용됩니다.
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }} className="grow">
            설치된 {label} <span className="sub">{entries.length}개</span>
          </h2>
          <button className="btn ghost" onClick={() => void window.api.system.openFolder(dir)}>
            폴더 열기
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="muted small">
            아직 없습니다. 위쪽에 파일을 끌어다 놓으면 여기에 표시됩니다.
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.file} className="row" style={{ padding: '7px 0' }}>
              <div className="grow" style={{ opacity: entry.enabled ? 1 : 0.45 }}>
                <div style={{ wordBreak: 'break-all' }}>{entry.name}</div>
                <div className="muted small">
                  {formatSize(entry.size)}
                  {entry.enabled ? '' : ' · 꺼둔 상태'}
                </div>
              </div>
              <button
                className="btn ghost"
                disabled={busy}
                onClick={() => void act(() => window.api.addons.toggle(instance.id, entry.file))}
              >
                {entry.enabled ? '끄기' : '켜기'}
              </button>
              <button
                className="btn ghost danger"
                disabled={busy}
                onClick={() => void act(() => window.api.addons.remove(instance.id, entry.file))}
              >
                삭제
              </button>
            </div>
          ))
        )}
      </div>

      <div className="muted small">
        {kind === 'plugin'
          ? '이 서버는 플러그인 서버라 plugins 폴더에 들어갑니다. 모드(Forge·Fabric용)는 동작하지 않습니다.'
          : '이 서버는 모드 서버라 mods 폴더에 들어갑니다. 플러그인(Bukkit·Spigot용)은 동작하지 않습니다.'}
      </div>
    </div>
  )
}
