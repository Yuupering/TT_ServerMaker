import { readFile, writeFile } from 'node:fs/promises'

/**
 * servers.dat 읽고 쓰기.
 *
 * 마인크래프트 서버 목록은 NBT라는 형식으로 저장된다. 이 파일은 압축돼 있지 않아서
 * 필요한 만큼만 직접 다루면 된다. 여기서 쓰는 태그는 문자열·목록·묶음 정도다.
 */

const TAG_END = 0
const TAG_BYTE = 1
const TAG_SHORT = 2
const TAG_INT = 3
const TAG_LONG = 4
const TAG_FLOAT = 5
const TAG_DOUBLE = 6
const TAG_BYTE_ARRAY = 7
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10
const TAG_INT_ARRAY = 11
const TAG_LONG_ARRAY = 12

export interface ServerEntry {
  name: string
  ip: string
  /** 서버 아이콘 (base64 png). 있으면 그대로 보존한다 */
  icon?: string
  acceptTextures?: number
  hidden?: number
}

/* ---------- 읽기 ---------- */

class Reader {
  private offset = 0
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buf.length
  }

  u8(): number {
    return this.buf.readUInt8(this.offset++)
  }
  i16(): number {
    const v = this.buf.readInt16BE(this.offset)
    this.offset += 2
    return v
  }
  i32(): number {
    const v = this.buf.readInt32BE(this.offset)
    this.offset += 4
    return v
  }
  skip(n: number): void {
    this.offset += n
  }
  string(): string {
    const len = this.buf.readUInt16BE(this.offset)
    this.offset += 2
    const s = this.buf.toString('utf8', this.offset, this.offset + len)
    this.offset += len
    return s
  }

  /** 값 하나를 읽는다. 우리가 쓰지 않는 종류는 건너뛰기만 한다 */
  value(type: number): unknown {
    switch (type) {
      case TAG_BYTE:
        return this.u8()
      case TAG_SHORT:
        return this.i16()
      case TAG_INT:
        return this.i32()
      case TAG_LONG:
        this.skip(8)
        return null
      case TAG_FLOAT:
        this.skip(4)
        return null
      case TAG_DOUBLE:
        this.skip(8)
        return null
      case TAG_BYTE_ARRAY:
        this.skip(this.i32())
        return null
      case TAG_STRING:
        return this.string()
      case TAG_LIST: {
        const itemType = this.u8()
        const count = this.i32()
        const items: unknown[] = []
        for (let i = 0; i < count; i++) items.push(this.value(itemType))
        return items
      }
      case TAG_COMPOUND: {
        const obj: Record<string, unknown> = {}
        for (;;) {
          const t = this.u8()
          if (t === TAG_END) break
          const key = this.string()
          obj[key] = this.value(t)
        }
        return obj
      }
      case TAG_INT_ARRAY:
        this.skip(this.i32() * 4)
        return null
      case TAG_LONG_ARRAY:
        this.skip(this.i32() * 8)
        return null
      default:
        throw new Error(`알 수 없는 NBT 태그: ${type}`)
    }
  }
}

export async function readServers(file: string): Promise<ServerEntry[]> {
  const buf = await readFile(file).catch(() => null)
  if (!buf || buf.length === 0) return []

  try {
    const reader = new Reader(buf)
    const rootType = reader.u8()
    if (rootType !== TAG_COMPOUND) return []
    reader.string() // 루트 이름 (보통 빈 문자열)

    const root = reader.value(TAG_COMPOUND) as Record<string, unknown>
    const list = root.servers
    if (!Array.isArray(list)) return []

    return list.map((item) => {
      const o = item as Record<string, unknown>
      return {
        name: String(o.name ?? ''),
        ip: String(o.ip ?? ''),
        icon: typeof o.icon === 'string' ? o.icon : undefined,
        acceptTextures: typeof o.acceptTextures === 'number' ? o.acceptTextures : undefined,
        hidden: typeof o.hidden === 'number' ? o.hidden : undefined
      }
    })
  } catch {
    // 형식이 예상과 다르면 건드리지 않는 편이 안전하다
    return []
  }
}

/* ---------- 쓰기 ---------- */

function writeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(body.length, 0)
  return Buffer.concat([head, body])
}

function namedTag(type: number, name: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), writeString(name), payload])
}

function serverCompound(entry: ServerEntry): Buffer {
  const parts: Buffer[] = []

  // 마인크래프트가 읽는 순서는 상관없지만, 원래 있던 값은 최대한 보존한다
  if (entry.icon) parts.push(namedTag(TAG_STRING, 'icon', writeString(entry.icon)))
  parts.push(namedTag(TAG_STRING, 'ip', writeString(entry.ip)))
  parts.push(namedTag(TAG_STRING, 'name', writeString(entry.name)))
  if (entry.acceptTextures !== undefined) {
    parts.push(namedTag(TAG_BYTE, 'acceptTextures', Buffer.from([entry.acceptTextures])))
  }
  if (entry.hidden !== undefined) {
    parts.push(namedTag(TAG_BYTE, 'hidden', Buffer.from([entry.hidden])))
  }

  parts.push(Buffer.from([TAG_END]))
  return Buffer.concat(parts)
}

export async function writeServers(file: string, entries: ServerEntry[]): Promise<void> {
  const items = entries.map(serverCompound)

  const listHeader = Buffer.alloc(5)
  listHeader.writeUInt8(TAG_COMPOUND, 0)
  listHeader.writeInt32BE(items.length, 1)

  const serversTag = namedTag(TAG_LIST, 'servers', Buffer.concat([listHeader, ...items]))

  const root = Buffer.concat([
    Buffer.from([TAG_COMPOUND]),
    writeString(''),
    serversTag,
    Buffer.from([TAG_END])
  ])

  await writeFile(file, root)
}

/**
 * 서버 목록에 하나 추가한다.
 * 같은 주소가 이미 있으면 이름만 갱신하고 중복해서 넣지 않는다.
 */
export async function addServerToList(file: string, entry: ServerEntry): Promise<void> {
  const list = await readServers(file)
  const idx = list.findIndex((s) => s.ip.toLowerCase() === entry.ip.toLowerCase())

  if (idx >= 0) list[idx] = { ...list[idx], ...entry }
  else list.push(entry)

  await writeServers(file, list)
}
