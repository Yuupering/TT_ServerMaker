import { useCallback, useEffect, useState } from 'react'
import type { GuardSettings, GuardStatus, Instance, ServerProperties } from '@shared/types'

interface Props {
  instance: Instance
  running: boolean
  onChanged: () => void
}

const FALLBACK_GUARD: GuardSettings = {
  enabled: false,
  maxPerIp: 3,
  ratePerMinute: 12,
  blockMinutes: 5,
  idleTimeoutSec: 10
}

/** 25565를 피해 눈에 덜 띄는 포트 하나를 고른다 */
function suggestPort(): number {
  return 20000 + Math.floor(Math.random() * 20000)
}

export default function SecurityPanel({ instance, running, onChanged }: Props): React.JSX.Element {
  const [props, setProps] = useState<ServerProperties | null>(null)
  const [guardStatus, setGuardStatus] = useState<GuardStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const settings = instance.guard ?? FALLBACK_GUARD
  const publicPort = instance.publicPort ?? props?.port ?? 25565

  useEffect(() => {
    void window.api.props.get(instance.id).then(setProps).catch(() => undefined)
    void window.api.guard.status().then(setGuardStatus).catch(() => undefined)
    return window.api.events.onGuard(setGuardStatus)
  }, [instance.id])

  const flash = useCallback((msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 2600)
  }, [])

  const patchProps = useCallback(
    async (patch: Partial<ServerProperties>) => {
      if (!props) return
      const next = { ...props, ...patch }
      setProps(next)
      setBusy(true)
      try {
        await window.api.props.set(instance.id, next)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [props, instance.id]
  )

  const patchGuard = useCallback(
    async (patch: Partial<GuardSettings>) => {
      setBusy(true)
      try {
        await window.api.instances.update(instance.id, { guard: { ...settings, ...patch } })
        onChanged()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [settings, instance.id, onChanged]
  )

  /** 권장 설정을 한 번에 적용한다 */
  const applyRecommended = useCallback(async () => {
    if (!props) return
    setBusy(true)
    setError(null)

    try {
      const port = publicPort === 25565 ? suggestPort() : publicPort

      await window.api.props.set(instance.id, {
        ...props,
        whitelist: true,
        onlineMode: true,
        enableStatus: false
      })
      setProps({ ...props, whitelist: true, onlineMode: true, enableStatus: false })

      await window.api.instances.update(instance.id, {
        guard: { ...settings, enabled: true },
        publicPort: port
      })
      onChanged()

      flash(
        port === publicPort
          ? '권장 설정을 적용했습니다.'
          : `권장 설정을 적용하고 포트를 ${port}로 바꿨습니다. 친구들에게 새 주소를 알려주세요.`
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [props, publicPort, settings, instance.id, onChanged, flash])

  const items = [
    {
      on: props?.whitelist ?? false,
      label: '화이트리스트',
      desc: '등록한 사람만 접속합니다. 봇을 막는 가장 확실한 방법입니다.'
    },
    {
      on: props?.onlineMode ?? false,
      label: '정품 인증',
      desc: '끄면 아무 닉네임으로나 들어올 수 있습니다.'
    },
    {
      on: !(props?.enableStatus ?? true),
      label: '서버 정보 숨기기',
      desc: '스캐너가 포트를 찾아도 서버 정보를 못 가져갑니다. 대신 친구 서버 목록에 인원수가 안 보입니다.'
    },
    {
      on: settings.enabled,
      label: '접속 보호',
      desc: '같은 곳에서 반복해서 밀려드는 접속을 걸러냅니다.'
    },
    {
      on: publicPort !== 25565,
      label: '비표준 포트',
      desc: '스캐너는 25565를 집중적으로 훑습니다.'
    }
  ]

  const onCount = items.filter((i) => i.on).length

  return (
    <div className="content">
      {notice && <div className="notice info">{notice}</div>}
      {error && <div className="notice error">{error}</div>}

      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="grow">
            <h2 style={{ margin: 0 }}>
              봇 차단 <span className="sub">{onCount} / {items.length} 적용됨</span>
            </h2>
            <div className="muted small">
              포트를 열어두면 스캐너 봇이 며칠 안에 서버를 찾아냅니다. 아래를 켜두면 대부분 막힙니다.
            </div>
          </div>
          <button className="btn primary" disabled={busy || !props} onClick={() => void applyRecommended()}>
            권장 설정 한 번에 켜기
          </button>
        </div>

        {items.map((item) => (
          <div key={item.label} className="row" style={{ padding: '8px 0', alignItems: 'flex-start' }}>
            <span className={`dot ${item.on ? 'running' : ''}`} style={{ marginTop: 7 }} />
            <div className="grow">
              <div>{item.label}</div>
              <div className="muted small">{item.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {props && (
        <div className="card">
          <h2>개별 설정</h2>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={props.whitelist}
              disabled={busy}
              onChange={(e) => void patchProps({ whitelist: e.target.checked })}
            />
            <span>화이트리스트 사용 (명단은 인원 관리 탭에서 추가)</span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={props.onlineMode}
              disabled={busy}
              onChange={(e) => void patchProps({ onlineMode: e.target.checked })}
            />
            <span>정품 인증 확인</span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={!props.enableStatus}
              disabled={busy}
              onChange={(e) => void patchProps({ enableStatus: !e.target.checked })}
            />
            <span>서버 목록에서 정보 숨기기</span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={props.enableCommandBlock}
              disabled={busy}
              onChange={(e) => void patchProps({ enableCommandBlock: e.target.checked })}
            />
            <span>명령블록 허용</span>
          </label>
          <div className="muted small" style={{ marginLeft: 26 }}>
            관리자 권한이 넘어가면 악용될 수 있어 기본은 꺼둡니다. 필요할 때만 켜세요.
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy || running}
              onChange={(e) => void patchGuard({ enabled: e.target.checked })}
            />
            <span>접속 보호 사용{running ? ' (서버를 껐다 켜야 바뀝니다)' : ''}</span>
          </label>
        </div>
      )}

      {settings.enabled && (
        <div className="card">
          <h2>
            접속 보호 세부 <span className="sub">보통 그대로 두면 됩니다</span>
          </h2>

          <div className="grid-2">
            <label className="field">
              <span>같은 IP 동시 접속 수</span>
              <input
                type="number"
                min={1}
                max={20}
                value={settings.maxPerIp}
                disabled={busy}
                onChange={(e) => void patchGuard({ maxPerIp: Number(e.target.value) })}
              />
            </label>

            <label className="field">
              <span>1분당 접속 시도 한도</span>
              <input
                type="number"
                min={3}
                max={120}
                value={settings.ratePerMinute}
                disabled={busy}
                onChange={(e) => void patchGuard({ ratePerMinute: Number(e.target.value) })}
              />
            </label>

            <label className="field">
              <span>차단 유지 시간 (분)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={settings.blockMinutes}
                disabled={busy}
                onChange={(e) => void patchGuard({ blockMinutes: Number(e.target.value) })}
              />
            </label>

            <label className="field">
              <span>무응답 연결 끊기 (초)</span>
              <input
                type="number"
                min={3}
                max={120}
                value={settings.idleTimeoutSec}
                disabled={busy}
                onChange={(e) => void patchGuard({ idleTimeoutSec: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="muted small">
            친구 여러 명이 같은 집에서 접속한다면 동시 접속 수를 넉넉히 잡아 주세요.
          </div>
        </div>
      )}

      {guardStatus?.running && (
        <div className="card">
          <h2>
            지금 상태{' '}
            <span className="sub">
              연결 {guardStatus.activeConnections}개 · 막아낸 접속 {guardStatus.rejected}건
            </span>
          </h2>

          <div className="muted small" style={{ marginBottom: 12 }}>
            공개 {guardStatus.publicPort} → 서버 {guardStatus.backendPort}
            {guardStatus.forwardingIp
              ? ' · 접속 IP를 서버에 그대로 전달합니다'
              : ' · 서버에는 접속자가 로컬로 보입니다'}
          </div>

          {guardStatus.blocked.length === 0 ? (
            <div className="muted small">차단된 주소가 없습니다.</div>
          ) : (
            guardStatus.blocked.map((b) => (
              <div key={b.ip} className="row" style={{ padding: '6px 0' }}>
                <div className="grow small">
                  <code>{b.ip}</code> <span className="muted">{b.reason}</span>
                </div>
                <button
                  className="btn ghost"
                  onClick={() => void window.api.guard.unblock(b.ip).catch(() => undefined)}
                >
                  차단 풀기
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
