# CODEMAP

## 목적
블루투스(BLE·클래식)로 고카트를 조종하는 정적 웹앱(GitHub Pages). 안드로이드 앱 `GoKart_BLE`의 웹 이식판.
이 저장소는 공개되므로 문서·코드에 개인 폴더 경로, 계정 이름, 내부 저장소 주소를 적지 않는다.

## 실행·시험
- 실행: 정적 파일. `python -m http.server 8080` 후 `http://localhost:8080` (블루투스는 HTTPS 또는 localhost에서만 동작).
- 핵심 시험: `node tests/core-test.js` (좌표 계산, 전송 주기. 가짜 시계 사용, 1초 미만)
- 화면 시험: `python tests/ui-test.py [스크린샷 폴더]` (playwright가 설치된 파이썬(이 PC는 anaconda)으로 실행, 약 20초. 가짜 블루투스·시리얼을 끼워 넣음)
- 배포: `main`에 올리면 `.github/workflows/pages.yml`이 앱 파일만(`index.html`, `style.css`, `core.js`, `app.js`, `favicon.svg`) Pages로 배포. 파일을 추가하면 목록에도 넣는다. `index.html`의 `?v=` 값을 함께 올린다.

## 파일
- `index.html` — 화면 구조. id가 `app.js`의 `els`와 1:1.
- `style.css` — nukcanon 사이트(`nukcanon.github.io/nukcanon/css/style.css`의 Home Page 부분) 테마를 따른다. 색·간격 변수는 `:root`에만 정의. 머리말·바닥글·카드 머리(`.card-heading`, `.section-icon`)는 사이트와 같은 클래스·값이므로 사이트가 바뀌면 함께 맞춘다.
- `core.js` — 화면과 무관한 로직. `computeCoords`(좌표), `createSender`(전송 주기). node에서도 그대로 불러 시험한다.
- `app.js` — 연결 방식 2종(`createBleTransport`, `createSerialTransport`), 연결·해제, 조이스틱, 설정 저장.
- `tests/` — 위 두 시험.

## 통신 규약 (펌웨어와 맞춰야 함)
- 보내는 값: 2바이트 `[x, y]`, 각 0~200, 100이 정지. 위로 밀면 y가 커진다.
- BLE: 서비스 `4fafc201-…914b`, 특성 `beb5483e-…26a8`, 응답 없는 쓰기. 장치 이름 `Go_Kart_BLE_XXXX`.
- 클래식: SPP(시리얼). 장치 이름 `Go_Kart_BT_XXXX`. 기기에서 먼저 등록(페어링)해야 목록에 나온다.
- 펌웨어: 고카트 자료 폴더의 `완성` 아래 `Go_kart_with_led_ESP32_BLE_V6`, `Go_kart_with_led_ESP32_BT_V5`가 최신(이 저장소에는 없음. 실물 시험 전).
- 펌웨어 V6에는 "방향 맞추기"(이 앱의 조종 설정과 같은 계산)가 있다. 펌웨어에서 맞춘 고카트는 이 앱의 조종 설정을 기본값으로 둔다.
- 펌웨어의 정지 조건: BLE는 마지막 명령 뒤 0.2초 또는 연결 끊김, 클래식은 마지막 명령 뒤 1초. 그 뒤에는 유선 조이스틱으로 넘어간다.

## 전송 흐름
조이스틱 누름 → `moveTo` → `computeCoords` → `sender.hold(x, y)`
- 누르는 동안 50ms마다 현재 값을 다시 보낸다(가만히 있어도). 펌웨어가 0.2초 동안 명령이 없으면 멈추기 때문.
- 손을 떼면 `sender.release()` → 정지 값 4번 → 전송 중단(유선 조이스틱에 제어를 돌려줌).
- 한 번에 하나만 전송. 전송이 1.5초 넘게 끝나지 않으면 연결 이상으로 보고 끊는다.

정지시키는 사건(모두 `centerJoystick` 또는 `handlePageHide`로 모인다): 손 뗌, 터치 취소, 포인터 캡처 잃음, 탭 가려짐(`visibilitychange`), 창 초점 잃음(`blur`), `freeze`, 창 닫힘(`pagehide`, 연결도 끊음), 설정 변경, 전체 화면 켜고 끄기, 연결·해제 순간.

## 전체 화면
- `setFullscreen` → `html[data-fullscreen="true"]`. 화면 배치는 `style.css`의 "전체 화면 조종" 부분이 바꾼다(머리말·안내 숨김, 위: 버튼·상태, 가운데: 조이스틱, 아래: 조종 설정. 스크롤 없음).
- 브라우저의 전체 화면 기능은 있을 때만 함께 쓴다. 없는 기기(아이폰)에서도 배치는 바뀌고, "전체 화면 끝내기" 버튼이 늘 위에 있어 뒤로 가기 없이 나올 수 있다.
- 뒤로 가기·Esc로 브라우저 전체 화면이 풀리면(`fullscreenchange`) 배치도 되돌린다.
- 전체 화면에서는 `display: contents`로 카드 틀을 풀어 격자에 다시 놓는다. `index.html`의 묶음 구조를 바꾸면 이 부분도 함께 본다.

## 보안
- `index.html`의 보안 정책(CSP): 이 사이트의 스크립트·스타일만 허용, 외부 전송(`connect-src`) 금지. 문서 안 스크립트·`style` 속성·외부 CDN을 쓰면 막힌다(`el.style.setProperty`는 허용).
- 다른 사이트의 iframe 안에서는 연결을 거부한다(`isFramed`).
- 클래식 연결에서 USB 장치를 고르면 열지 않는다(다른 기기에 조종 신호가 가는 것 방지).
- 화면에 넣는 글자는 모두 `textContent`. `innerHTML`을 쓰지 않는다(장치 이름은 남이 정할 수 있는 값).
- 펌웨어에는 연결 인증이 없다. 가까이 있는 누구나 연결할 수 있고, 블루투스 명령이 유선 조이스틱보다 우선한다. 고치려면 펌웨어를 바꿔야 한다.

## 함정
- 웹앱만으로는 "반드시 멈춤"을 보장하지 못한다(브라우저 강제 종료, 방전, 전파 끊김). 실제 보장은 펌웨어의 시간 제한이 한다. 재전송 주기(50ms)를 펌웨어 제한(200ms)보다 늘리면 주행이 끊긴다.
- 브라우저 오류(DOMException)에도 숫자 `code`가 있다. 우리가 만든 오류는 `isCoded()`로 가린다.
- Web Bluetooth는 전송을 겹치면 거부한다. 반드시 `createSender`를 거쳐 보낸다.
- 정지 상태에서 정지 값을 계속 보내면 펌웨어가 블루투스 제어 중으로 보고 유선 조이스틱이 먹지 않는다. 그래서 4번만 보내고 멈춘다.
- 조이스틱 판(`.pad`)에 테두리(border)를 주면 좌표 계산이 어긋난다(안쪽 그림자로 선을 그림).
- 회전은 90도 단위만 지원하고 삼각함수를 쓰지 않는다(안드로이드판은 오차로 1이 깎였음).
- 실제 고카트·실제 블루투스로는 검증하지 못했다. 시험은 가짜 장치 기준.
