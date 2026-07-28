import { useCallback, useState } from 'react'
import type { Instance, ServerStatus } from '@shared/types'
import ConsolePanel from '../panels/ConsolePanel'
import NetworkPanel from '../panels/NetworkPanel'
import SettingsPanel from '../panels/SettingsPanel'
import BackupPanel from '../panels/BackupPanel'
import PlayersPanel from '../panels/PlayersPanel'
import AddonsPanel from '../panels/AddonsPanel'
import SecurityPanel from '../panels/SecurityPanel'

interface Props {
  instance: Instance
  status: ServerStatus | null
  onBack: () => void
  /** 인스턴스 설정을 바꾼 뒤 목록을 다시 읽어오기 위한 것 */
  onRefresh: () => void
}

type Tab = 'console' | 'network' | 'addons' | 'players' | 'security' | 'settings' | 'backup'

const STATE_LABEL: Record<string, string> = {
  stopped: '꺼짐',
  installing: '설치 중',
  starting: '켜는 중',
  running: '실행 중',
  stopping: '끄는 중',
  crashed: '예기치 않게 종료됨'
}

export default function Dashboard({
  instance,
  status,
  onBack,
  onRefresh
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('console')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const mine = status?.instanceId === instance.id ? status : null
  const state = mine?.state ?? 'stopped'
  const running = state === 'running'
  const busy = state === 'starting' || state === 'stopping' || pending

  const toggle = useCallback(async () => {
    setError(null)
    setPending(true)
    try {
      if (state === 'stopped' || state === 'crashed') {
        await window.api.server.start(instance.id)
      } else {
        await window.api.server.stop()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }, [state, instance.id])

  return (
    <div className="app">
      <div className="topbar">
        {/* 서버가 켜져 있어도 목록으로 돌아갈 수 있다. 서버는 계속 돌아간다 */}
        <button className="btn ghost" onClick={onBack}>
          ←
        </button>
        <span
          className={`dot ${
            running ? 'running' : state === 'crashed' ? 'crashed' : state !== 'stopped' ? 'busy' : ''
          }`}
        />
        <div>
          <h1>{instance.name}</h1>
          <div className="muted small">
            {STATE_LABEL[state] ?? state}
            {running && mine?.players.length ? ` · 접속 ${mine.players.length}명` : ''}
          </div>
        </div>
        <div className="spacer" />
        <button
          className={`btn ${running ? 'danger' : 'primary'}`}
          onClick={() => void toggle()}
          disabled={busy}
        >
          {state === 'starting'
            ? '켜는 중…'
            : state === 'stopping'
              ? '끄는 중…'
              : pending
                ? '잠시만요…'
                : running
                  ? '서버 끄기'
                  : '서버 켜기'}
        </button>
      </div>

      <div className="tabs">
        <button className={tab === 'console' ? 'active' : ''} onClick={() => setTab('console')}>
          콘솔
        </button>
        <button className={tab === 'network' ? 'active' : ''} onClick={() => setTab('network')}>
          접속 주소
        </button>
        <button className={tab === 'addons' ? 'active' : ''} onClick={() => setTab('addons')}>
          모드 · 플러그인
        </button>
        <button className={tab === 'players' ? 'active' : ''} onClick={() => setTab('players')}>
          인원 관리
        </button>
        <button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>
          봇 차단
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          설정
        </button>
        <button className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>
          백업
        </button>
      </div>

      {error && (
        <div className="notice error" style={{ margin: '14px 20px 0' }}>
          {error}
        </div>
      )}

      {tab === 'console' && <ConsolePanel running={running} players={mine?.players ?? []} />}
      {tab === 'network' && (
        <NetworkPanel instance={instance} running={running} onRefresh={onRefresh} />
      )}
      {tab === 'addons' && <AddonsPanel instance={instance} running={running} />}
      {tab === 'players' && <PlayersPanel instance={instance} />}
      {tab === 'security' && (
        <SecurityPanel instance={instance} running={running} onChanged={onRefresh} />
      )}
      {tab === 'settings' && <SettingsPanel instance={instance} running={running} onDeleted={onBack} />}
      {tab === 'backup' && <BackupPanel instance={instance} />}
    </div>
  )
}
