import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Instance,
  JavaAvailability,
  LoaderType,
  PackSearchResult,
  PackVersion,
  ProgressEvent,
  ServerFileInfo
} from '@shared/types'

interface Props {
  onCancel: () => void
  onCreated: (instance: Instance) => void
}

type Source = 'modrinth' | 'file' | 'direct'

const EULA_URL = 'https://aka.ms/MinecraftEULA'

const SOURCES: { id: Source; title: string; desc: string }[] = [
  {
    id: 'modrinth',
    title: '모드팩 서버 열기',
    desc: '인기 모드팩을 검색해서 바로 설치합니다'
  },
  {
    id: 'file',
    title: '내 컴퓨터에서 가져오기',
    desc: '가지고 있는 모드팩 파일이나 서버 폴더를 씁니다'
  },
  {
    id: 'direct',
    title: '마인크래프트 서버 열기',
    desc: '서버 종류와 버전을 직접 골라 새로 만듭니다'
  }
]

const LOADER_HELP: Record<LoaderType, string> = {
  paper: '플러그인 서버 중 가장 널리 쓰입니다. Spigot·Bukkit 플러그인이 그대로 돌아가고 더 빠릅니다.',
  spigot: 'Bukkit 계열 플러그인 서버. 오래된 플러그인 호환이 필요할 때만 고르면 됩니다.',
  craftbukkit: '가장 오래된 플러그인 서버. 특별한 이유가 없으면 Paper가 낫습니다.',
  fabric: '가벼운 모드 로더. 최적화 모드 위주라면 이쪽입니다.',
  neoforge: 'Forge에서 갈라져 나온 모드 로더. 1.20.2 이후 모드가 많이 옮겨갔습니다.',
  forge: '가장 오래된 모드 로더. 예전 모드팩은 대부분 이쪽입니다.',
  quilt: 'Fabric에서 갈라져 나온 모드 로더.',
  vanilla: '모드도 플러그인도 없는 기본 서버입니다.'
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export default function Create({ onCancel, onCreated }: Props): React.JSX.Element {
  const [source, setSource] = useState<Source>('modrinth')
  const [name, setName] = useState('')
  const [eula, setEula] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [installing, setInstalling] = useState(false)

  /* 모드팩 검색 */
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PackSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [pack, setPack] = useState<PackSearchResult | null>(null)
  const [versions, setVersions] = useState<PackVersion[]>([])
  const [versionId, setVersionId] = useState<string>('')

  /* 내 컴퓨터에서 가져오기 */
  const [filePath, setFilePath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  /* 직접 고르기 */
  const [mcVersions, setMcVersions] = useState<string[]>([])
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState<LoaderType>('paper')
  const [versionsLoading, setVersionsLoading] = useState(false)

  /*
   * 서버 파일은 사용자가 직접 받아서 넣는 것을 기본으로 한다.
   * 서명 없는 앱이 받은 파일은 백신이 내용을 손대는 경우가 있어서,
   * 브라우저로 받은 파일을 쓰는 쪽이 훨씬 안전하다.
   */
  const [autoDownload, setAutoDownload] = useState(false)
  const [serverFile, setServerFile] = useState<string | null>(null)
  const [fileInfo, setFileInfo] = useState<ServerFileInfo | null>(null)
  const [fileInfoLoading, setFileInfoLoading] = useState(false)
  const [dragging, setDragging] = useState(false)

  /* 자바 */
  const [java, setJava] = useState<JavaAvailability | null>(null)
  const [javaChecking, setJavaChecking] = useState(false)

  useEffect(() => {
    return window.api.events.onProgress(setProgress)
  }, [])

  /* 모드팩 검색 (입력이 멈춘 뒤에 요청한다) */
  useEffect(() => {
    if (source !== 'modrinth') return
    let cancelled = false
    setSearching(true)

    const timer = setTimeout(() => {
      window.api.packs
        .search(query)
        .then((r) => {
          if (!cancelled) setResults(r)
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 350)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, source])

  /* 서버 종류마다 열 수 있는 마인크래프트 버전이 다르다 */
  useEffect(() => {
    if (source !== 'direct') return
    let cancelled = false
    setVersionsLoading(true)

    const fetchVersions =
      loader === 'paper' ? window.api.packs.paperVersions() : window.api.packs.vanillaVersions()

    fetchVersions
      .then((list) => {
        if (cancelled) return
        setMcVersions(list)
        // 고르던 버전이 새 목록에도 있으면 유지한다
        setMcVersion((prev) => (prev && list.includes(prev) ? prev : (list[0] ?? '')))
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [source, loader])

  /* 어떤 파일을 어디서 받아야 하는지 */
  useEffect(() => {
    if (source !== 'direct' || autoDownload || !mcVersion) {
      setFileInfo(null)
      return
    }
    let cancelled = false
    setFileInfoLoading(true)

    window.api.packs
      .serverFileInfo(loader, mcVersion)
      .then((info) => {
        if (!cancelled) setFileInfo(info)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setFileInfoLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [source, autoDownload, loader, mcVersion])

  /* 서버 종류나 버전이 바뀌면 넣어둔 파일은 더 이상 맞지 않는다 */
  useEffect(() => {
    setServerFile(null)
  }, [loader, mcVersion])

  /*
   * 고른 버전에 따라 필요한 자바가 다르다.
   * 이미 설치된 자바가 있으면 그걸 쓰고, 없으면 정식 설치를 먼저 권한다.
   */
  const targetMcVersion = useMemo(() => {
    if (source === 'direct') return mcVersion
    if (source === 'modrinth') {
      return versions.find((x) => x.id === versionId)?.mcVersions[0] ?? ''
    }
    return ''
  }, [source, mcVersion, versions, versionId])

  const refreshJava = useCallback(async () => {
    if (!targetMcVersion) {
      setJava(null)
      return
    }
    setJavaChecking(true)
    try {
      setJava(await window.api.system.javaCheck(targetMcVersion))
    } catch {
      setJava(null)
    } finally {
      setJavaChecking(false)
    }
  }, [targetMcVersion])

  useEffect(() => {
    void refreshJava()
  }, [refreshJava])

  const selectPack = useCallback(
    async (p: PackSearchResult) => {
      setPack(p)
      setVersions([])
      setVersionId('')
      if (!name.trim()) setName(p.title)

      try {
        const list = await window.api.packs.versions(p.id)
        // 서버로 돌릴 수 있는 정식 버전을 먼저 보여준다
        const sorted = [...list].sort((a, b) => b.datePublished.localeCompare(a.datePublished))
        setVersions(sorted)
        setVersionId(sorted.find((v) => v.channel === 'release')?.id ?? sorted[0]?.id ?? '')
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [name]
  )

  /** 파일을 고르든 끌어다 놓든 같은 처리를 탄다 */
  const useFile = useCallback(
    (path: string) => {
      setFilePath(path)
      if (!name.trim()) {
        setName(fileName(path).replace(/\.(mrpack|zip)$/i, ''))
      }
    },
    [name]
  )

  const pickFile = useCallback(async () => {
    const path = await window.api.packs.pickFile()
    if (path) useFile(path)
  }, [useFile])

  const pickFolder = useCallback(async () => {
    const path = await window.api.packs.pickFolder()
    if (!path) return
    setFilePath(path)
    if (!name.trim()) setName(fileName(path))
  }, [name])

  const dropServerFile = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    try {
      setServerFile(window.api.addons.pathOf(f))
      setError(null)
    } catch {
      setError('파일 경로를 읽지 못했습니다')
    }
  }, [])

  /** 아직 만들 수 없다면 그 이유를 알려준다 (버튼만 비활성이면 이유를 알 수 없다) */
  const blocker = useMemo(() => {
    if (source === 'modrinth' && !pack) return '모드팩을 골라 주세요'
    if (source === 'modrinth' && !versionId) return '모드팩 버전을 골라 주세요'
    if (source === 'file' && !filePath) return '가져올 파일이나 폴더를 골라 주세요'
    if (source === 'direct' && !mcVersion) return '마인크래프트 버전을 골라 주세요'
    if (source === 'direct' && !autoDownload && !serverFile) return '서버 파일을 넣어 주세요'
    if (!name.trim()) return '서버 이름을 입력해 주세요'
    if (!eula) return '마인크래프트 이용약관에 동의해 주세요'
    return null
  }, [source, pack, versionId, filePath, mcVersion, name, eula, autoDownload, serverFile])

  /** 준비된 것들을 한 줄로 요약해 액션 바에 보여준다 */
  const readySummary = useMemo(() => {
    const parts: string[] = []
    if (java?.ready) parts.push(`자바 ${java.major} 준비됨`)
    else if (java) parts.push(`자바 ${java.major} 없음 (앱이 받아서 씁니다)`)
    if (source === 'direct' && !autoDownload && serverFile) parts.push('서버 파일 확인됨')
    return parts.join(' · ')
  }, [java, source, autoDownload, serverFile])

  const install = useCallback(async () => {
    setError(null)
    setInstalling(true)
    setProgress(null)

    try {
      let instance: Instance
      if (source === 'modrinth' && pack) {
        instance = await window.api.instances.createFromModrinth({
          projectId: pack.id,
          versionId,
          name: name.trim()
        })
      } else if (source === 'file' && filePath) {
        instance = await window.api.instances.createFromFile({
          path: filePath,
          name: name.trim()
        })
      } else {
        instance = await window.api.instances.createVanilla({
          mcVersion,
          loader,
          name: name.trim(),
          serverFile: autoDownload ? null : serverFile
        })
      }
      onCreated(instance)
    } catch (e) {
      setError((e as Error).message)
      setInstalling(false)
    }
  }, [source, pack, versionId, filePath, mcVersion, loader, name, onCreated, autoDownload, serverFile])

  if (installing) {
    return (
      <div className="app">
        <div className="topbar">
          <h1>서버 만드는 중</h1>
        </div>
        <div className="content">
          <div className="card">
            <h2>{name}</h2>
            <div className={`progress ${progress?.ratio === null ? 'indeterminate' : ''}`}>
              <div style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }} />
            </div>
            <div className="muted small" style={{ marginTop: 10 }}>
              {progress?.message ?? '준비하는 중…'}
            </div>
          </div>

          {error && (
            <div className="notice error" style={{ whiteSpace: 'pre-line' }}>
              {error}
            </div>
          )}

          {error ? (
            <button className="btn" onClick={() => setInstalling(false)}>
              돌아가서 다시 시도
            </button>
          ) : (
            <div className="muted small">
              모드팩 크기에 따라 몇 분 걸릴 수 있습니다. 창을 닫지 말고 기다려 주세요.
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="topbar">
        <button className="btn ghost" onClick={onCancel}>
          ← 뒤로
        </button>
        <h1>새 서버 만들기</h1>
      </div>

      <div className="content">
        <div className="card">
          <h2>무엇으로 서버를 열까요?</h2>
          <div className="source-grid">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={`source ${source === s.id ? 'selected' : ''}`}
                onClick={() => setSource(s.id)}
              >
                <div className="source-title">{s.title}</div>
                <div className="source-desc">{s.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {source === 'modrinth' && (
          <div className="card">
            <input
              type="text"
              placeholder="모드팩 이름으로 검색 (비워두면 인기 팩)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            {searching && (
              <div className="muted small" style={{ marginTop: 10 }}>
                찾는 중…
              </div>
            )}

            {!searching && results.length === 0 && (
              <div className="muted small" style={{ marginTop: 10 }}>
                검색 결과가 없습니다. 다른 이름으로 찾아보거나, 가진 파일이 있다면 위에서
                &quot;내 컴퓨터에서 가져오기&quot;를 골라 주세요.
              </div>
            )}

            <div className="pack-grid">
              {results.map((r) => (
                <button
                  key={r.id}
                  className={`pack ${pack?.id === r.id ? 'selected' : ''}`}
                  onClick={() => void selectPack(r)}
                >
                  {r.iconUrl ? <img src={r.iconUrl} alt="" /> : <div className="pack-icon" />}
                  <div className="grow">
                    <div className="title">{r.title}</div>
                    <div className="desc">{r.description}</div>
                  </div>
                </button>
              ))}
            </div>

            {pack && (
              <label className="field" style={{ marginTop: 16 }}>
                <span>{pack.title} 버전</span>
                <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.versionNumber} · 마인크래프트 {v.mcVersions.join(', ')}
                      {v.channel !== 'release' ? ` (${v.channel})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {source === 'file' && (
          <div className="card">
            <h2>
              가진 파일로 만들기
              <span className="sub">.mrpack, CurseForge 서버팩 zip, 서버 폴더</span>
            </h2>
            <div
              className={`dropzone ${dragOver ? 'over' : ''} ${filePath ? 'filled' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)

                const file = e.dataTransfer.files[0]
                if (!file) return

                // Electron 32부터 File.path가 사라져서 preload를 거쳐 경로를 얻는다
                const path = window.api.addons.pathOf(file)
                if (!path) return

                if (!/\.(mrpack|zip)$/i.test(path)) {
                  setError('.mrpack이나 zip 파일을 넣어 주세요. 폴더는 아래 버튼으로 골라 주세요.')
                  return
                }
                setError(null)
                useFile(path)
              }}
            >
              {filePath ? (
                <>
                  <div style={{ wordBreak: 'break-all' }}>{fileName(filePath)}</div>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    다른 걸 넣으려면 여기에 다시 끌어다 놓으세요
                  </div>
                </>
              ) : (
                <>
                  <div>모드팩 파일을 여기에 끌어다 놓으세요</div>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    .mrpack 또는 CurseForge 서버팩 zip
                  </div>
                </>
              )}
            </div>

            <div className="row wrap">
              <button className="btn" onClick={() => void pickFile()}>
                파일 선택
              </button>
              <button className="btn" onClick={() => void pickFolder()}>
                폴더 선택
              </button>
              <div className="grow muted small" style={{ wordBreak: 'break-all' }}>
                {filePath ?? '선택된 항목이 없습니다'}
              </div>
            </div>
            <div className="notice info" style={{ marginTop: 14 }}>
              CurseForge 모드팩이라면 팩 페이지의 Files 탭에서 Server Pack을 받아 주세요.
              서버 파일(jar) 하나만 가지고 계시다면 위에서 &quot;마인크래프트 서버 열기&quot;를
              골라 주세요.
            </div>
          </div>
        )}

        {source === 'direct' && (
          <>
            <div className="card">
              <div className="grid-2">
                <label className="field">
                  <span>서버 종류</span>
                  <select value={loader} onChange={(e) => setLoader(e.target.value as LoaderType)}>
                    <optgroup label="플러그인 서버">
                      <option value="paper">Paper (권장)</option>
                      <option value="spigot">Spigot</option>
                      <option value="craftbukkit">CraftBukkit</option>
                    </optgroup>
                    <optgroup label="모드 서버">
                      <option value="fabric">Fabric</option>
                      <option value="neoforge">NeoForge</option>
                      <option value="forge">Forge</option>
                      <option value="quilt">Quilt</option>
                    </optgroup>
                    <optgroup label="그 외">
                      <option value="vanilla">순정 (아무것도 없음)</option>
                    </optgroup>
                  </select>
                </label>
                <label className="field">
                  <span>마인크래프트 버전</span>
                  <select
                    value={mcVersion}
                    disabled={versionsLoading}
                    onChange={(e) => setMcVersion(e.target.value)}
                  >
                    {versionsLoading ? (
                      <option>불러오는 중…</option>
                    ) : (
                      mcVersions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>

              <div className="muted small">{LOADER_HELP[loader]}</div>

              {(loader === 'spigot' || loader === 'craftbukkit') && (
                <div className="notice warn" style={{ marginTop: 12 }}>
                  배포 규정상 완성된 파일을 받을 수 없어 이 PC에서 직접 빌드합니다. 10~20분 걸리고
                  그동안 창을 닫으면 안 됩니다. 플러그인 호환은 같으면서 훨씬 빠른 Paper를
                  권합니다.
                </div>
              )}
            </div>

            <div className="card">
              <div className="row" style={{ marginBottom: 12 }}>
                <h2 className="grow" style={{ margin: 0 }}>
                  서버 파일 넣기
                  {fileInfo?.size ? (
                    <span className="sub">{(fileInfo.size / 1024 / 1024).toFixed(0)}MB</span>
                  ) : null}
                </h2>
                <label className="checkbox" style={{ padding: 0 }}>
                  <input
                    type="checkbox"
                    checked={autoDownload}
                    onChange={(e) => setAutoDownload(e.target.checked)}
                  />
                  <span className="small">앱이 대신 받기</span>
                </label>
              </div>

              {autoDownload ? (
                <div className="notice warn">
                  앱이 서버 파일을 직접 받습니다. 편하지만, 백신이 앱이 받은 파일을 검사하다 내용을
                  바꿔놓으면 설치나 실행이 실패할 수 있습니다. 그럴 때는 이 체크를 끄고 직접 받아
                  넣어 주세요.
                </div>
              ) : (
                <>
                  {fileInfoLoading && <div className="muted small">받을 파일을 확인하는 중…</div>}

                  {fileInfo && !fileInfo.supported && (
                    <div className="notice warn">{fileInfo.hint}</div>
                  )}

                  {fileInfo && fileInfo.supported && (
                    <>
                      <div className="filespec">
                        <div>
                          <div className="filespec-label">필요한 파일</div>
                          <div className="filespec-name">{fileInfo.filename}</div>
                          <div className="muted small">{fileInfo.label}</div>
                        </div>
                        <button
                          className="btn primary"
                          onClick={() => void window.api.system.openExternal(fileInfo.url)}
                        >
                          받으러 가기
                        </button>
                      </div>

                      <div
                        className={`dropzone ${dragging ? 'over' : ''} ${serverFile ? 'filled' : ''}`}
                        onDragOver={(e) => {
                          e.preventDefault()
                          setDragging(true)
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={dropServerFile}
                      >
                        {serverFile ? (
                          <>
                            <div className="dropzone-title">{fileName(serverFile)}</div>
                            <div className="muted small">넣을 준비가 됐습니다</div>
                            <button
                              className="btn ghost small"
                              style={{ marginTop: 10 }}
                              onClick={() => setServerFile(null)}
                            >
                              다른 파일 넣기
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="dropzone-title">
                              받은 파일을 여기에 끌어다 놓으세요
                            </div>
                            <div className="muted small">{fileInfo.hint}</div>
                            <button
                              className="btn"
                              style={{ marginTop: 12 }}
                              onClick={() => {
                                void window.api.packs
                                  .pickServerFile()
                                  .then((p) => {
                                    if (p) setServerFile(p)
                                  })
                                  .catch(() => undefined)
                              }}
                            >
                              파일 선택
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}

        <div className="card">
          <label className="field">
            <span>서버 이름</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="친구들과 할 서버"
            />
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} />
            <span>마인크래프트 이용약관(EULA)에 동의합니다</span>
          </label>
          <button
            className="btn ghost link small"
            style={{ marginLeft: 26 }}
            onClick={() => void window.api.system.openExternal(EULA_URL)}
          >
            약관 내용 보기
          </button>
        </div>

        {java && !java.ready && (
          <div className="card">
            <h2>
              자바 {java.major} 설치가 필요합니다{' '}
              <span className="sub">마인크래프트 {targetMcVersion}용</span>
            </h2>

            <div className="muted small" style={{ marginBottom: 14 }}>
              받은 파일을 실행하고 계속 누르면 끝납니다. 설치하지 않고 진행하면 앱이 자바를 직접
              받아서 쓰는데, 백신이 막으면 실패할 수 있습니다.
            </div>

            <div className="row wrap">
              <button
                className="btn primary"
                onClick={() => void window.api.system.openExternal(java.installerUrl)}
              >
                설치 파일 받기
              </button>
              <button className="btn" disabled={javaChecking} onClick={() => void refreshJava()}>
                {javaChecking ? '확인 중…' : '설치했습니다 · 다시 확인'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="notice error" style={{ whiteSpace: 'pre-line' }}>
            {error}
          </div>
        )}
      </div>

      <div className="actionbar">
        <div className="grow muted small">{blocker ?? readySummary}</div>
        <button className="btn" onClick={onCancel}>
          취소
        </button>
        <button className="btn primary" disabled={Boolean(blocker)} onClick={() => void install()}>
          서버 만들기
        </button>
      </div>
    </div>
  )
}
