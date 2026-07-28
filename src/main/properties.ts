import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerProperties } from '@shared/types'
import { APP_TITLE } from '@shared/meta'

/** 지인이 손댈 일이 많은 항목만 GUI로 노출하고, 나머지는 파일 값을 그대로 보존한다 */
const EXPOSED: Record<keyof ServerProperties, string> = {
  port: 'server-port',
  enableStatus: 'enable-status',
  motd: 'motd',
  maxPlayers: 'max-players',
  difficulty: 'difficulty',
  gamemode: 'gamemode',
  pvp: 'pvp',
  onlineMode: 'online-mode',
  viewDistance: 'view-distance',
  simulationDistance: 'simulation-distance',
  allowFlight: 'allow-flight',
  spawnProtection: 'spawn-protection',
  whitelist: 'white-list',

  hardcore: 'hardcore',
  forceGamemode: 'force-gamemode',
  allowNether: 'allow-nether',
  enableCommandBlock: 'enable-command-block',
  playerIdleTimeout: 'player-idle-timeout',

  levelName: 'level-name',
  levelSeed: 'level-seed',
  levelType: 'level-type',
  generateStructures: 'generate-structures',
  maxWorldSize: 'max-world-size',
  spawnMonsters: 'spawn-monsters',
  spawnAnimals: 'spawn-animals',
  spawnNpcs: 'spawn-npcs',

  resourcePack: 'resource-pack',
  resourcePackSha1: 'resource-pack-sha1',
  requireResourcePack: 'require-resource-pack',

  maxTickTime: 'max-tick-time',
  networkCompressionThreshold: 'network-compression-threshold',
  syncChunkWrites: 'sync-chunk-writes',
  entityBroadcastRangePercentage: 'entity-broadcast-range-percentage'
}

/** 값이 정해진 것만 고를 수 있는 항목 */
export const PROPERTY_CHOICES: Partial<Record<keyof ServerProperties, string[]>> = {
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  levelType: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified']
}

const DEFAULTS: ServerProperties = {
  port: 25565,
  enableStatus: true,
  motd: '친구들과 함께하는 모드팩 서버',
  maxPlayers: 10,
  difficulty: 'normal',
  gamemode: 'survival',
  pvp: true,
  onlineMode: true,
  viewDistance: 8,
  simulationDistance: 6,
  allowFlight: true,
  spawnProtection: 0,
  whitelist: false,

  hardcore: false,
  forceGamemode: false,
  allowNether: true,
  // 마인크래프트 기본값도 꺼짐이다. 관리자 권한이 넘어가면 악용될 수 있어 켜지 않는다
  enableCommandBlock: false,
  playerIdleTimeout: 0,

  levelName: 'world',
  levelSeed: '',
  levelType: 'minecraft:normal',
  generateStructures: true,
  maxWorldSize: 29999984,
  spawnMonsters: true,
  spawnAnimals: true,
  spawnNpcs: true,

  resourcePack: '',
  resourcePackSha1: '',
  requireResourcePack: false,

  maxTickTime: 60000,
  networkCompressionThreshold: 256,
  syncChunkWrites: false,
  entityBroadcastRangePercentage: 100
}

function parse(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const idx = line.indexOf('=')
    if (idx < 0) continue
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1))
  }
  return map
}

function propsPath(dir: string): string {
  return join(dir, 'server.properties')
}

export async function readProperties(dir: string): Promise<ServerProperties> {
  const text = await readFile(propsPath(dir), 'utf8').catch(() => '')
  const map = parse(text)

  const num = (key: string, fallback: number): number => {
    const v = Number(map.get(key))
    return Number.isFinite(v) ? v : fallback
  }
  const bool = (key: string, fallback: boolean): boolean => {
    const v = map.get(key)
    return v === undefined ? fallback : v.trim() === 'true'
  }

  /*
   * 항목이 서른 개쯤 되므로 하나씩 나열하지 않는다.
   * 기본값의 타입을 보고 숫자·참거짓·문자열을 알아서 읽는다.
   */
  const result = {} as Record<string, unknown>

  for (const [field, key] of Object.entries(EXPOSED)) {
    const fallback = DEFAULTS[field as keyof ServerProperties]
    if (typeof fallback === 'number') result[field] = num(key, fallback)
    else if (typeof fallback === 'boolean') result[field] = bool(key, fallback)
    else result[field] = map.get(key) ?? fallback
  }

  return result as unknown as ServerProperties
}

/* ---------- 원본 직접 편집 ---------- */

/** server.properties 파일 내용을 그대로 읽는다 */
export async function readRawProperties(dir: string): Promise<string> {
  return readFile(propsPath(dir), 'utf8').catch(() => '')
}

/**
 * 파일을 통째로 덮어쓴다.
 * 손으로 고치다 형식이 깨지면 서버가 뜨지 않으므로, 최소한의 확인은 하고 저장한다.
 */
export async function writeRawProperties(dir: string, text: string): Promise<void> {
  const lines = text.split(/\r?\n/)
  const bad = lines.findIndex((raw) => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) return false
    return !line.includes('=')
  })

  if (bad >= 0) {
    throw new Error(
      `${bad + 1}번째 줄이 "이름=값" 형식이 아닙니다.\n` + `문제가 된 줄: ${lines[bad].trim()}`
    )
  }

  await writeFile(propsPath(dir), text, 'utf8')
}

/** GUI에서 바꾼 값만 갱신하고 나머지 줄은 원본 그대로 유지한다 */
export async function writeProperties(dir: string, props: ServerProperties): Promise<void> {
  const file = propsPath(dir)
  const original = await readFile(file, 'utf8').catch(() => '')
  const lines = original ? original.split(/\r?\n/) : []

  const updates = new Map<string, string>()
  for (const [field, key] of Object.entries(EXPOSED) as [keyof ServerProperties, string][]) {
    updates.set(key, String(props[field]))
  }

  const seen = new Set<string>()
  const out = lines.map((raw) => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) return raw
    const idx = line.indexOf('=')
    if (idx < 0) return raw
    const key = line.slice(0, idx).trim()
    if (!updates.has(key)) return raw
    seen.add(key)
    return `${key}=${updates.get(key)}`
  })

  for (const [key, value] of updates) {
    if (!seen.has(key)) out.push(`${key}=${value}`)
  }

  await writeFile(file, out.join('\n'), 'utf8')
}

/**
 * GUI에 노출하지 않는 항목까지 직접 손봐야 할 때 쓴다.
 * (보호 프록시를 켜면 서버를 루프백에만 묶는 등)
 */
export async function setRawProperties(
  dir: string,
  values: Record<string, string>
): Promise<void> {
  const file = propsPath(dir)
  const original = await readFile(file, 'utf8').catch(() => '')
  const lines = original ? original.split(/\r?\n/) : []
  const seen = new Set<string>()

  const out = lines.map((raw) => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) return raw
    const idx = line.indexOf('=')
    if (idx < 0) return raw
    const key = line.slice(0, idx).trim()
    if (!(key in values)) return raw
    seen.add(key)
    return `${key}=${values[key]}`
  })

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) out.push(`${key}=${value}`)
  }

  await writeFile(file, out.join('\n'), 'utf8')
}

export async function readRawProperty(dir: string, key: string): Promise<string | null> {
  const text = await readFile(propsPath(dir), 'utf8').catch(() => '')
  return parse(text).get(key) ?? null
}

/** 서버가 실제로 열릴 포트 */
export async function readPort(dir: string): Promise<number> {
  const text = await readFile(propsPath(dir), 'utf8').catch(() => '')
  const port = Number(parse(text).get('server-port'))
  return Number.isFinite(port) && port > 0 ? port : 25565
}

export async function writePort(dir: string, port: number): Promise<void> {
  const file = propsPath(dir)
  const original = await readFile(file, 'utf8').catch(() => '')
  const lines = original ? original.split(/\r?\n/) : []
  let replaced = false

  const out = lines.map((raw) => {
    if (raw.trim().startsWith('server-port=')) {
      replaced = true
      return `server-port=${port}`
    }
    return raw
  })

  if (!replaced) out.push(`server-port=${port}`)
  await writeFile(file, out.join('\n'), 'utf8')
}

/** 새 인스턴스에 기본 server.properties를 깔아준다 */
export async function initProperties(dir: string, overrides: Partial<ServerProperties> = {}): Promise<void> {
  const existing = await readFile(propsPath(dir), 'utf8').catch(() => null)
  if (existing !== null) {
    // 모드팩이 들고 온 설정이 있으면 존중하고 노출 항목만 맞춘다
    const current = await readProperties(dir)
    await writeProperties(dir, { ...current, ...overrides })
    return
  }

  const props = { ...DEFAULTS, ...overrides }
  const lines = [
    `# ${APP_TITLE}가 만든 기본 설정입니다.`,
    ...Object.entries(EXPOSED).map(
      ([field, key]) => `${key}=${String(props[field as keyof ServerProperties])}`
    )
  ]
  await writeFile(propsPath(dir), lines.join('\n'), 'utf8')
}

export const defaultProperties = DEFAULTS
