import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AddonEntry, AddonKind, Instance } from '@shared/types'
import { PLUGIN_LOADERS } from '@shared/types'

/**
 * 모드와 플러그인은 들어가는 폴더가 다르다.
 * 서버 종류를 보고 알아서 정해주지 않으면, 지인이 mods와 plugins를 헷갈려
 * 넣어도 아무 일도 일어나지 않는 상황이 생긴다.
 */
export function addonKindFor(instance: Instance): AddonKind {
  return PLUGIN_LOADERS.includes(instance.loader.type) ? 'plugin' : 'mod'
}

export function addonDir(instance: Instance): string {
  return join(instance.dir, addonKindFor(instance) === 'plugin' ? 'plugins' : 'mods')
}

/** 꺼둔 파일은 .disabled를 붙여 보관한다 (지우지 않고 잠깐 빼두는 용도) */
const DISABLED_SUFFIX = '.disabled'

function isJarName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.jar') || lower.endsWith(`.jar${DISABLED_SUFFIX}`)
}

function safeName(name: string): string {
  // 경로 조작 방지: 파일 이름만 남긴다
  return basename(name)
}

export async function listAddons(instance: Instance): Promise<AddonEntry[]> {
  const dir = addonDir(instance)
  const names = await readdir(dir).catch(() => [] as string[])

  const entries = await Promise.all(
    names.filter(isJarName).map(async (name) => {
      const st = await stat(join(dir, name)).catch(() => null)
      if (!st?.isFile()) return null
      const enabled = !name.toLowerCase().endsWith(DISABLED_SUFFIX)
      return {
        file: name,
        name: enabled ? name.replace(/\.jar$/i, '') : name.replace(/\.jar\.disabled$/i, ''),
        size: st.size,
        enabled,
        kind: addonKindFor(instance)
      }
    })
  )

  return entries
    .filter((e): e is AddonEntry => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface AddResult {
  added: string[]
  skipped: { name: string; reason: string }[]
}

/** 끌어다 놓은 파일들을 알맞은 폴더에 넣는다 */
export async function addAddons(instance: Instance, paths: string[]): Promise<AddResult> {
  const dir = addonDir(instance)
  await mkdir(dir, { recursive: true })

  const added: string[] = []
  const skipped: { name: string; reason: string }[] = []

  for (const src of paths) {
    const name = safeName(src)

    if (!name.toLowerCase().endsWith('.jar')) {
      skipped.push({ name, reason: 'jar 파일이 아닙니다' })
      continue
    }

    const st = await stat(src).catch(() => null)
    if (!st?.isFile()) {
      skipped.push({ name, reason: '파일을 읽을 수 없습니다' })
      continue
    }

    try {
      await copyFile(src, join(dir, name))
      added.push(name)
    } catch (err) {
      skipped.push({ name, reason: (err as Error).message })
    }
  }

  return { added, skipped }
}

export async function removeAddon(instance: Instance, file: string): Promise<void> {
  const name = safeName(file)
  if (!isJarName(name)) throw new Error('jar 파일이 아닙니다')
  await rm(join(addonDir(instance), name), { force: true })
}

/** 파일을 지우지 않고 잠깐 빼두거나 되돌린다 */
export async function toggleAddon(instance: Instance, file: string): Promise<void> {
  const name = safeName(file)
  if (!isJarName(name)) throw new Error('jar 파일이 아닙니다')

  const dir = addonDir(instance)
  const disabled = name.toLowerCase().endsWith(DISABLED_SUFFIX)
  const next = disabled ? name.slice(0, -DISABLED_SUFFIX.length) : `${name}${DISABLED_SUFFIX}`

  await rename(join(dir, name), join(dir, next))
}
