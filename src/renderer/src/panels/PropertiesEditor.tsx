import { useCallback, useEffect, useState } from 'react'
import type { ServerProperties } from '@shared/types'

interface Props {
  instanceId: string
  running: boolean
}

type FieldType = 'text' | 'number' | 'bool' | 'select'

interface Field {
  key: keyof ServerProperties
  label: string
  type: FieldType
  desc?: string
  min?: number
  max?: number
  placeholder?: string
  /** 이미 만들어진 월드에는 적용되지 않는 항목 */
  worldOnly?: boolean
}

interface Section {
  title: string
  note?: string
  fields: Field[]
}

const SECTIONS: Section[] = [
  {
    title: '게임 진행',
    fields: [
      { key: 'motd', label: '서버 소개글', type: 'text', desc: '서버 목록에 표시됩니다' },
      { key: 'gamemode', label: '기본 게임 모드', type: 'select' },
      { key: 'difficulty', label: '난이도', type: 'select' },
      {
        key: 'hardcore',
        label: '하드코어',
        type: 'bool',
        desc: '죽으면 관전 모드가 됩니다. 난이도가 어려움으로 고정됩니다'
      },
      {
        key: 'forceGamemode',
        label: '접속할 때마다 기본 모드로 되돌리기',
        type: 'bool'
      },
      { key: 'pvp', label: '플레이어끼리 공격 허용', type: 'bool' },
      { key: 'allowFlight', label: '비행 허용', type: 'bool', desc: '끄면 비행 모드가 튕겨집니다' },
      { key: 'allowNether', label: '네더 사용', type: 'bool' },
      {
        key: 'playerIdleTimeout',
        label: '가만히 있으면 내보내기 (분)',
        type: 'number',
        min: 0,
        max: 1440,
        desc: '0이면 내보내지 않습니다'
      }
    ]
  },
  {
    title: '인원과 거리',
    fields: [
      { key: 'maxPlayers', label: '최대 인원', type: 'number', min: 1, max: 200 },
      {
        key: 'viewDistance',
        label: '시야 거리 (청크)',
        type: 'number',
        min: 3,
        max: 32,
        desc: '높일수록 멀리 보이지만 서버가 무거워집니다'
      },
      {
        key: 'simulationDistance',
        label: '작동 거리 (청크)',
        type: 'number',
        min: 3,
        max: 32,
        desc: '몹과 농작물이 실제로 움직이는 범위입니다'
      },
      {
        key: 'spawnProtection',
        label: '스폰 보호 반경',
        type: 'number',
        min: 0,
        max: 256,
        desc: '관리자가 아니면 이 범위에 건축할 수 없습니다. 0이면 해제'
      }
    ]
  },
  {
    title: '월드',
    note: '월드가 이미 만들어진 뒤에는 이름·시드·종류를 바꿔도 기존 월드에 적용되지 않습니다.',
    fields: [
      { key: 'levelName', label: '월드 폴더 이름', type: 'text', worldOnly: true },
      {
        key: 'levelSeed',
        label: '시드',
        type: 'text',
        placeholder: '비우면 무작위',
        worldOnly: true
      },
      { key: 'levelType', label: '월드 종류', type: 'select', worldOnly: true },
      { key: 'generateStructures', label: '구조물 생성', type: 'bool', worldOnly: true },
      {
        key: 'maxWorldSize',
        label: '월드 최대 반경 (블록)',
        type: 'number',
        min: 1,
        max: 29999984
      },
      { key: 'spawnMonsters', label: '몬스터 생성', type: 'bool' },
      { key: 'spawnAnimals', label: '동물 생성', type: 'bool' },
      { key: 'spawnNpcs', label: '주민 생성', type: 'bool' }
    ]
  },
  {
    title: '리소스팩',
    note: '접속할 때 자동으로 받게 할 리소스팩 주소입니다. 비워두면 쓰지 않습니다.',
    fields: [
      { key: 'resourcePack', label: '리소스팩 주소', type: 'text', placeholder: 'https://…' },
      {
        key: 'resourcePackSha1',
        label: 'SHA1 해시',
        type: 'text',
        desc: '넣어두면 바뀐 팩을 다시 받습니다'
      },
      {
        key: 'requireResourcePack',
        label: '거부하면 접속 차단',
        type: 'bool'
      }
    ]
  },
  {
    title: '성능',
    note: '잘 모르겠으면 그대로 두는 편이 낫습니다.',
    fields: [
      {
        key: 'maxTickTime',
        label: '멈춤 감지 시간 (밀리초)',
        type: 'number',
        min: -1,
        max: 600000,
        desc: '이 시간을 넘게 멈추면 서버가 스스로 종료합니다. -1이면 감시하지 않습니다'
      },
      {
        key: 'networkCompressionThreshold',
        label: '압축 시작 크기 (바이트)',
        type: 'number',
        min: -1,
        max: 65536,
        desc: '-1이면 압축하지 않습니다. 같은 집 안에서만 논다면 꺼도 됩니다'
      },
      {
        key: 'entityBroadcastRangePercentage',
        label: '개체 표시 범위 (%)',
        type: 'number',
        min: 10,
        max: 1000,
        desc: '낮추면 멀리 있는 몹이 덜 보이고 서버가 가벼워집니다'
      },
      {
        key: 'syncChunkWrites',
        label: '청크 저장을 즉시 기록',
        type: 'bool',
        desc: '끄면 빨라지지만 갑작스러운 정전에 약합니다'
      }
    ]
  }
]

export default function PropertiesEditor({ instanceId, running }: Props): React.JSX.Element {
  const [props, setProps] = useState<ServerProperties | null>(null)
  const [choices, setChoices] = useState<Partial<Record<string, string[]>>>({})
  const [open, setOpen] = useState<string | null>('게임 진행')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* 원본 편집 */
  const [rawOpen, setRawOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [rawDirty, setRawDirty] = useState(false)

  useEffect(() => {
    void window.api.props.get(instanceId).then(setProps).catch((e: Error) => setError(e.message))
    void window.api.props.choices().then(setChoices).catch(() => undefined)
  }, [instanceId])

  const flash = useCallback(() => {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }, [])

  const patch = useCallback(
    async (key: keyof ServerProperties, value: string | number | boolean) => {
      if (!props) return
      const next = { ...props, [key]: value } as ServerProperties
      setProps(next)
      try {
        await window.api.props.set(instanceId, next)
        flash()
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [props, instanceId, flash]
  )

  const loadRaw = useCallback(async () => {
    try {
      setRaw(await window.api.props.rawGet(instanceId))
      setRawDirty(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [instanceId])

  const saveRaw = useCallback(async () => {
    setError(null)
    try {
      await window.api.props.rawSet(instanceId, raw)
      setRawDirty(false)
      // 원본을 고쳤으니 위쪽 항목들도 다시 읽어온다
      setProps(await window.api.props.get(instanceId))
      flash()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [instanceId, raw, flash])

  if (!props) {
    return <div className="muted small">설정을 불러오는 중…</div>
  }

  const renderField = (field: Field): React.JSX.Element => {
    const value = props[field.key]

    if (field.type === 'bool') {
      return (
        <div key={field.key}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => void patch(field.key, e.target.checked)}
            />
            <span>{field.label}</span>
          </label>
          {field.desc && (
            <div className="muted small" style={{ marginLeft: 26, marginBottom: 6 }}>
              {field.desc}
            </div>
          )}
        </div>
      )
    }

    if (field.type === 'select') {
      const options = choices[field.key] ?? []
      return (
        <label className="field" key={field.key}>
          <span>{field.label}</span>
          <select
            value={String(value)}
            onChange={(e) => void patch(field.key, e.target.value)}
          >
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {field.desc && <div className="muted small">{field.desc}</div>}
        </label>
      )
    }

    return (
      <label className="field" key={field.key}>
        <span>{field.label}</span>
        {field.type === 'number' ? (
          <input
            type="number"
            min={field.min}
            max={field.max}
            value={Number(value)}
            onChange={(e) => void patch(field.key, Number(e.target.value))}
          />
        ) : (
          <input
            type="text"
            value={String(value)}
            placeholder={field.placeholder}
            onChange={(e) => setProps({ ...props, [field.key]: e.target.value })}
            onBlur={(e) => void patch(field.key, e.target.value)}
          />
        )}
        {field.desc && <div className="muted small">{field.desc}</div>}
      </label>
    )
  }

  return (
    <>
      {saved && (
        <div className="notice info">
          저장했습니다{running ? ' (서버를 껐다 켜야 적용되는 항목이 있습니다)' : ''}
        </div>
      )}
      {error && (
        <div className="notice error" style={{ whiteSpace: 'pre-line' }}>
          {error}
        </div>
      )}

      {SECTIONS.map((section) => {
        const isOpen = open === section.title
        return (
          <div className="card" key={section.title}>
            <button
              className="section-head"
              onClick={() => setOpen(isOpen ? null : section.title)}
            >
              <span className="grow">{section.title}</span>
              <span className="muted small">{isOpen ? '접기' : '펼치기'}</span>
            </button>

            {isOpen && (
              <div style={{ marginTop: 14 }}>
                {section.note && (
                  <div className="notice info" style={{ marginBottom: 14 }}>
                    {section.note}
                  </div>
                )}
                <div className="grid-2">{section.fields.map(renderField)}</div>
              </div>
            )}
          </div>
        )
      })}

      <div className="card">
        <button
          className="section-head"
          onClick={() => {
            const next = !rawOpen
            setRawOpen(next)
            if (next) void loadRaw()
          }}
        >
          <span className="grow">
            원본 파일 직접 고치기 <span className="sub">server.properties</span>
          </span>
          <span className="muted small">{rawOpen ? '접기' : '펼치기'}</span>
        </button>

        {rawOpen && (
          <div style={{ marginTop: 14 }}>
            <div className="muted small" style={{ marginBottom: 10 }}>
              위에 없는 항목까지 전부 고칠 수 있습니다. 형식이 깨지면 서버가 뜨지 않으니
              &quot;이름=값&quot; 모양을 지켜 주세요.
            </div>

            <textarea
              className="raw-editor"
              value={raw}
              spellCheck={false}
              onChange={(e) => {
                setRaw(e.target.value)
                setRawDirty(true)
              }}
            />

            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={!rawDirty} onClick={() => void saveRaw()}>
                저장
              </button>
              <button className="btn ghost" onClick={() => void loadRaw()}>
                되돌리기
              </button>
              {rawDirty && <span className="muted small">저장하지 않은 변경이 있습니다</span>}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
