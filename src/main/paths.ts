import { app } from 'electron'
import { existsSync, mkdirSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME } from '@shared/meta'

/**
 * 마인크래프트 서버와 일부 모드는 경로에 비ASCII 문자가 있으면 깨진다.
 * 사용자 이름이 한글이면 %APPDATA% 경로가 그대로 한글이 되므로,
 * 그럴 때는 항상 ASCII인 공용 폴더로 자동 폴백한다.
 */
function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E\\:]*$/.test(s)
}

function canWrite(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

let cachedRoot: string | null = null

/** 인스턴스/자바/캐시가 들어가는 데이터 루트 */
export function dataRoot(): string {
  if (cachedRoot) return cachedRoot

  const preferred = join(app.getPath('userData'), 'data')
  if (isAscii(preferred) && canWrite(preferred)) {
    cachedRoot = preferred
    return cachedRoot
  }

  const publicDir = process.env.PUBLIC || 'C:\\Users\\Public'
  const fallback = join(publicDir, APP_NAME)
  if (canWrite(fallback)) {
    cachedRoot = fallback
    return cachedRoot
  }

  // 마지막 수단
  cachedRoot = preferred
  mkdirSync(cachedRoot, { recursive: true })
  return cachedRoot
}

/** 설정에서 데이터 루트를 바꿨을 때 적용 */
export function setDataRoot(dir: string): void {
  mkdirSync(dir, { recursive: true })
  cachedRoot = dir
}

export function ensure(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export const paths = {
  get root(): string {
    return ensure(dataRoot())
  },
  get instances(): string {
    return ensure(join(dataRoot(), 'instances'))
  },
  get java(): string {
    return ensure(join(dataRoot(), 'java'))
  },
  get cache(): string {
    return ensure(join(dataRoot(), 'cache'))
  },
  get tools(): string {
    return ensure(join(dataRoot(), 'tools'))
  },
  get backups(): string {
    return ensure(join(dataRoot(), 'backups'))
  },
  get settingsFile(): string {
    return join(dataRoot(), 'settings.json')
  },
  get instancesFile(): string {
    return join(dataRoot(), 'instances.json')
  },
  instanceDir(id: string): string {
    return ensure(join(dataRoot(), 'instances', id))
  }
}

/** 경로에 비ASCII가 섞였는지 확인 (경고 표시용) */
export function pathHasNonAscii(p: string): boolean {
  return !isAscii(p)
}
