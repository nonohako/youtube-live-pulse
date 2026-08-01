# 라이브 펄스

지정한 YouTube 채널을 백그라운드에서 확인하고 라이브 또는 예약 방송을 Chrome으로 자동 여는 Windows 트레이 앱입니다.

기본 채널로 아래 주소가 등록되어 있습니다.

`https://www.youtube.com/channel/UCtKtCiaWRz-d3EZn2xd1mdA`

## 포함된 기능

- Windows 로그인 시 백그라운드 자동 실행(설치본)
- 15~300초 간격의 라이브 상태 확인
- 라이브 시작과 예약 방송 발견 시 Chrome 자동 열기
- 채널 URL, `@핸들`, 채널 ID로 채널 추가
- 새 동영상과 새 게시물 알림
- LIVE/OFFLINE/확인 상태 인디케이터
- 구독자 수와 로컬 누적 추이 차트
- 구독자 차트 클릭 시 기간별 상세 차트, 선형 추세선, 고점·저점과 일별 추세 표시
- 일일 증가량, 성장률 추이, 증가세 둔화, 3일 모멘텀과 기간 전후반 기울기 변화 분석
- Windows 트레이 상주, 중복 팝업·중복 알림 방지
- 선택적 YouTube Data API 키 지원

## 개발 실행

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" start
```

일반적인 npm 설치에서는 `npm install`, `npm start`만 사용하면 됩니다. 위의 긴 명령은 현재 개발 환경의 npm 경로 우회용입니다.

## 테스트와 Windows 설치 파일

```powershell
node --test
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build
```

완성된 설치 파일은 `dist/LivePulse-Setup-1.3.0.exe`에 생성됩니다. 설치 후 앱 설정에서 “Windows 로그인 때 자동 실행”이 켜져 있으면 다음 로그인부터 숨김 상태로 트레이에서 시작합니다.

## 자동 업데이트

설치본은 앱 시작 약 8초 후 GitHub Releases에서 새 버전을 확인하고, 이후 4시간마다 다시 확인합니다. 새 버전은 백그라운드에서 내려받으며 다운로드가 끝나면 재시작 설치 여부를 묻습니다. “나중에”를 선택하면 앱을 종료할 때 설치됩니다.

새 버전을 배포하려면 `package.json` 버전을 올려 커밋한 뒤 같은 버전의 태그를 푸시합니다.

```powershell
git tag v1.3.0
git push origin v1.3.0
```

GitHub Actions가 테스트, Windows 설치 파일 빌드, Release 및 업데이트 메타데이터 게시를 자동으로 처리합니다.

## 데이터와 제약

- API 키가 없어도 YouTube 공개 채널 페이지와 공식 RSS 피드로 동작합니다.
- YouTube Data API 키를 설정하면 공개 구독자 통계를 10분마다 공식 API로 보강합니다.
- 구독자 이력은 앱을 설치한 시점부터 로컬에 쌓이므로 첫 실행 직후에는 추이선이 한 점으로 보입니다.
- 성장 분석은 날짜별 마지막 측정값을 기준으로 하며, 측정일이 비면 증가분을 경과 일수로 나눕니다. 오늘 값은 하루가 끝나기 전의 부분 기록입니다.
- YouTube Data API에는 커뮤니티 게시물 조회 항목이 없습니다. 게시물 감지는 공개 채널 페이지 구조를 읽는 실험 기능이며 YouTube 페이지 변경이나 로그인/연령 제한에 따라 일시적으로 실패할 수 있습니다.
- “실시간” 감시는 푸시가 아닌 설정된 간격의 폴링입니다. 기본값은 30초입니다.

앱 데이터는 Electron 사용자 데이터 폴더의 `live-pulse.json` 파일에만 저장됩니다. API 키도 해당 로컬 파일에 저장되므로 공유 PC에서는 입력하지 않는 편이 안전합니다.
