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

function harness({ supported = true, legacy = false, startFailures = 0, stopFailures = 0, readOnly = false, synchronousStopEnd = false } = {}) {
  const input = createNode();
  const voiceButton = createNode();
  const voiceLabel = createNode();
  const speechStatus = createNode();
  const addButton = createNode();
  const instances = [];
  const parsedInputs = [];
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
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, callback) { const callbacks = windowListeners.get(name) || []; callbacks.push(callback); windowListeners.set(name, callbacks); },
    removeEventListener(name, callback) { windowListeners.set(name, (windowListeners.get(name) || []).filter(item => item !== callback)); },
  };
  if (supported) windowObject[legacy ? 'webkitSpeechRecognition' : 'SpeechRecognition'] = Recognition;
  const control = setupSpeechInput({
    input, voiceButton, voiceLabel, speechStatus, windowObject,
    onListening(active) { addButton.disabled = readOnly || active; },
    isReadOnly: () => readOnly,
  });
  return {
    input, voiceButton, voiceLabel, speechStatus, addButton, instances, control, parsedInputs,
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
  assert.equal(app.voiceLabel.textContent, '聆聽中...');
  assert.equal(app.voiceButton.getAttribute('aria-pressed'), 'true');
  assert.equal(app.addButton.disabled, true);
  recognition.onstart();
  assert.equal(app.control.state, 'listening');
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
  assert.equal(app.control.state, 'ending');
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

test('fast retries between error and end cannot construct or start a second session', () => {
  const app = harness();
  const first = beginListening(app);
  first.onerror({ error: 'no-speech' });
  for (let index = 0; index < 10; index += 1) app.click();
  assert.equal(app.instances.length, 1);
  assert.equal(first.starts, 1);
  assert.equal(first.stops, 0);
  first.onstart();
  first.onresult(result('錯誤後不應接受文字'));
  assert.equal(app.input.value, '');
  assert.equal(app.control.state, 'ending');
  first.onend();
  app.click();
  assert.equal(app.instances.length, 2);
  assert.equal(app.control.state, 'starting');
});

test('rapid start and stop clicks call each recognizer method at most once', () => {
  const app = harness();
  for (let index = 0; index < 10; index += 1) app.click();
  const first = app.instances[0];
  assert.equal(app.instances.length, 1);
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
  assert.equal(app.instances.length, 2);
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

test('a thrown stop does not repeat stop before end or recovery arrives', () => {
  const app = harness({ stopFailures: 1 });
  const first = beginListening(app);
  app.click();
  assert.equal(app.control.state, 'ending');
  assert.equal(first.stops, 1);
  assert.equal(app.addButton.disabled, false);
  app.click();
  assert.equal(first.stops, 1);
  assert.equal(app.instances.length, 1);
  first.onend();
  assert.equal(app.speechStatus.textContent, '無法結束語音輸入，請稍後再試或改用打字。');
  app.click();
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
    app.click(); app.click();
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
  for (const state of ['starting', 'listening', 'stopping', 'ending']) {
    const app = harness();
    app.type('保留草稿');
    app.click();
    const first = app.instances[0];
    if (state !== 'starting') first.onstart();
    if (state === 'stopping') app.click();
    if (state === 'ending') first.onerror({ error: 'no-speech' });
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
  assert.equal(first.aborts, 1);
  assert.equal(app.control.state, 'idle');
  beginListening(app);
  app.control.destroy();
  app.click(); app.pageEvent('pageshow', true);
  assert.equal(app.instances.length, 2);
  assert.equal(app.timers.size, 0);
});
