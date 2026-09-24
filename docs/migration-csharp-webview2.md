# Live Pulse: C# + WebView2 마이그레이션 실행 지침

작성: 2026-09-23. 준비 기준: e447509, 운영 버전 v1.12.1. 이 문서는 구현 계획이며 완료 보고가 아니다.

진행 기록: `native/LivePulse.Windows`에 첫 수명 시제품을, `native/LivePulse.DataMigration`에 격리 JSON→SQLite 이전 검증 도구를, `native/LivePulse.Core`에 공개 YouTube 읽기 전용 스냅샷, 채널 입력 해석과 순수 감시 변경 계획기를 추가했다. `native/LivePulse.NativeStore`는 이전 DB 위에 별도 런타임 테이블을 쓰고 한 번의 감시 판정을 저장 후 효과로 실행하는 격리 검증 단계다. 격리된 주기 감시 실행기와 수동 SQLite 백업·복구 증명도 추가했다. 트레이 시제품은 명시적인 복사본 경로에서만 공개 감시를 실행하며 알림/Chrome 열기를 억제한다. 운영 자동 시작·자동 백업/복구는 연결하지 않았다. 아래의 '준비 작업' 문구는 문서 작성 당시 상태를 설명한다. 검증 범위와 다음 단계는 `handoff.md` 및 `native/README.md`를 본다. 운영 앱은 여전히 Electron v1.12.1이다.

## 1. 사용자 결정과 범위

사용자의 목표는 **트레이 상태의 메모리 절약**이다. 화면 사용 중 최소 메모리를 위해 UI를 전면 재작성할 필요는 없다.

- C#이 트레이, 채널 감시, 알림, Chrome 열기, 저장, 클라우드 동기화, 업데이트를 담당한다.
- 기존 `src/renderer/` HTML/CSS/JS와 차트 계산/상호작용을 WebView2에서 재사용한다.
- 트레이 시작 시 WebView를 만들지 않는다. 창을 닫으면 WebView와 화면 전용 데이터를 해제한다.
- 기본 10~30분 UI 유지, 숨겨 둔 WebView 예열, UI 재사용을 위한 장기 메모리 점유는 채택하지 않는다. 다시 열 때의 초기화 비용은 수용한다.
- 순수 WPF 차트 재작성, CHZZK 추가, UI 전면 개편, 클라우드 서버 재작성은 이번 범위가 아니다.
- 이번 준비 작업은 문서만 만든다. 실제 구현은 사용자가 GPT-6 Sol high에 맡길 예정이다. 새 Codex 작업을 자동 생성하거나 설치 앱을 교체하지 않는다.

## 2. 권장 구현 구성

권장 출발점: .NET 10 LTS / C# + 얇은 WPF 창 호스트 + Microsoft.Web.WebView2 + Microsoft.Data.Sqlite. WPF는 창 수명 관리용이며 화면은 기존 웹 UI다. 패키지는 구현 시 호환성을 확인하고 버전을 고정한다.

준비 시 `dotnet --list-sdks` 결과는 9.0.308 하나였다. .NET 10 SDK 및 Windows 빌드 환경을 먼저 준비하고 확인할 것. 이 문서 작성 중 SDK 설치는 하지 않았다. 고객 PC의 .NET/WebView2 Runtime 배포도 설치 패키지의 책임으로 검증한다. WebView2 Evergreen 사용을 우선 검토한다.

권장 경계(디렉터리 이름은 구현자가 조정 가능):

- `native/LivePulse.Core`: YouTube 공급자, 감시/중복 방지, 동기화, 저장소. WebView/WPF 수명과 무관.
- `native/LivePulse.Windows`: 트레이, 얇은 창, WebView 브리지, 알림/로그인 시작, 업데이트.
- `native/LivePulse.Tests`: 기존 JS 테스트에서 추출한 동일 입력/기대 결과 및 저장/수명 테스트.
- 웹 자산은 `src/renderer/`를 단일 원본으로 빌드 시 복사한다. 수동으로 두 벌 관리하지 않는다.
- Node/Electron을 감시용 상주 sidecar로 남기지 않는다. 기존 Node는 회귀 테스트/개발 도구 및 별도 `cloud/` 서비스에서 계속 사용할 수 있다.

SQLite는 전체 기록 상주와 전체 JSON 재직렬화를 줄이기 위한 권장 저장 설계다. 사용자 확정 사항은 C# + WebView2 및 트레이 자원 절약이며, 저장 엔진의 세부 구현은 검증을 통해 확정한다. SQLite를 쓰더라도 전체 테이블을 리스트로 적재하면 목표를 달성하지 못한다.

공식 참고:

- [.NET 지원 정책](https://dotnet.microsoft.com/en-us/platform/support/policy)
- [WebView2 성능과 수명 관리](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)
- [WebView2 프로세스 모델](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)

## 3. 현재 코드에서 옮기거나 보존할 것

| 현재 파일 | 이전 책임 및 확인점 |
| --- | --- |
| `src/main.js` | 트레이/단일 인스턴스/명령행/창/IPC/로그인 시작/Chrome 실행. 현재는 `--hidden`이어도 창을 생성한 뒤 숨긴다. |
| `src/preload.js` | 아래 브리지 계약의 원본. Promise, 이벤트 구독/해제, 반환 DTO를 유지한다. |
| `src/lib/youtube.js`, `test/youtube.test.js` | 공개 페이지/RSS/선택적 API 해석 및 안전한 live/upcoming 판정. 문자열 정규식만 임의 간소화하지 않는다. |
| `src/lib/monitor.js`, `events.js` | 주기 실행, 중복 열기 방지, 첫 등록 기준선, 이벤트/구독자/영상 수집. |
| `src/lib/store.js`, `defaults.js` | JSON v3 입력, 정규화, 실패 시 중단, 복구/백업. 전체 데이터 수명 재설계 대상. |
| `src/lib/cloud-sync.js` | 페이지/커서/재시작/중복 제거/로컬 보관/토큰 은닉. 서버 계약 유지. |
| `src/lib/subscriber-import.js` | 채널 지정 XLSX 가져오기, 날짜/헤더/중복 규칙. C# 라이브러리 선택 시 라이선스 검토. |
| `src/lib/video-history.js`, `analytics-projection.js` | 로컬 기록과 클라우드 보관 정책 구분, 화면 투영/범위 검증. |
| `src/lib/windows-notifications.js` | 개발/설치 앱 식별 격리, 바로가기/토스트 활성화/작업표시줄 복구 조건. |
| `src/lib/updater.js`, `.github/workflows/release.yml` | 기존 설치 앱에서 새 설치 파일로 넘어가는 호환 경로. 단순 삭제/교체 금지. |
| `src/renderer/*` | 화면과 차트 재사용. Electron 의존부는 preload 계약으로 격리되어 있다. |
| `test/*`, `scripts/analytics-smoke.cjs` | 파서/계산/저장 회귀와 실제 UI 테스트 근거. Electron smoke가 WebView2 검증을 대신하지 않는다. |

`AGENTS.md`의 모든 YouTube, 기록, 차트, 알림, 클라우드 불변 조건을 유지한다. 특히 완료일/로컬 날짜 계산, 실측 표본과 렌더링 전용 점 분리, 오래된 기록 보존을 변경하지 않는다.

## 4. 창과 WebView 수명

명시적 상태: TrayOnly → Opening → Visible → Closing → TrayOnly. 앱 종료는 별도 Quitting 상태로 처리한다.

1. 트레이 자동 시작(`--hidden`)에서는 C# 작업만 시작한다. 수동 실행 시 메인 창을 여는 기존 동작은 유지 가능하다.
2. 열기 요청 시 STA UI 스레드에서 한 번만 초기화한다. 연속 클릭/중복 실행 요청을 합치고, 초기화 중 닫기/종료도 처리한다.
3. 로컬 화면 틀을 먼저 표시하고 필요한 DTO를 비동기로 요청한다. 생성 실패 시 감시는 계속하고 한국어 오류와 재시도 경로를 제공한다.
4. 닫기/트레이 숨기기 시 분석 구독, pending 요청, JS/네이티브 이벤트 연결, DTO/썸네일/차트 캐시를 해제하고 WebView를 Dispose한다. 취소된 세션으로 늦게 도착한 결과를 보내지 않는다.
5. WebView 관련 프로세스 종료는 비동기일 수 있다. 마지막 컨트롤 해제 뒤 해당 앱의 프로세스 그룹 종료를 관찰한다. 공유 환경/핸들/이벤트 참조가 종료를 막지 않도록 한다. 모든 `msedgewebview2.exe`를 일괄 종료하지 않는다.
6. 다시 열면 새로운 UI 세션에 완전한 최신 상태를 보낸다. 이전 세션의 '이미 전송한 기록' 캐시를 재사용하지 않는다.
7. 일반 최소화는 트레이 닫기와 구분한다. 최소화 중 UI 타이머/전송을 멈추되, 트레이로 전환하는 동작은 동일한 Dispose 경로로 연결한다.
8. 감시/동기화는 창 존재 여부와 무관하다. 실제 종료에서는 타이머/진행 작업과 저장을 정리한다.

Environment 생성만으로 HTML 첫 표시 준비가 끝났다고 간주하지 않는다. 사전 예열은 기본에서 제외한다. GC 강제 호출이나 working-set trimming으로만 낮춘 수치를 성능 개선 증거로 제시하지 않는다.

## 5. 웹-네이티브 계약

`window.livePulse`를 유지하는 얇은 JS 어댑터를 만든다. 기존 preload의 실제 입력/결과/오류 형태를 계약 테스트로 고정한다.

요청 메서드: `watchAnalytics`, `getState`, `addChannel`, `removeChannel`, `refresh`, `checkForUpdates`, `importSubscriberHistory`, `updateSettings`, `importCloudConnection`, `openUrl`, `hideWindow`, `quit`.

이벤트 메서드: `onState`, `onWindowActive`. 반환되는 unsubscribe 함수가 정상 해제되게 한다.

- WebMessage 기반의 제한된 `{ id, method, params }` 요청/결과와 세션 ID를 권장한다. 메서드 allowlist, 입력 형식/크기, 원본 페이지를 C#에서 검증한다.
- 문서 스크립트 실행 전 브리지를 준비한다. 외부 페이지/프레임이 네이티브 API를 호출하지 못하도록 신뢰된 로컬 origin만 허용하고 탐색/새 창을 통제한다.
- 범용 .NET host object, 임의 파일 읽기/쓰기, 임의 shell 실행을 노출하지 않는다. 외부 URL은 기존 공급자 allowlist와 검증을 유지한다.
- HTML/CSS/JS는 로컬 가상 호스트 등에 매핑하고 CSP를 보존한다. 운영 앱에 개발 HTTP 서버를 상주시킬 필요가 없다.
- API key/cloud token은 C#이 보관하고 public DTO에 재노출하지 않는다. 설정 입력과 저장 여부 표시만 제한적으로 처리한다.
- 분석 상세는 선택한 구독자 채널과 최대 네 영상만 구독한다. 닫힌 창을 위해 전체 기록을 투영/직렬화하지 않는다.
- `live-pulse:chart-preferences`는 현재 Electron localStorage 키다. WebView2는 별도 프로필이므로 자동으로 따라온다고 가정하지 않는다. 검증된 표시 설정만 이전하는 exporter/importer 또는 호환 단계가 필요하다. 토큰/전체 Chromium 프로필을 복사하지 않는다.

## 6. 데이터 보존과 저장소 전환

실제 데이터 파일 위치는 Electron `app.getPath('userData')/live-pulse.json`에서 확인한다. 프로젝트 안이나 추정 디렉터리의 파일로 대체하지 않는다. 테스트는 격리 복사본으로 수행한다.

- 채널/설정/이벤트/이미 연 방송 ID/영상 메타데이터/구독자와 조회수 표본/클라우드 커서와 버전을 필드별로 목록화한다.
- 로컬/가져온 기록과 다운로드한 클라우드 기록의 출처를 구분한다. 날짜별 close를 저장 원본으로 대체하지 않는다. 중복 시 기존 의미와 우선순위를 보존한다.
- SQLite에는 필요한 채널·영상·시간 범위 인덱스를 두고, 현재 요약과 작업 중인 작은 배치만 메모리에 둔다. 전체 이력 ORM tracking/무제한 캐시를 피한다.
- 원본과 유효한 백업을 변경 없이 보존하고 새 DB에 트랜잭션으로 가져온다. 스키마 버전/완료 마커를 두어 실패·중단·재실행이 안전하고 idempotent하게 만든다.
- 원본 JSON이 손상되었거나 읽기 권한/정규화 오류가 있으면 기존 복구 규칙을 따른다. 기본값으로 덮어쓰거나 초기 채널만 등록해 성공 처리하지 않는다.
- 시리즈별 표본 수, 시간/값, 첫/끝 날짜, 채널 수, 설정, dedup 상태를 이전 전/후 및 재시작 후 비교한다. 같은 시각 중복의 처리도 원본 정규화와 대조한다.
- 백업 두 세대와 복구 실패 시 가시적인 중단을 유지한다. SQLite 사용 시 WAL/동시 쓰기를 고려한 유효한 backup API 또는 닫힌 DB 스냅샷을 사용한다. 실행 중 DB 파일 하나만 복사해 백업이라고 하지 않는다.
- 격리 시제품은 첫 감시 기록 저장과 이후 최소 5분이 지난 저장에서 SQLite backup API로 두 세대를 갱신한다. 알림/URL 효과가 예정된 저장은 간격과 관계없이 먼저 백업한다. 백업 실패 시 효과를 실행하지 않고 감시를 오류로 중단한다. 이 단계는 백업 생성 검증일 뿐이며, 운영 전에는 시작 시 복구, 다른 프로세스와의 쓰기 배제, 전체 이력 검증을 연결해야 한다.
- 구버전과 신버전이 동시에 같은 기록을 쓰거나 중복 알림을 내지 못하게 한다. .NET mutex만으로 Electron의 기존 single-instance lock과 호환된다고 가정하지 않는다.
- 격리 트레이 시제품의 `.native-lock`은 같은 DB를 쓰는 협조적인 네이티브 프로세스만 배제한다. 잠금 파일의 존재가 아니라 열린 독점 핸들이 잠금이며, 이전 시제품·수동 도구·설치된 Electron은 참여하지 않는다. 운영 자동 복구와 전환 허용의 근거로 사용하지 않는다.
- 롤백 시 원본 JSON만 되돌리면 전환 후 기록이 사라진다. 새로운 기록의 보존/역변환 또는 버전별 안전한 복귀 절차를 검증한다.
- 2026-09-21 복구에서 남은 로컬 기록 공백을 보간하거나 새로 복구했다고 주장하지 않는다. 실제 개인 기록/비밀/복구 산출물은 Git 밖에 둔다.

## 7. 설치·업데이트·Windows 통합

현재 앱 ID `kr.local.youtubelivepulse`, 제품명 `라이브 펄스`, GitHub `nonohako/youtube-live-pulse`, Start Menu/설치 위치/토스트 identity를 보존한다. 기존 ToastActivatorCLSID와 바로가기 수정 범위는 `AGENTS.md`를 따른다. C#에서 같은 GUID를 선언하는 것만으로 토스트 활성화가 구현되지는 않는다.

기존 앱은 `electron-updater`와 NSIS, `latest.yml`/blockmap을 사용한다. 새 GitHub Release에 C# EXE만 올려서는 안전한 자동 이전이 완성되지 않는다.

- 기존 설치본이 새 설치 파일을 발견/다운로드/검증/실행할 수 있는지 테스트한다. 필요하면 호환용 Electron bridge release 또는 NSIS bootstrap 경로를 설계한다.
- 설치 파일의 기존 앱 종료, 같은 제품 업그레이드/제거 등록, 데이터 보존, 로그인 시작 인수, 바로가기/고정 항목을 확인한다.
- 새 C# 앱의 후속 업데이트도 구현한다. GitHub HTTPS 자산 검증과 재시도/실패 표시를 유지하고, UI를 닫아도 업데이트가 가능해야 한다.
- 개발/미설치/테스트 실행은 운영 토스트 identity 및 사용자 바로가기를 변경하면 안 된다.
- .NET 및 WebView2 Runtime 미설치 환경과 설치 실패를 시험한다. 설치 프로그램은 현재 unsigned라는 사실을 유지한다.
- native 릴리스 체크리스트/CI/버전 원본을 명시적으로 갱신한다. 전환 기간 package.json/package-lock/native 버전 불일치를 방지한다. 실제 tag를 밀기 전에 구 설치본부터 후속 업데이트까지 검증한다.

## 8. 권장 실행 순서와 완료 조건

1. **기준선:** clean/dirty 상태 확인, 기존 `npm test`, SDK 확보. 실제 데이터의 격리 복사본으로 현재 설치/packaged Electron 트레이 메모리와 CPU 측정.
2. **수명 시제품:** C# 트레이 + WebView + 기존 정적 화면/fixture DTO + 완전한 닫기/재열기. 실제 데이터 변경 없이 프로세스 종료와 메모리 회수부터 검증.
3. **핵심 기능:** 저장 인터페이스 및 C# 공급자/감시/동기화 구현. 기존 JS 테스트를 행동 기준으로 옮겨 같은 fixture의 결과 비교. 핵심 감시에는 API key가 없어도 동작해야 함.
4. **기록 이전:** 격리 JSON 복사본 → 새 DB → 재시작 → 샘플 비교, 실패/복구/재실행 검증. 큰 기록에서도 트레이 상주 메모리가 기록 크기에 비례해 계속 증가하지 않도록 확인.
5. **실제 UI:** preload 계약 연결, XLSX/설정/차트/비교/키보드/900x660 레이아웃, 창 종료 후 기록 투영 해제 확인. 기존 JS 계산 테스트는 계속 실행.
6. **Windows/배포:** 알림 활성화/Chrome/로그인 시작/중복 인스턴스, 구 설치본→신 앱 및 신 앱→다음 버전 업데이트 검증.
7. **완료:** 실제 packaged 앱 성능·회귀·데이터·설치 검증 후 AGENTS/handoff/CI 갱신, 버전/commit/tag/release/공개 installer hash 절차 수행. 소스 빌드 성공이나 fixture 화면만으로 마이그레이션 완료라 하지 않는다.

CHZZK나 unrelated 리팩터링을 끼워 넣지 않는다. 진행 중엔 각 단계의 완료 증거/미검증 항목을 handoff에 남기고, 최종적으로 중복된 운영 런타임/저장 경로가 남지 않게 한다.

## 9. 메모리·기능 인수 검증

앞선 대화의 현재 앱 관측치는 process 4개의 working set 합계 659.6 MiB, private bytes 합계 613.6 MiB였다. 한 번의 통제되지 않은 스냅샷이며 창 상태/운영 기간/GC/부하가 고정되지 않았다. working set에는 공유 페이지 중복이 있고 private bytes는 실제 상주 RAM과 다르다. 두 지표를 더하거나 이를 tray baseline으로 사용하지 않는다.

100~200 MiB는 이전 대화에서 제안한 공학적 목표일 뿐 보장/측정 결과나 사용자 확정 상한이 아니다. 핵심 사용자 요구는 트레이 자원 감소이며 UI 활성 상태 최소화가 아니다.

같은 PC, Release/packaged 빌드, 동일 데이터/채널/설정/동기화 상태에서 비교한다. 디버거 없이 앱 전용 전체 프로세스(C# + 소유한 WebView browser/renderer/GPU)를 포함한다.

| 시나리오 | 증거 |
| --- | --- |
| 트레이로 cold start | WebView 프로세스 없음, 감시/동기화 시작, 1/5/15분 메모리 및 CPU 표본 |
| 창 처음 열기 | 클릭→화면 틀/실제 데이터 표시 시간, 전체 메모리 |
| 차트/비교 후 닫기 | 앱 소유 WebView 프로세스 종료 시간, 30/60초·5분 후 메모리, 분석 데이터 참조 해제 |
| 20회 열기/닫기 | 새로 연 화면 정상 동작, 취소/이벤트 누수 없음, 트레이 복귀값이 지속 증가하지 않음 |
| 30~60분 트레이 운영 | 여러 감시/동기화 주기, idle와 수집 순간 CPU/메모리 분리, 실제 기록 증가와 커서 저장 |
| 실패·경합 | 초기화 중 닫기, 빠른 재열기, WebView 실패, 네트워크 실패, 저장 중 종료, 중복 실행 |

측정은 시간별 raw 값과 median/peak를 남기고 polling/sync 순간을 표시한다. 마지막 컨트롤 해제 이후 브라우저 종료 전 수치를 정상 tray 값으로 섞지 않는다. 실제 live 감지는 안전한 공개 데이터로 읽기 검증하되 fixture 알림 테스트와 미래 실제 방송 알림 증거를 구분한다.

## 10. GPT-6 Sol high에 전달할 시작 프롬프트

모델과 reasoning은 사용자가 GPT-6 Sol / high로 설정한 뒤 다음을 전달한다.

> 이 저장소의 AGENTS.md, handoff.md, docs/migration-csharp-webview2.md를 읽고 Live Pulse를 C# 백엔드 + WebView2로 마이그레이션해 줘. 목표는 트레이 상태의 메모리 절약이고 기존 HTML/CSS/JS 화면과 차트는 유지해. 트레이 시작 시 WebView를 만들지 말고 창을 닫으면 WebView와 화면 데이터를 해제하되 감시·알림·클라우드 동기화는 계속 실행해. 순수 WPF UI 재작성이나 기본 10~30분 WebView 보관은 하지 마. 기존 기록, 중복 방지, 날짜 계산, 토스트/바로가기와 설치된 Electron 앱의 업데이트 경로를 보존해. 먼저 동일 데이터의 기준선과 C# 트레이/WebView 수명 시제품을 검증한 뒤 코어 포팅, 저장소 이전, 실제 UI, 설치/업데이트 검증 순서로 완성해. 문서의 메모리 수치는 보장값이 아니니 packaged 실측으로 보고해. 실제 사용자 데이터는 격리 복사본으로 검증하고 개인 데이터나 비밀을 커밋하지 마. 기존 회귀 테스트와 동등한 native 검증을 유지하고 완료 증거·한계·다음 작업을 AGENTS.md와 handoff.md에 갱신해.
