import { useCallback, useEffect, useState } from 'react'
import type { Instance, ServerStatus } from '@shared/types'
import {
  APP_TITLE,
  APP_VERSION,
  AUTHOR,
  CONTACT,
  MOJANG_DISCLAIMER,
  MOJANG_DISCLAIMER_KO,
  STUDIO
} from '@shared/meta'

interface Props {
  instances: Instance[]
  status: ServerStatus | null
  onCreate: () => void
  onOpen: (id: string) => void
}

const LOADER_LABEL: Record<string, string> = {
  vanilla: '순정',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  paper: 'Paper',
  spigot: 'Spigot',
  craftbukkit: 'CraftBukkit'
}

interface Orphan {
  name: string
  path: string
  size: number
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '-'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}MB`
  return `${(bytes / 1024).toFixed(0)}KB`
}

export default function Home({ instances, status, onCreate, onOpen }: Props): React.JSX.Element {
  const [pathInfo, setPathInfo] = useState<{ root: string; nonAscii: boolean } | null>(null)
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const [orphans, setOrphans] = useState<Orphan[]>([])
  const [diskError, setDiskError] = useState<string | null>(null)

  const refreshDisk = useCallback(async () => {
    // 폴더를 훑는 작업이라 목록 표시를 막지 않도록 따로 불러온다
    const [s, o] = await Promise.all([
      window.api.instances.sizes().catch(() => ({})),
      /*
       * 남은 폴더 목록은 서버 목록과 대조해서 만든다.
       * 대조에 실패했는데 결과를 비워버리면 지우기 버튼이 잘못된 대상을 가리킬 수 있으므로,
       * 실패하면 목록을 아예 감추고 이유만 알린다.
       */
      window.api.instances.orphans().catch((e: Error) => {
        setDiskError(e.message)
        return null
      })
    ])
    setSizes(s)
    if (o) {
      setOrphans(o)
      setDiskError(null)
    } else {
      setOrphans([])
    }
  }, [])

  useEffect(() => {
    void window.api.system.paths().then(setPathInfo).catch(() => undefined)
    void refreshDisk()
  }, [refreshDisk, instances.length])

  return (
    <div className="app">
      <div className="topbar">
        <h1>{APP_TITLE}</h1>
        <div className="spacer" />
        {instances.length > 0 && (
          <button className="btn primary" onClick={onCreate}>
            새 서버 만들기
          </button>
        )}
      </div>

      <div className="content">
        {instances.length === 0 ? (
          <div className="empty">
            <h2>서버를 하나 만들어 봅시다</h2>
            <p>
              무엇으로 열지만 고르면 자바 설치부터 서버 구성까지 알아서 합니다.
              <br />
              따로 준비할 건 없습니다.
            </p>
            <button className="btn primary big" onClick={onCreate}>
              서버 만들기
            </button>
          </div>
        ) : (
          <>
            <div className="muted small" style={{ marginBottom: 10 }}>
              저장된 서버 {instances.length}개
            </div>
            <div className="instance-list">
              {instances.map((instance) => {
                const active = status?.instanceId === instance.id && status.state !== 'stopped'
                const size = sizes[instance.id]
                return (
                  <div key={instance.id} className="instance" onClick={() => onOpen(instance.id)}>
                    <span
                      className={`dot ${
                        active
                          ? status?.state === 'running'
                            ? 'running'
                            : status?.state === 'crashed'
                              ? 'crashed'
                              : 'busy'
                          : ''
                      }`}
                    />
                    <div className="grow">
                      <div className="name">{instance.name}</div>
                      <div className="muted small">
                        마인크래프트 {instance.mcVersion} ·{' '}
                        {LOADER_LABEL[instance.loader.type] ?? instance.loader.type}
                        {instance.loader.version ? ` ${instance.loader.version}` : ''} · 메모리{' '}
                        {(instance.memoryMb / 1024).toFixed(1)}GB
                        {size !== undefined ? ` · 용량 ${formatSize(size)}` : ''}
                      </div>
                    </div>
                    {active && (
                      <span className="badge">
                        {status?.state === 'running'
                          ? '실행 중'
                          : status?.state === 'crashed'
                            ? '멈춤'
                            : '준비 중'}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {pathInfo && (
          <div className="card" style={{ marginTop: 18 }}>
            <h2>
              서버 파일 저장 위치 <span className="sub">월드와 모드가 여기 들어갑니다</span>
            </h2>
            <div className="row">
              <div className="grow muted small" style={{ wordBreak: 'break-all' }}>
                {pathInfo.root}
              </div>
              <button
                className="btn"
                onClick={() => void window.api.system.openFolder(pathInfo.root)}
              >
                폴더 열기
              </button>
            </div>
          </div>
        )}

        {orphans.length > 0 && (
          <div className="card">
            <h2>
              쓰이지 않는 서버 폴더 <span className="sub">설치가 중간에 끊겼을 때 남습니다</span>
            </h2>
            {orphans.map((o) => (
              <div key={o.name} className="row" style={{ padding: '6px 0' }}>
                <div className="grow small" style={{ wordBreak: 'break-all' }}>
                  {o.name} <span className="muted">({formatSize(o.size)})</span>
                </div>
                <button
                  className="btn ghost danger"
                  onClick={() => {
                    void window.api.instances
                      .removeOrphan(o.name)
                      .then(refreshDisk)
                      .catch((e: Error) => setDiskError(e.message))
                  }}
                >
                  지우기
                </button>
              </div>
            ))}
          </div>
        )}

        {diskError && (
          <div className="notice warn" style={{ marginTop: 18, whiteSpace: 'pre-wrap' }}>
            {diskError}
          </div>
        )}

        {pathInfo?.nonAscii && (
          <div className="notice warn" style={{ marginTop: 18 }}>
            서버 파일 경로에 한글이 섞여 있어 일부 모드가 오작동할 수 있습니다. 경로: {pathInfo.root}
          </div>
        )}

        <div className="disclaimer">
          <div className="credit">
            {APP_TITLE} v{APP_VERSION} · {STUDIO} 제작
          </div>
          <div className="credit">
            만든이 {AUTHOR} · <span className="selectable">{CONTACT}</span>
          </div>
          <div style={{ marginTop: 10 }}>{MOJANG_DISCLAIMER}</div>
          <div>{MOJANG_DISCLAIMER_KO}</div>
        </div>
      </div>
    </div>
  )
}
