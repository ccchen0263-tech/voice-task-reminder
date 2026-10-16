import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupGoogleApp } from '../js/google-app.js';
import { createGoogleCalendarDraftURL } from '../js/google-calendar.js';
import { parseTaskInput } from '../js/time-parser.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Actual candidate entry/callbacks, synthetic DOM/speech/navigation. No browser,
// microphone permission or Google event is exercised by this harness.
function harness({ supported = true, secure = true, blockedStorage = true, navigationFailure = false, startFailures = 0, stopFailures = 0 } = {}) {
  const nodes = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  const instances = [];
  const navigations = [];
  const legacyHistory = new Map([
    ['voice-task-reminder.tasks.v1', '{synthetic unreadable old task data'],
    ['voice-task-reminder.settings.v1', '{synthetic unreadable old preferences'],
    ['voice-task-reminder.alerts.v1', '[synthetic legacy alerts]'],
    ['voice-task-reminder.theme.v1', 'dark'],
  ]);
  const originalHistory = [...legacyHistory];
  const storageAccess = { local: 0, session: 0, indexedDB: 0, mutations: 0 };
  let nextTimer = 0;
  let elapsed = 0;
  let currentTime = new Date('2030-01-02T08:00:00+08:00');

  function node(id) {
    const listeners = new Map();
    const attributes = new Map();
    return {
      id, value: '', textContent: '', hidden: false, disabled: false, dataset: {},
      addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)); },
      dispatchEvent(event) {
        event.target ??= this; event.preventDefault ??= () => { event.defaultPrevented = true; };
        for (const fn of listeners.get(event.type) || []) fn(event);
        return !event.defaultPrevented;
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      setCustomValidity(value) { this.validationMessage = value; },
      reportValidity() { this.validityReported = true; return !this.validationMessage; },
      focus() { this.focused = true; },
    };
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(`#${match[1]}`, node(match[1]));
  const get = selector => {
    assert.ok(nodes.has(selector), `A real HTML element must exist for ${selector}`);
    return nodes.get(selector);
  };
  get('#task-repeat').value = 'none';
  get('#google-handoff').hidden = true;
  const examples = [...html.matchAll(/data-example="([^"]+)"/g)].map((match, i) => {
    const button = node(`example-${i}`); button.dataset.example = match[1]; return button;
  });
  class InputEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  class Recognition {
    constructor() { this.starts = 0; this.stops = 0; this.aborts = 0; instances.push(this); }
    start() { this.starts += 1; if (startFailures-- > 0) throw new Error('Synthetic start failure'); }
    stop() { this.stops += 1; if (stopFailures-- > 0) throw new Error('Synthetic stop failure'); }
    abort() { this.aborts += 1; }
  }
  const windowObject = {
    Event: InputEvent, isSecureContext: secure,
    performance: { now: () => elapsed },
    ...(supported ? { SpeechRecognition: Recognition } : {}),
    addEventListener(type, fn) { const list = windowListeners.get(type) || []; list.push(fn); windowListeners.set(type, list); },
    removeEventListener(type, fn) { windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== fn)); },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: false }),
    location: { assign(url) { navigations.push(url); if (navigationFailure) throw new Error('Synthetic navigation failure'); } },
    open() { assert.fail('The candidate must not depend on a scripted popup'); },
    fetch() { assert.fail('No background network request is expected'); },
  };
  Object.defineProperties(windowObject, {
    localStorage: { get() {
      storageAccess.local += 1;
      if (blockedStorage) throw new Error('Synthetic localStorage denial');
      return { getItem: key => legacyHistory.get(key), setItem(key, value) { storageAccess.mutations += 1; legacyHistory.set(key, value); },
        removeItem(key) { storageAccess.mutations += 1; legacyHistory.delete(key); }, clear() { storageAccess.mutations += 1; legacyHistory.clear(); } };
    } },
    sessionStorage: { get() { storageAccess.session += 1; throw new Error('Synthetic sessionStorage denial'); } },
    indexedDB: { get() { storageAccess.indexedDB += 1; throw new Error('Synthetic IndexedDB denial'); } },
  });
  const documentObject = { ...node('document'), visibilityState: 'visible', querySelector: get, querySelectorAll: selector => selector === '[data-example]' ? examples : [], documentElement: { dataset: {} } };
  const control = setupGoogleApp({ documentObject, windowObject, now: () => new Date(currentTime) });
  return {
    get, control, instances, navigations, storageAccess, examples, legacyHistory, originalHistory,
    type(text) { get('#task-input').value = text; get('#task-input').dispatchEvent(new InputEvent('input', { bubbles: true })); },
    setField(selector, value) { get(selector).value = value; get(selector).dispatchEvent(new InputEvent('input', { bubbles: true })); },
    click(selector) { get(selector).dispatchEvent({ type: 'click' }); },
    submit() { get('#task-form').dispatchEvent({ type: 'submit' }); },
    page(type, persisted = true) { for (const fn of windowListeners.get(type) || []) fn({ type, persisted }); },
    visibility(value) { documentObject.visibilityState = value; documentObject.dispatchEvent({ type: 'visibilitychange' }); },
    advanceRecording(seconds) { elapsed += seconds * 1000; },
    runTimers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay && timers.has(id)) { timers.delete(id); timer.callback(); } },
    advance(minutes) { currentTime = new Date(currentTime.getTime() + minutes * 60_000); },
    now: () => new Date(currentTime),
  };
}

function result(text) { return { results: [Object.assign([{ transcript: text }], { isFinal: true })] }; }
function begin(app) { app.click('#voice-button'); const recognition = app.instances.at(-1); recognition.onstart(); return recognition; }
function assertHistoryUntouched(app) {
  assert.deepEqual(app.storageAccess, { local: 0, session: 0, indexedDB: 0, mutations: 0 });
  assert.deepEqual([...app.legacyHistory], app.originalHistory);
}

test('Google-only entry initializes with unreadable/denied historical storage and never requests speech on load', () => {
  for (const blockedStorage of [true, false]) {
    const app = harness({ blockedStorage });
    assert.equal(app.get('#add-button').disabled, false);
    assert.equal(app.get('#voice-button').disabled, false);
    assert.equal(app.instances.length, 0);
    app.click('#theme-toggle');
    assertHistoryUntouched(app);
  }
});

test('first, second and third voice drafts navigate only on confirmation and recover after Google BFCache return', () => {
  const app = harness();
  const inputs = ['十分鐘後提醒我喝水', '明天早上八點提醒我買早餐', '半小時後提醒我出門'];
  for (let i = 0; i < inputs.length; i += 1) {
    const recognition = begin(app);
    recognition.onresult(result(inputs[i])); recognition.onend();
    assert.equal(app.navigations.length, i);
    app.submit();
    assert.equal(app.navigations.length, i + 1);
    const url = new URL(app.navigations[i]);
    assert.equal(url.origin, 'https://calendar.google.com');
    assert.equal(url.searchParams.get('text'), parseTaskInput(inputs[i], app.now()).title);
    assert.equal(app.get('#google-retry').href, url.href);
    assert.match(app.get('#app-status').textContent, /尚待.*儲存/);
    app.page('pagehide'); app.page('pageshow');
    assert.equal(app.get('#task-input').value, '');
    assert.equal(app.get('#voice-button').disabled, false);
    assert.equal(app.get('#add-button').disabled, false);
    assert.equal(app.control.speech.state, 'idle');
    assert.equal(app.instances.length, i + 1, 'Returning must not open the microphone');
  }
  assert.equal(new Set(app.instances).size, 3);
  assertHistoryUntouched(app);
});

test('first stop without end, immediate retry after second error, and third recording all remain recoverable', () => {
  const app = harness();
  const first = begin(app); first.onresult(result('十分鐘後提醒我喝水'));
  assert.equal(app.get('#add-button').disabled, true);
  app.click('#voice-button');
  app.runTimers(2000);
  assert.equal(app.get('#add-button').disabled, false);
  app.submit(); app.page('pagehide'); app.page('pageshow');
  const second = begin(app); second.onerror({ error: 'network' });
  assert.equal(app.control.speech.state, 'idle');
  const third = begin(app); third.onresult(result('明早提醒我買早餐')); third.onend();
  first.onresult(result('過期第一筆')); second.onend();
  assert.equal(app.get('#task-input').value, '明早提醒我買早餐');
  app.submit();
  assert.equal(app.navigations.length, 2);
  assert.equal(new URL(app.navigations[1]).searchParams.get('text'), '買早餐');
  assertHistoryUntouched(app);
});

test('cancel during starting/listening preserves typing and old callbacks cannot contaminate a fresh recording', () => {
  for (const starting of [true, false]) {
    const app = harness();
    app.type('明早提醒我買早餐');
    app.click('#voice-button'); const first = app.instances[0];
    if (!starting) first.onstart();
    app.click('#reset-voice');
    assert.equal(first.aborts, 1);
    assert.equal(app.get('#task-input').value, '明早提醒我買早餐');
    const second = begin(app);
    first.onstart(); first.onresult(result('過期取消結果')); first.onend();
    second.onresult(result('十分鐘後提醒我喝水')); second.onend();
    app.submit();
    assert.equal(new URL(app.navigations[0]).searchParams.get('text'), '喝水');
    assertHistoryUntouched(app);
  }
});

test('failed starts and thrown stops release the Google form and permit the next recording', () => {
  const app = harness({ startFailures: 1, stopFailures: 1 });
  app.click('#voice-button');
  assert.equal(app.control.speech.state, 'idle');
  const second = begin(app);
  app.click('#voice-button'); app.runTimers(2000);
  assert.equal(app.control.speech.state, 'idle');
  const third = begin(app); third.onresult(result('十分鐘後提醒我喝水')); third.onend();
  app.submit();
  assert.equal(app.navigations.length, 1);
  assert.equal(second.aborts, 1);
  assertHistoryUntouched(app);
});

test('unknown time and invalid manual dates require scheduling, with no memo or external action', () => {
  const app = harness();
  app.type('睡前提醒我吃藥'); app.submit();
  assert.equal(app.navigations.length, 0);
  assert.match(app.get('#app-status').textContent, /補上開始時間/);
  app.setField('#task-time', '2030-02-30T08:00'); app.submit();
  assert.equal(app.navigations.length, 0);
  app.setField('#task-time', '2030-02-28T08:00'); app.submit();
  assert.equal(app.navigations.length, 1);
  assert.equal(new URL(app.navigations[0]).searchParams.get('text'), '吃藥');
  assertHistoryUntouched(app);
});

test('an empty title cannot open a Google event and keyboard text uses the same parser', () => {
  const app = harness();
  app.submit();
  assert.equal(app.navigations.length, 0);
  app.type('明天早上八點提醒我買早餐'); app.submit();
  assert.equal(new URL(app.navigations[0]).searchParams.get('text'), '買早餐');
  assertHistoryUntouched(app);
});

test('relative time is recomputed on confirmation while a manual override remains authoritative', () => {
  const app = harness();
  app.type('十分鐘後提醒我喝水');
  app.advance(5); app.submit();
  const expected = createGoogleCalendarDraftURL({ title: '喝水', reminderAt: new Date(app.now().getTime() + 10 * 60_000).toISOString(), originalInput: '十分鐘後提醒我喝水', repeat: 'none' });
  assert.equal(app.navigations[0], expected);
  app.page('pagehide'); app.page('pageshow');
  app.type('明早提醒我買早餐');
  app.setField('#task-time', '2031-03-04T12:30');
  app.type('十分鐘後提醒我喝水'); app.submit();
  const dates = new URL(app.navigations[1]).searchParams.get('dates');
  const expectedStart = new Date(2031, 2, 4, 12, 30).toISOString().replace(/[-:]|\.\d{3}/g, '');
  assert.equal(dates.split('/')[0], expectedStart);
});

test('IME composition cannot navigate with partial input; final text can prepare Google', () => {
  const app = harness();
  app.get('#task-input').dispatchEvent({ type: 'compositionstart' });
  app.type('明早提醒我買早'); app.submit();
  assert.equal(app.navigations.length, 0);
  app.get('#task-input').value = '明早提醒我買早餐';
  app.get('#task-input').dispatchEvent({ type: 'compositionend' }); app.submit();
  assert.equal(new URL(app.navigations[0]).searchParams.get('text'), '買早餐');
});

test('double confirmation cannot produce two handoffs before returning or starting a new draft', () => {
  const app = harness();
  app.type('十分鐘後提醒我喝水'); app.submit(); app.submit();
  assert.equal(app.navigations.length, 1);
  assert.equal(app.control.pendingNavigation, true);
  app.page('pagehide'); app.page('pageshow');
  app.type('明早提醒我買早餐'); app.submit();
  assert.equal(app.navigations.length, 2);
  assertHistoryUntouched(app);
});

test('navigation exceptions preserve the draft and a real retry link without creating any local task', () => {
  const app = harness({ navigationFailure: true });
  app.type('十分鐘後提醒我喝水'); app.setField('#task-notes', '要保留的備註'); app.submit();
  assert.equal(app.control.pendingNavigation, false);
  assert.equal(app.get('#task-input').value, '十分鐘後提醒我喝水');
  assert.equal(app.get('#task-notes').value, '要保留的備註');
  assert.equal(app.get('#google-retry').href, app.navigations[0]);
  assert.match(app.get('#app-status').textContent, /尚未儲存/);
  app.page('pageshow', false);
  assert.equal(app.get('#task-input').value, '十分鐘後提醒我喝水');
  assertHistoryUntouched(app);
});

test('silently blocked navigation unlocks controls and preserves a newer draft when retrying the previous link', () => {
  const app = harness();
  app.type('十分鐘後提醒我喝水'); app.submit();
  const previousURL = app.navigations[0];
  app.runTimers(2500);
  assert.equal(app.get('#voice-button').disabled, false);
  app.type('明早提醒我買早餐'); app.setField('#task-notes', '新的草稿，不要清除');
  assert.equal(app.get('#google-retry').href, previousURL);
  app.click('#google-retry'); app.page('pagehide'); app.page('pageshow');
  assert.equal(app.get('#task-input').value, '明早提醒我買早餐');
  assert.equal(app.get('#task-notes').value, '新的草稿，不要清除');
  assert.match(app.get('#app-status').textContent, /仍保留/);
  assertHistoryUntouched(app);
});

test('even a note-only edit or autofill without an input event survives a previous handoff return', () => {
  for (const fireEvent of [true, false]) {
    const app = harness();
    app.type('十分鐘後提醒我喝水'); app.submit(); app.runTimers(2500);
    if (fireEvent) app.setField('#task-notes', '不能清除');
    else app.get('#task-notes').value = '不能清除';
    app.page('pagehide'); app.page('pageshow');
    assert.equal(app.get('#task-notes').value, '不能清除');
  }
});

test('pagehide or pageshow alone cancels stale speech without accepting late results or restarting microphones', () => {
  for (const hideFirst of [true, false]) {
    const app = harness();
    app.type('手動保留文字'); const first = begin(app);
    if (hideFirst) app.page('pagehide');
    app.page('pageshow');
    assert.equal(app.control.speech.state, 'idle');
    assert.equal(app.instances.length, 1);
    const second = begin(app);
    first.onresult(result('過期結果')); first.onend();
    assert.equal(app.get('#task-input').value, '手動保留文字');
    second.onresult(result('明早提醒我買早餐')); second.onend();
    assert.equal(app.get('#task-input').value, '明早提醒我買早餐');
  }
});

test('unsupported or insecure speech still allows typed Google drafts without permission prompts', () => {
  for (const options of [{ supported: false }, { secure: false }]) {
    const app = harness(options);
    assert.equal(app.get('#voice-button').disabled, true);
    assert.equal(app.get('#reset-voice').disabled, true);
    if (options.secure === false) assert.match(app.get('#speech-status').textContent, /HTTPS/);
    app.type('十分鐘後提醒我喝水'); app.submit();
    assert.equal(app.navigations.length, 1);
    assert.equal(app.instances.length, 0);
    assertHistoryUntouched(app);
  }
});

test('clear next draft resets controls, manual scheduling and repeat without accessing historical data', () => {
  const app = harness();
  app.type('明早提醒我買早餐'); app.setField('#task-time', '2031-03-04T12:30');
  app.setField('#task-repeat', 'daily'); app.setField('#task-notes', '舊草稿');
  const first = begin(app); app.click('#clear-draft');
  assert.equal(first.aborts, 1);
  assert.equal(app.get('#task-input').value, '');
  assert.equal(app.get('#task-repeat').value, 'none');
  assert.equal(app.get('#task-time').value, '');
  assert.equal(app.get('#task-notes').value, '');
  const second = begin(app); second.onresult(result('十分鐘後提醒我喝水')); second.onend();
  app.submit();
  assert.equal(new URL(app.navigations[0]).searchParams.get('text'), '喝水');
  assertHistoryUntouched(app);
});

test('active HTML and module graph expose only the Google flow and never load a history store', () => {
  assert.match(html, /src="js\/google-app\.js"/);
  assert.doesNotMatch(html, /localStorage|indexedDB|sessionStorage|Apple|\.ics|task-destination|task-template|task-no-time|attachment-input|storage-mode|export-backup|task-sections/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|loadTasks|saveTasks|loadSettings|saveSettings|createReminderTracker|downloadICS|\bfetch\(|XMLHttpRequest|import\(/);
    for (const match of source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) visit(match[1]);
  }
  visit('google-app.js');
  assert.deepEqual([...visited].sort(), ['google-app.js', 'google-calendar.js', 'planner.js', 'speech-input.js', 'time-parser.js']);
});

test('Google URL contains a 30-minute prefilled event and notes/location without an invented calendar ID', () => {
  const start = '2030-01-02T00:00:00.000Z';
  const url = new URL(createGoogleCalendarDraftURL({ title: '喝水 & 休息', reminderAt: start, originalInput: '原始輸入', notes: '第一行\n第二行', location: '台北車站', repeat: 'weekly' }));
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), '喝水 & 休息');
  assert.equal(url.searchParams.get('dates'), '20300102T000000Z/20300102T003000Z');
  assert.equal(url.searchParams.get('location'), '台北車站');
  assert.match(url.searchParams.get('details'), /第一行\n第二行/);
  assert.match(url.searchParams.get('details'), /每週.*確認重複規則後儲存/);
  for (const key of ['calendarId', 'cid', 'src', 'recur', 'rrule']) assert.equal(url.searchParams.has(key), false);
});

test('Google URL rejects missing names and invalid times instead of silently creating all-day or now events', () => {
  for (const reminderAt of [null, '', 'invalid', '2030-02-30T00:00:00Z', '0000-01-01T00:00:00Z']) {
    assert.throws(() => createGoogleCalendarDraftURL({ title: '事件', reminderAt }));
  }
  assert.throws(() => createGoogleCalendarDraftURL({ title: '  ', reminderAt: '2030-01-02T00:00:00Z' }));
});

test('the Google form displays elapsed time and supports 120 seconds before a second and third recording', () => {
  const app = harness();
  assert.equal(app.get('#speech-timer').textContent, '00:00 / 02:00');
  for (const text of ['十分鐘後提醒我喝水', '明天早上八點提醒我買早餐', '半小時後提醒我出門']) {
    const recognition = begin(app);
    assert.equal(recognition.continuous, true);
    assert.equal(app.get('#speech-timer').textContent, '00:00 / 02:00');
    recognition.onresult(result(text));
    app.advanceRecording(75); app.runTimers(1000); app.runTimers(2000);
    assert.equal(app.get('#speech-timer').textContent, '01:15 / 02:00');
    assert.equal(app.control.speech.state, 'listening');
    assert.equal(app.get('#add-button').disabled, true);
    app.advanceRecording(45); app.runTimers(120_000);
    assert.equal(app.get('#speech-timer').textContent, '02:00 / 02:00');
    assert.equal(recognition.stops, 1);
    app.runTimers(2000);
    assert.equal(app.get('#add-button').disabled, false);
    assert.equal(app.get('#voice-button').disabled, false);
    app.submit(); app.page('pagehide'); app.page('pageshow');
  }
  assert.equal(app.instances.length, 3);
  assert.equal(app.navigations.length, 3);
  assertHistoryUntouched(app);
});

test('home-screen backgrounding without pagehide releases recording and foregrounding never starts the mic', () => {
  const app = harness();
  const first = begin(app);
  first.onresult(result('十分鐘後提醒我喝水'));
  app.visibility('hidden');
  assert.equal(first.aborts, 1);
  assert.equal(app.control.speech.state, 'idle');
  assert.equal(app.get('#voice-button').disabled, false);
  assert.equal(app.get('#task-input').value, '十分鐘後提醒我喝水');
  app.visibility('visible');
  assert.equal(app.instances.length, 1);
  const second = begin(app);
  first.onresult(result('不要覆蓋下一筆')); first.onend();
  second.onresult(result('明早提醒我買早餐')); second.onend();
  app.submit();
  assert.equal(new URL(app.navigations[0]).searchParams.get('text'), '買早餐');
  assertHistoryUntouched(app);
});
