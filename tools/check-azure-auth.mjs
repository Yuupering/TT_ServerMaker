/**
 * Azure 앱이 마인크래프트 로그인에 쓸 수 있는 상태인지 확인하는 도구.
 *
 * 쓰임새가 둘이다.
 *
 * 하나, 승인 신청 전에 한 번 돌린다. 마이크로소프트는 그 앱에 로그인 시도 기록이 있어야
 * 심사를 진행한다. 이때는 마지막 단계에서 403이 나는 게 정상이고, 그 실패가 기록으로 남는다.
 *
 * 둘, 승인 후에 다시 돌려서 통과했는지 확인한다. 끝까지 가면 닉네임과 UUID가 찍힌다.
 *
 * 실행:
 *   node tools/check-azure-auth.mjs <클라이언트 ID>
 *   node tools/check-azure-auth.mjs            (AZURE_CLIENT_ID 환경변수 사용)
 *
 * 토큰은 화면에 찍지도, 파일로 남기지도 않는다. 확인만 하고 끝난다.
 */

const CLIENT_ID = (process.argv[2] ?? process.env.AZURE_CLIENT_ID ?? '').trim()

// 마인크래프트 계정은 개인 계정이라 consumers 엔드포인트를 쓴다
const OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const SCOPE = 'XboxLive.signin offline_access'
const UA = 'TT_ServerJoiner-authcheck/1.0 (https://github.com/Yuupering/TT_ServerJoiner)'

const ok = (s) => `  \x1b[32m✓\x1b[0m ${s}`
const bad = (s) => `  \x1b[31m✗\x1b[0m ${s}`
const info = (s) => `  \x1b[90m${s}\x1b[0m`

function step(n, title) {
  console.log(`\n[${n}/5] ${title}`)
}

/** 실패했을 때 본문을 그대로 보여줘야 원인을 알 수 있다 */
async function readBody(res) {
  const text = await res.text().catch(() => '')
  try {
    return { text, json: JSON.parse(text) }
  } catch {
    return { text, json: null }
  }
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams(params)
  })
  return { res, ...(await readBody(res)) }
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      ...headers
    },
    body: JSON.stringify(body)
  })
  return { res, ...(await readBody(res)) }
}

async function main() {
  if (!CLIENT_ID) {
    console.error('클라이언트 ID를 넣어 주세요.')
    console.error('  node tools/check-azure-auth.mjs 00000000-0000-0000-0000-000000000000')
    process.exit(2)
  }

  console.log(`\n클라이언트 ID  ${CLIENT_ID}`)
  console.log(`요청 범위      ${SCOPE}`)

  /* ── 1. 기기 코드 받기 ─────────────────────────────────── */
  step(1, '기기 코드 요청')

  const device = await postForm(`${OAUTH}/devicecode`, { client_id: CLIENT_ID, scope: SCOPE })

  if (!device.res.ok) {
    console.log(bad(`실패 (HTTP ${device.res.status})`))
    const desc = device.json?.error_description ?? device.text.slice(0, 300)
    console.log(info(desc))

    /*
     * error 필드만 보면 원인이 안 갈린다. 잘못된 ID도, 공용 클라이언트 흐름이 꺼진 것도
     * 똑같이 unauthorized_client로 온다. 실제 구분은 본문의 AADSTS 코드가 해준다.
     */
    const code = /AADSTS(\d+)/.exec(desc)?.[1]
    const causes = {
      700038: '클라이언트 ID 형식이 올바르지 않습니다. 포털 [개요]의 "애플리케이션(클라이언트) ID"를 그대로 붙여넣어 주세요.',
      700016:
        '이 ID로 등록된 앱을 개인 계정 쪽에서 찾지 못했습니다.\n' +
        '  ID가 틀렸거나, 앱의 계정 유형이 "개인 Microsoft 계정만"이 아닌 경우입니다.',
      50194:
        '앱의 계정 유형이 개인 계정을 포함하지 않습니다.\n' +
        '  포털 [인증] → [지원되는 계정 유형]에서 개인 Microsoft 계정을 포함하도록 바꿔 주세요.',
      7000218:
        '앱이 비밀 값을 요구하는 상태입니다. 공용 클라이언트 흐름이 꺼져 있습니다.\n' +
        '  포털 [인증] → [고급 설정] → "공용 클라이언트 흐름 허용"을 예로 바꿔 주세요.',
      650057: '요청한 범위를 이 앱이 쓸 수 없습니다. XboxLive.signin 접근 권한을 확인해 주세요.'
    }

    console.log('')
    if (code && causes[code]) {
      console.log(`원인: ${causes[code]}`)
    } else {
      console.log(
        '자주 겪는 원인 두 가지입니다.\n' +
          '  - 계정 유형이 "개인 Microsoft 계정만"이 아님\n' +
          '  - [인증] → [고급 설정] → "공용 클라이언트 흐름 허용"이 꺼져 있음'
      )
    }
    process.exit(1)
  }

  console.log(ok('기기 코드를 받았습니다'))
  console.log('\n────────────────────────────────────────')
  console.log(`  ${device.json.verification_uri} 에 접속해서`)
  console.log(`  코드  ${device.json.user_code}  를 입력하고 로그인하세요.`)
  console.log('────────────────────────────────────────')
  console.log(info(`제한 시간 ${Math.round(device.json.expires_in / 60)}분`))

  /* ── 2. 로그인 완료 기다리기 ───────────────────────────── */
  step(2, '브라우저 로그인 대기')

  const deadline = Date.now() + device.json.expires_in * 1000
  let interval = (device.json.interval ?? 5) * 1000
  let msToken = null

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))

    const poll = await postForm(`${OAUTH}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: device.json.device_code
    })

    if (poll.json?.access_token) {
      msToken = poll.json.access_token
      break
    }

    const err = poll.json?.error
    if (err === 'authorization_pending') continue
    if (err === 'slow_down') {
      interval += 5000
      continue
    }

    console.log(bad(`중단됨 (${err ?? poll.res.status})`))
    console.log(info(poll.json?.error_description ?? poll.text.slice(0, 300)))
    process.exit(1)
  }

  if (!msToken) {
    console.log(bad('시간이 지났습니다. 다시 실행해 주세요.'))
    process.exit(1)
  }
  console.log(ok('마이크로소프트 로그인 성공'))

  /* ── 3. Xbox Live ─────────────────────────────────────── */
  step(3, 'Xbox Live 인증')

  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msToken}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  })

  if (!xbl.res.ok) {
    console.log(bad(`실패 (HTTP ${xbl.res.status})`))
    console.log(info(xbl.text.slice(0, 300)))
    console.log(
      '\n여기서 막히면 XboxLive.signin 범위 자체가 이 앱에 허용되지 않은 경우입니다.\n' +
        '마인크래프트 API 승인과는 다른 관문이라, 이 단계 실패는 따로 알아봐야 합니다.'
    )
    process.exit(1)
  }
  console.log(ok('Xbox Live 토큰을 받았습니다'))

  /* ── 4. XSTS ──────────────────────────────────────────── */
  step(4, 'XSTS 토큰 (마인크래프트용)')

  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.json.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  })

  if (!xsts.res.ok) {
    console.log(bad(`실패 (HTTP ${xsts.res.status})`))
    const xerr = xsts.json?.XErr
    const reason = {
      2148916233: 'Xbox 계정이 없는 마이크로소프트 계정입니다. Xbox 프로필을 먼저 만들어 주세요.',
      2148916235: '이 계정이 속한 국가에서 Xbox Live를 쓸 수 없습니다.',
      2148916238: '미성년 계정입니다. 가족 구성원으로 등록돼 있어야 합니다.'
    }[xerr]
    console.log(info(reason ?? xsts.text.slice(0, 300)))
    process.exit(1)
  }

  const uhs = xsts.json?.DisplayClaims?.xui?.[0]?.uhs
  if (!uhs) {
    console.log(bad('응답에서 사용자 해시를 찾지 못했습니다'))
    process.exit(1)
  }
  console.log(ok('XSTS 토큰을 받았습니다'))

  /* ── 5. 마인크래프트 ──────────────────────────────────── */
  step(5, '마인크래프트 API')

  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.json.Token}`
  })

  if (mc.res.status === 403) {
    console.log(bad('403 — 이 앱은 아직 마인크래프트 API를 쓸 수 없습니다'))
    console.log(
      '\n승인 전이라면 여기까지가 정상입니다.\n' +
        '방금 이 시도가 활동 기록으로 남았으니, 이제 아래에서 승인을 신청하세요.\n\n' +
        '  https://aka.ms/mce-reviewappid\n\n' +
        '승인 후 최대 24시간이 지나면 이 스크립트를 다시 돌려 확인하세요.'
    )
    process.exit(3)
  }

  if (!mc.res.ok) {
    console.log(bad(`실패 (HTTP ${mc.res.status})`))
    console.log(info(mc.text.slice(0, 300)))
    process.exit(1)
  }
  console.log(ok('마인크래프트 토큰을 받았습니다'))

  const profile = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.json.access_token}`, 'User-Agent': UA }
  })

  if (profile.status === 404) {
    console.log(bad('이 계정에는 마인크래프트 자바 에디션이 없습니다'))
    console.log(info('앱 설정은 정상입니다. 자바 에디션이 있는 계정으로 다시 확인해 보세요.'))
    process.exit(1)
  }
  if (!profile.ok) {
    console.log(bad(`프로필 조회 실패 (HTTP ${profile.status})`))
    process.exit(1)
  }

  const me = await profile.json()
  console.log(ok(`프로필 확인: ${me.name}`))
  console.log(info(`UUID ${me.id}`))

  console.log('\n────────────────────────────────────────')
  console.log('  이 앱은 마인크래프트 로그인에 쓸 수 있습니다.')
  console.log('  클라이언트 ID를 src/shared/meta.ts에 넣으면 됩니다.')
  console.log('────────────────────────────────────────\n')
}

main().catch((err) => {
  console.error('\n예상치 못한 오류:', err.message)
  process.exit(1)
})
