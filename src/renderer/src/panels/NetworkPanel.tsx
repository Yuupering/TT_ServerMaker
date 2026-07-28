import { useCallback, useEffect, useState } from 'react'
import type { Instance, NetStatus, ServerProperties } from '@shared/types'

interface Props {
  instance: Instance
  running: boolean
  onRefresh: () => void
}

export default function NetworkPanel({ instance, running, onRefresh }: Props): React.JSX.Element {
  const [net, setNet] = useState<NetStatus | null>(null)
  const [props, setProps] = useState<ServerProperties | null>(null)
  const [port, setPort] = useState(instance.publicPort ?? 25565)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviteCode, setInviteCode] = useState<string | null>(null)

  useEffect(() => {
    void window.api.net.status().then(setNet).catch(() => undefined)
    void window.api.props
      .get(instance.id)
      .then((p) => {
        setProps(p)
        setPort(instance.publicPort ?? p.port)
      })
      .catch(() => undefined)
    return window.api.events.onNet(setNet)
  }, [instance.id, instance.publicPort])

  /**
   * 친구들이 접속하는 포트. 보호가 켜져 있으면 서버 자체는 다른 내부 포트에서 돌기 때문에,
   * server.properties가 아니라 인스턴스 설정에 저장하고 서버를 켤 때 맞춘다.
   */
  const savePort = useCallback(
    async (value: number) => {
      setPort(value)
      if (!Number.isFinite(value) || value < 1024 || value > 65535) return
      try {
        await window.api.instances.update(instance.id, { publicPort: value })
        if (props && !instance.guard?.enabled) {
          const next = { ...props, port: value }
          setProps(next)
          await window.api.props.set(instance.id, next)
        }
        onRefresh()
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [props, instance.id, instance.guard?.enabled, onRefresh]
  )

  const act = useCallback(async (fn: () => Promise<NetStatus>) => {
    setError(null)
    try {
      setNet(await fn())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(text)
    setTimeout(() => setCopied(null), 1600)
  }, [])

  const busy = net?.busy ?? false
  const manual = net?.manual

  return (
    <div className="content">
      {net?.address && (
        <div className="card">
          <h2>친구들에게 알려줄 주소</h2>
          <div className="address">
            <code>{net.address}</code>
            <button className="btn" onClick={() => void copy(net.address as string)}>
              {copied === net.address ? '복사됨' : '복사'}
            </button>
          </div>
          <div className="muted small" style={{ marginTop: 10 }}>
            {net.mode === 'upnp'
              ? '공유기에서 포트를 열어 직접 연결합니다.'
              : '직접 설정한 포트포워딩으로 연결합니다.'}
            {!running && ' 서버가 켜져 있어야 친구들이 들어올 수 있습니다.'}
          </div>
        </div>
      )}

      <div className="card">
        <h2>외부에서 접속하게 열기</h2>

        <div className="muted small" style={{ marginBottom: 14 }}>
          {net?.detail ?? '아직 열지 않았습니다'}
        </div>

        <div className="row wrap">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void act(() => window.api.net.open(port))}
          >
            {busy ? '여는 중…' : '공유기로 열기'}
          </button>
          {net?.mode !== 'none' && (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => void act(() => window.api.net.close())}
            >
              닫기
            </button>
          )}
        </div>
      </div>

      {manual && net?.mode === 'none' && (
        <div className="card">
          <h2>
            공유기에서 직접 열기 <span className="sub">자동으로 안 될 때</span>
          </h2>

          <div className="muted small" style={{ marginBottom: 14 }}>
            공유기 설정 페이지에서 포트포워딩(포트 포워딩, 가상 서버 등으로 표기)을 아래 값으로
            추가하면 됩니다.
          </div>

          <div className="manual-grid">
            <div className="manual-row">
              <span className="muted">공유기 설정 주소</span>
              <span>
                {manual.gatewayUrl ? (
                  <button
                    className="btn ghost small link"
                    onClick={() =>
                      void window.api.system.openExternal(manual.gatewayUrl as string)
                    }
                  >
                    {manual.gatewayUrl}
                  </button>
                ) : (
                  <span className="muted">찾지 못했습니다</span>
                )}
              </span>
            </div>

            <div className="manual-row">
              <span className="muted">내부 IP (이 PC)</span>
              <span>
                <code>{manual.localIp ?? '-'}</code>
                {manual.localIp && (
                  <button className="btn ghost small" onClick={() => void copy(manual.localIp!)}>
                    {copied === manual.localIp ? '복사됨' : '복사'}
                  </button>
                )}
              </span>
            </div>

            <div className="manual-row">
              <span className="muted">외부 · 내부 포트</span>
              <span>
                <code>{manual.port}</code> <span className="muted small">(TCP, UDP 둘 다)</span>
              </span>
            </div>

            <div className="manual-row">
              <span className="muted">공인 IP</span>
              <span>
                {manual.externalIp ? (
                  <>
                    <code>{manual.externalIp}</code>
                    <button
                      className="btn ghost small"
                      onClick={() => void copy(manual.externalIp!)}
                    >
                      {copied === manual.externalIp ? '복사됨' : '복사'}
                    </button>
                  </>
                ) : (
                  <span className="muted small">
                    확인 못 했습니다. 브라우저에서 &quot;내 아이피&quot;를 검색하면 나옵니다.
                  </span>
                )}
              </span>
            </div>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void act(() => window.api.net.manual(port))}
            >
              설정 마쳤습니다 · 주소 만들기
            </button>
          </div>

          <div className="notice info" style={{ marginTop: 14 }}>
            인터넷이 공인 IP를 주지 않는 환경(대부분의 아파트 공용 인터넷, 모바일 라우터)이라면
            포트포워딩을 해도 외부에서 못 들어옵니다. 이 경우는 통신사에 공인 IP를 요청하거나,
            서버를 임대 서버에서 돌리는 방법밖에 없습니다.
          </div>
        </div>
      )}

      <div className="card">
        <h2>
          친구에게 보낼 초대 코드 <span className="sub">참가자 런처에 붙여넣으면 끝</span>
        </h2>

        <div className="muted small" style={{ marginBottom: 12 }}>
          접속 주소와 필요한 버전·모드팩 정보가 한 덩어리로 들어갑니다. 받은 사람은 서버 조인터에
          붙여넣기만 하면 알아서 맞춰집니다.
        </div>

        {inviteCode ? (
          <>
            <div className="invite-code">{inviteCode}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={() => void copy(inviteCode)}>
                {copied === inviteCode ? '복사됨' : '코드 복사'}
              </button>
              <button className="btn ghost" onClick={() => setInviteCode(null)}>
                닫기
              </button>
            </div>
          </>
        ) : (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              void window.api.invite
                .create(instance.id)
                .then((r) => setInviteCode(r.code))
                .catch((e: Error) => setError(e.message))
            }}
          >
            초대 코드 만들기
          </button>
        )}
      </div>

      <div className="card">
        <h2>같은 집·같은 와이파이에서 접속</h2>
        <div className="muted small">
          {net?.localAddress ? (
            <div className="row">
              <code style={{ color: 'var(--text)' }}>{net.localAddress}</code>
              <button className="btn small" onClick={() => void copy(net.localAddress as string)}>
                {copied === net.localAddress ? '복사됨' : '복사'}
              </button>
            </div>
          ) : (
            '서버를 켜고 위에서 한 번 열면 표시됩니다'
          )}
        </div>
      </div>

      <div className="card">
        <h2>
          포트 <span className="sub">보통 그대로 두면 됩니다</span>
        </h2>
        <div className="row">
          <input
            type="number"
            style={{ maxWidth: 140 }}
            value={port}
            min={1024}
            max={65535}
            disabled={running}
            onChange={(e) => void savePort(Number(e.target.value))}
          />
          {running && <span className="muted small">서버가 켜져 있는 동안에는 바꿀 수 없습니다</span>}
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}
    </div>
  )
}
