/**
 * 앱을 식별하는 값들. 한곳에서 관리한다.
 *
 * Modrinth와 PaperMC는 API를 쓰는 프로그램이 자신을 식별할 수 있어야 하고
 * 연락처를 포함해야 한다고 요구한다. 이걸 지키지 않으면 트래픽이 차단될 수 있다.
 */

export const APP_NAME = 'TT_ServerMaker'
export const APP_TITLE = '서버 메이커'
export const APP_VERSION = '0.2.0'
export const APP_REPO = 'https://github.com/Yuupering/TT_ServerMaker'

export const STUDIO = 'TT Studio'
export const AUTHOR = 'Yuupe'
export const CONTACT = 'yuupe@naver.com'

/** 외부 API를 부를 때 붙이는 User-Agent */
export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (${APP_REPO})`

/**
 * 모장 브랜드 가이드라인이 요구하는 고지.
 * 앱과 배포 페이지 양쪽에 눈에 띄게 넣어야 한다.
 */
export const MOJANG_DISCLAIMER =
  'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.'

export const MOJANG_DISCLAIMER_KO =
  '이 프로그램은 공식 마인크래프트 제품이 아니며, Mojang 또는 Microsoft의 승인을 받거나 관계된 바 없습니다.'
