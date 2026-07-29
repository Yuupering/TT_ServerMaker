import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Invite, JoinResult, JoinStatus } from '@shared/types'
import { emit, joinLog } from './events'
import { ensureJava, resolveJavaMajor } from './java'
import { hasOfficialLauncher, paths } from './paths'
import { ensureLoader } from './minecraft/loader'
import { installModpackFromModrinth } from './minecraft/mods'
import { addServerToList } from './minecraft/nbt'
import { isLauncherWindowOpen, registerProfile } from './minecraft/profile'

/**
 * 남이 연 서버에 들어갈 준비.
 *
 * 초대 코드 하나로 클라이언트 모드팩과 로더를 맞추고, 공식 런처가 고를 수 있는
 * 프로필을 남긴다. 게임 실행과 로그인은 공식 런처에 맡긴다. 게임 본체와 라이브러리도
 * 런처가 이미 받아둔 것을 그대로 쓰므로 새로 받는 건 모드팩과 로더뿐이다.
 *
 * 서버를 여는 쪽은 instance.ts와 server.ts가 맡는다. 이 파일은 그 반대편이다.
 */

export function joinId(invite: Invite): string {
  return createHash('sha1').update(invite.address.trim().toLowerCase()).digest('hex').slice(0, 12)
}

/**
 * 준비 작업이 겹치지 않게 막는 잠금.
 *
 * 같은 폴더에 모드팩을 풀고 로더를 설치하는 일이라, 두 번 눌려 동시에 돌면
 * 한쪽이 쓰는 파일을 다른 쪽이 지우거나 덮어써서 설치가 반쯤 깨진 채로 끝난다.
 */
let preparing = false

export function isJoining(): boolean {
  return preparing
}

function report(step: JoinStatus['step'], message: string, ratio: number | null = null): void {
  emit.joinStatus({ step, message, ratio })
}

export interface JoinArgs {
  invite: Invite
  minMemoryMb: number
  maxMemoryMb: number
}

/** 공식 런처에서 바로 고를 수 있게 준비한다 */
export async function prepareJoin(args: JoinArgs): Promise<JoinResult> {
  const { invite } = args

  if (preparing) throw new Error('이미 준비 중입니다. 끝날 때까지 기다려 주세요.')

  if (!hasOfficialLauncher()) {
    throw new Error(
      '공식 마인크래프트 런처를 찾지 못했습니다.\n' +
        '런처를 설치하고 한 번 실행한 뒤 다시 시도해 주세요.'
    )
  }

  preparing = true
  try {
    const gameDir = paths.clientDir(joinId(invite))
    await mkdir(gameDir, { recursive: true })

    let mcVersion = invite.mcVersion
    let loader = invite.loader
    let loaderVersion = invite.loaderVersion

    /* 모드팩 — 팩에 적힌 값이 초대 코드보다 정확하다 */
    if (invite.pack) {
      report('mods', '모드팩을 맞추는 중')
      const pack = await installModpackFromModrinth(
        invite.pack.projectId,
        invite.pack.versionId,
        gameDir,
        (done, total, label) => {
          emit.joinStatus({ step: 'mods', message: label, ratio: total > 0 ? done / total : null })
        }
      )
      mcVersion = pack.mcVersion
      loader = pack.loader
      loaderVersion = pack.loaderVersion
      joinLog(`모드팩 준비 완료: ${pack.name ?? invite.pack.title ?? ''}`, 'system')
    }

    /* 자바 — 로더 설치 프로그램을 돌리는 데 필요하다 */
    report('java', '자바를 확인하는 중')
    const javaMajor = await resolveJavaMajor(mcVersion)
    const javaExe = await ensureJava(javaMajor)

    /* 로더 — 공식 런처가 읽는 폴더에 버전을 만들어 둔다 */
    report('loader', '모드 로더를 준비하는 중')
    const versionId = await ensureLoader(loader, mcVersion, loaderVersion, javaExe, (message) =>
      report('loader', message)
    )

    /* 서버 목록에 미리 넣어두면 게임에서 클릭만 하면 된다 */
    report('ready', '서버 목록에 등록하는 중')
    await addServerToList(join(gameDir, 'servers.dat'), {
      name: invite.name || invite.address,
      ip: invite.address
    }).catch((err: Error) => {
      // 목록 등록이 실패해도 게임은 할 수 있으니 멈추지 않는다
      joinLog(`서버 목록 등록은 건너뜁니다: ${err.message}`, 'warn')
    })

    report('ready', '런처에 프로필을 등록하는 중')

    /*
     * 창이 열려 있으면 런처가 자기 목록으로 나중에 덮어쓸 수 있다.
     * 막지는 않는다. 등록이 실제로 남았는지는 registerProfile이 확인하고,
     * 나중에 사라지는 경우를 대비해 미리 알려만 둔다.
     */
    if (await isLauncherWindowOpen()) {
      joinLog(
        '공식 런처 창이 열려 있습니다. 프로필이 안 보이면 런처를 껐다 다시 켜 주세요.',
        'warn'
      )
    }
    const profileName = await registerProfile({
      serverId: joinId(invite),
      name: invite.name || invite.address,
      versionId,
      gameDir,
      minMemoryMb: args.minMemoryMb,
      maxMemoryMb: args.maxMemoryMb
    })

    joinLog(`준비 완료. 공식 런처에서 "${profileName}"을 고르면 됩니다.`, 'system')
    emit.joinStatus({ step: 'idle', message: '', ratio: null })

    return { profileName, versionId, gameDir }
  } catch (err) {
    const message = (err as Error).message
    emit.joinStatus({ step: 'error', message: '준비 중 문제가 생겼습니다', ratio: null, error: message })
    throw err
  } finally {
    preparing = false
  }
}
