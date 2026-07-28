import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlayerEntry } from '@shared/types'
import { readProperties } from './properties'
import { serverManager } from './server'

interface OpFileEntry extends PlayerEntry {
  level: number
  bypassesPlayerLimit: boolean
}

function dashed(hex: string): string {
  const h = hex.replace(/-/g, '')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 정품 인증을 끈 서버는 닉네임으로 만든 고정 UUID를 쓴다 */
function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  return dashed(hash.toString('hex'))
}

async function lookupUuid(name: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const json = (await res.json()) as { id?: string; name?: string }
    return json.id ? dashed(json.id) : null
  } catch {
    return null
  }
}

async function readJsonList<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

async function writeJsonList(file: string, list: unknown[]): Promise<void> {
  await writeFile(file, JSON.stringify(list, null, 2), 'utf8')
}

function opsFile(dir: string): string {
  return join(dir, 'ops.json')
}

function whitelistFile(dir: string): string {
  return join(dir, 'whitelist.json')
}

export async function listOps(dir: string): Promise<PlayerEntry[]> {
  const list = await readJsonList<OpFileEntry>(opsFile(dir))
  return list.map((e) => ({ uuid: e.uuid, name: e.name }))
}

export async function listWhitelist(dir: string): Promise<PlayerEntry[]> {
  return readJsonList<PlayerEntry>(whitelistFile(dir))
}

/**
 * 닉네임에 해당하는 UUID를 구한다.
 * 정품 서버면 모장에 물어보고, 정품 확인을 꺼둔 서버면 계산해서 만든다.
 */
async function resolveUuid(dir: string, name: string): Promise<string> {
  const props = await readProperties(dir)
  if (!props.onlineMode) return offlineUuid(name)

  const uuid = await lookupUuid(name)
  if (!uuid) {
    throw new Error(`'${name}' 이라는 마인크래프트 계정을 찾지 못했습니다. 닉네임을 확인해 주세요.`)
  }
  return uuid
}

/**
 * 서버가 켜져 있으면 명령어로 처리한다.
 * 실행 중에 파일만 고치면 서버가 메모리에 들고 있는 목록과 어긋나기 때문이다.
 */
function runningInstanceDir(dir: string): boolean {
  return serverManager.getRunningDir() === dir
}

/**
 * 서버 콘솔에 그대로 실어 보내는 값이라 형식을 반드시 확인한다.
 * 줄바꿈이 섞이면 그 뒤가 별개의 명령으로 실행된다.
 */
function assertNickname(name: string): string {
  const trimmed = name.trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
    throw new Error(
      `'${name}' 은(는) 쓸 수 없는 닉네임입니다.\n마인크래프트 닉네임은 영문·숫자·밑줄 3~16자입니다.`
    )
  }
  return trimmed
}

export async function addOp(dir: string, rawName: string): Promise<PlayerEntry[]> {
  const name = assertNickname(rawName)

  if (runningInstanceDir(dir)) {
    serverManager.command(`op ${name}`)
    // 서버가 파일에 반영할 시간을 준다
    await new Promise((r) => setTimeout(r, 600))
    return listOps(dir)
  }

  const uuid = await resolveUuid(dir, name)
  const list = await readJsonList<OpFileEntry>(opsFile(dir))
  if (!list.some((e) => e.uuid === uuid)) {
    list.push({ uuid, name, level: 4, bypassesPlayerLimit: false })
    await writeJsonList(opsFile(dir), list)
  }
  return list.map((e) => ({ uuid: e.uuid, name: e.name }))
}

export async function removeOp(dir: string, uuid: string): Promise<PlayerEntry[]> {
  const list = await readJsonList<OpFileEntry>(opsFile(dir))
  const target = list.find((e) => e.uuid === uuid)

  // 파일에서 읽은 이름도 그대로 믿지 않는다
  if (target && runningInstanceDir(dir) && /^[A-Za-z0-9_]{3,16}$/.test(target.name)) {
    serverManager.command(`deop ${target.name}`)
    await new Promise((r) => setTimeout(r, 600))
    return listOps(dir)
  }

  const next = list.filter((e) => e.uuid !== uuid)
  await writeJsonList(opsFile(dir), next)
  return next.map((e) => ({ uuid: e.uuid, name: e.name }))
}

export async function addWhitelist(dir: string, rawName: string): Promise<PlayerEntry[]> {
  const name = assertNickname(rawName)

  if (runningInstanceDir(dir)) {
    serverManager.command(`whitelist add ${name}`)
    await new Promise((r) => setTimeout(r, 600))
    return listWhitelist(dir)
  }

  const uuid = await resolveUuid(dir, name)
  const list = await readJsonList<PlayerEntry>(whitelistFile(dir))
  if (!list.some((e) => e.uuid === uuid)) {
    list.push({ uuid, name })
    await writeJsonList(whitelistFile(dir), list)
  }
  return list
}

export async function removeWhitelist(dir: string, uuid: string): Promise<PlayerEntry[]> {
  const list = await readJsonList<PlayerEntry>(whitelistFile(dir))
  const target = list.find((e) => e.uuid === uuid)

  if (target && runningInstanceDir(dir) && /^[A-Za-z0-9_]{3,16}$/.test(target.name)) {
    serverManager.command(`whitelist remove ${target.name}`)
    await new Promise((r) => setTimeout(r, 600))
    return listWhitelist(dir)
  }

  const next = list.filter((e) => e.uuid !== uuid)
  await writeJsonList(whitelistFile(dir), next)
  return next
}
