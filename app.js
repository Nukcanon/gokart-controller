// 화면·블루투스 연결 담당. 좌표 계산과 전송 주기는 core.js.
(() => {
  'use strict';

  const Core = window.GoKartCore;
  const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
  const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
  const NAME_PREFIX = 'Go_Kart_';
  const CONNECT_TIMEOUT_MS = 10000;
  const CLOSE_TIMEOUT_MS = 2000;
  const FLUSH_TIMEOUT_MS = 300;
  const STORAGE_KEY = 'gokart-controller:settings:v1';

  const MESSAGES = {
    unsupported: '이 브라우저에서는 블루투스를 쓸 수 없습니다. 안드로이드 폰이나 PC의 크롬·엣지로 열어 주세요. (아이폰은 지원하지 않습니다)',
    apple: '아이폰·아이패드에서는 고카트를 연결할 수 없습니다. 사파리와 크롬 모두 웹 페이지의 블루투스 기능이 없기 때문입니다. 안드로이드 폰이나 PC의 크롬·엣지로 열어 주세요.',
    insecure: '보안 연결(https)에서만 블루투스를 쓸 수 있습니다. 주소가 https로 시작하는지 확인해 주세요.',
    cancel: '장치를 고르지 않았습니다. 다시 "연결하기"를 눌러 주세요.',
    blocked: '블루투스 사용이 막혀 있습니다. 주소창의 사이트 설정에서 블루투스를 허용한 뒤 다시 시도해 주세요.',
    timeout: '연결 시간이 지났습니다. 고카트 전원을 확인하고 가까이에서 다시 시도해 주세요.',
    notkart: '고카트가 아닌 장치입니다. 이름이 Go_Kart_로 시작하는 장치를 골라 주세요.',
    notbt: 'USB로 연결된 장치에는 조종 신호를 보내지 않습니다. 블루투스로 등록한 고카트(Go_Kart_BT_…)를 골라 주세요.',
    framed: '다른 사이트 안에 끼워진 화면에서는 조종할 수 없습니다. 주소를 직접 열어 주세요.',
    connect: '연결하지 못했습니다. 고카트 전원이 켜져 있는지, 다른 기기가 이미 연결하고 있지 않은지 확인해 주세요.',
    lost: '연결이 끊어졌습니다. 고카트는 스스로 멈춥니다. 다시 연결해 주세요.',
    stall: '고카트가 응답하지 않아 연결을 끊었습니다. 고카트는 스스로 멈춥니다. 가까이에서 다시 연결해 주세요.'
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    statusPill: $('statusPill'),
    statusText: $('statusText'),
    connectBtn: $('connectBtn'),
    connectLabel: $('connectLabel'),
    fullscreenBtn: $('fullscreenBtn'),
    fullscreenLabel: $('fullscreenLabel'),
    pad: $('pad'),
    knob: $('knob'),
    coordX: $('coordX'),
    coordY: $('coordY'),
    notice: $('notice'),
    invertX: $('invertX'),
    invertY: $('invertY'),
    rotations: Array.from(document.querySelectorAll('input[name="rotation"]')),
    dialog: $('connectDialog'),
    chooseBle: $('chooseBle'),
    chooseClassic: $('chooseClassic'),
    bleHint: $('bleHint'),
    classicHint: $('classicHint'),
    dialogCancel: $('dialogCancel'),
    waitDialog: $('waitDialog'),
    waitArrow: $('waitArrow'),
    waitText: $('waitText'),
    waitPin: $('waitPin'),
    waitList: $('waitList'),
    waitCancel: $('waitCancel')
  };

  const settings = loadSettings();
  let status = 'idle'; // idle | connecting | connected | closing
  let link = null; // 연결된 동안: { transport, sender, type, name }
  let pendingTransport = null; // 연결 시도 중인 것
  let connectSeq = 0;
  let activePointer = null;
  let wakeLock = null;
  let fullscreen = false; // 전체 화면 조종 중인가
  let bleAdapterOff = false; // 이 기기의 블루투스가 꺼져 있는 것으로 확인됨

  // ---------- 공통 ----------

  function codedError(code, cause) {
    const error = new Error(code);
    error.code = code;
    error.cause = cause;
    error.coded = true;
    return error;
  }

  // 브라우저 오류(DOMException)에도 숫자 code가 있으므로, 우리가 만든 오류인지는 coded로 가린다.
  function isCoded(error) {
    return Boolean(error && error.coded === true);
  }

  function withTimeout(promise, ms, code) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(codedError(code)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  function chooserErrorCode(error) {
    if (error && error.name === 'NotFoundError') return 'cancel';
    if (error && (error.name === 'SecurityError' || error.name === 'NotAllowedError')) return 'blocked';
    return 'connect';
  }

  function hasBle() { return 'bluetooth' in navigator; }
  function hasSerial() { return 'serial' in navigator; }

  // ---------- 연결 방식 ----------

  function createBleTransport(onLost) {
    let device = null;
    let characteristic = null;
    let closed = false;
    const handleLost = () => { if (!closed) onLost(); };

    return {
      async connect() {
        try {
          device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: NAME_PREFIX }],
            optionalServices: [SERVICE_UUID]
          });
        } catch (error) {
          throw codedError(chooserErrorCode(error), error);
        }
        const target = device;
        // 고르는 사이 창이 닫혔으면(close 호출됨) 더 진행하지 않는다.
        if (closed) throw codedError('cancel');
        target.addEventListener('gattserverdisconnected', handleLost);

        let server;
        try {
          server = await withTimeout(target.gatt.connect(), CONNECT_TIMEOUT_MS, 'timeout');
        } catch (error) {
          throw isCoded(error) ? error : codedError('connect', error);
        }
        if (closed) {
          try { target.gatt.disconnect(); } catch (error) { /* 이미 끊김 */ }
          throw codedError('cancel');
        }
        try {
          const service = await withTimeout(server.getPrimaryService(SERVICE_UUID), CONNECT_TIMEOUT_MS, 'timeout');
          const found = await withTimeout(service.getCharacteristic(CHARACTERISTIC_UUID), CONNECT_TIMEOUT_MS, 'timeout');
          if (closed) throw codedError('cancel');
          characteristic = found;
        } catch (error) {
          if (isCoded(error)) throw error;
          throw codedError(error && error.name === 'NotFoundError' ? 'notkart' : 'connect', error);
        }
        return target.name || 'BLE 장치';
      },
      write(bytes) {
        if (!characteristic) return Promise.reject(codedError('lost'));
        // 펌웨어는 "응답 없는 쓰기"를 지원한다. 지원하지 않는 장치면 일반 쓰기로 보낸다.
        const props = characteristic.properties;
        const noResponse = typeof characteristic.writeValueWithoutResponse === 'function'
          && (!props || props.writeWithoutResponse !== false);
        return noResponse
          ? characteristic.writeValueWithoutResponse(bytes)
          : characteristic.writeValue(bytes);
      },
      close() {
        closed = true;
        const target = device;
        device = null;
        characteristic = null;
        if (!target) return;
        target.removeEventListener('gattserverdisconnected', handleLost);
        // 연결 중이어도 disconnect()가 시도를 취소한다.
        try { target.gatt.disconnect(); } catch (error) { /* 이미 끊김 */ }
      }
    };
  }

  function createSerialTransport(onLost) {
    let port = null;
    let writer = null;
    let closed = false;
    const handleLost = () => { if (!closed) onLost(); };

    return {
      async connect() {
        try {
          port = await navigator.serial.requestPort();
        } catch (error) {
          throw codedError(chooserErrorCode(error), error);
        }
        const target = port;
        // 고카트는 블루투스로만 연결한다. USB 장치(프린터·다른 보드 등)를 잘못 골라도 신호를 보내지 않는다.
        let info = null;
        try { info = typeof target.getInfo === 'function' ? target.getInfo() : null; } catch (error) { /* 정보 없음 */ }
        if (info && info.usbVendorId !== undefined) {
          port = null;
          throw codedError('notbt');
        }
        const opening = target.open({ baudRate: 115200 });
        try {
          await withTimeout(opening, CONNECT_TIMEOUT_MS, 'timeout');
        } catch (error) {
          // 시간 초과 뒤 늦게 열리면 그대로 두지 않고 닫는다.
          opening.then(() => target.close()).catch(() => {});
          port = null;
          throw isCoded(error) ? error : codedError('connect', error);
        }
        if (closed) {
          target.close().catch(() => {});
          throw codedError('cancel');
        }
        writer = target.writable.getWriter();
        target.addEventListener('disconnect', handleLost);
        return '클래식 장치';
      },
      async write(bytes) {
        if (!writer) throw codedError('lost');
        const current = writer;
        await current.ready; // 밀린 전송이 있으면 기다린다(쌓아 두지 않음).
        await current.write(bytes);
      },
      close() {
        closed = true;
        const target = port;
        const current = writer;
        port = null;
        writer = null;
        if (!target) return;
        target.removeEventListener('disconnect', handleLost);
        (async () => {
          if (current) {
            try { await withTimeout(current.abort(), CLOSE_TIMEOUT_MS, 'timeout'); } catch (error) { /* 무시 */ }
            try { current.releaseLock(); } catch (error) { /* 무시 */ }
          }
          try { await target.close(); } catch (error) { /* 이미 닫힘 */ }
        })();
      }
    };
  }

  // ---------- 연결·해제 ----------

  async function connect(type) {
    if (status !== 'idle') return;
    const seq = ++connectSeq;
    centerJoystick();
    hideNotice();
    setStatus('connecting');
    showWait(type); // 장치를 고르는 창은 브라우저가 띄운다. 놓치지 않도록 무엇을 해야 하는지 크게 알려 준다.

    const onLost = () => { if (link && link.transport === transport) dropLink('lost'); };
    const transport = type === 'ble' ? createBleTransport(onLost) : createSerialTransport(onLost);
    pendingTransport = transport;

    try {
      const name = await transport.connect();
      if (seq !== connectSeq) { transport.close(); return; }
      pendingTransport = null;
      const sender = Core.createSender({
        write: (x, y) => transport.write(new Uint8Array([x, y])),
        onError: (error) => {
          if (link && link.transport === transport) dropLink(error && error.code === 'stall' ? 'stall' : 'lost');
        }
      });
      link = { transport, sender, type, name };
      centerJoystick(); // 연결되는 순간에는 반드시 정지 상태에서 시작
      hideWait();
      hideNotice();
      setStatus('connected');
      acquireWakeLock();
    } catch (error) {
      transport.close();
      if (seq !== connectSeq) return;
      pendingTransport = null;
      hideWait();
      setStatus('idle');
      const code = isCoded(error) ? error.code : 'connect';
      showNotice(MESSAGES[code] || MESSAGES.connect, code === 'cancel' ? 'info' : 'error');
    }
  }

  // 사용자가 누른 "연결 끊기": 정지 값을 보낸 뒤 끊는다.
  async function disconnect() {
    const current = link;
    if (!current || status !== 'connected') return;
    link = null;
    current.sender.release();
    centerJoystick();
    setStatus('closing');
    releaseWakeLock();
    await current.sender.flush(FLUSH_TIMEOUT_MS);
    current.sender.stop();
    current.transport.close();
    if (status === 'closing') setStatus('idle');
    hideNotice();
  }

  // 연결이 저절로 끊겼거나 응답이 없을 때.
  function dropLink(reason) {
    const current = link;
    if (!current) return;
    link = null;
    current.sender.stop();
    current.transport.close();
    centerJoystick();
    releaseWakeLock();
    setStatus('idle');
    showNotice(MESSAGES[reason] || MESSAGES.lost, 'error');
  }

  // 창을 닫거나 다른 주소로 이동할 때: 정지 값을 보내고 연결을 끊는다.
  function handlePageHide() {
    connectSeq += 1;
    if (pendingTransport) { pendingTransport.close(); pendingTransport = null; }
    hideWait();
    const current = link;
    link = null;
    centerJoystick();
    if (current) {
      current.sender.release();
      if (current.type === 'ble') {
        // BLE는 연결이 끊기는 즉시 펌웨어가 멈추므로 바로 끊는다.
        current.sender.stop();
        current.transport.close();
      } else {
        current.sender.flush(FLUSH_TIMEOUT_MS).then(() => {
          current.sender.stop();
          current.transport.close();
        });
      }
    }
    releaseWakeLock();
    setStatus('idle');
  }

  // ---------- 조이스틱 ----------

  function onPointerDown(event) {
    if (activePointer !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    activePointer = event.pointerId;
    try { els.pad.setPointerCapture(event.pointerId); } catch (error) { /* 무시 */ }
    els.pad.classList.add('dragging');
    moveTo(event);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (event.pointerId !== activePointer) return;
    // 버튼을 뗀 사실을 놓쳤을 때(창 밖에서 뗌 등)를 대비: 눌린 버튼이 없으면 정지.
    if (event.pointerType === 'mouse' && event.buttons === 0) { centerJoystick(); return; }
    moveTo(event);
  }

  function onPointerEnd(event) {
    if (event.pointerId !== activePointer) return;
    centerJoystick();
  }

  function moveTo(event) {
    const rect = els.pad.getBoundingClientRect();
    const knobSize = els.knob.offsetWidth;
    const travelX = rect.width - knobSize;
    const travelY = rect.height - knobSize;
    if (travelX <= 0 || travelY <= 0) return;
    const nx = Core.clamp((event.clientX - rect.left - knobSize / 2) / travelX, 0, 1);
    const ny = Core.clamp((event.clientY - rect.top - knobSize / 2) / travelY, 0, 1);
    els.knob.style.setProperty('--dx', `${(nx - 0.5) * travelX}px`);
    els.knob.style.setProperty('--dy', `${(ny - 0.5) * travelY}px`);
    const coords = Core.computeCoords(nx, ny, settings);
    showCoords(coords.x, coords.y);
    if (link) link.sender.hold(coords.x, coords.y);
  }

  // 손잡이를 가운데로 돌리고 정지 값을 보낸다. 여러 번 불러도 안전하다.
  function centerJoystick() {
    if (activePointer !== null) {
      const pointerId = activePointer;
      activePointer = null;
      try { els.pad.releasePointerCapture(pointerId); } catch (error) { /* 무시 */ }
    }
    els.pad.classList.remove('dragging');
    els.knob.style.setProperty('--dx', '0px');
    els.knob.style.setProperty('--dy', '0px');
    showCoords(Core.NEUTRAL, Core.NEUTRAL);
    if (link) link.sender.release();
  }

  function showCoords(x, y) {
    els.coordX.textContent = String(x);
    els.coordY.textContent = String(y);
  }

  // ---------- 화면 표시 ----------

  function setStatus(next) {
    status = next;
    const connected = next === 'connected';
    els.statusPill.dataset.state = next;
    if (connected) {
      const kind = link.type === 'ble' ? 'BLE' : '클래식';
      els.statusText.textContent = link.type === 'ble' ? `${kind} 연결됨 · ${link.name}` : `${kind} 연결됨`;
    } else {
      els.statusText.textContent = { idle: '연결 안 됨', connecting: '연결 중…', closing: '연결 끊는 중…' }[next];
    }
    els.connectLabel.textContent = { idle: '연결하기', connecting: '연결 중…', connected: '연결 끊기', closing: '연결 끊는 중…' }[next];
    els.connectBtn.disabled = next === 'connecting' || next === 'closing';
    els.connectBtn.classList.toggle('button-danger', connected);
    els.connectBtn.classList.toggle('button-primary', !connected);
    els.pad.dataset.live = connected ? 'true' : 'false';
  }

  function showNotice(text, kind) {
    els.notice.textContent = text;
    els.notice.dataset.kind = kind || 'error';
    els.notice.hidden = false;
  }

  function hideNotice() {
    els.notice.hidden = true;
    els.notice.textContent = '';
  }

  // 다른 사이트가 이 화면을 끼워 넣어 누르게 유도하는 것을 막는다.
  function isFramed() {
    try { return window.top !== window.self; } catch (error) { return true; }
  }

  function openConnectDialog() {
    if (isFramed()) { showNotice(MESSAGES.framed, 'error'); return; }
    if (!window.isSecureContext) { showNotice(MESSAGES.insecure, 'error'); return; }
    if (!hasBle() && !hasSerial()) { showNotice(unsupportedMessage(), 'error'); return; }
    // 쓸 수 없는 방식도 누를 수는 있게 두고, 누르면 이유와 해결 방법을 알려 준다.
    // (눌러도 아무 반응이 없으면 사용자가 원인을 알 수 없다)
    setChoice(els.chooseBle, els.bleHint, bleProblem(),
      '이름이 Go_Kart_BLE_로 시작하는 고카트. 누르면 브라우저가 장치 고르는 창을 띄웁니다.');
    setChoice(els.chooseClassic, els.classicHint, classicProblem(),
      '이름이 Go_Kart_BT_로 시작하는 고카트. 누르면 브라우저의 "직렬 포트" 창이 뜹니다. 먼저 기기의 블루투스 설정에서 등록(페어링)해 두어야 목록에 나옵니다.');
    if (typeof els.dialog.showModal === 'function') els.dialog.showModal();
    else els.dialog.setAttribute('open', '');

    // 블루투스가 꺼져 있는지는 조금 뒤에 알 수 있다. 알게 되면 안내를 바꾼다.
    if (hasBle() && typeof navigator.bluetooth.getAvailability === 'function') {
      navigator.bluetooth.getAvailability().then((available) => {
        bleAdapterOff = !available;
        if (els.dialog.open) setChoice(els.chooseBle, els.bleHint, bleProblem(), els.bleHint.dataset.normal || '');
      }).catch(() => { /* 알 수 없으면 그대로 둔다 */ });
    }
  }

  function isPhone() {
    if (navigator.userAgentData && navigator.userAgentData.mobile === true) return true;
    // 주로 손가락으로 쓰는 기기(폰·패드)인지
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  }

  // 장치 고르는 창(브라우저가 띄움)을 기다리는 동안의 안내
  function showWait(type) {
    const phone = isPhone();
    const where = phone ? '화면에 뜬 창' : '주소창 바로 아래(화면 왼쪽 위)에 뜬 작은 창';
    els.waitText.textContent = type === 'ble'
      ? `${where}에서 Go_Kart_BLE_…를 고르고 "페어링"을 눌러 주세요.`
      : `${where}("직렬 포트")에서 Go_Kart_BT_…를 고르고 "연결"을 눌러 주세요.`;
    const checks = type === 'ble'
      ? ['고카트 전원이 켜져 있는지', '이 기기의 블루투스가 켜져 있는지']
      : ['고카트 전원이 켜져 있는지', '기기의 블루투스 설정에서 고카트를 먼저 등록(페어링)했는지'];
    if (phone && type === 'ble') checks.push('창 안에 "근처 기기"나 "위치" 권한을 허용하라는 글자가 보이면 눌러서 허용했는지');
    els.waitList.textContent = '';
    checks.forEach((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      els.waitList.appendChild(item);
    });
    els.waitArrow.hidden = phone;
    els.waitPin.hidden = type !== 'ble'; // 비밀번호는 BLE 고카트에서만 쓴다
    if (els.waitDialog.open) return;
    if (typeof els.waitDialog.showModal === 'function') els.waitDialog.showModal();
    else els.waitDialog.setAttribute('open', '');
  }

  function hideWait() {
    if (!els.waitDialog.open) return;
    if (typeof els.waitDialog.close === 'function') els.waitDialog.close();
    else els.waitDialog.removeAttribute('open');
  }

  // 기다리다가 그만둘 때. 브라우저의 창은 우리가 닫을 수 없으므로, 나중에 고르더라도 연결하지 않게만 한다.
  function cancelConnect() {
    if (status !== 'connecting') { hideWait(); return; }
    connectSeq += 1;
    if (pendingTransport) { pendingTransport.close(); pendingTransport = null; }
    hideWait();
    setStatus('idle');
    showNotice(MESSAGES.cancel, 'info');
  }

  // 아이폰·아이패드인가(아이패드는 맥으로 표시되므로 터치 여부로 가린다)
  function isApplePhone() {
    const agent = navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  }

  function unsupportedMessage() {
    return isApplePhone() ? MESSAGES.apple : MESSAGES.unsupported;
  }

  function isBrave() {
    return Boolean(navigator.brave && typeof navigator.brave.isBrave === 'function');
  }

  // BLE를 쓸 수 없는 이유(쓸 수 있으면 빈 문자열)
  function bleProblem() {
    if (!hasBle()) {
      return isBrave()
        ? 'Brave에서는 BLE가 기본으로 꺼져 있습니다. 주소창에 brave://flags/#brave-web-bluetooth-api 를 입력해 Enabled로 바꾸고 브라우저를 다시 시작하거나, 크롬·엣지로 열어 주세요.'
        : '이 브라우저는 BLE를 지원하지 않습니다. 안드로이드 폰이나 PC의 크롬·엣지로 열어 주세요.';
    }
    if (bleAdapterOff) return '이 기기의 블루투스가 꺼져 있거나 없습니다. 블루투스를 켠 뒤 다시 눌러 주세요.';
    return '';
  }

  function classicProblem() {
    return hasSerial() ? '' : '이 브라우저는 클래식 블루투스를 지원하지 않습니다. 안드로이드 폰이나 PC의 크롬·엣지(최신 버전)로 열어 주세요.';
  }

  function setChoice(button, hint, problem, normalText) {
    hint.dataset.normal = normalText;
    hint.textContent = problem || normalText;
    button.dataset.state = problem ? 'off' : 'on';
  }

  function choose(type) {
    const problem = type === 'ble' ? bleProblem() : classicProblem();
    closeConnectDialog();
    if (problem) { showNotice(problem, 'error'); return; }
    connect(type);
  }

  function closeConnectDialog() {
    if (typeof els.dialog.close === 'function') els.dialog.close();
    else els.dialog.removeAttribute('open');
  }

  // ---------- 화면 켜짐 유지 ----------

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!link || wakeLock) { lock.release().catch(() => {}); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch (error) { /* 절전 모드 등으로 거부될 수 있음. 조종에는 지장 없음 */ }
  }

  function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  // ---------- 전체 화면 ----------
  // 화면 배치는 이 앱이 직접 바꾸고(style.css의 data-fullscreen), 브라우저의 전체 화면 기능은 있을 때만 함께 쓴다.
  // 그래서 그 기능이 없는 기기(아이폰)에서도 되고, 끝내는 버튼이 늘 화면에 있어 뒤로 가기 버튼이 없어도 나올 수 있다.

  function nativeFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function setFullscreen(on) {
    if (fullscreen === on) return;
    centerJoystick(); // 화면 배치가 바뀌는 동안 움직이지 않도록 정지
    fullscreen = on;
    const root = document.documentElement;
    root.dataset.fullscreen = on ? 'true' : 'false';
    els.fullscreenLabel.textContent = on ? '전체 화면 끝내기' : '전체 화면';
    els.fullscreenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    try {
      if (on) {
        window.scrollTo(0, 0);
        const request = root.requestFullscreen || root.webkitRequestFullscreen;
        const result = request && !nativeFullscreenElement() ? request.call(root) : null;
        if (result && result.catch) result.catch(() => {}); // 거부돼도 화면 배치만으로 계속 쓴다
      } else if (nativeFullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        const result = exit ? exit.call(document) : null;
        if (result && result.catch) result.catch(() => {});
      }
    } catch (error) { /* 브라우저 전체 화면을 못 써도 화면 배치는 바뀌어 있다 */ }
  }

  // 뒤로 가기·Esc 등으로 브라우저의 전체 화면이 풀리면 화면 배치도 함께 되돌린다.
  function onNativeFullscreenChange() {
    if (!nativeFullscreenElement()) setFullscreen(false);
  }

  // ---------- 설정 ----------

  function loadSettings() {
    const result = { invertX: false, invertY: false, rotation: 0 };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        result.invertX = saved.invertX === true;
        result.invertY = saved.invertY === true;
        if ([0, 90, 180, 270].includes(saved.rotation)) result.rotation = saved.rotation;
      }
    } catch (error) { /* 저장소를 못 쓰면 기본값 */ }
    return result;
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (error) { /* 무시 */ }
  }

  function applySettingsToForm() {
    els.invertX.checked = settings.invertX;
    els.invertY.checked = settings.invertY;
    els.rotations.forEach((input) => { input.checked = Number(input.value) === settings.rotation; });
  }

  function onSettingsChange() {
    centerJoystick(); // 방향이 바뀌는 순간 움직이지 않도록 정지
    settings.invertX = els.invertX.checked;
    settings.invertY = els.invertY.checked;
    const checked = els.rotations.find((input) => input.checked);
    settings.rotation = checked ? Number(checked.value) : 0;
    saveSettings();
  }

  // ---------- 시작 ----------

  function init() {
    applySettingsToForm();
    setStatus('idle');
    showCoords(Core.NEUTRAL, Core.NEUTRAL);

    els.connectBtn.addEventListener('click', () => {
      if (status === 'connected') disconnect();
      else if (status === 'idle') openConnectDialog();
    });
    els.fullscreenBtn.addEventListener('click', () => setFullscreen(!fullscreen));
    document.addEventListener('fullscreenchange', onNativeFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onNativeFullscreenChange);
    els.chooseBle.addEventListener('click', () => choose('ble'));
    els.chooseClassic.addEventListener('click', () => choose('classic'));
    els.dialogCancel.addEventListener('click', closeConnectDialog);
    els.waitCancel.addEventListener('click', cancelConnect);
    els.waitDialog.addEventListener('cancel', (event) => { event.preventDefault(); cancelConnect(); }); // Esc 키

    els.pad.addEventListener('pointerdown', onPointerDown);
    els.pad.addEventListener('pointermove', onPointerMove);
    els.pad.addEventListener('pointerup', onPointerEnd);
    els.pad.addEventListener('pointercancel', onPointerEnd);
    els.pad.addEventListener('lostpointercapture', onPointerEnd);
    els.pad.addEventListener('contextmenu', (event) => event.preventDefault());
    // 포인터 캡처가 실패해 조이스틱 밖에서 손을 뗀 경우에도 반드시 정지시킨다.
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);

    els.invertX.addEventListener('change', onSettingsChange);
    els.invertY.addEventListener('change', onSettingsChange);
    els.rotations.forEach((input) => input.addEventListener('change', onSettingsChange));

    // 화면이 가려지거나 꺼지면 즉시 정지. 다시 보이면 화면 켜짐 유지를 다시 건다.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') centerJoystick();
      else if (link) acquireWakeLock();
    });
    document.addEventListener('freeze', centerJoystick);
    window.addEventListener('blur', centerJoystick);
    window.addEventListener('pagehide', handlePageHide);

    if (isFramed()) showNotice(MESSAGES.framed, 'error');
    else if (!window.isSecureContext) showNotice(MESSAGES.insecure, 'error');
    else if (!hasBle() && !hasSerial()) showNotice(unsupportedMessage(), 'error');
  }

  init();
})();
