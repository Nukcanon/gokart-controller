// 핵심 로직 시험: node tests/core-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const Core = require(path.join(__dirname, '..', 'core.js'));

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

// 가짜 시계: 시간을 손으로 흘려 주기 전송을 정확히 센다.
function makeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const add = (fn, ms, repeat) => { const id = nextId++; timers.set(id, { fn, ms, at: time + ms, repeat }); return id; };
  return {
    now: () => time,
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearTimeout: (id) => timers.delete(id),
    count: () => timers.size,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        let pick = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!pick || timer.at < pick.timer.at)) pick = { id, timer };
        }
        if (!pick) break;
        time = pick.timer.at;
        if (pick.timer.repeat) pick.timer.at += pick.timer.ms;
        else timers.delete(pick.id);
        pick.timer.fn();
        await flush();
      }
      time = end;
      await flush();
    }
  };
}

function makeSender(clock, write, extra) {
  const errors = [];
  const sender = Core.createSender(Object.assign({
    write,
    onError: (error) => errors.push(error),
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  }, extra || {}));
  return { sender, errors };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NEUTRAL = [100, 100];

// ---------- 좌표 ----------

test('좌표: 가운데·끝 값', () => {
  const base = { invertX: false, invertY: false, rotation: 0 };
  assert.deepStrictEqual(Core.computeCoords(0.5, 0.5, base), { x: 100, y: 100 });
  assert.deepStrictEqual(Core.computeCoords(0.5, 0, base), { x: 100, y: 200 });
  assert.deepStrictEqual(Core.computeCoords(0.5, 1, base), { x: 100, y: 0 });
  assert.deepStrictEqual(Core.computeCoords(0, 0.5, base), { x: 0, y: 100 });
  assert.deepStrictEqual(Core.computeCoords(1, 0.5, base), { x: 200, y: 100 });
});

test('좌표: 반전', () => {
  assert.deepStrictEqual(Core.computeCoords(0, 0, { invertX: true, invertY: false, rotation: 0 }), { x: 200, y: 200 });
  assert.deepStrictEqual(Core.computeCoords(0, 0, { invertX: false, invertY: true, rotation: 0 }), { x: 0, y: 0 });
});

test('좌표: 회전은 90도 단위로 정확', () => {
  const at = (rotation) => Core.computeCoords(0.5, 0, { rotation }); // 위로 끝까지
  assert.deepStrictEqual(at(90), { x: 0, y: 100 });
  assert.deepStrictEqual(at(180), { x: 100, y: 0 });
  assert.deepStrictEqual(at(270), { x: 200, y: 100 });
  // 안드로이드판은 삼각함수 오차로 149가 나오던 자리
  assert.deepStrictEqual(Core.computeCoords(0.25, 0.25, { rotation: 180 }), { x: 150, y: 50 });
});

test('좌표: 어떤 입력에도 0~200 정수, 가운데는 항상 정지', () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const invertX of [false, true]) {
      for (const invertY of [false, true]) {
        const settings = { invertX, invertY, rotation };
        assert.deepStrictEqual(Core.computeCoords(0.5, 0.5, settings), { x: 100, y: 100 });
        for (let i = -2; i <= 12; i += 1) {
          for (let j = -2; j <= 12; j += 1) {
            const c = Core.computeCoords(i / 10, j / 10, settings);
            assert.ok(Number.isInteger(c.x) && c.x >= 0 && c.x <= 200, `x=${c.x}`);
            assert.ok(Number.isInteger(c.y) && c.y >= 0 && c.y <= 200, `y=${c.y}`);
          }
        }
      }
    }
  }
  assert.deepStrictEqual(Core.computeCoords(NaN, Infinity, { rotation: 0 }), { x: 100, y: 100 });
  assert.deepStrictEqual(Core.computeCoords(0.5, 0.5), { x: 100, y: 100 });
});

// ---------- 전송 ----------

test('전송: 누르고 있으면 가만히 있어도 50ms마다 다시 보낸다', async () => {
  const clock = makeClock();
  const writes = [];
  const { sender, errors } = makeSender(clock, async (x, y) => { writes.push([x, y]); });
  sender.hold(100, 200);
  await flush();
  assert.strictEqual(writes.length, 1, '누르는 즉시 전송');
  await clock.advance(500);
  assert.strictEqual(writes.length, 11);
  assert.ok(writes.every((w) => w[0] === 100 && w[1] === 200));
  sender.hold(30, 40);
  await clock.advance(50);
  assert.deepStrictEqual(writes[writes.length - 1], [30, 40]);
  assert.strictEqual(errors.length, 0);
});

test('전송: 손을 떼면 정지 값을 4번 보내고 완전히 멈춘다', async () => {
  const clock = makeClock();
  const writes = [];
  const { sender } = makeSender(clock, async (x, y) => { writes.push([x, y]); });
  sender.hold(200, 200);
  await clock.advance(120);
  const before = writes.length;
  sender.release();
  await flush();
  assert.deepStrictEqual(writes[before], NEUTRAL, '떼는 즉시 정지 값');
  await clock.advance(2000);
  const tail = writes.slice(before);
  assert.strictEqual(tail.length, 4);
  assert.ok(tail.every((w) => w[0] === 100 && w[1] === 100));
  assert.strictEqual(clock.count(), 0, '남은 타이머 없음');
  assert.ok(sender.isIdle());
});

test('전송: 전송 중에 손을 떼면 끝나자마자 정지 값을 보낸다', async () => {
  const clock = makeClock();
  const writes = [];
  let finish = null;
  const { sender } = makeSender(clock, (x, y) => {
    writes.push([x, y]);
    return new Promise((resolve) => { finish = resolve; });
  });
  sender.hold(0, 200);
  await flush();
  sender.release(); // 아직 첫 전송이 끝나지 않음
  await flush();
  assert.strictEqual(writes.length, 1);
  finish();
  await flush(); // 시간은 흐르지 않았다
  assert.strictEqual(writes.length, 2);
  assert.deepStrictEqual(writes[1], NEUTRAL);
});

test('전송: 겹쳐 보내지 않고 가장 최근 값만 보낸다', async () => {
  const clock = makeClock();
  const writes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { sender, errors } = makeSender(clock, (x, y) => {
    writes.push([x, y]);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => clock.setTimeout(() => { inFlight -= 1; resolve(); }, 120));
  });
  sender.hold(1, 1);
  await clock.advance(60);
  sender.hold(2, 2);
  await clock.advance(30);
  sender.hold(3, 3);
  await clock.advance(400);
  assert.strictEqual(maxInFlight, 1);
  assert.deepStrictEqual(writes[0], [1, 1]);
  assert.deepStrictEqual(writes[1], [3, 3], '밀린 값(2,2)은 건너뜀');
  assert.strictEqual(errors.length, 0);
});

test('전송: 응답이 없으면 1.5초 뒤 한 번만 오류를 알리고 멈춘다', async () => {
  const clock = makeClock();
  const writes = [];
  const { sender, errors } = makeSender(clock, (x, y) => { writes.push([x, y]); return new Promise(() => {}); });
  sender.hold(200, 100);
  await clock.advance(1400);
  assert.strictEqual(errors.length, 0);
  await clock.advance(200);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].code, 'stall');
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(clock.count(), 0);
  sender.hold(1, 1);
  await clock.advance(500);
  assert.strictEqual(writes.length, 1, '멈춘 뒤에는 보내지 않음');
});

test('전송: 전송 실패는 한 번만 알리고 멈춘다', async () => {
  const clock = makeClock();
  let calls = 0;
  const { sender, errors } = makeSender(clock, () => { calls += 1; return Promise.reject(new Error('gone')); });
  sender.hold(10, 10);
  await clock.advance(500);
  assert.strictEqual(calls, 1);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(clock.count(), 0);
});

test('전송: write가 바로 예외를 던져도 같은 방식으로 처리', async () => {
  const clock = makeClock();
  const { sender, errors } = makeSender(clock, () => { throw new Error('sync'); });
  sender.hold(10, 10);
  await clock.advance(200);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(clock.count(), 0);
});

test('전송: flush는 정지 값이 나간 뒤에 끝난다', async () => {
  const clock = makeClock();
  const writes = [];
  const finishers = [];
  const { sender } = makeSender(clock, (x, y) => {
    writes.push([x, y]);
    return new Promise((resolve) => finishers.push(resolve));
  });
  let done = false;
  await sender.flush(300); // 아무것도 안 눌렀으면 바로 끝
  sender.hold(50, 50);
  await flush();
  sender.release();
  sender.flush(300).then(() => { done = true; });
  await flush();
  assert.strictEqual(done, false);
  finishers.shift()(); // 누른 값 전송 완료 → 정지 값 전송 시작
  await flush();
  assert.strictEqual(done, false);
  finishers.shift()(); // 정지 값 전송 완료
  await flush();
  assert.strictEqual(done, true);
  assert.deepStrictEqual(writes[1], NEUTRAL);
  sender.stop();
});

test('전송: 정지 값 전송 중 다시 눌렀다 떼도 flush는 새 정지 값을 기다린다', async () => {
  const clock = makeClock();
  const writes = [];
  const finishers = [];
  const { sender } = makeSender(clock, (x, y) => {
    writes.push([x, y]);
    return new Promise((resolve) => finishers.push(resolve));
  });
  sender.hold(10, 10);
  await flush();
  finishers.shift()(); // 누른 값 전송 완료
  await flush();
  sender.release(); // 정지 값 전송 시작(아직 안 끝남)
  await flush();
  sender.hold(20, 20); // 그 사이 다시 누름
  finishers.shift()(); // 앞의 정지 값 전송 완료
  await flush();
  await clock.advance(50); // 누른 값(20,20) 전송 시작
  sender.release();
  let done = false;
  sender.flush(300).then(() => { done = true; });
  await flush();
  assert.strictEqual(done, false, '앞선 정지 값으로 끝난 것으로 치면 안 됨');
  finishers.shift()(); // (20,20) 완료 → 정지 값 전송 시작
  await flush();
  assert.strictEqual(done, false);
  finishers.shift()(); // 정지 값 완료
  await flush();
  assert.strictEqual(done, true);
  assert.deepStrictEqual(writes[writes.length - 1], NEUTRAL);
  sender.stop();
});

test('전송: flush는 응답이 없어도 제한 시간에 끝난다', async () => {
  const clock = makeClock();
  const { sender } = makeSender(clock, () => new Promise(() => {}));
  sender.hold(50, 50);
  sender.release();
  let done = false;
  sender.flush(300).then(() => { done = true; });
  await clock.advance(299);
  assert.strictEqual(done, false);
  await clock.advance(2);
  assert.strictEqual(done, true);
  sender.stop();
  assert.strictEqual(clock.count(), 0);
});

test('전송: 정지 값을 보내는 중 다시 누르면 누른 값으로 돌아간다', async () => {
  const clock = makeClock();
  const writes = [];
  const { sender } = makeSender(clock, async (x, y) => { writes.push([x, y]); });
  sender.hold(200, 200);
  await clock.advance(60);
  sender.release();
  await clock.advance(60);
  sender.hold(0, 0);
  await flush();
  const from = writes.length - 1;
  assert.deepStrictEqual(writes[from], [0, 0]);
  await clock.advance(300);
  assert.ok(writes.slice(from).every((w) => w[0] === 0 && w[1] === 0), '정지 값이 섞이지 않음');
  sender.stop();
});

test('전송: stop 뒤에 늦게 끝난 전송은 아무것도 일으키지 않는다', async () => {
  const clock = makeClock();
  const writes = [];
  let finish = null;
  const { sender, errors } = makeSender(clock, (x, y) => {
    writes.push([x, y]);
    return new Promise((resolve) => { finish = resolve; });
  });
  sender.hold(5, 5);
  await flush();
  sender.stop();
  finish();
  await clock.advance(500);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(clock.count(), 0);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`통과  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`실패  ${name}\n      ${error && error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 통과`);
  process.exit(failed ? 1 : 0);
})();
