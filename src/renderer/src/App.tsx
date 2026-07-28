import { useCallback, useEffect, useState } from 'react'
import type { Instance, ServerStatus } from '@shared/types'
import Home from './views/Home'
import Create from './views/Create'
import Dashboard from './views/Dashboard'

type View = 'home' | 'create' | 'dashboard'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

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
    return () => {
      offInstances()
      offStatus()
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
      onOpen={(id) => {
        setSelectedId(id)
        setView('dashboard')
      }}
    />
  )
}
