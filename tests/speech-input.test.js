import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSpeechInput } from '../js/speech-input.js';
import { parseTaskInput } from '../js/time-parser.js';

function createNode() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    value: '', textContent: '', disabled: false,
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) || []) callback(event);
      return true;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
}

function harness({ supported = true, legacy = false, continuous = false, startFailures = 0, stopFailures = 0, readOnly = false, synchronousStopEnd = false } = {}) {
  const input = createNode();
  const voiceButton = createNode();
  const voiceLabel = createNode();
  const speechStatus = createNode();
  const addButton = createNode();
  const instances = [];
  const parsedInputs = [];
  const progress = [];
  let elapsed = 0;
  const timers = new Map();
  const windowListeners = new Map();
  let nextTimer = 0;
  let parsed;
  const clock = new Date('2026-10-13T08:00:00+08:00');
  class InputEvent {
    constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles || false; }
  }
  class Recognition {
    constructor() { this.starts = 0; this.stops = 0; this.aborts = 0; instances.push(this); }
    abort() { this.aborts += 1; }
    start() {
      this.starts += 1;
      if (startFailures > 0) { startFailures -= 1; throw new Error('Synthetic start failure'); }
    }
    stop() {
      this.stops += 1;
      if (stopFailures > 0) { stopFailures -= 1; throw new Error('Synthetic stop failure'); }
      if (synchronousStopEnd) this.onend();
    }
  }
  input.addEventListener('input', event => {
    assert.equal(event.bubbles, true);
    parsedInputs.push(input.value);
    parsed = parseTaskInput(input.value, clock);
  });
  const windowObject = {
    Event: InputEvent,
    performance: { now: () => elapsed },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, due: elapsed + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, callback) { const callbacks = windowListeners.get(name) || []; callbacks.push(callback); windowListeners.set(name, callbacks); },
    removeEventListener(name, callback) { windowListeners.set(name, (windowListeners.get(name) || []).filter(item => item !== callback)); },
  };
  if (supported) windowObject[legacy ? 'webkitSpeechRecognition' : 'SpeechRecognition'] = Recognition;
  const control = setupSpeechInput({
    input, voiceButton, voiceLabel, speechStatus, windowObject,
    continuous, onProgress: (seconds, limit) => progress.push({ seconds, limit }),
    onListening(active) { addButton.disabled = readOnly || active; },
    isReadOnly: () => readOnly,
  });
  return {
    input, voiceButton, voiceLabel, speechStatus, addButton, instances, control, parsedInputs, progress,
    advance(seconds) { elapsed += seconds * 1000; },
    advanceTo(milliseconds, { reverseAtSameTime = false } = {}) {
      assert.ok(milliseconds >= elapsed, 'The clock must move forward');
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= milliseconds)
          .sort((a, b) => a[1].due - b[1].due || (reverseAtSameTime ? b[0] - a[0] : a[0] - b[0]))[0];
        if (!next) break;
        const [id, timer] = next;
        elapsed = timer.due; timers.delete(id); timer.callback();
      }
      elapsed = milliseconds;
    },
    get parsed() { return parsed; },
    click() { voiceButton.dispatchEvent({ type: 'click' }); },
    type(value) { input.value = value; input.dispatchEvent(new InputEvent('input', { bubbles: true })); },
    setReadOnly(value) { readOnly = value; },
    timers,
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay || !timers.has(id)) continue;
        timers.delete(id); timer.callback();
      }
    },
    pageEvent(type, persisted = false) { for (const callback of windowListeners.get(type) || []) callback({ type, persisted }); },
  };
}

function result(transcript, isFinal = true) {
  return { results: [Object.assign([{ transcript }], { isFinal })] };
}

function beginListening(app) {
  app.click();
  const recognition = app.instances.at(-1);
  recognition.onstart();
  return recognition;
}

test('unsupported browsers keep the exact typing fallback and never create a recognizer', () => {
  const app = harness({ supported: false });
  assert.equal(app.control.supported, false);
  assert.equal(app.voiceButton.disabled, true);
  assert.equal(app.speechStatus.textContent, '此瀏覽器不支援語音輸入，請改用打字');
  assert.equal(app.addButton.disabled, false);
  app.click();
  assert.equal(app.instances.length, 0);
});

test('Taiwan recognition uses listening and stopping states before restoring controls on end', () => {
  const app = harness();
  app.click();
  const recognition = app.instances[0];
  assert.equal(app.control.state, 'starting');
  assert.equal(recognition.lang, 'zh-TW');
  assert.equal(recognition.continuous, false);
  assert.equal(recognition.interimResults, true);
  assert.equal(app.voiceLabel.textContent, '開啟中，點擊取消');
  assert.equal(app.voiceButton.getAttribute('aria-pressed'), 'true');
  assert.equal(app.addButton.disabled, true);
  recognition.onstart();
  assert.equal(app.control.state, 'listening');
  assert.equal(app.voiceLabel.textContent, '聆聽中...');
  app.click();
  assert.equal(app.control.state, 'stopping');
  assert.equal(recognition.stops, 1);
  recognition.onend();
  assert.equal(app.control.state, 'idle');
  assert.equal(app.voiceLabel.textContent, '語音輸入');
  assert.equal(app.voiceButton.getAttribute('aria-pressed'), 'false');
  assert.equal(app.addButton.disabled, false);
});

test('final text dispatches a bubbling input event through the shared time parser', () => {
  const app = harness();
  const recognition = beginListening(app);
  recognition.onresult(result('十分鐘後提醒我喝水'));
  assert.equal(app.input.value, '十分鐘後提醒我喝水');
  assert.deepEqual(app.parsedInputs, ['十分鐘後提醒我喝水']);
  assert.equal(app.parsed.title, '喝水');
  assert.equal(app.parsed.reminderAt, '2026-10-13T00:10:00.000Z');
  recognition.onend();
  assert.equal(app.speechStatus.textContent, '辨識完成，請確認任務與時間後新增。');
});

test('manual corrections after a final result survive duplicate results and recognition ending', () => {
  const app = harness();
  const recognition = beginListening(app);
  recognition.onresult(result('明早提醒我買早餐'));
  app.type('明早提醒我買午餐');
  recognition.onresult(result('明早提醒我買早餐'));
  recognition.onend();
  assert.equal(app.input.value, '明早提醒我買午餐');
  assert.equal(app.parsed.title, '買午餐');
  assert.deepEqual(app.parsedInputs, ['明早提醒我買早餐', '明早提醒我買午餐']);
});

test('a manual value change without an input event is also preserved after the final result', () => {
  const app = harness();
  const recognition = beginListening(app);
  recognition.onresult(result('明早提醒我買早餐'));
  app.input.value = '明早提醒我買午餐';
  recognition.onresult(result('明早提醒我買早餐'));
  recognition.onend();
  assert.equal(app.input.value, '明早提醒我買午餐');
});

test('network errors restore typing controls and retain their message after end', () => {
  const app = harness();
  const recognition = beginListening(app);
  recognition.onerror({ error: 'network' });
  assert.equal(app.control.state, 'idle');
  assert.equal(app.voiceLabel.textContent, '語音輸入');
  assert.equal(app.addButton.disabled, false);
  assert.equal(app.speechStatus.textContent, '語音辨識服務無法連線，請檢查網路或改用打字。');
  recognition.onend();
  assert.equal(app.control.state, 'idle');
  assert.equal(app.speechStatus.textContent, '語音辨識服務無法連線，請檢查網路或改用打字。');
});

test('the second task receives a fresh recognizer and its own final text', () => {
  const app = harness();
  const first = beginListening(app);
  first.onresult(result('十分鐘後提醒我喝水'));
  first.onend();
  const second = beginListening(app);
  assert.notEqual(second, first);
  assert.equal(app.instances.length, 2);
  assert.equal(first.starts, 1);
  assert.equal(second.starts, 1);
  second.onresult(result('明天早上八點提醒我買早餐'));
  second.onend();
  assert.equal(app.input.value, '明天早上八點提醒我買早餐');
  assert.equal(app.parsed.title, '買早餐');
  assert.equal(app.parsed.reminderAt, '2026-10-14T00:00:00.000Z');
});

test('all delayed callbacks from an old recognizer leave the active session untouched', () => {
  const app = harness();
  const first = beginListening(app);
  first.onresult(result('十分鐘後提醒我喝水'));
  first.onend();
  const second = beginListening(app);
  second.onresult(result('明早提醒我買早餐'));
  const snapshot = {
    input: app.input.value, status: app.speechStatus.textContent, label: app.voiceLabel.textContent,
    pressed: app.voiceButton.getAttribute('aria-pressed'), disabled: app.addButton.disabled,
    count: app.parsedInputs.length,
  };
  first.onstart();
  first.onresult(result('過期回呼提醒我錯誤任務'));
  first.onerror({ error: 'network' });
  first.onend();
  assert.equal(app.control.state, 'listening');
  assert.deepEqual({
    input: app.input.value, status: app.speechStatus.textContent, label: app.voiceLabel.textContent,
    pressed: app.voiceButton.getAttribute('aria-pressed'), disabled: app.addButton.disabled,
    count: app.parsedInputs.length,
  }, snapshot);
  second.onend();
  assert.equal(app.control.state, 'idle');
});

test('retry immediately after an error starts a fresh session without waiting for old end', () => {
  const app = harness();
  const first = beginListening(app);
  first.onerror({ error: 'no-speech' });
  app.click();
  assert.equal(app.instances.length, 2);
  assert.equal(first.starts, 1);
  assert.equal(first.stops, 0);
  first.onstart();
  first.onresult(result('錯誤後不應接受文字'));
  assert.equal(app.input.value, '');
  assert.equal(app.control.state, 'starting');
  first.onend();
  assert.equal(app.instances.length, 2);
  assert.equal(app.control.state, 'starting');
  const second = app.instances[1];
  second.onstart(); second.onresult(result('十分鐘後提醒我喝水')); second.onend();
  assert.equal(app.parsed.title, '喝水');
});

test('starting can be cancelled and repeated stop clicks never stop a recognizer twice', () => {
  const app = harness();
  app.click(); app.click();
  const cancelled = app.instances[0];
  assert.equal(cancelled.aborts, 1);
  assert.equal(app.control.state, 'idle');
  assert.equal(app.timers.size, 0);
  cancelled.onstart(); cancelled.onresult(result('取消的文字')); cancelled.onend();
  assert.equal(app.input.value, '');
  assert.equal(app.instances.length, 1);
  app.click();
  const first = app.instances[1];
  assert.equal(first.starts, 1);
  assert.equal(first.stops, 0);
  first.onstart();
  for (let index = 0; index < 10; index += 1) app.click();
  assert.equal(app.control.state, 'stopping');
  assert.equal(first.stops, 1);
  assert.equal(first.starts, 1);
  first.onresult(result('半小時後提醒我出門'));
  first.onend();
  assert.equal(app.parsed.title, '出門');
  app.click();
  assert.equal(app.instances.length, 3);
});

test('a thrown start restores idle controls and its delayed events cannot contaminate a retry', () => {
  const app = harness({ startFailures: 1 });
  app.click();
  const failed = app.instances[0];
  assert.equal(app.control.state, 'idle');
  assert.equal(app.voiceLabel.textContent, '語音輸入');
  assert.equal(app.addButton.disabled, false);
  assert.equal(app.speechStatus.textContent, '無法啟動語音輸入，請稍後再試或改用打字。');
  app.click();
  const second = app.instances[1];
  failed.onstart();
  failed.onresult(result('失敗輪次的過期文字'));
  failed.onerror({ error: 'network' });
  failed.onend();
  assert.equal(app.control.state, 'starting');
  assert.equal(app.speechStatus.textContent, '正在開啟麥克風…');
  assert.equal(app.input.value, '');
  second.onstart();
  second.onresult(result('十分鐘後提醒我喝水'));
  second.onend();
  assert.equal(app.parsed.title, '喝水');
});

test('a thrown stop immediately resets and permits another recording', () => {
  const app = harness({ stopFailures: 1 });
  const first = beginListening(app);
  app.click();
  assert.equal(app.control.state, 'idle');
  assert.equal(first.stops, 1);
  assert.equal(app.addButton.disabled, false);
  app.click();
  assert.equal(first.stops, 1);
  assert.equal(app.instances.length, 2);
  first.onend();
  assert.equal(app.control.state, 'starting');
  assert.equal(app.instances.length, 2);
});

test('synchronous end inside stop restores idle and permits a fresh next session', () => {
  const app = harness({ synchronousStopEnd: true });
  beginListening(app);
  app.click();
  assert.equal(app.control.state, 'idle');
  app.click();
  assert.equal(app.instances.length, 2);
  assert.equal(app.control.state, 'starting');
});

test('interim text is status only and a no-final session leaves the input available for typing', () => {
  const app = harness();
  const recognition = beginListening(app);
  recognition.onresult(result('明天早上八點', false));
  assert.equal(app.speechStatus.textContent, '辨識中：明天早上八點');
  assert.equal(app.input.value, '');
  assert.deepEqual(app.parsedInputs, []);
  recognition.onend();
  assert.equal(app.speechStatus.textContent, '尚未辨識到文字，請再試一次或改用打字。');
  app.type('明早提醒我買早餐');
  assert.equal(app.parsed.title, '買早餐');
});

test('read-only mode prevents microphone start while the webkit alias remains supported', () => {
  const app = harness({ legacy: true, readOnly: true });
  assert.equal(app.control.supported, true);
  app.click();
  assert.equal(app.instances.length, 0);
  assert.equal(app.addButton.disabled, true);
  app.setReadOnly(false);
  const recognition = beginListening(app);
  recognition.onresult(result('半小時後提醒我出門'));
  assert.equal(app.parsed.title, '出門');
});

test('permission and microphone errors retain their existing fallback messages', () => {
  const messages = {
    'not-allowed': '無法使用麥克風，請檢查瀏覽器權限；也可改用鍵盤麥克風或打字。',
    'service-not-allowed': '目前環境無法使用語音服務，請改用鍵盤麥克風或打字。',
    'audio-capture': '找不到可用的麥克風，請確認裝置設定。',
    aborted: '已結束語音輸入。',
  };
  for (const [error, message] of Object.entries(messages)) {
    const app = harness();
    const recognition = beginListening(app);
    recognition.onerror({ error });
    recognition.onend();
    assert.equal(app.speechStatus.textContent, message);
    assert.equal(app.control.state, 'idle');
  }
});

test('a missing start callback times out and late events cannot affect the next session', () => {
  const app = harness();
  app.click();
  const first = app.instances[0];
  app.runTimers(10_000);
  assert.equal(app.control.state, 'idle');
  assert.equal(first.aborts, 1);
  assert.equal(app.addButton.disabled, false);
  assert.match(app.speechStatus.textContent, /啟動逾時/);
  const second = beginListening(app);
  first.onstart(); first.onresult(result('舊的文字')); first.onend();
  assert.equal(app.control.state, 'listening');
  assert.equal(app.input.value, '');
  assert.equal(second.starts, 1);
});

test('error without end releases retry after recovery and preserves the error and manual text', () => {
  const app = harness();
  const first = beginListening(app);
  first.onerror({ error: 'network' });
  app.type('明早提醒我買早餐');
  app.runTimers(2000);
  assert.equal(app.control.state, 'idle');
  assert.equal(app.input.value, '明早提醒我買早餐');
  assert.match(app.speechStatus.textContent, /無法連線/);
  assert.equal(first.aborts, 1);
  const second = beginListening(app);
  second.onresult(result('十分鐘後提醒我喝水'));
  second.onend();
  const third = beginListening(app);
  third.onresult(result('半小時後提醒我出門')); third.onend();
  assert.equal(app.instances.length, 3);
  assert.equal(app.parsed.title, '出門');
});

test('stop without end and thrown stop both recover without repeating stop', () => {
  for (const stopFailures of [0, 1]) {
    const app = harness({ stopFailures });
    const first = beginListening(app);
    app.click();
    if (!stopFailures) app.click();
    assert.equal(first.stops, 1);
    app.runTimers(2000);
    assert.equal(app.control.state, 'idle');
    assert.equal(first.aborts, 1);
    app.click();
    assert.equal(app.instances.length, 2);
    assert.equal(first.stops, 1);
  }
});

test('a final result without end releases controls without overwriting a manual correction', () => {
  const app = harness();
  const first = beginListening(app);
  first.onresult(result('明早提醒我買早餐'));
  app.type('明早提醒我買午餐');
  app.runTimers(2000);
  assert.equal(app.control.state, 'idle');
  assert.equal(app.addButton.disabled, false);
  assert.equal(app.input.value, '明早提醒我買午餐');
  assert.equal(first.aborts, 1);
});

test('normal end cancels watchdogs and a stale captured timer cannot stop a new session', () => {
  const app = harness();
  const first = beginListening(app);
  first.onresult(result('十分鐘後提醒我喝水'));
  const staleTimer = [...app.timers.values()][0].callback;
  first.onend();
  assert.equal(app.timers.size, 0);
  const second = beginListening(app);
  staleTimer();
  assert.equal(app.control.state, 'listening');
  assert.equal(second.aborts, 0);
  assert.equal(app.addButton.disabled, true);
});

test('pagehide and BFCache pageshow reset every active state without starting a microphone', () => {
  for (const state of ['starting', 'listening', 'stopping']) {
    const app = harness();
    app.type('保留草稿');
    app.click();
    const first = app.instances[0];
    if (state !== 'starting') first.onstart();
    if (state === 'stopping') app.click();
    assert.equal(app.control.state, state);
    app.pageEvent('pagehide', true);
    assert.equal(app.control.state, 'idle');
    assert.equal(first.aborts, 1);
    assert.equal(app.timers.size, 0);
    app.pageEvent('pageshow', true);
    assert.equal(app.instances.length, 1);
    assert.equal(app.addButton.disabled, false);
    assert.equal(app.input.value, '保留草稿');
    const second = beginListening(app);
    first.onresult(result('舊的返回文字')); first.onend();
    assert.equal(app.control.state, 'listening');
    assert.equal(app.input.value, '保留草稿');
    assert.equal(second.aborts, 0);
  }
});

test('pageshow alone recovers stale active state and never automatically requests another session', () => {
  const app = harness();
  const first = beginListening(app);
  app.pageEvent('pageshow', true);
  assert.equal(app.control.state, 'idle');
  assert.equal(first.aborts, 1);
  assert.equal(app.instances.length, 1);
  app.click();
  assert.equal(app.instances.length, 2);
});

test('manual reset invalidates first, even if abort synchronously sends callbacks or throws', () => {
  for (const throws of [false, true]) {
    const app = harness();
    const first = beginListening(app);
    first.onresult(result('十分鐘後提醒我喝水'));
    first.abort = () => {
      first.onerror({ error: 'aborted' }); first.onend();
      if (throws) throw new Error('Synthetic abort failure');
    };
    app.control.reset();
    assert.equal(app.control.state, 'idle');
    assert.equal(app.input.value, '十分鐘後提醒我喝水');
    assert.match(app.speechStatus.textContent, /已重設/);
    assert.equal(app.timers.size, 0);
    const second = beginListening(app);
    first.onresult(result('過期結果'));
    assert.equal(app.input.value, '十分鐘後提醒我喝水');
    assert.equal(second.starts, 1);
  }
});

test('a silent listening session has a finite limit and destroy prevents further recording', () => {
  const app = harness();
  const first = beginListening(app);
  app.runTimers(60_000);
  assert.equal(first.stops, 0);
  assert.equal(app.control.state, 'listening');
  app.runTimers(120_000);
  assert.equal(first.stops, 1);
  assert.equal(app.control.state, 'stopping');
  app.runTimers(2000);
  assert.equal(first.aborts, 1);
  assert.equal(app.control.state, 'idle');
  beginListening(app);
  app.control.destroy();
  app.click(); app.pageEvent('pageshow', true);
  assert.equal(app.instances.length, 2);
  assert.equal(app.timers.size, 0);
});

test('continuous results accumulate through pauses without shortening the 120-second limit', () => {
  const app = harness({ continuous: true });
  const recognition = beginListening(app);
  assert.equal(recognition.continuous, true);
  recognition.onresult(result('明天早上八點'));
  app.runTimers(2000);
  assert.equal(app.control.state, 'listening');
  assert.equal(recognition.aborts, 0);
  app.advance(61); app.runTimers(1000);
  assert.deepEqual(app.progress.at(-1), { seconds: 61, limit: 120 });
  recognition.onresult({ results: [
    ...result('明天早上八點').results,
    ...result('提醒我買早餐').results,
  ] });
  assert.equal(app.input.value, '明天早上八點提醒我買早餐');
  assert.equal(app.parsed.title, '買早餐');
  assert.equal(recognition.stops, 0);
  app.advance(59); app.runTimers(120_000);
  assert.equal(recognition.stops, 1);
  assert.equal(app.control.state, 'stopping');
  assert.deepEqual(app.progress.at(-1), { seconds: 120, limit: 120 });
  recognition.onresult(result('明天早上八點提醒我買早餐和牛奶'));
  app.runTimers(2000);
  assert.equal(app.control.state, 'idle');
  assert.equal(app.input.value, '明天早上八點提醒我買早餐和牛奶');
  assert.match(app.speechStatus.textContent, /120 秒/);
  assert.equal(app.timers.size, 0);
  const second = beginListening(app);
  assert.equal(second.starts, 1);
  assert.deepEqual(app.progress.at(-1), { seconds: 0, limit: 120 });
});

test('manual stop before the limit keeps the final result and freezes the elapsed time', () => {
  const app = harness({ continuous: true });
  const recognition = beginListening(app);
  app.advance(17); app.runTimers(1000);
  app.click();
  assert.equal(recognition.stops, 1);
  assert.equal(app.voiceLabel.textContent, '結束中...');
  app.advance(2);
  recognition.onresult(result('十分鐘後提醒我喝水'));
  recognition.onend();
  assert.equal(app.input.value, '十分鐘後提醒我喝水');
  assert.deepEqual(app.progress.at(-1), { seconds: 17, limit: 120 });
  app.runTimers(120_000); app.runTimers(1000); app.runTimers(2000);
  assert.equal(recognition.stops, 1);
  assert.equal(recognition.aborts, 0);
  assert.equal(app.timers.size, 0);
});

test('audio ending without an end callback recovers even in continuous mode', () => {
  const app = harness({ continuous: true });
  const first = beginListening(app);
  first.onaudioend();
  assert.equal(app.control.state, 'stopping');
  const recovery = [...app.timers.values()][0];
  first.onresult(result('半小時後提醒我出門'));
  assert.equal([...app.timers.values()][0], recovery, 'A late result must not extend the stop deadline');
  app.runTimers(2000);
  assert.equal(app.control.state, 'idle');
  assert.equal(app.parsed.title, '出門');
  const second = beginListening(app);
  first.onaudioend(); first.onend();
  assert.equal(app.control.state, 'listening');
  assert.equal(second.aborts, 0);
});

test('old duration and progress callbacks cannot affect the next recording', () => {
  const app = harness({ continuous: true });
  const first = beginListening(app);
  const oldTimers = [...app.timers.values()];
  app.advance(5); first.onend();
  const second = beginListening(app);
  for (const timer of oldTimers) timer.callback();
  assert.equal(app.control.state, 'listening');
  assert.equal(second.stops, 0);
  assert.equal(second.aborts, 0);
  assert.deepEqual(app.progress.at(-1), { seconds: 0, limit: 120 });
});

test('scheduled clock enforces the exact 120-second boundary and bounded settling in either timer order', () => {
  for (const reverseAtSameTime of [false, true]) {
    const app = harness({ continuous: true });
    const first = beginListening(app);
    first.onresult(result('十分鐘後提醒我喝水'));
    app.advanceTo(119_999, { reverseAtSameTime });
    assert.equal(app.control.state, 'listening');
    assert.equal(first.stops, 0);
    assert.deepEqual(app.progress.at(-1), { seconds: 119, limit: 120 });
    app.advanceTo(120_000, { reverseAtSameTime });
    assert.equal(app.control.state, 'stopping');
    assert.equal(first.stops, 1, 'Duration and progress deadlines must stop only once');
    assert.deepEqual(app.progress.at(-1), { seconds: 120, limit: 120 });
    app.advanceTo(121_999, { reverseAtSameTime });
    first.onresult(result('十分鐘後提醒我喝水和休息'));
    assert.equal(app.control.state, 'stopping');
    app.advanceTo(122_000, { reverseAtSameTime });
    assert.equal(app.control.state, 'idle');
    assert.equal(first.aborts, 1);
    assert.equal(app.input.value, '十分鐘後提醒我喝水和休息');
    assert.equal(app.timers.size, 0, 'A late result must not extend the settling deadline');
    const second = beginListening(app);
    app.advanceTo(123_000, { reverseAtSameTime });
    assert.equal(second.stops, 0);
    assert.equal(app.control.state, 'listening');
    assert.deepEqual(app.progress.at(-1), { seconds: 1, limit: 120 });
    second.onend();
  }
});

test('manual stop just before the duration deadline wins and settling releases a third consecutive recording', () => {
  const app = harness({ continuous: true });
  const first = beginListening(app);
  app.advanceTo(119_999);
  app.click();
  assert.equal(first.stops, 1);
  app.advanceTo(120_000);
  assert.equal(first.stops, 1);
  assert.deepEqual(app.progress.at(-1), { seconds: 119, limit: 120 });
  app.advanceTo(121_998);
  assert.equal(app.control.state, 'stopping');
  app.advanceTo(121_999);
  assert.equal(app.control.state, 'idle');
  const second = beginListening(app);
  second.onresult(result('明早提醒我買早餐'));
  app.click(); second.onend();
  const third = beginListening(app);
  first.onend(); second.onerror({ error: 'network' });
  app.advanceTo(123_999);
  assert.equal(app.control.state, 'listening');
  assert.equal(third.stops, 0);
  third.onend();
  assert.equal(app.timers.size, 0);
});

test('typing before the first final result survives delayed voice text without blocking the next voice draft', () => {
  const app = harness({ continuous: true });
  const first = beginListening(app);
  app.type('明天早上八點提醒我買午餐');
  first.onresult(result('明天早上八點提醒我買早餐'));
  assert.equal(app.input.value, '明天早上八點提醒我買午餐');
  first.onresult({ results: [...result('明天早上八點提醒我買早餐').results, ...result('和牛奶').results] });
  app.click(); first.onend();
  assert.equal(app.parsed.title, '買午餐');
  const second = beginListening(app);
  second.onresult(result('十分鐘後提醒我喝水')); second.onend();
  assert.equal(app.input.value, '十分鐘後提醒我喝水');
});

test('a value changed without an input event before the first final is preserved and single-utterance recovery still runs', () => {
  const app = harness();
  app.type('原本的草稿');
  const first = beginListening(app);
  app.input.value = '手動修正的新草稿';
  first.onresult(result('不應覆蓋的辨識結果'));
  assert.equal(app.input.value, '手動修正的新草稿');
  app.advanceTo(1999);
  assert.equal(app.control.state, 'listening');
  app.advanceTo(2000);
  assert.equal(app.control.state, 'idle', 'A preserved correction must not bypass missing-end recovery');
  assert.equal(first.aborts, 1);
  const second = beginListening(app);
  second.onresult(result('十分鐘後提醒我喝水')); second.onend();
  assert.equal(app.input.value, '十分鐘後提醒我喝水', 'A fresh recording may replace the old starting draft');
  first.onresult(result('過期第一筆')); first.onend();
  assert.equal(app.input.value, '十分鐘後提醒我喝水');
});
