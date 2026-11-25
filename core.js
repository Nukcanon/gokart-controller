// 화면과 무관한 핵심 로직: 좌표 계산, 전송 주기 관리.
// 브라우저에서는 window.GoKartCore, 시험(node)에서는 module.exports로 쓴다.
(function (root) {
  'use strict';

  var NEUTRAL = 100; // 정지(가운데) 값. 펌웨어가 0~200을 받는다.
  var MAX = 200;

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  }

  // nx, ny: 조이스틱 손잡이의 상대 위치(0~1). ny는 0이 위쪽.
  // 반환: 펌웨어로 보낼 좌표(0~200, 위로 밀수록 y가 커짐).
  function computeCoords(nx, ny, settings) {
    // 숫자가 아닌 값이 들어오면 가운데(정지)로 본다.
    if (!isFinite(nx)) nx = 0.5;
    if (!isFinite(ny)) ny = 0.5;
    var x = Math.trunc(clamp(nx, 0, 1) * MAX);
    var y = MAX - Math.trunc(clamp(ny, 0, 1) * MAX);
    if (settings && settings.invertX) x = MAX - x;
    if (settings && settings.invertY) y = MAX - y;

    var dx = x - NEUTRAL;
    var dy = y - NEUTRAL;
    var rotation = settings ? ((Number(settings.rotation) % 360) + 360) % 360 : 0;
    // 90도 단위 회전은 삼각함수 없이 정확히 계산한다(오차로 1이 깎이는 문제 방지).
    if (rotation === 90) { x = NEUTRAL - dy; y = NEUTRAL + dx; }
    else if (rotation === 180) { x = NEUTRAL - dx; y = NEUTRAL - dy; }
    else if (rotation === 270) { x = NEUTRAL + dy; y = NEUTRAL - dx; }

    return { x: clamp(x, 0, MAX), y: clamp(y, 0, MAX) };
  }

  // 전송 관리기.
  // - 누르고 있는 동안: intervalMs마다 현재 값을 다시 보낸다(펌웨어는 명령이 끊기면 스스로 멈춘다).
  // - 손을 떼면: 정지 값을 neutralRepeats번 보낸 뒤 전송을 멈춘다(유선 조이스틱에 제어를 돌려줌).
  // - 전송이 stallMs 넘게 끝나지 않으면 연결 이상으로 보고 onError를 부른다.
  // - 한 번에 하나만 전송한다(Web Bluetooth는 겹친 전송을 거부한다).
  function createSender(options) {
    var write = options.write;
    var onError = options.onError || function () {};
    var intervalMs = options.intervalMs || 50;
    var stallMs = options.stallMs || 1500;
    var neutralRepeats = options.neutralRepeats || 4;
    var now = options.now || Date.now;
    var setIntervalFn = options.setInterval || setInterval;
    var clearIntervalFn = options.clearInterval || clearInterval;
    var setTimeoutFn = options.setTimeout || setTimeout;
    var clearTimeoutFn = options.clearTimeout || clearTimeout;

    var x = NEUTRAL;
    var y = NEUTRAL;
    var held = false;
    var neutralLeft = 0;
    var neutralSent = true; // 마지막으로 끝난 전송이 정지 값인가
    var busy = false;
    var busySince = 0;
    var timer = null;
    var stopped = false;
    var waiters = [];

    function startTimer() {
      if (timer === null && !stopped) timer = setIntervalFn(tick, intervalMs);
    }

    function haltTimer() {
      if (timer !== null) { clearIntervalFn(timer); timer = null; }
    }

    function resolveWaiters() {
      var list = waiters;
      waiters = [];
      for (var i = 0; i < list.length; i += 1) list[i]();
    }

    function fail(error) {
      if (stopped) return;
      stop();
      onError(error);
    }

    function send() {
      if (busy || stopped) return;
      var sendingHeld = held;
      var sx = sendingHeld ? x : NEUTRAL;
      var sy = sendingHeld ? y : NEUTRAL;
      var result;
      busy = true;
      busySince = now();
      try {
        result = Promise.resolve(write(sx, sy));
      } catch (error) {
        result = Promise.reject(error);
      }
      result.then(function () {
        busy = false;
        if (stopped) return;
        if (!sendingHeld) {
          // 정지 값이 나가는 사이 다시 눌렀다면 "정지 값 전송됨"으로 치지 않는다.
          if (!held) {
            neutralSent = true;
            resolveWaiters();
            if (neutralLeft > 0) neutralLeft -= 1;
            if (neutralLeft === 0) haltTimer();
          }
        } else if (!held) {
          // 전송 중에 손을 뗐다: 다음 주기를 기다리지 않고 바로 정지 값을 보낸다.
          send();
        }
      }, function (error) {
        busy = false;
        fail(error);
      });
    }

    function tick() {
      if (stopped) return;
      if (busy) {
        if (now() - busySince >= stallMs) {
          var error = new Error('write stalled');
          error.code = 'stall';
          fail(error);
        }
        return;
      }
      if (held || neutralLeft > 0) send();
      else haltTimer();
    }

    function hold(nextX, nextY) {
      if (stopped) return;
      x = clamp(Math.round(nextX), 0, MAX);
      y = clamp(Math.round(nextY), 0, MAX);
      if (!held) {
        held = true;
        neutralLeft = 0;
        neutralSent = false;
        startTimer();
        send();
      }
    }

    function release() {
      if (stopped || !held) return;
      held = false;
      x = NEUTRAL;
      y = NEUTRAL;
      neutralSent = false;
      neutralLeft = neutralRepeats;
      startTimer();
      send();
    }

    // 정지 값이 한 번이라도 전송될 때까지(또는 timeoutMs까지) 기다린다.
    function flush(timeoutMs) {
      return new Promise(function (resolve) {
        if (stopped || (neutralSent && !held)) { resolve(); return; }
        var done = false;
        var timeoutId = setTimeoutFn(finish, timeoutMs);
        function finish() {
          if (done) return;
          done = true;
          clearTimeoutFn(timeoutId);
          resolve();
        }
        waiters.push(finish);
      });
    }

    function stop() {
      stopped = true;
      held = false;
      haltTimer();
      resolveWaiters();
    }

    return {
      hold: hold,
      release: release,
      flush: flush,
      stop: stop,
      isHeld: function () { return held; },
      isIdle: function () { return timer === null && !busy; }
    };
  }

  var api = {
    NEUTRAL: NEUTRAL,
    MAX: MAX,
    clamp: clamp,
    computeCoords: computeCoords,
    createSender: createSender
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoKartCore = api;
})(typeof self !== 'undefined' ? self : this);
