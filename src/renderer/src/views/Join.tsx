import { useCallback, useEffect, useState } from 'react'
import type { Invite, JoinResult, JoinStatus, JoinedServer } from '@shared/types'

interface Props {
  status: JoinStatus
  onBack: () => void
  /** 준비 결과. 준비 중에는 이 화면이 내려가므로 App이 들고 있는다 */
  result: JoinResult | null
  onResult: (result: JoinResult | null) => void
}

const LOADER_LABEL: Record<string, string> = {
  vanilla: '순정',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge'
}

export default function Join({ status, result, onResult, onBack }: Props): React.JSX.Element {
  const [servers, setServers] = useState<JoinedServer[]>([])
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<Invite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [launcherReady, setLauncherReady] = useState(true)
  const [autoOpen, setAutoOpen] = useState(true)

  /*
   * 목록을 못 읽었을 때 빈 목록으로 넘기면 참가해둔 서버가 사라진 것처럼 보인다.
   * 실패는 실패라고 알려야 사용자가 다시 초대 코드를 받으러 가지 않는다.
   */
  const refresh = useCallback(async () => {
    try {
      setServers(await window.api.join.list())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.join.launcherAvailable().then(setLauncherReady).catch(() => setLauncherReady(false))
    void window.api.settings
      .get()
      .then((s) => setAutoOpen(s.autoOpenLauncher))
      .catch(() => undefined)
    return window.api.events.onJoinedChanged(() => void refresh())
  }, [refresh])

  /* 코드를 붙여넣는 즉시 어떤 서버인지 보여준다 */
  useEffect(() => {
    if (!code.trim()) {
      setPreview(null)
      setError(null)
      return
    }
    let cancelled = false
    window.api.join
      .decode(code)
      .then((invite) => {
        if (cancelled) return
        setPreview(invite)
        setError(null)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setPreview(null)
        setError(e.message)
      })

    return () => {
      cancelled = true
    }
  }, [code])

  const prepare = useCallback(
    async (invite: Invite) => {
      setBusy(true)
      setError(null)
      onResult(null)
      try {
        onResult(await window.api.join.prepare(invite))
        setCode('')
        await refresh()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [refresh, onResult]
  )

  return (
    <div className="app">
      <div className="topbar">
        <button className="btn ghost" onClick={onBack}>
          ← 뒤로
        </button>
        <h1>친구 서버에 참가하기</h1>
        <div className="spacer" />
        <div className="muted small">모드팩을 맞춰 공식 런처에 등록합니다</div>
      </div>

      <div className="content">
        {result && (
          <div className="card done-card">
            <h2>준비가 끝났습니다</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>
              {result.launcherOpened
                ? '마인크래프트 런처를 띄웠습니다. 아래 프로필이 목록 맨 위에 있으니 플레이만 누르면 됩니다. 게임에 들어가면 서버 목록에 이미 등록돼 있습니다.'
                : '마인크래프트 공식 런처를 열고, 왼쪽 아래 버전 목록에서 아래 프로필을 고른 뒤 플레이를 누르세요. 게임에 들어가면 서버 목록에 이미 등록돼 있습니다.'}
            </div>

            <div className="profile-name">{result.profileName}</div>

            <div className="row wrap" style={{ marginTop: 14 }}>
              <button
                className="btn primary"
                onClick={() =>
                  void window.api.join.openLauncher().catch((e: Error) => setError(e.message))
                }
              >
                {result.launcherOpened ? '런처 다시 열기' : '마인크래프트 런처 열기'}
              </button>
              <button
                className="btn"
                onClick={() => void window.api.system.openFolder(result.gameDir)}
              >
                모드 폴더 열기
              </button>
              <button className="btn ghost" onClick={() => onResult(null)}>
                닫기
              </button>
            </div>

            {/* 자동으로 여는 게 싫은 사람은 여기서 끈다. 필요할 때만 눈에 띄면 된다 */}
            {result.launcherOpened && (
              <label className="checkbox" style={{ marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={!autoOpen}
                  onChange={(e) => {
                    const next = !e.target.checked
                    setAutoOpen(next)
                    void window.api.settings
                      .set({ autoOpenLauncher: next })
                      .catch((err: Error) => setError(err.message))
                  }}
                />
                <span className="muted small">다음부터 런처를 자동으로 열지 않기</span>
              </label>
            )}
          </div>
        )}

        {!launcherReady && (
          <div className="notice warn">
            공식 마인크래프트 런처를 찾지 못했습니다. 이 앱은 런처가 읽는 폴더에 모드팩을
            맞춰두는 방식이라, 런처를 설치하고 한 번 실행한 뒤에 쓸 수 있습니다.
          </div>
        )}

        <div className="card">
          <h2>초대 코드 넣기</h2>
          <div className="muted small" style={{ marginBottom: 12 }}>
            서버를 연 친구에게 받은 코드를 그대로 붙여넣으세요.
          </div>

          <input
            type="text"
            placeholder="TTSM1.…"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />

          {preview && (
            <div className="preview">
              <div className="grow">
                <div className="preview-name">{preview.name || preview.address}</div>
                <div className="muted small">
                  마인크래프트 {preview.mcVersion} ·{' '}
                  {LOADER_LABEL[preview.loader] ?? preview.loader}
                  {preview.pack ? ` · 모드팩 ${preview.pack.title ?? '있음'}` : ' · 모드 없음'}
                </div>
                <div className="muted small">{preview.address}</div>
              </div>
              <button
                className="btn primary"
                disabled={busy || !launcherReady}
                onClick={() => void prepare(preview)}
              >
                {busy ? '준비 중…' : '준비하기'}
              </button>
            </div>
          )}

          {error && (
            <div className="notice error" style={{ marginTop: 12, whiteSpace: 'pre-line' }}>
              {error}
            </div>
          )}
        </div>

        {servers.length > 0 && (
          <div className="card">
            <h2>
              내 서버 <span className="sub">{servers.length}개</span>
            </h2>

            {servers.map((s) => (
              <div key={s.id} className="row" style={{ padding: '9px 0' }}>
                <div className="grow">
                  <div>{s.name || s.address}</div>
                  <div className="muted small">
                    마인크래프트 {s.mcVersion} · {LOADER_LABEL[s.loader] ?? s.loader}
                    {s.pack ? ' · 모드팩' : ''} · {s.address}
                  </div>
                </div>
                <button
                  className="btn primary"
                  disabled={busy || !launcherReady}
                  onClick={() => void prepare(s)}
                >
                  준비하기
                </button>
                <button
                  className="btn ghost danger"
                  disabled={busy}
                  onClick={() => void window.api.join.remove(s.id)}
                >
                  삭제
                </button>
              </div>
            ))}
          </div>
        )}

        {servers.length === 0 && !preview && !result && (
          <div className="empty">
            <h2>아직 참가한 서버가 없습니다</h2>
            <p>
              서버를 연 친구에게 초대 코드를 받아 위에 붙여넣으면
              <br />
              모드팩과 로더를 맞추고 공식 런처에 프로필까지 만들어 둡니다.
            </p>
          </div>
        )}

        {status.step === 'error' && status.error && (
          <div className="notice error" style={{ whiteSpace: 'pre-line' }}>
            {status.error}
          </div>
        )}
      </div>
    </div>
  )
}
