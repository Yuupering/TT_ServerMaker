import { join } from 'node:path'
import { paths } from '../paths'

/**
 * 마인크래프트 버전 폴더.
 *
 * 공식 런처는 versions/<이름>/<이름>.json을 읽어 실행할 버전 목록을 만든다.
 * Fabric이나 Forge를 깔면 그 규칙에 맞는 폴더가 하나 더 생기고, 우리는 거기에
 * 로더 버전을 만들어 두기만 한다. 실행은 런처가 한다.
 */

export interface VersionJson {
  id: string
  inheritsFrom?: string
  type?: string
  mainClass: string
  libraries: unknown[]
  [key: string]: unknown
}

export function versionDir(id: string): string {
  return join(paths.versions, id)
}

export function versionJsonPath(id: string): string {
  return join(versionDir(id), `${id}.json`)
}
