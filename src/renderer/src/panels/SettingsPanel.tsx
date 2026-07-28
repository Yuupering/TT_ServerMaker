import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, Instance } from '@shared/types'
import PropertiesEditor from './PropertiesEditor'

interface Props {
  instance: Instance
  running: boolean
  onDeleted: () => void
}

export default function SettingsPanel({ instance, running, onDeleted }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [memory, setMemory] = useState(instance.memoryMb)
  const [memoryRange, setMemoryRange] = useState({ recommended: 4096, max: 8192 })
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [antivirus, setAntivirus] = useState<{ dataRoot: string; command: string } | null>(null)

  useEffect(() => {
    // 설정을 못 읽으면 조용히 비워두지 않고 이유를 보여준다 (파일 손상 등)
    void window.api.settings
      .get()
      .then(setSettings)
      .catch((e: Error) => setError(e.message))
    void window.api.system.memory().then(setMemoryRange).catch(() => undefined)
    void window.api.system.antivirusHint().then(setAntivirus).catch(() => undefined)
  }, [instance.id])

  const flash = useCallback(() => {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }, [])

  const saveMemory = useCallback(
    async (mb: number) => {
      try {
        await window.api.instances.update(instance.id, { memoryMb: mb })
        flash()
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [instance.id, flash]
  )

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await window.api.settings.set(patch).catch((e: Error) => {
        setError(e.message)
        return null
      })
      if (next) {
        setSettings(next)
        flash()
      }
    },
    [flash]
  )

  return (
    <div className="content">
      {saved && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          저장했습니다{running ? ' (일부 항목은 서버를 껐다 켜야 적용됩니다)' : ''}
        </div>
      )}

      <div className="card">
        <h2>
          서버 메모리 <span className="sub">모드팩이 무거우면 늘려 주세요</span>
        </h2>
        <div className="row">
          <input
            type="range"
            min={2048}
            max={memoryRange.max}
            step={512}
            value={memory}
            style={{ flex: 1 }}
            onChange={(e) => setMemory(Number(e.target.value))}
            onMouseUp={() => void saveMemory(memory)}
            onKeyUp={() => void saveMemory(memory)}
          />
          <span style={{ minWidth: 70, textAlign: 'right' }}>{(memory / 1024).toFixed(1)}GB</span>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          이 PC 기준 권장값은 {(memoryRange.recommended / 1024).toFixed(1)}GB입니다. 너무 크게 주면
          컴퓨터 전체가 느려집니다.
        </div>
      </div>

      <PropertiesEditor instanceId={instance.id} running={running} />

      {settings && (
        <div className="card">
          <h2>앱 동작</h2>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.autoRestart}
              onChange={(e) => void patchSettings({ autoRestart: e.target.checked })}
            />
            <span>서버가 갑자기 꺼지면 자동으로 다시 켜기</span>
          </label>

          <label className="field" style={{ marginTop: 12 }}>
            <span>자동 백업 주기</span>
            <select
              value={settings.backupIntervalMin}
              onChange={(e) => void patchSettings({ backupIntervalMin: Number(e.target.value) })}
            >
              <option value={0}>사용 안 함</option>
              <option value={30}>30분마다</option>
              <option value={60}>1시간마다</option>
              <option value={180}>3시간마다</option>
              <option value={360}>6시간마다</option>
            </select>
          </label>

          <label className="field">
            <span>백업 보관 개수</span>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.backupKeep}
              onChange={(e) => void patchSettings({ backupKeep: Number(e.target.value) })}
            />
          </label>
        </div>
      )}

      <div className="card">
        <h2>
          백신이 서버 파일을 막을 때 <span className="sub">자바 설치나 서버 실행이 자꾸 실패하면</span>
        </h2>

        <div className="muted small" style={{ marginBottom: 12 }}>
          백신이 자바나 서버가 쓰는 파일을 검사하면서 내용을 바꿔버리는 경우가 있습니다. 압축이
          안 풀리거나 &quot;Hash check failed&quot; 오류가 나면 대부분 이 문제입니다. 아래 명령을
          관리자 권한 PowerShell에 붙여넣으면 Windows Defender 검사에서 서버 폴더가 빠집니다.
        </div>

        {antivirus && (
          <div className="row" style={{ marginBottom: 12 }}>
            <code
              className="grow"
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '9px 12px',
                fontSize: 12.5,
                wordBreak: 'break-all',
                userSelect: 'all'
              }}
            >
              {antivirus.command}
            </code>
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(antivirus.command)
                flash()
              }}
            >
              복사
            </button>
          </div>
        )}

        <div className="muted small" style={{ marginBottom: 12 }}>
          알약이나 V3 같은 다른 백신을 쓰신다면 그 프로그램의 설정에서도 위 폴더를 검사 예외로
          넣어야 합니다. 예외 등록을 마친 뒤에는 이미 망가진 파일을 지워야 새로 받아옵니다.
        </div>

        <button
          className="btn"
          disabled={busy || running}
          onClick={() => {
            setBusy(true)
            void window.api.system
              .clearDamaged(instance.id)
              .then(() => flash())
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(false))
          }}
        >
          망가진 파일 지우고 다시 받기
        </button>
        {running && (
          <span className="muted small" style={{ marginLeft: 10 }}>
            서버를 끈 뒤에 눌러 주세요
          </span>
        )}
      </div>

      <div className="card">
        <h2>서버 파일</h2>
        <div className="row wrap">
          <button className="btn" onClick={() => void window.api.system.openFolder(instance.dir)}>
            서버 폴더 열기
          </button>
          <button
            className="btn"
            onClick={() => void window.api.system.openFolder(`${instance.dir}\\mods`)}
          >
            모드 폴더 열기
          </button>
        </div>
        <div className="muted small" style={{ marginTop: 10, wordBreak: 'break-all' }}>
          {instance.dir}
        </div>
      </div>

      <div className="card">
        <h2>서버 삭제</h2>
        <div className="muted small" style={{ marginBottom: 12 }}>
          월드와 모드까지 전부 지웁니다. 되돌릴 수 없습니다.
        </div>
        <button className="btn danger" disabled={running} onClick={() => setConfirmDelete(true)}>
          이 서버 삭제
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}

      {confirmDelete && (
        <div className="overlay" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>정말 삭제할까요?</h2>
            <p className="muted">
              {instance.name}의 월드, 모드, 설정이 모두 사라집니다. 백업 파일도 함께 지워지지는
              않지만, 월드를 되살리려면 먼저 백업을 다른 곳에 복사해 두세요.
            </p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                취소
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  void window.api.instances
                    .remove(instance.id, true)
                    .then(onDeleted)
                    .catch((e: Error) => {
                      setError(e.message)
                      setConfirmDelete(false)
                    })
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
