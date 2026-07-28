import { useCallback, useEffect, useState } from 'react'
import type { BackupEntry, Instance } from '@shared/types'

interface Props {
  instance: Instance
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}MB`
  return `${(bytes / 1024).toFixed(0)}KB`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function BackupPanel({ instance }: Props): React.JSX.Element {
  const [list, setList] = useState<BackupEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<BackupEntry | null>(null)

  const refresh = useCallback(async () => {
    const items = await window.api.backups.list(instance.id).catch(() => [])
    setList(items)
  }, [instance.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await window.api.backups.create(instance.id)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [instance.id, refresh])

  const restore = useCallback(
    async (entry: BackupEntry) => {
      setBusy(true)
      setError(null)
      setRestoring(null)
      try {
        await window.api.backups.restore(instance.id, entry.file)
        await refresh()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [instance.id, refresh]
  )

  return (
    <div className="content">
      <div className="card">
        <div className="row">
          <div className="grow">
            <h2 style={{ margin: 0 }}>월드 백업</h2>
            <div className="muted small">
              사고가 나도 예전 월드로 되돌릴 수 있습니다. 복원은 서버를 끈 상태에서만 됩니다.
            </div>
          </div>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            {busy ? '작업 중…' : '지금 백업'}
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="card">
        <h2>
          백업 목록 <span className="sub">{list.length}개</span>
        </h2>

        {list.length === 0 ? (
          <div className="muted small">아직 백업이 없습니다.</div>
        ) : (
          <div className="instance-list">
            {list.map((entry) => (
              <div key={entry.file} className="row" style={{ padding: '8px 0' }}>
                <div className="grow">
                  <div>{formatDate(entry.createdAt)}</div>
                  <div className="muted small">{formatSize(entry.size)}</div>
                </div>
                <button className="btn" disabled={busy} onClick={() => setRestoring(entry)}>
                  이걸로 되돌리기
                </button>
                <button
                  className="btn ghost danger"
                  disabled={busy}
                  onClick={() => {
                    void window.api.backups
                      .remove(instance.id, entry.file)
                      .then(refresh)
                      .catch((e: Error) => setError(e.message))
                  }}
                >
                  삭제
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {restoring && (
        <div className="overlay" onClick={() => setRestoring(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>월드를 되돌릴까요?</h2>
            <p className="muted">
              {formatDate(restoring.createdAt)} 시점으로 돌아갑니다. 지금 월드는 지우지 않고 서버
              폴더에 따로 남겨두니, 잘못 눌러도 되살릴 수 있습니다.
            </p>
            <div className="actions">
              <button className="btn" onClick={() => setRestoring(null)}>
                취소
              </button>
              <button className="btn primary" onClick={() => void restore(restoring)}>
                되돌리기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
