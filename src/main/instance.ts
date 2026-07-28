import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CreateFromFileArgs,
  CreateFromModrinthArgs,
  CreateVanillaArgs,
  Instance
} from '@shared/types'
import { ProgressReporter, emit } from './events'
import { ensureJava, resolveJavaMajor } from './java'
import { installLoader } from './loader'
import { cleanupInstallLeftovers, importFromPath, installFromModrinth, type PackInfo } from './pack'
import { paths } from './paths'
import { initProperties } from './properties'
import { dirSize } from './util/archive'
import {
  getInstance,
  getInstances,
  recommendMemoryMb,
  removeInstance,
  upsertInstance
} from './store'
import { serverManager } from './server'

const STEPS = 4

async function build(
  name: string,
  source: Instance['source'],
  install: (dir: string, progress: ProgressReporter) => Promise<PackInfo>,
  providedFile?: string | null
): Promise<Instance> {
  const id = randomUUID().slice(0, 8)
  const dir = paths.instanceDir(id)
  const progress = new ProgressReporter(id, STEPS)

  try {
    progress.step('pack', '모드팩을 준비하는 중')
    const pack = await install(dir, progress)

    progress.step('java', '자바를 준비하는 중')
    const javaMajor = await resolveJavaMajor(pack.mcVersion)
    const javaExe = await ensureJava(javaMajor, progress)

    progress.step('loader', '서버를 구성하는 중')
    const launch = await installLoader({
      dir,
      mcVersion: pack.mcVersion,
      loader: pack.loader,
      loaderVersion: pack.loaderVersion,
      javaExe,
      progress,
      providedFile
    })

    progress.step('finish', '마무리하는 중')
    await initProperties(dir, { motd: `${name} 서버` })
    await cleanupInstallLeftovers(dir)

    const instance: Instance = {
      id,
      name,
      dir,
      mcVersion: pack.mcVersion,
      loader: { type: pack.loader, version: pack.loaderVersion },
      javaMajor,
      memoryMb: recommendMemoryMb(),
      source: { ...source, label: pack.name ?? source.label },
      createdAt: Date.now(),
      launch
    }

    await upsertInstance(instance)
    emit.instancesChanged()

    progress.done(pack.warning ?? '설치가 끝났습니다')
    return instance
  } catch (err) {
    // 실패한 인스턴스 폴더는 남겨두면 다음 설치가 헷갈리므로 지운다
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    progress.fail((err as Error).message)
    throw err
  }
}

export async function createFromModrinth(args: CreateFromModrinthArgs): Promise<Instance> {
  return build(
    args.name,
    { kind: 'modrinth', ref: args.projectId, versionRef: args.versionId },
    (dir, progress) => installFromModrinth(args.projectId, args.versionId, dir, progress)
  )
}

export async function createFromFile(args: CreateFromFileArgs): Promise<Instance> {
  return build(
    args.name,
    { kind: args.path.toLowerCase().endsWith('.mrpack') ? 'modrinth' : 'local', ref: args.path },
    (dir, progress) => importFromPath(args.path, dir, progress)
  )
}

export async function createVanilla(args: CreateVanillaArgs): Promise<Instance> {
  return build(
    args.name,
    { kind: 'vanilla', ref: args.mcVersion },
    async () => ({
      mcVersion: args.mcVersion,
      loader: args.loader,
      loaderVersion: null
    }),
    args.serverFile
  )
}

export async function deleteInstance(id: string, deleteFiles: boolean): Promise<void> {
  const status = serverManager.getStatus()
  if (status.instanceId === id && status.state !== 'stopped' && status.state !== 'crashed') {
    throw new Error('실행 중인 서버는 삭제할 수 없습니다. 먼저 서버를 꺼주세요.')
  }

  const instance = await getInstance(id)
  if (instance && deleteFiles) {
    await rm(instance.dir, { recursive: true, force: true })
  }

  await removeInstance(id)
  emit.instancesChanged()
}

/** 서버별 디스크 사용량 (목록에서 용량을 보여주기 위한 것) */
export async function instanceSizes(): Promise<Record<string, number>> {
  const list = await getInstances()
  const entries = await Promise.all(
    list.map(async (i) => [i.id, await dirSize(i.dir).catch(() => 0)] as const)
  )
  return Object.fromEntries(entries)
}

/**
 * 서버 폴더는 남아 있는데 목록에는 없는 것들.
 * 설치가 중간에 끊기면 생기며, 수 GB를 차지한 채 눈에 띄지 않는다.
 */
export async function findOrphans(): Promise<{ name: string; path: string; size: number }[]> {
  const list = await getInstances()
  const known = new Set(list.map((i) => i.id))

  const dirs = await readdir(paths.instances, { withFileTypes: true }).catch(() => [])
  const orphans = dirs.filter((d) => d.isDirectory() && !known.has(d.name))

  return Promise.all(
    orphans.map(async (d) => {
      const path = join(paths.instances, d.name)
      return { name: d.name, path, size: await dirSize(path).catch(() => 0) }
    })
  )
}

export async function removeOrphan(name: string): Promise<void> {
  // 폴더 이름만 허용해 상위 경로로 빠져나가지 못하게 한다
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('잘못된 폴더 이름입니다')
  }
  const list = await getInstances()
  if (list.some((i) => i.id === name)) {
    throw new Error('사용 중인 서버 폴더입니다')
  }
  await rm(join(paths.instances, name), { recursive: true, force: true })
}

export async function updateInstance(id: string, patch: Partial<Instance>): Promise<Instance> {
  const instance = await getInstance(id)
  if (!instance) throw new Error('서버를 찾을 수 없습니다')

  const updated: Instance = { ...instance, ...patch, id: instance.id, dir: instance.dir }
  await upsertInstance(updated)
  emit.instancesChanged()
  return updated
}
