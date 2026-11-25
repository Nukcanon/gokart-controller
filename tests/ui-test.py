# 화면 시험: 가짜 블루투스를 끼워 실제 브라우저에서 동작을 확인한다.
# 실행: python tests/ui-test.py [스크린샷 폴더]   (playwright가 설치된 파이썬 필요)
import base64
import mimetypes
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "http://localhost:8765"
SHOT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else None
PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

MOCK = r"""
(() => {
  const log = { writes: [], bleDisconnects: 0, serialClosed: 0, serialAborted: 0, requestOptions: null, wakeLocks: 0 };
  const mock = { hangWrites: false, failWrites: false, cancelChooser: false, noService: false, unsupported: false, usbPort: false };
  try { Object.assign(mock, JSON.parse(sessionStorage.getItem('mock') || '{}')); } catch (e) {}
  window.__log = log;
  window.__mock = mock;

  const record = (via, data) => {
    if (mock.hangWrites) return new Promise(() => {});
    if (mock.failWrites) return Promise.reject(new DOMException('gone', 'NetworkError'));
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
    log.writes.push({ t: performance.now(), x: bytes[0], y: bytes[1], n: bytes.length, via });
    return Promise.resolve();
  };

  if (mock.unsupported) {
    delete Navigator.prototype.bluetooth;
    delete Navigator.prototype.serial;
    return;
  }
  if (mock.brave) Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: async () => true } });

  const device = new EventTarget();
  device.name = 'Go_Kart_BLE_TEST';
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    disconnect() { this.connected = false; log.bleDisconnects += 1; },
    async getPrimaryService() {
      if (mock.noService) throw new DOMException('no service', 'NotFoundError');
      return { async getCharacteristic() { return { writeValueWithoutResponse: (data) => record('ble', data) }; } };
    }
  };
  window.__device = device;
  if (mock.noBle) delete Navigator.prototype.bluetooth;
  else Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
    async getAvailability() { return !mock.btOff; },
    async requestDevice(options) {
      log.requestOptions = options;
      if (mock.hangChooser) return new Promise(() => {});
      if (mock.cancelChooser) throw new DOMException('cancelled', 'NotFoundError');
      return device;
    }
  } });

  const port = new EventTarget();
  port.getInfo = () => (mock.usbPort ? { usbVendorId: 0x1a86, usbProductId: 0x7523 } : { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' });
  port.open = async (options) => { log.serialOpen = options; };
  port.close = async () => { log.serialClosed += 1; };
  port.writable = { getWriter: () => ({
    ready: Promise.resolve(),
    write: (data) => record('serial', data),
    abort: async () => { log.serialAborted += 1; },
    releaseLock() {}
  }) };
  window.__port = port;
  if (mock.noSerial) delete Navigator.prototype.serial;
  else Object.defineProperty(navigator, 'serial', { configurable: true, value: {
    async requestPort() {
      if (mock.cancelChooser) throw new DOMException('cancelled', 'NotFoundError');
      return port;
    }
  } });

  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
    async request() { log.wakeLocks += 1; const lock = new EventTarget(); lock.release = async () => { log.wakeLocks -= 1; }; return lock; }
  } });
})();
"""

results = []
problems = []


def serve(route):
    url = route.request.url
    if not url.startswith(ORIGIN):
        route.fulfill(status=200, content_type="image/png", body=PIXEL)
        return
    name = url[len(ORIGIN):].split("?")[0].lstrip("/") or "index.html"
    if name == "__host.html":  # 다른 사이트가 이 화면을 끼워 넣은 상황을 흉내 낸다.
        route.fulfill(status=200, content_type="text/html",
                      body='<!doctype html><iframe id="inner" src="/index.html" width="900" height="700"></iframe>')
        return
    target = ROOT / name
    if not target.is_file():
        route.fulfill(status=404, body="not found")
        return
    kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if target.suffix == ".js":
        kind = "text/javascript"
    route.fulfill(status=200, content_type=kind, body=target.read_bytes())


def new_page(browser, mock=None, **context_options):
    context = browser.new_context(**context_options)
    context.route("**/*", serve)
    context.add_init_script(
        "try { if (!sessionStorage.getItem('mock')) sessionStorage.setItem('mock', %r); } catch (e) {}" % (
            __import__("json").dumps(mock or {})
        )
    )
    context.add_init_script(MOCK)
    page = context.new_page()
    page.on("console", lambda m: problems.append(f"console {m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    page.goto(ORIGIN + "/index.html")
    wait_js(page, "document.getElementById('connectLabel').textContent === '연결하기'")
    return context, page


def wait_js(page, expression, timeout=5000):
    """조건이 참이 될 때까지 기다린다. (보안 정책이 문자열 실행을 막아 wait_for_function을 쓸 수 없음)"""
    waited = 0
    while not page.evaluate(expression):
        if waited >= timeout:
            raise AssertionError(f"시간 초과: {expression}")
        page.wait_for_timeout(30)
        waited += 30


def connect(page, kind="ble"):
    page.click("#connectBtn")
    page.wait_for_selector("#connectDialog[open]")
    page.click("#chooseBle" if kind == "ble" else "#chooseClassic")
    wait_js(page, "document.getElementById('statusPill').dataset.state === 'connected'")


def pad_point(page, fx, fy):
    page.locator("#pad").scroll_into_view_if_needed()
    box = page.locator("#pad").bounding_box()
    return box["x"] + box["width"] * fx, box["y"] + box["height"] * fy


def press(page, fx=0.5, fy=0.01):
    x, y = pad_point(page, fx, fy)
    page.mouse.move(x, y)
    page.mouse.down()


def writes(page):
    return page.evaluate("window.__log.writes")


def status(page):
    return page.evaluate("document.getElementById('statusPill').dataset.state")


def notice(page):
    return page.evaluate("(() => { const n = document.getElementById('notice'); return n.hidden ? '' : n.textContent; })()")


def coords(page):
    return page.evaluate("[document.getElementById('coordX').textContent, document.getElementById('coordY').textContent]")


def assert_stopped(page, label):
    """마지막 전송이 정지 값이고, 그 뒤로 더 보내지 않는다."""
    page.wait_for_timeout(450)
    first = writes(page)
    page.wait_for_timeout(400)
    second = writes(page)
    assert first, f"{label}: 전송 기록 없음"
    assert (first[-1]["x"], first[-1]["y"]) == (100, 100), f"{label}: 마지막 값 {first[-1]}"
    assert len(first) == len(second), f"{label}: 멈춘 뒤에도 전송 {len(first)} → {len(second)}"
    assert coords(page) == ["100", "100"], f"{label}: 좌표 표시 {coords(page)}"


def test(name):
    def wrap(fn):
        results.append((name, fn))
        return fn
    return wrap


@test("처음 화면: 연결 안 됨, 좌표 100/100, 안내 없음")
def _(browser):
    context, page = new_page(browser)
    assert status(page) == "idle"
    assert coords(page) == ["100", "100"]
    assert notice(page) == ""
    assert page.inner_text("#statusText") == "연결 안 됨"
    # 연결 버튼과 조이스틱이 스크롤 없이 한 화면(1280x720)에 들어온다.
    button = page.locator("#connectBtn").bounding_box()
    pad = page.locator("#pad").bounding_box()
    assert button["y"] >= 0 and pad["y"] + pad["height"] <= 720, (button, pad)
    if SHOT_DIR:
        page.set_viewport_size({"width": 1280, "height": 800})
        page.screenshot(path=str(SHOT_DIR / "desktop.png"))
    context.close()


@test("BLE 연결: 상태 표시, 장치 이름 필터, 화면 켜짐 유지")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    assert page.inner_text("#statusText") == "BLE 연결됨 · Go_Kart_BLE_TEST"
    assert page.inner_text("#connectLabel") == "연결 끊기"
    options = page.evaluate("window.__log.requestOptions")
    assert options["filters"] == [{"namePrefix": "Go_Kart_"}], options
    assert options["optionalServices"] == ["4fafc201-1fb5-459e-8fcc-c5c9c331914b"]
    assert writes(page) == [], "연결만으로는 아무것도 보내지 않음"
    wait_js(page, "window.__log.wakeLocks === 1")
    context.close()


@test("누르고 가만히 있어도 계속 보내고(간격 150ms 미만), 떼면 정지 후 전송 중단")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    press(page)
    page.wait_for_timeout(700)
    held = writes(page)
    assert len(held) >= 9, f"전송 수 {len(held)}"
    assert all(w["n"] == 2 and w["y"] == 200 and 99 <= w["x"] <= 101 for w in held), held[:3]
    gaps = [b["t"] - a["t"] for a, b in zip(held, held[1:])]
    assert max(gaps) < 150, f"최대 간격 {max(gaps):.0f}ms"
    assert coords(page)[1] == "200"
    page.mouse.up()
    assert_stopped(page, "손 뗌")
    tail = writes(page)[len(held):]
    neutral = [w for w in tail if (w["x"], w["y"]) == (100, 100)]
    assert len(neutral) == 4, f"정지 값 {len(neutral)}번"
    context.close()


@test("움직이면 값이 바뀌고 범위를 벗어나도 0~200")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    press(page, 0.5, 0.5)
    x, y = pad_point(page, 1.6, 1.4)  # 조이스틱 밖 오른쪽 아래
    page.mouse.move(x, y, steps=5)
    page.wait_for_timeout(200)
    last = writes(page)[-1]
    assert (last["x"], last["y"]) == (200, 0), last
    page.mouse.up()
    assert_stopped(page, "밖에서 손 뗌")
    context.close()


@test("화면이 가려지면 즉시 정지, 누른 채 움직여도 다시 보내지 않음")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    press(page)
    page.wait_for_timeout(200)
    page.evaluate("""() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }""")
    x, y = pad_point(page, 0.9, 0.9)
    page.mouse.move(x, y, steps=4)
    assert_stopped(page, "화면 가려짐")
    assert status(page) == "connected"
    page.mouse.up()
    context.close()


@test("창이 초점을 잃으면 즉시 정지")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    press(page)
    page.wait_for_timeout(200)
    page.evaluate("window.dispatchEvent(new Event('blur'))")
    assert_stopped(page, "초점 잃음")
    page.mouse.up()
    context.close()


@test("버튼을 뗀 사실을 놓쳐도(눌린 버튼 없는 이동) 즉시 정지")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    press(page)
    page.wait_for_timeout(200)
    page.evaluate("""() => document.getElementById('pad').dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, bubbles: true, clientX: 5, clientY: 5 }))""")
    assert_stopped(page, "뗀 사실 놓침")
    page.mouse.up()
    context.close()


@test("창을 닫을 때(pagehide): 정지 값 전송 + 연결 끊기")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    press(page)
    page.wait_for_timeout(200)
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    assert page.evaluate("window.__log.bleDisconnects") == 1
    assert status(page) == "idle"
    assert_stopped(page, "창 닫힘")
    page.mouse.up()
    context.close()


@test("연결이 저절로 끊기면 안내하고 조작을 보내지 않음")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    press(page)
    page.wait_for_timeout(150)
    before = len(writes(page))
    page.evaluate("window.__device.dispatchEvent(new Event('gattserverdisconnected'))")
    page.wait_for_timeout(300)
    assert status(page) == "idle"
    assert "끊어졌습니다" in notice(page)
    assert len(writes(page)) == before
    assert page.evaluate("window.__log.wakeLocks") == 0
    page.mouse.up()
    context.close()


@test("고카트가 응답하지 않으면 1.5초쯤 뒤 연결을 끊고 안내")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    page.evaluate("window.__mock.hangWrites = true")
    press(page)
    wait_js(page, "document.getElementById('statusPill').dataset.state === 'idle'", timeout=4000)
    assert "응답하지 않아" in notice(page)
    assert page.evaluate("window.__log.bleDisconnects") == 1
    page.mouse.up()
    context.close()


@test("전송 실패 시 연결을 끊고 안내")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    page.evaluate("window.__mock.failWrites = true")
    press(page)
    wait_js(page, "document.getElementById('statusPill').dataset.state === 'idle'", timeout=2000)
    assert "끊어졌습니다" in notice(page)
    page.mouse.up()
    context.close()


@test("연결 끊기 버튼: 끊고 다시 연결 가능")
def _(browser):
    context, page = new_page(browser)
    connect(page)
    page.click("#connectBtn")
    wait_js(page, "document.getElementById('statusPill').dataset.state === 'idle'")
    assert page.evaluate("window.__log.bleDisconnects") == 1
    assert notice(page) == ""
    connect(page)
    press(page)
    page.wait_for_timeout(150)
    assert writes(page), "다시 연결한 뒤 전송됨"
    page.mouse.up()
    context.close()


@test("클래식(시리얼) 연결: 전송·정지·닫기")
def _(browser):
    context, page = new_page(browser)
    connect(page, "classic")
    assert page.inner_text("#statusText") == "클래식 연결됨"
    press(page, 0.01, 0.5)
    page.wait_for_timeout(300)
    held = writes(page)
    assert held and all(w["via"] == "serial" and w["x"] == 0 for w in held), held[:2]
    page.mouse.up()
    assert_stopped(page, "클래식 손 뗌")
    page.click("#connectBtn")
    wait_js(page, "window.__log.serialClosed === 1")
    assert status(page) == "idle"
    context.close()


@test("클래식: 창을 닫을 때 정지 값을 보낸 뒤 닫는다")
def _(browser):
    context, page = new_page(browser)
    connect(page, "classic")
    press(page)
    page.wait_for_timeout(200)
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    wait_js(page, "window.__log.serialClosed === 1")
    assert_stopped(page, "클래식 창 닫힘")
    page.mouse.up()
    context.close()


@test("장치를 고르지 않으면 안내만 하고 대기 상태")
def _(browser):
    context, page = new_page(browser, {"cancelChooser": True})
    page.click("#connectBtn")
    page.click("#chooseBle")
    wait_js(page, "!document.getElementById('notice').hidden")
    assert "고르지 않았습니다" in notice(page)
    assert page.evaluate("document.getElementById('notice').dataset.kind") == "info"
    assert status(page) == "idle"
    assert page.is_enabled("#connectBtn")
    context.close()


@test("고카트가 아닌 장치는 연결을 끊고 안내")
def _(browser):
    context, page = new_page(browser, {"noService": True})
    page.click("#connectBtn")
    page.click("#chooseBle")
    wait_js(page, "!document.getElementById('notice').hidden")
    assert "고카트가 아닌 장치" in notice(page), notice(page)
    assert page.evaluate("window.__log.bleDisconnects") == 1, page.evaluate("window.__log.bleDisconnects")
    assert status(page) == "idle", status(page)
    context.close()


@test("클래식: USB 장치를 고르면 열지 않고 신호도 보내지 않음")
def _(browser):
    context, page = new_page(browser, {"usbPort": True})
    page.click("#connectBtn")
    page.click("#chooseClassic")
    wait_js(page, "!document.getElementById('notice').hidden")
    assert "USB로 연결된 장치" in notice(page), notice(page)
    assert status(page) == "idle"
    assert page.evaluate("window.__log.serialOpen") is None, "포트를 열지 않음"
    assert writes(page) == []
    context.close()


@test("보안 정책: 문서 안 스크립트·외부 전송이 막히고, 다른 사이트에 끼워지면 연결을 거부")
def _(browser):
    context, page = new_page(browser)
    result = page.evaluate("""async () => {
      const out = {};
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true';
      document.head.appendChild(s);
      out.inline = window.__inlineRan === true;
      try { await fetch('https://example.com/x', { mode: 'no-cors' }); out.fetch = true; } catch (e) { out.fetch = false; }
      const ext = document.createElement('script');
      ext.src = 'https://example.com/evil.js';
      out.external = await new Promise((resolve) => { ext.onload = () => resolve(true); ext.onerror = () => resolve(false); document.head.appendChild(ext); });
      return out;
    }""")
    assert result == {"inline": False, "fetch": False, "external": False}, result
    problems[:] = [p for p in problems if "Content Security Policy" not in p and "example.com" not in p]
    # 끼워진 화면: 다른 문서의 iframe 안에서는 연결 창이 열리지 않아야 한다.
    page.goto(ORIGIN + "/__host.html")
    inner = page.frame_locator("#inner")
    inner.locator("#notice").wait_for(state="visible", timeout=5000)
    assert "끼워진 화면" in inner.locator("#notice").inner_text()
    inner.locator("#connectBtn").click()
    assert inner.locator("#connectDialog").get_attribute("open") is None
    context.close()


@test("BLE가 꺼진 브라우저(Brave): 눌러도 반응 없는 일이 없고, 켜는 방법을 안내")
def _(browser):
    context, page = new_page(browser, {"noBle": True, "brave": True})
    assert notice(page) == "", "클래식은 쓸 수 있으므로 처음에는 안내 없음"
    page.click("#connectBtn")
    page.wait_for_selector("#connectDialog[open]")
    assert page.get_attribute("#chooseBle", "data-state") == "off"
    assert "brave://flags/#brave-web-bluetooth-api" in page.inner_text("#bleHint")
    assert page.get_attribute("#chooseClassic", "data-state") == "on"
    assert page.is_enabled("#chooseBle"), "누를 수 있어야 함"
    page.click("#chooseBle")
    wait_js(page, "!document.getElementById('notice').hidden")
    assert "brave://flags/#brave-web-bluetooth-api" in notice(page), notice(page)
    assert status(page) == "idle"
    assert page.get_attribute("#connectDialog", "open") is None
    connect(page, "classic")  # 클래식은 그대로 연결됨
    assert notice(page) == "", "연결되면 안내를 지움"
    context.close()


@test("블루투스가 꺼진 기기: BLE 선택에 켜라는 안내, 연결 중에는 무엇을 기다리는지 안내")
def _(browser):
    context, page = new_page(browser, {"btOff": True})
    page.click("#connectBtn")
    wait_js(page, "document.getElementById('chooseBle').dataset.state === 'off'")
    assert "블루투스가 꺼져 있으면 켜" in page.inner_text("#bleHint") and "근처 기기" in page.inner_text("#bleHint")
    page.click("#chooseBle")
    wait_js(page, "!document.getElementById('notice').hidden")
    assert "블루투스가 꺼져 있으면 켜" in notice(page)
    context.close()
    # 폰의 Brave: 블루투스가 켜져 있어도 "쓸 수 없음"으로 답한다. 블루투스를 켜라고 하지 않고 Brave 안내를 보여 준다.
    context, page = new_page(browser, {"btOff": True, "brave": True}, viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    page.click("#connectBtn")
    wait_js(page, "document.getElementById('chooseBle').dataset.state === 'off'")
    hint = page.inner_text("#bleHint")
    assert "Brave" in hint and "크롬으로 열면" in hint and "꺼져 있으면" not in hint, hint
    page.click("#chooseBle")
    wait_js(page, "!document.getElementById('notice').hidden")
    assert "brave://flags/#brave-web-bluetooth-api" in notice(page) and status(page) == "idle"
    context.close()
    context, page = new_page(browser, {"hangChooser": True})
    page.click("#connectBtn")
    page.click("#chooseBle")
    wait_js(page, "document.getElementById('statusPill').dataset.state === 'connecting'")
    # 장치 고르는 창을 기다리는 동안: 무엇을 해야 하는지 팝업으로 안내
    assert page.get_attribute("#waitDialog", "open") is not None
    assert "Go_Kart_BLE_" in page.inner_text("#waitText") and "주소창 바로 아래" in page.inner_text("#waitText")
    assert page.locator("#waitList li").count() == 2
    assert page.is_visible("#waitArrow"), "PC에서는 창이 뜨는 쪽을 가리킴"
    assert page.is_visible("#waitPin") and "6자리" in page.inner_text("#waitPin"), "BLE는 비밀번호 안내를 보여 줌"
    if SHOT_DIR:
        page.screenshot(path=str(SHOT_DIR / "waiting.png"))
    page.click("#waitCancel")
    assert status(page) == "idle"
    assert page.get_attribute("#waitDialog", "open") is None
    assert "고르지 않았습니다" in notice(page)
    assert page.is_enabled("#connectBtn")
    context.close()
    # 휴대폰: 화살표 없이, 권한 안내가 하나 더 붙는다
    context, page = new_page(browser, {"hangChooser": True}, viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    page.click("#connectBtn")
    page.click("#chooseBle")
    wait_js(page, "document.getElementById('waitDialog').open")
    assert not page.is_visible("#waitArrow")
    assert page.locator("#waitList li").count() == 3
    assert "근처 기기" in page.inner_text("#waitList")
    context.close()


@test("지원하지 않는 브라우저: 처음부터 안내, 연결 창을 열지 않음")
def _(browser):
    context, page = new_page(browser, {"unsupported": True})
    assert "쓸 수 없습니다" in notice(page)
    page.click("#connectBtn")
    assert not page.evaluate("document.getElementById('connectDialog').open")
    context.close()


@test("아이폰: 연결할 수 없다는 것과 대신 쓸 기기를 처음부터 안내")
def _(browser):
    agent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    context, page = new_page(browser, {"unsupported": True}, user_agent=agent,
                             viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    text = notice(page)
    assert "아이폰" in text and "Bluefy" in text and "연결할 수 없습니다" in text and "크롬으로 열어" not in text, text
    page.click("#connectBtn")
    assert not page.evaluate("document.getElementById('connectDialog').open")
    assert "Bluefy" in notice(page)
    # 전체 화면에서도 안내가 화면 안에 보인다.
    no_native_fullscreen(page)
    page.click("#fullscreenBtn")
    box = page.locator("#notice").bounding_box()
    assert box and box["y"] >= 0 and box["y"] + box["height"] <= 760, box
    check_fullscreen_layout(page, "아이폰 안내", 200)
    context.close()
    # 아이폰의 웹 블루투스 브라우저 앱(BLE만 있음): 안내 없이 열리고 BLE로 연결된다. 클래식은 쓸 수 없다고 알려 준다.
    context, page = new_page(browser, {"noSerial": True}, user_agent=agent,
                             viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    assert notice(page) == "", notice(page)
    page.click("#connectBtn")
    page.wait_for_selector("#connectDialog[open]")
    assert page.get_attribute("#chooseBle", "data-state") == "on"
    hint = page.inner_text("#classicHint")
    assert page.get_attribute("#chooseClassic", "data-state") == "off" and "아이폰" in hint and "BLE 고카트" in hint, hint
    page.click("#chooseBle")
    wait_js(page, "document.getElementById('statusPill').dataset.state === 'connected'")
    press(page)
    page.wait_for_timeout(200)
    assert writes(page) and writes(page)[-1]["y"] == 200
    page.mouse.up()
    assert_stopped(page, "아이폰 BLE")
    context.close()


@test("크롬이 아닌 브라우저: 안 될 때 크롬으로 열라고 안내, 크롬에서는 그 말을 붙이지 않음")
def _(browser):
    context, page = new_page(browser, {"unsupported": True})
    assert "크롬으로 열어 주세요" in notice(page), notice(page)
    context.close()
    context, page = new_page(browser, {"btOff": True, "noSerial": True})
    page.click("#connectBtn")
    wait_js(page, "document.getElementById('chooseBle').dataset.state === 'off'")
    assert "계속 안 되면 크롬으로 열어 주세요" in page.inner_text("#bleHint")
    assert "크롬(최신 버전)으로 열어 주세요" in page.inner_text("#classicHint")
    context.close()
    context, page = new_page(browser)
    connect_fail ="document.getElementById('statusPill').dataset.state === 'idle' && !document.getElementById('notice').hidden"
    page.evaluate("(() => { window.__device.gatt.connect = async () => { throw new DOMException('fail', 'NetworkError'); }; })()")
    page.click("#connectBtn")
    page.click("#chooseBle")
    wait_js(page, connect_fail)
    assert "연결하지 못했습니다" in notice(page) and "계속 안 되면 크롬으로 열어 주세요" in notice(page), notice(page)
    # 구글 크롬이면 붙이지 않는다.
    page.evaluate("Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { brands: [{ brand: 'Google Chrome', version: '140' }], mobile: false } })")
    page.click("#connectBtn")
    page.click("#chooseBle")
    wait_js(page, connect_fail)
    assert "연결하지 못했습니다" in notice(page) and "크롬으로 열어" not in notice(page), notice(page)
    context.close()


@test("설정: 앞뒤 반대로·회전이 적용되고 새로 열어도 유지")
def _(browser):
    context, page = new_page(browser)
    page.click("label.switch-row:has(#invertY)")
    connect(page)
    press(page)
    page.wait_for_timeout(150)
    assert writes(page)[-1]["y"] == 0, writes(page)[-1]
    page.mouse.up()
    page.wait_for_timeout(100)
    page.click(".segmented label:has(input[value='90'])")
    press(page)  # 위로: 반전으로 y=0 → 90도 회전하면 x=200
    page.wait_for_timeout(150)
    last = writes(page)[-1]
    assert (last["x"], last["y"]) == (200, 100), last
    page.mouse.up()
    page.reload()
    wait_js(page, "document.getElementById('connectLabel').textContent === '연결하기'")
    assert page.is_checked("#invertY") and not page.is_checked("#invertX")
    assert page.is_checked("input[name='rotation'][value='90']")
    context.close()


@test("터치: 누르면 전송, 터치가 취소되면 즉시 정지")
def _(browser):
    context, page = new_page(browser, viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    if SHOT_DIR:
        page.screenshot(path=str(SHOT_DIR / "phone.png"), full_page=True)
    connect(page)
    cdp = context.new_cdp_session(page)
    x, y = pad_point(page, 0.5, 0.02)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1}]})
    page.wait_for_timeout(300)
    held = writes(page)
    assert len(held) >= 4 and held[-1]["y"] == 200, held[-1:]
    if SHOT_DIR:
        page.screenshot(path=str(SHOT_DIR / "phone-driving.png"))
    cdp.send("Input.dispatchTouchEvent", {"type": "touchCancel", "touchPoints": []})
    assert_stopped(page, "터치 취소")
    context.close()


@test("폰을 눕힌 화면에서도 조이스틱이 화면 안에 들어온다")
def _(browser):
    context, page = new_page(browser, viewport={"width": 844, "height": 390}, has_touch=True, is_mobile=True)
    page.evaluate("document.getElementById('pad').scrollIntoView({ block: 'center' })")
    box = page.locator("#pad").bounding_box()
    assert box["height"] <= 390 and abs(box["width"] - box["height"]) < 1, box
    knob = page.locator("#knob").bounding_box()
    assert abs((knob["x"] + knob["width"] / 2) - (box["x"] + box["width"] / 2)) < 1, "손잡이 가운데"
    if SHOT_DIR:
        page.screenshot(path=str(SHOT_DIR / "phone-landscape.png"))
    context.close()


FULLSCREEN_LAYOUT = """(() => {
  const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const shown = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return {
    mode: document.documentElement.dataset.fullscreen,
    label: document.getElementById('fullscreenLabel').textContent,
    view: { w: window.innerWidth, h: window.innerHeight },
    scrolls: document.documentElement.scrollHeight > window.innerHeight + 1 || document.documentElement.scrollWidth > window.innerWidth + 1,
    header: shown('.site-header'), footer: shown('.site-footer'), guide: shown('.guide-panel'),
    exit: box('#fullscreenBtn'), connect: box('#connectBtn'), pill: box('#statusPill'),
    pad: box('#pad'), settings: box('.settings-panel'),
    flipX: box('.switch-row:nth-of-type(1)'), flipY: box('.switch-row:nth-of-type(2)'), turn: box('.segmented'),
    last: box('.segmented label:last-of-type span'),
  };
})()"""


def check_fullscreen_layout(page, label, min_pad):
    """전체 화면: 끝내기 버튼·조이스틱·조종 설정이 스크롤 없이 한 화면에 있고, 설정은 맨 아래에 있다."""
    info = page.evaluate(FULLSCREEN_LAYOUT)
    view = info["view"]
    assert info["mode"] == "true" and info["label"] == "전체 화면 끝내기", (label, info["mode"], info["label"])
    assert not info["header"] and not info["footer"] and not info["guide"], f"{label}: 머리말·안내가 남아 있음"
    assert not info["scrolls"], f"{label}: 스크롤이 생김"
    for name in ("exit", "connect", "pill", "pad", "settings", "flipX", "flipY", "turn", "last"):
        b = info[name]
        assert b["w"] > 0 and b["h"] > 0, f"{label}: {name} 안 보임"
        assert b["x"] >= -0.5 and b["y"] >= -0.5 and b["right"] <= view["w"] + 0.5 and b["bottom"] <= view["h"] + 0.5, f"{label}: {name} 화면 밖 {b}"
    pad, settings = info["pad"], info["settings"]
    assert abs(pad["w"] - pad["h"]) < 1 and pad["w"] >= min_pad, f"{label}: 조이스틱 크기 {pad}"
    assert pad["bottom"] <= settings["y"] + 0.5, f"{label}: 조이스틱이 설정과 겹침"
    assert info["exit"]["bottom"] <= pad["y"] + 0.5 and info["connect"]["bottom"] <= pad["y"] + 0.5, f"{label}: 버튼이 조이스틱과 겹침"
    assert view["h"] - settings["bottom"] <= 16, f"{label}: 설정이 맨 아래에 있지 않음 {settings}"
    assert info["exit"]["h"] >= 40 and info["last"]["h"] >= 36, f"{label}: 누르는 곳이 너무 작음"
    return info


def no_native_fullscreen(page):
    """브라우저의 전체 화면 기능이 없는 기기(아이폰)를 흉내 낸다."""
    page.evaluate("delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen")
    assert page.evaluate("!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen")


@test("전체 화면(폰 세로, 브라우저 기능 없는 기기): 설정은 아래에, 끝내기 버튼으로 나옴, 조종·설정 동작")
def _(browser):
    context, page = new_page(browser, viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    no_native_fullscreen(page)
    assert page.inner_text("#fullscreenLabel") == "전체 화면"
    page.click("#fullscreenBtn")
    check_fullscreen_layout(page, "세로", 300)
    if SHOT_DIR:
        page.screenshot(path=str(SHOT_DIR / "fullscreen-portrait.png"))
    # 전체 화면에서 연결·조종
    connect(page)
    check_fullscreen_layout(page, "세로(연결됨)", 300)
    cdp = context.new_cdp_session(page)
    x, y = pad_point(page, 0.5, 0.02)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1}]})
    page.wait_for_timeout(300)
    held = writes(page)
    assert len(held) >= 4 and (held[-1]["x"], held[-1]["y"]) == (100, 200), held[-1:]
    # 누른 채로 전체 화면을 끝내면 정지한다(화면 배치가 바뀌므로).
    page.evaluate("document.getElementById('fullscreenBtn').click()")
    assert page.evaluate("document.documentElement.dataset.fullscreen") == "false"
    assert_stopped(page, "전체 화면 끝내기")
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    assert page.evaluate("(() => { const r = document.querySelector('.site-header').getBoundingClientRect(); return r.height > 0; })()"), "머리말이 돌아오지 않음"
    assert page.inner_text("#fullscreenLabel") == "전체 화면"
    # 전체 화면에서 설정을 바꾸면 적용된다.
    page.click("#fullscreenBtn")
    page.click(".switch-row:nth-of-type(2)")
    assert page.evaluate("document.getElementById('invertY').checked")
    before = len(writes(page))
    x, y = pad_point(page, 0.5, 0.02)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 2}]})
    page.wait_for_timeout(250)
    sent = writes(page)[before:]
    assert sent and sent[-1]["y"] == 0, sent[-1:]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    assert_stopped(page, "전체 화면 손 뗌")
    context.close()


@test("전체 화면(폰 가로): 작은 폰에서도 조이스틱·설정·끝내기 버튼이 한 화면에")
def _(browser):
    for width, height, min_pad in ((760, 390, 200), (640, 360, 170), (360, 640, 250)):
        context, page = new_page(browser, viewport={"width": width, "height": height}, has_touch=True, is_mobile=True)
        no_native_fullscreen(page)
        page.click("#fullscreenBtn")
        check_fullscreen_layout(page, f"{width}x{height}", min_pad)
        # 오류 안내가 떠도 화면 밖으로 밀려나지 않는다.
        page.evaluate("(() => { const n = document.getElementById('notice'); n.textContent = '연결이 끊어졌습니다. 고카트 전원을 확인하고 다시 연결하세요.'; n.dataset.kind = 'error'; n.hidden = false; })()")
        check_fullscreen_layout(page, f"{width}x{height}(안내)", min_pad - 70)
        if SHOT_DIR and width != 640:
            page.evaluate("document.getElementById('notice').hidden = true")
            page.screenshot(path=str(SHOT_DIR / f"fullscreen-{width}x{height}.png"))
        context.close()


@test("전체 화면(브라우저 기능 있는 기기): 뒤로 가기로 풀리면 화면도 돌아오고, 버튼으로 끝내면 브라우저 전체 화면도 풀림")
def _(browser):
    context, page = new_page(browser, viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    page.click("#fullscreenBtn")
    wait_js(page, "document.fullscreenElement === document.documentElement")
    assert page.evaluate("document.documentElement.dataset.fullscreen") == "true"
    page.evaluate("document.exitFullscreen()")  # 뒤로 가기·Esc와 같은 효과
    wait_js(page, "document.documentElement.dataset.fullscreen === 'false'")
    assert page.inner_text("#fullscreenLabel") == "전체 화면"
    page.click("#fullscreenBtn")
    wait_js(page, "document.fullscreenElement === document.documentElement")
    page.click("#fullscreenBtn")
    wait_js(page, "document.fullscreenElement === null")
    assert page.evaluate("document.documentElement.dataset.fullscreen") == "false"
    # 연결 창은 전체 화면에서도 뜬다.
    page.click("#fullscreenBtn")
    wait_js(page, "document.fullscreenElement === document.documentElement")
    page.click("#connectBtn")
    page.wait_for_selector("#connectDialog[open]")
    box = page.locator("#chooseBle").bounding_box()
    assert box and box["width"] > 0, "전체 화면에서 연결 창이 보이지 않음"
    context.close()


def main():
    if SHOT_DIR:
        SHOT_DIR.mkdir(parents=True, exist_ok=True)
    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for name, fn in results:
                try:
                    fn(browser)
                    print(f"통과  {name}")
                except Exception as error:  # noqa: BLE001
                    failed += 1
                    print(f"실패  {name}\n      {str(error).splitlines()[0] if str(error) else type(error).__name__}")
        finally:
            browser.close()
    if problems:
        failed += 1
        print("콘솔 오류:")
        for line in problems[:10]:
            print("      " + line)
    print(f"\n{len(results) - failed if failed <= len(results) else 0}/{len(results)} 통과")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
