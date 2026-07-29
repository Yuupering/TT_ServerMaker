import { useCallback, useEffect, useState } from 'react'
import type { Instance, JoinResult, JoinStatus, ServerStatus } from '@shared/types'
import Home from './views/Home'
import Create from './views/Create'
import Dashboard from './views/Dashboard'
import Join from './views/Join'
import Joining from './views/Joining'

type View = 'home' | 'create' | 'dashboard' | 'join'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  /* 참가 준비 상태와 결과 */
  const [joinStatus, setJoinStatus] = useState<JoinStatus>({
    step: 'idle',
    message: '',
    ratio: null
  })
  /*
   * 준비하는 동안에는 참가 화면이 내려가고 진행 화면이 뜬다.
   * 결과를 참가 화면 안에 두면 준비가 끝났을 때 그걸 받을 대상이 이미 사라진 뒤라
   * "준비가 끝났습니다" 카드가 영영 안 뜬다. 그래서 여기서 들고 있는다.
   */
  const [joinResult, setJoinResult] = useState<JoinResult | null>(null)

  /*
   * 목록을 못 읽었을 때 빈 목록으로 넘기면 "서버가 하나도 없다"처럼 보인다.
   * 그 화면에서 사용자가 멀쩡한 서버 폴더를 남은 찌꺼기로 오해하고 지울 수 있어,
   * 실패는 실패라고 그대로 보여준다.
   */
  const refresh = useCallback(async () => {
    try {
      const list = await window.api.instances.list()
      setInstances(list)
      setLoadError(null)
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.server.status().then(setStatus).catch(() => undefined)

    const offInstances = window.api.events.onInstancesChanged(() => void refresh())
    const offStatus = window.api.events.onStatus(setStatus)
    const offJoin = window.api.events.onJoinStatus(setJoinStatus)
    return () => {
      offInstances()
      offStatus()
      offJoin()
    }
  }, [refresh])

  // 서버가 돌고 있으면 그 서버 화면을 보여주는 게 자연스럽다
  useEffect(() => {
    if (status?.instanceId && status.state !== 'stopped' && view === 'home') {
      setSelectedId(status.instanceId)
      setView('dashboard')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.instanceId])

  const selected = instances.find((i) => i.id === selectedId) ?? null

  if (!loaded) {
    return (
      <div className="app">
        <div className="content">
          <div className="empty muted">불러오는 중…</div>
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="app">
        <div className="content">
          <div className="empty">
            <h2>서버 목록을 불러오지 못했습니다</h2>
            <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
              {loadError}
            </p>
            <p className="muted small">
              서버 폴더는 그대로 남아 있습니다. 이 화면에서는 아무것도 지우지 마세요.
            </p>
            <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
              <button className="btn primary" onClick={() => void refresh()}>
                다시 시도
              </button>
              <button
                className="btn"
                onClick={() =>
                  void window.api.system
                    .paths()
                    .then((p) => window.api.system.openFolder(p.root))
                    .catch(() => undefined)
                }
              >
                저장 폴더 열기
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // 참가 준비 중에는 그 진행 화면만 보여준다
  if (joinStatus.step !== 'idle' && joinStatus.step !== 'error') {
    return <Joining status={joinStatus} />
  }

  if (view === 'join') {
    return (
      <Join
        status={joinStatus}
        result={joinResult}
        onResult={setJoinResult}
        onBack={() => setView('home')}
      />
    )
  }

  if (view === 'create') {
    return (
      <Create
        onCancel={() => setView(instances.length ? 'home' : 'home')}
        onCreated={(instance) => {
          setSelectedId(instance.id)
          setView('dashboard')
          void refresh()
        }}
      />
    )
  }

  if (view === 'dashboard' && selected) {
    return (
      <Dashboard
        instance={selected}
        status={status}
        onRefresh={() => void refresh()}
        onBack={() => {
          setView('home')
          setSelectedId(null)
        }}
      />
    )
  }

  return (
    <Home
      instances={instances}
      status={status}
      onCreate={() => setView('create')}
      onJoin={() => setView('join')}
      onOpen={(id) => {
        setSelectedId(id)
        setView('dashboard')
      }}
    />
  )
}
