# Notch 디자인 재작성 사양서

대상: Electron + React + TypeScript 노치 오버레이. 기능은 그대로 두고 시각 디자인만 교체한다.
이 파일이 기준 문서다. 저장소의 docs/ 폴더에 두고 경로로 읽는다. (특수 기호는 일부러 쓰지 않았다.)

## 1. 목표

- 걷어낼 것: 대문자 텍스트 버튼과 라벨, 세 자리 숫자 표시, 9x9 도트 날씨 아이콘, 눈금 슬라이더, 스캔라인, 유휴 상태의 눈 두 개, NOTCH-01 푸터, 연두색 포인트, 카드(타일) 구조.
- 새 디자인: 순흑 캡슐 하나 + 상자 없는 단일 표면 + 가사 빛 스윕이 주인공인 절제된 다크 미니멀.
- 기능, 데이터 흐름, 타이밍, IPC 계약은 바꾸지 않는다. 바뀌는 것은 마크업, 스타일, 문구, 아이콘, 모션이다.

## 2. 현재 상태

- 1단계(분리), 2단계(토큰과 마크업), 3단계(모션과 바운즈)는 구현됨.
- 남은 일(4단계): 전환 중 잘림 검증, 실제 연결 상태에서 음성/Discord 화면 검증, 7장 체크리스트 전체 점검, 보고.

## 3. 바꾸지 않을 것

- window.notchApi의 메서드 이름, 인자, 반환 형태와 notch-api.d.ts. 꼭 필요하면 멈추고 사유를 보고한다.
- 폴링 주기 상수: MEDIA_POLL_MS, BATTERY_POLL_MS, VOLUME_POLL_MS, MIX_POLL_MS, PEAK_POLL_MS, PROGRESS_TICK_MS, LYRICS_GAP_MS, LYRICS_CACHE_LIMIT.
- 가사와 제목 로직 전체(fetchLyrics, matchScore, betterHit, parseSynced, stripTimestamps, trackName, cleanTitle, titleArtist, artistName, displayArtist, 캐시와 throttle). 파일 이동만 허용하고 내용은 바꾸지 않는다.
- 경쟁 상태 방지 장치: 미디어 조회 세대 번호(mediaRequestRef)와 재생/일시정지 낙관적 갱신(pendingPlayRef, playPending), 볼륨 쓰기 세대 번호(writeSeq, writesInFlight)와 묶음 전송(queuedLevel, queued, queuedMaster, 60/70ms), 드래그 중 폴링 무시(draggingRef, busyRef), 언마운트 시 마지막 값 전송.
- 상호작용 규칙: 마이크 아이콘 클릭이 노치 고정/해제로 새지 않게 하는 stopPropagation, 아이콘으로 곧장 들어올 때 펼치지 않는 onMouseEnter 처리(게임 중 헛클릭 방지), 패널의 inert, 슬라이더 키보드 조작(방향키, Shift 10단위, Home/End, M), aria 속성과 한글 라벨.
- 하위 화면과 배지가 나타나는 조건(mixOpen, voiceOpen, linkOpen, voiceActive, 충전 중, 배터리 30% 이하, 출력 장치 변경 9초). 표시 방식만 바꾼다.
- DiscordLink의 비밀번호 입력(type=password, autoComplete=off)과 닫힐 때의 closeDiscordLink() 호출. 시크릿 값을 화면이나 로그에 출력하지 않는다.
- 가사 빛 스윕 계산(shinePosition, lineSpan, shineProgress)과 줄 요소의 key={activeLine} 재마운트.

## 4. 디자인 스펙

### 4.1 색

| 토큰 | 값 | 용도 |
|---|---|---|
| --notch-bg | #000000 | 본체. 틴트 없는 순흑 |
| --notch-tile | #141416 | 부품용 면(썸네일 배경 등). 컨테이너 배경으로는 쓰지 않음 |
| --notch-tile-high | #3A3A40 | 슬라이더 트랙, 눌림, 호버 |
| --notch-line | #2C2C31 | 구분선 1px(화면당 최대 한 줄) |
| --notch-text | #F4F4F6 | 주 글자 |
| --notch-text-dim | #8C8C93 | 보조 글자 |
| --notch-accent | 앨범에서 추출 | 가사 스윕, 진행 막대, 썸네일 주변에만. 실패 시 #F4F4F6 |
| --notch-ok | #10B981 | 말하는 중, 충전 중 |
| --notch-mute | #F43F5E | 음소거 |
| --notch-warn | #F59E0B | CPU 85C 이상, 배터리 30% 이하 |

규칙:

- 반투명 면과 backdrop-filter는 쓰지 않는다(투명 창에서는 바탕화면이 흐려지지 않는다).
- 앨범 색은 미디어 내용에만 쓴다. 믹서 피크 미터는 여러 앱의 소리이므로 앨범 색을 쓰지 않고 고정 무채색으로 칠한다.
- 상태는 글자 라벨 대신 6px 점이나 아이콘 색으로 보여준다. 평소엔 무채색이고 상태가 바뀐 요소에만 점을 켠다.
- 글자 대비는 4.5:1 이상. 가사 기본 글자색은 #C8C8CE.

### 4.2 앨범 색 추출 (src/useAccent.ts)

- 입력은 이미지 src(media.thumbnail 또는 ytThumb), 출력은 CSS 색 문자열인 훅.
- 16x16 오프스크린 canvas에 그려 샘플링한다. 채도가 높은 클러스터를 우선 고르고, 너무 어둡거나 밝거나 채도가 낮은 픽셀은 뺀다.
- 결과는 HSL 명도 72~80%, 채도 45% 이상으로 보정한다. 가사 스윕에 쓸 때는 명도 90% 이상으로 올린다.
- getImageData가 실패할 수 있으므로 try/catch로 감싸고 실패하면 #F4F4F6을 쓴다. src별로 캐시한다.
- .notch 루트의 style에 --notch-accent로 넣고 곡이 바뀔 때 300ms 동안 부드럽게 전환한다(@property로 등록).

### 4.3 글꼴

- Pretendard Variable 하나. PretendardVariable.woff2를 프로젝트에 넣고 @font-face로 불러온다(CDN 금지). OFL 라이선스 파일을 같이 둔다.
- 폴백: "Pretendard Variable", Pretendard, "Segoe UI Variable Text", "Segoe UI", "Malgun Gothic", system-ui, sans-serif
- 숫자(시계, 시간, 온도, 사용률, 볼륨)는 font-variant-numeric: tabular-nums.
- 크기는 세 단계와 굵기로만 만든다: 가사 22~24px/600, 제목 14px/600, 보조 12px/400, 접힌 가사 13px/500. text-transform: uppercase와 넓은 자간은 쓰지 않는다. CPU, GPU 같은 약어는 그대로 둔다.

### 4.4 형태

- 컨테이너는 순흑 캡슐 하나뿐이다. 캡슐 안에 상자(타일, 카드)를 또 두지 않고, 영역 구분은 여백과 글자 크기 대비, 필요한 곳의 1px 구분선으로만 한다.
- 위쪽은 화면 가장자리에 붙어 평평하고 아래쪽 모서리만 둥글다. corner-shape: squircle을 @supports로 감싸 쓰고, 미지원이면 일반 radius로 둔다.
- 위쪽 좌우에 오목한 역곡선을 ::before, ::after와 radial-gradient 마스크로 만든다. 크기도 스프링과 같은 속도로 변하게 한다.
- 반지름 동심원 규칙: 안쪽 radius = 바깥 radius - 여백. 썸네일 같은 부품에만 적용한다. 시작값: 펼침 바깥 아래쪽 radius 28px, 바깥 여백 20px, 썸네일 radius 8px. 접힌 상태 radius는 현재 알약 높이에서 정한다.
- 캡슐 안쪽 여백 20~24px, 영역 사이 간격 16~24px, 그림자 없음.

### 4.5 화면별 구성

**접힘, 유휴(미디어 없음)**: 아무것도 없는 순흑 알약. 배지(충전, 배터리 부족, 출력 장치 변경)와 음성 채널 마이크 아이콘만 표시한다.

**접힘, 미디어 재생 중**: 왼쪽 24px 썸네일(radius 6px), 가운데 현재 가사 한 줄(없으면 정리한 제목), 오른쪽 EQ 막대 3개(재생 중에만 움직임). 음성 채널에 있으면 EQ 오른쪽에 VoiceNow와 MicStatus, 배지는 맨 오른쪽. 폭은 고정(--notch-collapsed-w: 440px)이고 가사는 한 줄 말줄임. 가사 줄이 바뀔 때는 120ms 크로스페이드.

**펼침, 미디어**(폭 600, 가사가 길면 최대 860까지 넓어지는 expandedWidth 로직은 유지): 상자 없이 위에서 아래로 쌓는다.

- 윗줄: 앨범 아트 64px(radius 8px) + 오른쪽에 제목(ScrollingTitle, 14px/600), 가수(12px, text-dim), 앨범(있을 때만 한 줄, text-dim)을 세로 중앙 정렬. 가수와 앨범을 기호로 잇지 않는다. 재생 소스가 둘 이상이면 소스 칩(notch-sources)을 이 줄 오른쪽에 둔다.
- 가사(주인공): 현재 가사 한 줄, 22~24px/600, 가운데 정렬, 위아래 여백 20px, 줄 높이 고정. 기본 글자색은 #C8C8CE, 빛 스윕 구간은 --notch-text에 가깝게 밝힌다(앨범 색을 쓰면 명도 90% 이상). 줄이 바뀔 때 아래에서 8px 올라오며 블러 6px에서 0으로 풀린다(160ms).
- 가사 자리의 상태 문구(--notch-text-dim 13px, 가운데): 불러오는 중 "가사를 불러오는 중...", 연주곡 "연주곡입니다.", 못 찾음 "가사를 찾지 못했어요". 가사가 도착해도 패널 높이가 바뀌지 않도록 이 줄 높이를 항상 확보한다.
- 싱크 가사가 없을 때는 기존 분기(유튜브 썸네일, 앨범 아트와 안내문, 비싱크 가사 텍스트)를 새 스타일로 그린다. 같은 이미지가 한 화면에 두 번 나오지 않게 하고(가사 영역에 썸네일을 쓰면 윗줄의 앨범 아트는 숨김), 비싱크 가사는 높이를 고정하고 안에서 스크롤한다.
- .notch-line-measure는 새 가사 줄과 같은 글꼴, 크기, 굵기여야 하고 폭 계산식의 여백 상수(+200)도 새 여백에 맞게 다시 계산한다.
- 진행 막대: 높이 4px, 진행분은 --notch-accent, 머리 점은 호버 때만 커진다. 양끝에 시간(0:06, 3:30).
- 컨트롤 줄: 왼쪽 VolumeDeck(짧은 슬라이더), 가운데 이전/재생/다음(재생은 36px 원형에 --notch-text 배경과 검정 아이콘, 이전/다음은 아이콘만), 오른쪽 믹서 열기 버튼. 음성 채널에 있으면 VOICE 버튼과 MicStatus를 믹서 버튼 옆에 둔다.

**펼침, HUD(미디어 없음)**: 폭 600. 상자 없이 두 줄.

- 윗줄 왼쪽: 시계(40px/600, 초는 text-dim), 그 아래 날짜(2026.11.17 화 형식, 요일은 한글 약어)와 날씨(Lucide 아이콘, 온도, 도시) 한 줄.
- 윗줄 오른쪽: CPU(또는 ACPI)와 GPU. "라벨 숫자 단위"가 한 덩어리로 읽히게 오른쪽 정렬(라벨과 숫자 간격 16px, 숫자 24px/600, 단위는 작게, 단위에 min-width: 2ch). CPU가 85C 이상이면 숫자 옆에 --notch-warn 점.
- 아랫줄: 음소거 아이콘 버튼, 전체 폭 VolumeDeck, 믹서 열기 버튼. 음성 채널에 있으면 VOICE 버튼과 MicStatus를 같은 줄 끝에 둔다. 두 줄 사이는 여백 16~24px.

**하위 화면(믹서, 음성, Discord 연결)**: 카드 없이 순흑 위의 줄 목록.

- 줄 높이 36px, 줄 사이는 여백으로 구분하고 전체 볼륨 줄 아래에만 1px 구분선.
- 믹서 피크 미터: 줄 뒤의 채움이 아니라 슬라이더 트랙 바로 아래(간격 4px)의 2px 선(--notch-text 35% 투명도, 트랙과 같은 폭).
- 하단 버튼: 뒤로(왼쪽)와 소리 설정(오른쪽)을 한 줄 양끝에 두고 위에 1px 구분선. 글자 왼쪽 끝은 위 줄과 맞추고, 호버/포커스 때만 radius 8px의 옅은 면.
- 패널 높이는 내용에 맞추고 최소 높이만 둔다(빈 공간을 남기지 않는다).
- 음성 패널: 말하는 사람은 글자색을 바꾸지 않고 이름 앞 6px 에메랄드 점으로 표시. 마이크/헤드셋 꺼짐은 --notch-mute 아이콘. 이름이 '나'일 때는 '(나)' 접미사를 붙이지 않는다. 헤더, 목록, 하단 버튼의 왼쪽 정렬선은 하나로 맞춘다.
- Discord 연결: 설명문에 word-break: keep-all, 상태 글자에 letter-spacing 없음, 입력창 radius 8px.

**슬라이더(VolumeDeck, MixRow 공통)**: 눈금, 커서, 세 자리 숫자는 없앤다. 6px 캡슐 트랙(--notch-tile-high), 채움은 --notch-text, 손잡이(14px 원)는 호버/드래그/키보드 포커스 때만, 숫자는 드래그 중이거나 호버 미리보기 중일 때만 보인다. 음소거면 채움을 --notch-text-dim으로 줄이고 음소거 아이콘에 --notch-mute. 좌우 아이콘은 구분한다: 왼쪽은 음소거 버튼(볼륨 단계별 Volume, Volume1, Volume2, VolumeX), 오른쪽은 믹서 열기(SlidersHorizontal).

**배지**: 충전은 Zap 아이콘(--notch-ok)과 퍼센트, 배터리 부족은 BatteryLow 아이콘(--notch-warn)과 퍼센트, 출력 장치 변경은 스피커 또는 헤드셋 아이콘(믹서 버튼과 같은 슬라이더 아이콘은 쓰지 않는다).

### 4.6 문구와 아이콘

아이콘은 lucide-react(필요한 것만 named import, stroke 1.75). 도트 방식의 WEATHER_DOTS와 WeatherIcon은 삭제하고 날씨 종류 키(sun, cloud, fog, rain, snow, thunder)를 Lucide 아이콘에 매핑한다.

문구는 모두 문장형 한글. 대문자 영문 라벨과 기호로 이은 상태 문자열은 쓰지 않는다. CPU, GPU 같은 약어는 예외.

| 현재 | 새 문구 / 처리 |
|---|---|
| PREV / PLAY / PAUSE / NEXT | 아이콘 버튼. aria-label은 이전, 재생, 일시정지, 다음 유지 |
| VOL (믹서 열기 버튼) | 아이콘 버튼. aria-label과 title "앱별 볼륨 열기" 유지 |
| M (음소거 버튼) | 스피커/음소거 아이콘 버튼. aria-pressed와 라벨 유지 |
| SOUND, 출력 장치 | 소리, 장치 이름 |
| MASTER | 전체 볼륨 |
| 앱 이름 toUpperCase() | 원래 표기 그대로 |
| BACK, SOUND SETTINGS | 뒤로, 소리 설정 |
| OUT + 장치명 + SETTINGS | 장치 아이콘 + 장치명 한 줄과 설정 버튼 |
| NOTCH-01, NOTCH 푸터 | 삭제 |
| CHARGE 85% | 번개 아이콘(--notch-ok)과 85% |
| LOW 20% | 배터리 부족 아이콘(--notch-warn)과 20% |
| VOICE(제목), NN IN | 음성 채널, N명 |
| DEAF, MUTE 플래그 | 헤드셋 꺼짐/마이크 꺼짐 아이콘(--notch-mute) |
| MIC ON, UNMUTE, MUTE, HEADSET ON, DEAFEN, CLOSE | 마이크 켜기, 음소거 해제, 음소거, 헤드셋 켜기, 헤드셋 끄기, 닫기 |
| DISCORD, LINKED / NOT LINKED | Discord, 연결됨 / 연결 안 됨 |
| CLIENT SECRET (placeholder) | 클라이언트 시크릿 |
| CONNECT / WAIT | 연결 / 연결 중 |
| --- 자리표시 | 대시 하나 또는 빈 상태 |
| 날짜의 영문 요일 대문자 | toLocaleDateString('ko-KR', { weekday: 'short' }) |
| mediaAppName의 CHROME, EDGE 등 | Chrome, Edge, Whale, Firefox, Brave, Opera, Vivaldi, Chromium, Arc, Spotify. 같은 앱 탭이 둘 이상이면 "Chrome 2"처럼 공백과 숫자 |

### 4.7 모션

- 크기 변화(접힘과 펼침, 폭 변화): 스프링 곡선. 응답 약 350ms, 감쇠비 0.8~0.85(오버슈트는 변화량의 1.5% 이내, 최대 약 6px). CSS linear() easing 값은 스프링 방정식으로 계산하는 스크립트로 생성해 --notch-spring에 넣는다. 대상 속성: width, height, border-radius, 역곡선 크기. 오버슈트가 거슬리면 감쇠비를 0.9까지 올린다.
- 내용 전환: 이전 내용은 블러 0에서 8px로 사라지고(120ms), 새 내용은 8px에서 0으로 풀리며 나타난다(160ms). 컨테이너 크기 변화와 겹치게 시작한다.
- 사용자 동작이나 이벤트에 반응하는 모션만 둔다. 평소에 계속 움직이는 장식은 없다. 재생 상태를 알리는 EQ는 예외.
- prefers-reduced-motion: reduce이면 스프링, 블러, 이동을 끄고 120ms 불투명도 전환만 쓴다. 가사 스윕은 유지하되 속도를 낮춘다.
- 키보드 포커스는 :focus-visible로 2px --notch-text 외곽선, 2px 간격.

### 4.8 바운즈

- Windows는 setShape로 창 영역을 제한한다. setShape는 클릭 영역뿐 아니라 그려지는 영역도 제한하므로, 사각형이 목표보다 작으면 전환 중 내용이 잘린다.
- 펼칠 때: 전환 시작 시점에 목표(큰) 사각형을 한 번 보낸다. 오버슈트 여유 8px와 역곡선 영역을 포함한다.
- 접을 때: 전환이 끝난 뒤(transitionend, 안 오는 경우를 대비한 타임아웃 포함) 목표(작은) 사각형을 보낸다.
- 내용 때문에 크기가 바뀌는 경우(가사 폭 변화)를 위해 ResizeObserver는 전환이 끝난 뒤의 보정용으로 남긴다.
- 폭과 높이 전환이 가사/제목 측정(ResizeObserver, document.fonts.ready)과 간섭하지 않아야 한다. 측정 요소는 전환 중에도 값이 흔들리지 않게 한다.

## 5. 작업 순서

각 단계는 별도 커밋. 새 브랜치(redesign/dark-minimal)에서 작업하고 푸시하지 않는다.

1. 분리만(동작 변화 없음): lyrics.ts, mediaText.ts, 화면 컴포넌트 분리. (구현됨)
2. 토큰과 마크업: index.css 교체, 폰트 번들, useAccent, Lucide 아이콘, 화면별 재작성. (구현됨)
3. 모션과 바운즈: 스프링, 내용 전환, 바운즈 전송. (구현됨)
4. 점검과 보고: 7장 체크리스트 전체 통과. (남음)

## 6. 하지 말 것

- 새 의존성 추가(허용: lucide-react, Pretendard 폰트 파일). 다른 것이 필요하면 먼저 묻는다.
- 새 네트워크 요청 추가(기존 LRCLIB와 유튜브 썸네일 외). 폰트와 아이콘은 모두 로컬 번들.
- localStorage 등 새 저장소 사용, 설정 스키마(NotchSettings) 변경.
- .discord-secret*, .env*, *.log 파일을 열어 내용을 출력하거나 커밋. 로그에 시크릿을 남기지 않는다.
- 기능 추가나 로직 개선. 발견한 버그는 고치지 말고 보고한다. (알려진 항목: 믹서가 언마운트될 때 대기 중인 볼륨 값을 보내지 않음)
- 푸시, 강제 푸시, 기존 커밋 수정.

## 7. 점검 체크리스트

타입체크와 빌드를 통과시키고 아래를 실제 Electron 창에서 직접 확인한다. 확인하지 못한 항목은 이유와 함께 보고한다. 브라우저 미리보기는 참고용이다.

- 호버로 140ms 뒤 열리고 마우스를 떼면 320ms 뒤 닫힌다. 클릭하면 고정되고 다시 클릭하면 해제된다.
- 열기/닫기 전환 중 노치의 실제 사각형이 마지막으로 보낸 setShape 사각형 안에 있다(개발 모드 검사: 프레임마다 비교해 벗어난 프레임 수와 최대 초과 픽셀을 기록, 열기와 닫기 각 10회 이상, 벗어난 프레임 0).
- 빠르게 10번 반복해도 히트 영역이 도형과 어긋나지 않고 깜빡임이 없다.
- 접힘: 유휴, 미디어 재생(가사 있음/없음), 일시정지, 긴 제목, 충전 중, 배터리 30% 이하, 출력 장치 변경, 음성 채널 참가 중.
- 펼침 미디어: 싱크 가사와 빛 스윕(움직이는 상태에서 스윕 구간이 기본색보다 분명히 밝고 줄 끝 전에 오른쪽 끝에 닿음), 비싱크 가사, 가사 없음, 연주곡, 가사 로딩 중, 재생 소스가 둘 이상일 때 칩 전환, 재생/일시정지 낙관적 갱신, 이전/다음, 진행 막대.
- HUD: 시계, 날씨(모든 종류), CPU/GPU 수치, 85C 이상 경고, 값 없음.
- 볼륨: 마우스 드래그, 호버 미리보기, 키보드(방향키, Shift, Home/End, M), 음소거. 드래그 중 값이 튀거나 되돌아가지 않는다.
- 믹서: 피크 미터, 앱별 슬라이더와 음소거, 전체 볼륨, 앱이 없을 때의 빈 상태.
- Discord: 음성 패널(참가자, 말하는 중, 음소거, 헤드셋), 마이크 클릭/우클릭, 연결 화면(오류 문구 포함). 실제 연결 상태에서 확인.
- 앨범 색: 어두운 앨범, 흑백 앨범, 이미지 없음, 추출 실패 시 폴백. 어느 경우에도 가사 스윕이 읽힌다.
- Windows 디스플레이 배율 100/125/150%, reduced-motion 켜기.

## 8. 보고 방식

단계마다 적는다: 바꾼 파일 목록, 확인한 것과 못 한 것, 이 문서와 달라진 점과 이유, 사용자 결정이 필요한 질문(최대 3개). 4단계 보고에는 아래도 포함한다.

- git log --oneline 결과
- 첫 기준 커밋(155341b)에 시크릿, 로그, 빌드 산출물이 없는지 git show --stat으로 확인한 결과
- npm audit --omit=dev 결과(고치지 말고 보고만)
