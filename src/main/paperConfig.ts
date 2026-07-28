import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Paper 계열에 PROXY protocol을 켜고 끈다.
 *
 * 보호 프록시를 거치면 서버에는 모든 접속이 127.0.0.1로 보인다.
 * Paper는 앞단이 보내주는 실제 IP를 읽을 수 있어서, 이 설정을 켜면
 * 밴이나 접속 기록이 원래대로 동작한다.
 */

const GLOBAL_CONFIG = ['config', 'paper-global.yml']
const LEGACY_CONFIG = ['paper.yml']

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 값만 바꾸고 나머지 줄과 주석은 그대로 둔다 */
function patchYaml(content: string, enabled: boolean): string | null {
  const re = /^(\s*proxy-protocol:\s*)(true|false)\s*$/m
  if (!re.test(content)) return null
  return content.replace(re, `$1${enabled}`)
}

export async function setProxyProtocol(dir: string, enabled: boolean): Promise<boolean> {
  const globalPath = join(dir, ...GLOBAL_CONFIG)
  const legacyPath = join(dir, ...LEGACY_CONFIG)

  for (const path of [globalPath, legacyPath]) {
    if (!(await exists(path))) continue
    const content = await readFile(path, 'utf8').catch(() => null)
    if (content === null) continue

    const patched = patchYaml(content, enabled)
    if (patched !== null) {
      await writeFile(path, patched, 'utf8')
      return true
    }
  }

  // 설정 파일은 서버를 한 번 켜야 생기므로, 없으면 최소한만 만들어 둔다.
  // Paper는 빠진 항목을 기본값으로 채워서 다시 쓴다.
  if (enabled) {
    await mkdir(dirname(globalPath), { recursive: true })
    await writeFile(globalPath, ['proxies:', '  proxy-protocol: true', ''].join('\n'), 'utf8')
    return true
  }

  return false
}

/** 지금 PROXY protocol이 켜져 있는지 */
export async function isProxyProtocolEnabled(dir: string): Promise<boolean> {
  for (const path of [join(dir, ...GLOBAL_CONFIG), join(dir, ...LEGACY_CONFIG)]) {
    const content = await readFile(path, 'utf8').catch(() => null)
    if (content === null) continue
    const m = /^\s*proxy-protocol:\s*(true|false)\s*$/m.exec(content)
    if (m) return m[1] === 'true'
  }
  return false
}
