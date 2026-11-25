# HANDOFF (2026-11-25)

## 지금 상태
- 게시 완료: `https://nukcanon.github.io/gokart-controller/` (저장소 `Nukcanon/gokart-controller`, `main`에 올리면 자동 배포).
- 홈(`Nukcanon/nukcanon`의 `index.html`) "웹 애플리케이션" 카드에 "고카트 조종기" 링크를 넣었다.
- 화면은 nukcanon 사이트 테마, 조이스틱은 원형 받침 + 검은 엄지 스틱 모양(CSS로 그림).
- 보안 보강: 보안 정책(CSP), iframe 안 연결 거부, 클래식에서 USB 장치 거부. 배포는 앱 파일만.
- 검증: `node tests/core-test.js` 16/16, `tests/ui-test.py` 22/22 통과(가짜 블루투스·시리얼 기준). 게시된 주소를 휴대폰 크기 창으로 열어 오류 없이 뜨는 것 확인.
- 호환: BLE 펌웨어 V2~V6(같은 이름·UUID·2바이트 값). 맨 처음 BLE판(UUID가 다름)은 안 된다.

## 확인되지 않은 것
- 실제 고카트·실제 블루투스 연결. 특히 클래식(Web Serial): 안드로이드 크롬에서 목록에 나오는지, 연결 끊김이 감지되는지.
- 펌웨어 V6에서 블루투스 비밀번호를 켰을 때 웹앱에서 비밀번호 창이 뜨고 연결되는지(첫 전송이 거부되면 "연결이 끊어졌습니다"가 뜰 수 있음. 다시 연결하면 되는지 확인 필요).
- Brave에서 Web Bluetooth가 켜지는지(기본 꺼짐으로 알고 있음).

## 함정(배포)
- 새 저장소는 Pages가 꺼져 있어 첫 배포가 실패한다. `gh api -X POST repos/<소유자>/<이름>/pages -f build_type=workflow`로 켠 뒤 다시 실행한다.
- 홈 저장소는 `nukcanon.com` 도메인을 쓴다. `nukcanon.github.io/nukcanon/...` 주소는 그쪽으로 넘어가므로, 보안 정책(CSP)의 `img-src`에 `https://nukcanon.com`이 있어야 머리말 아이콘이 보인다.

## 다음에 할 것
1. 실제 고카트로 시험: 주행 중 창 닫기·화면 끄기·탭 전환·폰 멀어지기에서 멈추는지.
2. 펌웨어 V6을 올린 고카트에서 비밀번호 켬/끔 각각 연결 시험.
