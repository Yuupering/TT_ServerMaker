# 코드 서명 정책 (Code signing policy)

이 문서는 TT_ServerMaker 배포본이 어떻게 만들어지고 서명되는지를 밝힙니다.
[SignPath Foundation](https://signpath.org/)의 오픈소스 코드 서명 조건에 따라 공개합니다.

## 서명

무료 코드 서명은 [SignPath Foundation](https://signpath.org/)이 제공하고,
서명은 [SignPath.io](https://signpath.io/)의 서명 정책에 따라 이루어집니다.

Free code signing is provided by [SignPath Foundation](https://signpath.org/),
certificate by [SignPath.io](https://signpath.io/).

## 팀 역할

이 프로젝트는 1인이 관리합니다. 아래 세 역할은 모두 관리자 본인이 맡습니다.

| 역할 | 하는 일 | 담당 |
| --- | --- | --- |
| Author | 소스 코드를 고치고 커밋합니다 | [Yuupering](https://github.com/Yuupering) |
| Reviewer | 외부에서 온 변경(풀 리퀘스트)을 검토하고 병합합니다 | [Yuupering](https://github.com/Yuupering) |
| Approver | 릴리스마다 서명 요청을 승인합니다 | [Yuupering](https://github.com/Yuupering) |

관리자 계정은 GitHub와 SignPath 양쪽 모두 2단계 인증을 사용합니다.

## 빌드 방법

배포본은 개인 PC가 아니라 GitHub Actions에서 만들어집니다.
워크플로는 [`.github/workflows/release.yml`](.github/workflows/release.yml)에 있고,
`v`로 시작하는 태그를 밀 때만 동작합니다.

빌드는 이 저장소의 소스와 `package-lock.json`에 고정된 의존성만 사용합니다.
서명 대상은 이 저장소의 코드로 만든 설치본뿐이며, 다른 프로젝트의 결과물은 서명하지 않습니다.

## 이 앱이 배포하지 않는 것

마인크래프트 서버, 자바, 각 모드 로더의 파일은 배포본에 들어 있지 않습니다.
사용자가 앱을 쓰는 시점에 각 공식 배포처에서 사용자 PC로 직접 받으며, 받은 파일은
게시자가 공개한 해시로 확인합니다. 자세한 목록은 [README](README.md)에 있습니다.

이 파일들은 서명 대상이 아닙니다.

## 개인정보

이 앱은 사용자 정보를 수집하거나 외부로 보내지 않습니다. 사용 기록을 남기는 기능도 없습니다.

바깥으로 나가는 통신은 아래가 전부이며, 모두 사용자가 그 기능을 쓸 때만 발생합니다.

- 모드팩 검색과 내려받기 — Modrinth API
- 마인크래프트 서버 파일 — Mojang
- 자바 — Eclipse Adoptium (이 PC에 설치된 자바가 없을 때만)
- 모드 로더 — Paper, Fabric, Quilt, Forge, NeoForge 각 공식 배포처
- 공유기 포트 열기 — 같은 네트워크 안의 공유기 (UPnP)
- 공인 IP 확인 — 접속 주소를 만들 때

요청에는 앱 이름과 버전, 이 저장소 주소가 담긴 User-Agent가 들어갑니다.
이는 Modrinth와 PaperMC의 API 이용 규정이 요구하는 사항입니다.

서버를 열면 사용자가 지정한 포트가 인터넷에 열립니다. 이건 앱의 목적 그대로이며,
화면에서 켜고 끌 수 있습니다.

## 삭제

설치본으로 깔았다면 윈도우 설정의 앱 목록에서 지울 수 있습니다.

만든 서버 파일과 백업은 지워지지 않고 남습니다. 실수로 월드를 잃지 않도록 일부러
그렇게 두었습니다. 완전히 지우려면 아래 폴더를 직접 삭제하세요.

```
%APPDATA%\TT_ServerMaker
```

사용자 이름에 한글이 섞여 있으면 앱이 아래 경로를 대신 씁니다.

```
C:\Users\Public\TT_ServerMaker
```

## 연락

문제를 발견하면 [이슈](https://github.com/Yuupering/TT_ServerMaker/issues)로 알려주세요.
