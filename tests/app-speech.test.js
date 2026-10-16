import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseTaskInput } from '../js/time-parser.js';
import * as taskView from '../js/task-view.js';
import * as planner from '../js/planner.js';
import { SETTINGS_KEY, loadSettings, normalizeSettings, saveSettings } from '../js/settings-store.js';
import { STORAGE_KEY, classifyTasks, loadTasks, saveTasks } from '../js/task-store.js';
import * as recurrence from '../js/recurrence.js';
import { createReminderTracker, getOverdueTasks } from '../js/reminders.js';
import { setupSpeechInput } from '../js/speech-input.js';
import { setupTheme } from '../js/theme.js';
import * as destinations from '../js/destinations.js';
import { createGoogleCalendarUrl, createMapUrl } from '../js/calendar.js';
import { validateAttachment as validateAttachmentFile } from '../js/attachment-store.js';

// Exercise the actual App callback registration without a browser or microphone.
// Single-line imports are removed so collaborators can be supplied below.
const source = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function createHarness({
  supported = true, initialTasks = [], initialSettings = {}, storedTaskJSON, storedSettingsJSON, attachmentRecords = [],
  now = Date.now(), audio = false, notifications = false, settingsSaveFailure = false, taskSaveFailure = false,
  attachmentSave = async () => [], geolocation = false, navigationFailure = false, downloadFailure = false,
} = {}) {
  const nodes = new Map();
  const parsedInputs = [];
  const storageValues = new Map();
  const storageWrites = [];
  const calendarDownloads = [];
  const navigationCalls = [];
  const popupCalls = [];
  const locationRequests = [];
  const channelCalls = { audioContexts: 0, resumes: 0, tones: 0, notificationRequests: 0, notifications: [] };
  let clockTime = now;
  let rejectSettingsWrites = false;
  let rejectTaskWrites = false;
  const memoryStorage = {
    getItem: key => storageValues.get(key) ?? null,
    setItem(key, value) {
      if ((key === SETTINGS_KEY && rejectSettingsWrites) || (key === STORAGE_KEY && rejectTaskWrites)) {
        throw Object.assign(new Error('Synthetic storage failure'), { name: 'QuotaExceededError' });
      }
      storageValues.set(key, String(value)); storageWrites.push({ key, value: String(value) });
    },
  };
  assert.equal(saveTasks(initialTasks, memoryStorage).ok, true, 'Synthetic task fixtures must be valid');
  assert.equal(saveSettings(initialSettings, memoryStorage).ok, true);
  if (storedTaskJSON !== undefined) memoryStorage.setItem(STORAGE_KEY, storedTaskJSON);
  if (storedSettingsJSON !== undefined) memoryStorage.setItem(SETTINGS_KEY, storedSettingsJSON);
  rejectSettingsWrites = settingsSaveFailure;
  rejectTaskWrites = taskSaveFailure;
  const windowListeners = new Map();
  const timers = new Map();
  const intervals = new Map();
  const attachmentCalls = { list: 0, delete: [] };
  let nextTimerId = 0;
  let createdNodeCount = 0;
  let recognition;
  const recognitions = [];
  class HarnessInput {}
  class HarnessDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockTime])); }
    static now() { return clockTime; }
  }
  class HarnessAudioContext {
    constructor() {
      channelCalls.audioContexts += 1;
      this.state = 'suspended'; this.currentTime = 0; this.destination = {};
    }
    async resume() {
      channelCalls.resumes += 1;
      if (audio.resumeReject) throw new Error('Synthetic audio resume failure');
      this.state = 'running';
    }
    createOscillator() {
      if (audio.toneReject) throw new Error('Synthetic tone failure');
      return { frequency: { value: 0 }, connect() {}, disconnect() {},
        start() { channelCalls.tones += 1; }, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
  }
  class HarnessNotification {
    static permission = notifications.permission || 'default';
    static async requestPermission() {
      channelCalls.notificationRequests += 1;
      if (notifications.requestReject) throw new Error('Synthetic notification request failure');
      this.permission = notifications.result || 'granted';
      return this.permission;
    }
    constructor(title, options) {
      if (notifications.constructReject) throw new Error('Synthetic notification delivery failure');
      channelCalls.notifications.push({ title, options: JSON.parse(JSON.stringify(options)) });
    }
  }

  function descendants(node) {
    return node.children.flatMap(child => child && typeof child === 'object' ? [child, ...descendants(child)] : []);
  }

  function prepareEvent(node, event) {
    event.target ??= node;
    event.preventDefault ??= () => {};
    return event;
  }

  function getNode(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const listeners = new Map();
    const attributes = new Map();
    const classes = new Set();
    const node = {
      value: '', textContent: '', hidden: false, disabled: false, checked: false,
      dataset: {}, style: {}, children: [], parentNode: null, isConnected: true,
      classList: {
        add(...values) { values.forEach(value => classes.add(value)); },
        remove(...values) { values.forEach(value => classes.delete(value)); },
        contains(value) { return classes.has(value); },
        toggle(value, force) {
          const enabled = force ?? !classes.has(value);
          if (enabled) classes.add(value);
          else classes.delete(value);
          return enabled;
        },
      },
      addEventListener(name, listener) {
        const callbacks = listeners.get(name) ?? [];
        callbacks.push(listener);
        listeners.set(name, callbacks);
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(prepareEvent(node, event));
        return true;
      },
      async dispatchAsync(event) {
        await Promise.all((listeners.get(event.type) ?? []).map(listener => listener(prepareEvent(node, event))));
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      setCustomValidity(value) { node.validationMessage = value; },
      reportValidity() { return !node.validationMessage; },
      append(...children) {
        node.children.push(...children);
        for (const child of children) {
          if (child && typeof child === 'object') child.parentNode = node;
        }
      },
      appendChild(child) { node.append(child); return child; },
      prepend(...children) {
        node.children.unshift(...children);
        for (const child of children) {
          if (child && typeof child === 'object') child.parentNode = node;
        }
      },
      after(...children) {
        if (!node.parentNode) return;
        const parent = node.parentNode;
        parent.children.splice(parent.children.indexOf(node) + 1, 0, ...children);
        for (const child of children) {
          if (child && typeof child === 'object') child.parentNode = parent;
        }
      },
      replaceChildren(...children) {
        for (const child of node.children) {
          if (child && typeof child === 'object') child.parentNode = null;
        }
        node.children = [];
        node.append(...children);
      },
      remove() {
        if (node.parentNode) {
          node.parentNode.children = node.parentNode.children.filter(child => child !== node);
        }
        node.parentNode = null;
        node.isConnected = false;
      },
      showModal() { node.open = true; },
      close() { node.open = false; node.dispatchEvent({ type: 'close' }); },
      focus() {},
      scrollIntoView() {},
      matches(matchSelector) {
        if (matchSelector.includes(',')) return matchSelector.split(',').some(part => node.matches(part.trim()));
        if (matchSelector.startsWith('.')) return classes.has(matchSelector.slice(1));
        const dataMatch = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(matchSelector);
        if (dataMatch) {
          const key = dataMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return dataMatch[2] === undefined ? key in node.dataset : node.dataset[key] === dataMatch[2];
        }
        return node.tagName === matchSelector.toUpperCase();
      },
      closest(matchSelector) {
        let current = node;
        while (current) {
          if (current.matches(matchSelector)) return current;
          current = current.parentNode;
        }
        return null;
      },
      querySelector(childSelector) {
        const existing = descendants(node).find(child => child.matches(childSelector));
        if (existing) return existing;
        const child = getNode(`${selector} ${childSelector}`);
        node.append(child);
        return child;
      },
      querySelectorAll(childSelector) { return descendants(node).filter(child => child.matches(childSelector)); },
    };
    Object.defineProperty(node, 'className', {
      get: () => [...classes].join(' '),
      set(value) {
        classes.clear();
        String(value).split(/\s+/).filter(Boolean).forEach(item => classes.add(item));
      },
    });
    nodes.set(selector, node);
    return node;
  }

  function createTaskFragment() {
    const prefix = `template-clone-${++createdNodeCount}`;
    const fragment = getNode(prefix);
    function element(name, tag, className = '') {
      const node = getNode(`${prefix} ${name}`);
      node.tagName = tag.toUpperCase();
      node.className = className;
      if (tag === 'input') Object.setPrototypeOf(node, HarnessInput.prototype);
      return node;
    }
    const row = element('row', 'article', 'task-row');
    const content = element('content', 'div', 'task-content');
    const taskTime = element('task-time', 'p', 'task-time');
    taskTime.append(element('time', 'time'));
    const original = element('original', 'p', 'task-original');
    original.append(element('original-text', 'span', 'original-text'));
    const calendar = element('calendar', 'div', 'calendar-actions');
    calendar.append(element('google', 'a', 'google-button'), element('apple', 'button', 'apple-button'),
      element('calendar-note', 'p', 'field-hint calendar-export-note'));
    content.append(element('title', 'h3', 'task-title'), taskTime, original, calendar);
    const checkbox = element('checkbox', 'input');
    checkbox.type = 'checkbox';
    row.append(checkbox, content, element('delete', 'button', 'delete-button'));
    fragment.append(row);
    return fragment;
  }

  class Recognition {
    constructor() { recognition = this; recognitions.push(this); this.startCount = 0; this.stopCount = 0; }
    start() { this.startCount += 1; }
    stop() { this.stopCount += 1; }
  }

  function querySelectorAll(selector) {
    if (selector === 'select.task-category-select') {
      return [getNode('#task-category'), getNode('#edit-category')];
    }
    if (selector === 'select.task-repeat-select') {
      return [getNode('#task-repeat'), getNode('#edit-repeat')];
    }
    if (selector === '[data-view]') {
      return ['agenda', 'calendar', 'memo'].map(view => {
        const node = getNode(`[data-view="${view}"]`);
        node.dataset.view = view;
        return node;
      });
    }
    return [];
  }

  getNode('#category-filter').value = 'all';
  getNode('#include-completed').checked = true;
  getNode('#task-template').content = { cloneNode: createTaskFragment };
  const formControls = [
    ['#task-input', 'textarea'], ['#voice-button', 'button'], ['#task-destination', 'select'],
    ['#task-time', 'input'], ['#task-no-time', 'input'], ['#task-category', 'select'],
    ['#task-repeat', 'select'], ['#task-notes', 'textarea'], ['#task-location', 'input'],
    ['#location-button', 'button'], ['#attachment-input', 'input'], ['#add-button', 'button'],
  ].map(([selector, tag]) => {
    const control = getNode(selector); control.tagName = tag.toUpperCase();
    if (tag === 'input') Object.setPrototypeOf(control, HarnessInput.prototype);
    return control;
  });
  getNode('#task-form').elements = formControls;
  getNode('#task-form').append(...formControls);
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };

  const context = {
    ...taskView,
    ...planner,
    ...recurrence,
    ...destinations,
    setupSpeechInput: options => setupSpeechInput({ ...options, windowObject: context.window }),
    setupTheme: options => setupTheme({ ...options, root: context.document.documentElement, storage: memoryStorage, media }),
    createNextOccurrence: (task, options) => recurrence.createNextOccurrence(task, { now: new Date(clockTime), ...options }),
    createReminderTracker: () => createReminderTracker({ storage: memoryStorage, now: () => clockTime }),
    getOverdueTasks: (tasks, timestamp = clockTime) => getOverdueTasks(tasks, timestamp),
    Date: HarnessDate, Intl, HTMLInputElement: HarnessInput,
    Event: class { constructor(type, options = {}) { this.type = type; this.bubbles = Boolean(options.bubbles); } },
    window: {
      addEventListener(name, listener) {
        const listeners = windowListeners.get(name) ?? [];
        listeners.push(listener);
        windowListeners.set(name, listeners);
      },
      isSecureContext: true,
      setTimeout: (callback, delay) => context.setTimeout(callback, delay),
      clearTimeout: id => context.clearTimeout(id),
      location: { assign(url) {
        navigationCalls.push({ url, savedTasks: JSON.parse(memoryStorage.getItem(STORAGE_KEY)) });
        if (navigationFailure) throw new Error('Synthetic navigation failure');
      } },
      open(...args) { popupCalls.push(args); throw new Error('Unexpected popup'); },
      matchMedia: () => media,
      ...(audio ? { AudioContext: HarnessAudioContext } : {}),
      ...(notifications ? { Notification: HarnessNotification } : {}),
      ...(supported ? { SpeechRecognition: Recognition } : {}),
    },
    navigator: {
      ...(geolocation ? { geolocation: {
        getCurrentPosition(success, error, options) { locationRequests.push({ success, error, options }); },
      } } : {}),
    },
    document: {
      querySelector: getNode, querySelectorAll, addEventListener() {},
      documentElement: getNode('document-root'),
      createElement(tag) {
        const node = getNode(`created-${++createdNodeCount}`);
        node.tagName = tag.toUpperCase();
        return node;
      },
      createDocumentFragment: () => getNode(`fragment-${++createdNodeCount}`),
    },
    setInterval(callback, delay) {
      const id = ++nextTimerId;
      intervals.set(id, { callback, delay });
      return id;
    },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    parseTaskInput(input) { parsedInputs.push(input); return parseTaskInput(input); },
    createGoogleCalendarUrl, createMapUrl,
    downloadICS(task, options) {
      calendarDownloads.push(JSON.parse(JSON.stringify({ task, options, savedTasks: JSON.parse(memoryStorage.getItem(STORAGE_KEY)) })));
      if (downloadFailure) throw new Error('Synthetic download failure');
    },
    STORAGE_KEY, SETTINGS_KEY, normalizeSettings,
    loadTasks: () => loadTasks(memoryStorage),
    saveTasks: tasks => saveTasks(tasks, memoryStorage),
    classifyTasks,
    loadSettings: () => loadSettings(memoryStorage),
    saveSettings: settings => saveSettings(settings, memoryStorage),
    deleteAttachments: async ids => { attachmentCalls.delete.push(Array.from(ids)); },
    getAttachment: async () => null,
    listAttachments: async () => { attachmentCalls.list += 1; return attachmentRecords; },
    saveAttachmentBatch: attachmentSave,
    sanitizeAttachmentName: name => String(name),
    validateAttachment: validateAttachmentFile,
    MAX_ATTACHMENTS_PER_TASK: 3,
  };

  context.window.Event = context.Event;
  vm.runInNewContext(source, context, { filename: 'js/app.js' });
  function getTaskRow(id) {
    for (const group of ['overdue', 'today', 'pending', 'completed']) {
      const rows = getNode(`[data-group="${group}"]`).querySelector('.task-list').children;
      for (const fragment of rows) {
        const row = fragment.querySelector('.task-row');
        if (row.dataset.id === id) return row;
      }
    }
    return null;
  }
  return {
    getNode, getTaskRow, get recognition() { return recognition; }, recognitions, parsedInputs, attachmentCalls, channelCalls, calendarDownloads, navigationCalls, popupCalls, locationRequests,
    getSavedTasks: () => JSON.parse(memoryStorage.getItem(STORAGE_KEY)),
    getSavedSettings: () => JSON.parse(memoryStorage.getItem(SETTINGS_KEY)),
    getTaskWriteCount: () => storageWrites.filter(write => write.key === STORAGE_KEY).length,
    getSettingsWriteCount: () => storageWrites.filter(write => write.key === SETTINGS_KEY).length,
    getStoredJSON: () => memoryStorage.getItem(STORAGE_KEY),
    getStoredSettingsJSON: () => memoryStorage.getItem(SETTINGS_KEY),
    rejectTaskWrites(value) { rejectTaskWrites = value; },
    rejectDownloads(value) { downloadFailure = value; },
    updateTasksFromOtherTab(nextTasks, { notify = true } = {}) {
      assert.equal(saveTasks(nextTasks, memoryStorage).ok, true);
      if (notify) for (const listener of windowListeners.get('storage') ?? []) listener({ key: STORAGE_KEY });
    },
    updateTaskJSONFromOtherTab(raw) {
      memoryStorage.setItem(STORAGE_KEY, raw);
      for (const listener of windowListeners.get('storage') ?? []) listener({ key: STORAGE_KEY });
    },
    setNow(timestamp) { assert.ok(Number.isFinite(timestamp)); clockTime = timestamp; },
    async runIntervals(delay) {
      for (const interval of intervals.values()) if (interval.delay === delay) await interval.callback();
    },
    pendingTimers: delay => [...timers.values()].filter(timer => timer.delay === delay).length,
    async runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay || !timers.has(id)) continue;
        timers.delete(id);
        await timer.callback();
      }
    },
  };
}

function finalResult(transcript) {
  return { results: [Object.assign([{ transcript }], { isFinal: true })] };
}

test('Unsupported browsers show the exact fallback message and disable voice input', () => {
  const { getNode } = createHarness({ supported: false });
  assert.equal(getNode('#voice-button').disabled, true);
  assert.equal(getNode('#speech-status').textContent, '此瀏覽器不支援語音輸入，請改用打字');
  assert.equal(getNode('#add-button').disabled, false);
});

test('Starting and ending recognition restores the voice and add button states', () => {
  const app = createHarness();
  const { getNode } = app;
  assert.equal(app.recognitions.length, 0, 'Recognition is only constructed after a user click');
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  const recognition = app.recognition;
  assert.equal(recognition.lang, 'zh-TW');
  assert.equal(recognition.startCount, 1);
  assert.equal(getNode('#voice-label').textContent, '開啟中，點擊取消');
  assert.equal(getNode('#voice-button').getAttribute('aria-pressed'), 'true');
  assert.equal(getNode('#add-button').disabled, true);

  recognition.onstart();
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  assert.equal(recognition.stopCount, 1);
  recognition.onend();
  assert.equal(getNode('#voice-label').textContent, '語音輸入');
  assert.equal(getNode('#voice-button').getAttribute('aria-pressed'), 'false');
  assert.equal(getNode('#add-button').disabled, false);
});

test('Final recognition text enters the input and triggers the shared time parser', () => {
  const app = createHarness();
  const { getNode, parsedInputs } = app;
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  const recognition = app.recognition;
  recognition.onresult(finalResult('十分鐘後提醒我喝水'));
  assert.equal(getNode('#task-input').value, '十分鐘後提醒我喝水');
  assert.ok(parsedInputs.includes('十分鐘後提醒我喝水'));
  assert.equal(getNode('#preview-title').textContent, '喝水');
  assert.notEqual(getNode('#preview-time').textContent, '未設定');
  recognition.onend();
  assert.equal(getNode('#speech-status').textContent, '辨識完成，請確認任務與時間後新增。');
});

test('Manual corrections after the final result survive recognition ending', () => {
  const app = createHarness();
  const { getNode } = app;
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  const recognition = app.recognition;
  recognition.onresult(finalResult('明早提醒我買早餐'));
  getNode('#task-input').value = '明早提醒我買午餐';
  getNode('#task-input').dispatchEvent({ type: 'input' });
  assert.equal(getNode('#preview-title').textContent, '買午餐');

  recognition.onend();
  assert.equal(getNode('#task-input').value, '明早提醒我買午餐');
  assert.equal(getNode('#preview-title').textContent, '買午餐');
});

test('IME composition delays parsing until the final text is committed', () => {
  const { getNode, parsedInputs } = createHarness();
  const input = getNode('#task-input');
  input.dispatchEvent({ type: 'compositionstart' });
  input.value = '明天早上八點提醒我買早餐';
  input.dispatchEvent({ type: 'input' });
  assert.deepEqual(parsedInputs, []);

  input.dispatchEvent({ type: 'compositionend' });
  assert.deepEqual(parsedInputs, ['明天早上八點提醒我買早餐']);
  assert.equal(getNode('#preview-title').textContent, '買早餐');
  assert.notEqual(getNode('#preview-time').textContent, '未設定');
});

test('Network errors restore controls and their message remains after onend', () => {
  const app = createHarness();
  const { getNode } = app;
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  const recognition = app.recognition;
  recognition.onerror({ error: 'network' });
  const expected = '語音辨識服務無法連線，請檢查網路或改用打字。';
  assert.equal(getNode('#speech-status').textContent, expected);
  assert.equal(getNode('#voice-label').textContent, '語音輸入');
  assert.equal(getNode('#add-button').disabled, false);
  recognition.onend();
  assert.equal(getNode('#speech-status').textContent, expected);
});

function syntheticTask(overrides = {}) {
  return {
    id: 'synthetic-task', title: '企劃會議', originalInput: '明天早上八點提醒我企劃會議',
    reminderAt: new Date(new Date().getFullYear() + 1, 0, 5, 8, 0, 31, 345).toISOString(),
    completed: false, createdAt: '2026-01-01T00:00:00.000Z', category: 'work', notes: '',
    location: '', locationAddress: '', locationLat: null, locationLng: null, attachments: [],
    ...overrides,
  };
}

function editThroughRegisteredCallbacks(harness, id, fields) {
  const row = harness.getTaskRow(id);
  assert.ok(row, 'The task must be visible before opening its editor');
  harness.getNode('#task-sections').dispatchEvent({ type: 'click', target: row.querySelector('.edit-button') });
  assert.equal(harness.getNode('#edit-dialog').open, true);
  for (const [field, value] of Object.entries(fields)) harness.getNode(`#edit-${field}`).value = value;
  harness.getNode('#edit-form').dispatchEvent({ type: 'submit' });
  assert.equal(harness.getNode('#edit-dialog').open, false, 'Successful edits close the dialog');
}

test('Editing preserves task identity and attachments, and unchanged times keep seconds', () => {
  const original = syntheticTask({
    completed: true, location: '公司', locationAddress: '台北市測試地址', locationLat: 25, locationLng: 121,
    attachments: [{ id: 'synthetic-attachment', name: '議程.pdf', type: 'application/pdf', size: 120, kind: 'file', createdAt: '2026-01-01T00:00:00.000Z' }],
  });
  const harness = createHarness({ initialTasks: [original] });
  editThroughRegisteredCallbacks(harness, original.id, { notes: '只修改備註，保留原時間精度' });
  assert.equal(harness.getSavedTasks()[0].reminderAt, original.reminderAt);

  const year = new Date().getFullYear() + 1;
  editThroughRegisteredCallbacks(harness, original.id, {
    title: '  更新會議  ', time: `${year}-03-05T15:30`, category: 'health', notes: '  帶報告\n準備附件  ',
  });
  const edited = harness.getSavedTasks()[0];
  assert.equal(edited.title, '更新會議');
  assert.equal(edited.reminderAt, new Date(year, 2, 5, 15, 30).toISOString());
  assert.equal(edited.category, 'health');
  assert.equal(edited.notes, '帶報告\n準備附件');
  for (const field of ['id', 'originalInput', 'completed', 'createdAt', 'location', 'locationAddress', 'locationLat', 'locationLng', 'attachments']) {
    assert.deepEqual(edited[field], original[field], `Editing must preserve ${field}`);
  }
  assert.ok(Number.isFinite(new Date(edited.updatedAt).getTime()));
});

test('Scheduling a memo opens its calendar date and updates the visible task group', () => {
  const memo = syntheticTask({ id: 'memo', title: '安排健檢', reminderAt: null, category: 'health' });
  const harness = createHarness({ initialTasks: [memo] });
  harness.getNode('[data-view="memo"]').dispatchEvent({ type: 'click' });
  assert.equal(harness.getNode('#view-heading').textContent, '未定時間的備忘');

  const year = new Date().getFullYear() + 1;
  editThroughRegisteredCallbacks(harness, memo.id, { time: `${year}-11-19T09:00` });
  assert.equal(harness.getNode('[data-view="calendar"]').getAttribute('aria-pressed'), 'true');
  assert.equal(harness.getNode('[data-view="memo"]').getAttribute('aria-pressed'), 'false');
  assert.equal(harness.getNode('#view-heading').textContent, `${year}-11-19 的行程`);
  assert.equal(harness.getNode('#month-label').textContent, `${year} 年 11 月`);
  assert.equal(String(harness.getNode('[data-group="pending"]').querySelector('.section-count').textContent), '1');
  const cells = harness.getNode('#month-grid').children;
  assert.equal(cells.length, 42);
  const selected = cells.find(cell => cell.dataset.date === `${year}-11-19`);
  assert.equal(selected.getAttribute('aria-pressed'), 'true');
  assert.equal(selected.getAttribute('aria-label'), `${year}-11-19，1 件待完成行程`);
  assert.equal(harness.getSavedTasks()[0].id, memo.id);
});

test('Search, category, and completion filters update counts without rewriting stored tasks', () => {
  const harness = createHarness({ initialTasks: [
    syntheticTask({ id: 'work' }),
    syntheticTask({ id: 'life', title: '買早餐', category: 'life', location: '會議中心' }),
    syntheticTask({ id: 'completed', title: '已完成會議', completed: true }),
    syntheticTask({ id: 'memo', title: '備忘', originalInput: '整理備忘', reminderAt: null }),
  ] });
  const originalJSON = harness.getStoredJSON();
  assert.equal(harness.getNode('#task-summary').textContent, '4 筆 · 3 件待完成');

  harness.getNode('#search-input').value = '會議';
  harness.getNode('#search-input').dispatchEvent({ type: 'input' });
  assert.equal(harness.getNode('#task-summary').textContent, '3 筆 · 3 件待完成');
  harness.getNode('#category-filter').value = 'work';
  harness.getNode('#category-filter').dispatchEvent({ type: 'change' });
  assert.equal(harness.getNode('#task-summary').textContent, '2 筆 · 3 件待完成');
  harness.getNode('#include-completed').checked = false;
  harness.getNode('#include-completed').dispatchEvent({ type: 'change' });
  assert.equal(harness.getNode('#task-summary').textContent, '1 筆 · 3 件待完成');
  assert.equal(harness.getNode('[data-group="completed"]').hidden, true);

  harness.getNode('#search-input').value = '';
  harness.getNode('#search-input').dispatchEvent({ type: 'input' });
  assert.equal(harness.getNode('#task-summary').textContent, '2 筆 · 3 件待完成');
  assert.equal(harness.getStoredJSON(), originalJSON);
});

test('Calendar callbacks render 42 unique dates and navigate across December and January', () => {
  const today = new Date();
  const fixtureDate = new Date(today.getFullYear(), today.getMonth(), 20, 8).toISOString();
  const harness = createHarness({ initialTasks: [
    syntheticTask({ id: 'pending', reminderAt: fixtureDate }),
    syntheticTask({ id: 'completed', reminderAt: fixtureDate, completed: true }),
  ] });
  harness.getNode('[data-view="calendar"]').dispatchEvent({ type: 'click' });
  let cells = harness.getNode('#month-grid').children;
  assert.equal(cells.length, 42);
  assert.equal(new Set(cells.map(cell => cell.dataset.date)).size, 42);
  const fixtureKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-20`;
  assert.equal(cells.find(cell => cell.dataset.date === fixtureKey).getAttribute('aria-label'), `${fixtureKey}，1 件待完成行程`);

  for (let month = today.getMonth(); month < 11; month += 1) harness.getNode('#next-month').dispatchEvent({ type: 'click' });
  assert.equal(harness.getNode('#month-label').textContent, `${today.getFullYear()} 年 12 月`);
  harness.getNode('#next-month').dispatchEvent({ type: 'click' });
  assert.equal(harness.getNode('#month-label').textContent, `${today.getFullYear() + 1} 年 1 月`);
  assert.equal(harness.getNode('#view-heading').textContent, `${today.getFullYear() + 1}-01-01 的行程`);
  harness.getNode('#previous-month').dispatchEvent({ type: 'click' });
  assert.equal(harness.getNode('#month-label').textContent, `${today.getFullYear()} 年 12 月`);
  cells = harness.getNode('#month-grid').children;
  assert.equal(cells.length, 42);
  assert.equal(new Set(cells.map(cell => cell.dataset.date)).size, 42);
});

test('Creation saves manual-time and memo overrides with their selected categories and notes', async () => {
  const harness = createHarness();
  const year = new Date().getFullYear() + 1;
  harness.getNode('#task-input').value = '十分鐘後提醒我喝水';
  harness.getNode('#task-time').value = `${year}-02-06T10:15`;
  harness.getNode('#task-category').value = 'health';
  harness.getNode('#task-notes').value = '  攜帶水壺  ';
  await harness.getNode('#task-form').dispatchAsync({ type: 'submit' });
  let saved = harness.getSavedTasks();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, '喝水');
  assert.equal(saved[0].reminderAt, new Date(year, 1, 6, 10, 15).toISOString());
  assert.equal(saved[0].category, 'health');
  assert.equal(saved[0].notes, '攜帶水壺');
  assert.equal(harness.getNode('#task-time').value, '');
  assert.equal(harness.getNode('#task-category').value, 'other');

  harness.getNode('#task-input').value = '明天早上八點提醒我買早餐';
  harness.getNode('#task-no-time').checked = true;
  harness.getNode('#task-no-time').dispatchEvent({ type: 'change' });
  assert.equal(harness.getNode('#task-time').disabled, true);
  harness.getNode('#task-category').value = 'life';
  harness.getNode('#task-notes').value = '想好再安排時間';
  await harness.getNode('#task-form').dispatchAsync({ type: 'submit' });
  saved = harness.getSavedTasks();
  assert.equal(saved.length, 2);
  assert.equal(saved[1].title, '買早餐');
  assert.equal(saved[1].reminderAt, null);
  assert.equal(saved[1].category, 'life');
  assert.equal(saved[1].notes, '想好再安排時間');
  assert.equal(harness.getNode('#task-no-time').checked, false);
  assert.equal(harness.getNode('#task-time').disabled, false);
});

test('An editor cannot overwrite a newer same-task update received from another tab', () => {
  const original = syntheticTask();
  const harness = createHarness({ initialTasks: [original] });
  const row = harness.getTaskRow(original.id);
  harness.getNode('#task-sections').dispatchEvent({ type: 'click', target: row.querySelector('.edit-button') });
  harness.getNode('#edit-title').value = '此分頁尚未儲存的舊草稿';

  harness.updateTasksFromOtherTab([{ ...original, title: '另一分頁已更新', notes: '保留較新的內容', updatedAt: new Date().toISOString() }]);
  const newerJSON = harness.getStoredJSON();
  harness.getNode('#edit-form').dispatchEvent({ type: 'submit' });

  assert.equal(harness.getStoredJSON(), newerJSON);
  assert.equal(harness.getSavedTasks()[0].title, '另一分頁已更新');
  assert.equal(harness.getNode('#edit-dialog').open, false);
  assert.equal(harness.getNode('#notification-text').textContent, '這筆任務已在其他分頁更新，請重新開啟編輯，避免覆寫。');
});

test('Unreadable task JSON disables attachment cleanup and its handler cannot list or delete files', async () => {
  const corruptedJSON = '{synthetic-invalid-json';
  const harness = createHarness({
    storedTaskJSON: corruptedJSON,
    attachmentRecords: [{ id: 'potentially-referenced-attachment' }],
  });
  assert.equal(harness.getNode('#cleanup-attachments').disabled, true);
  assert.equal(harness.getNode('#add-button').disabled, true);
  // Invoke the registered handler directly as well as checking the disabled UI.
  await harness.getNode('#cleanup-attachments').dispatchAsync({ type: 'click' });
  assert.equal(harness.attachmentCalls.list, 0);
  assert.deepEqual(harness.attachmentCalls.delete, []);
  assert.equal(harness.getStoredJSON(), corruptedJSON);
  assert.equal(harness.getNode('#notification-text').textContent, '任務資料無法完整讀取，已停用附件清理，避免刪除仍被使用的檔案。');
});

test('Delayed deletion cleanup preserves attachments restored by another tab before the timeout', async () => {
  const task = syntheticTask({
    attachments: [{ id: 'restored-attachment', name: '待保留.pdf', type: 'application/pdf', size: 120, kind: 'file', createdAt: '2026-01-01T00:00:00.000Z' }],
  });
  const harness = createHarness({ initialTasks: [task] });
  const row = harness.getTaskRow(task.id);
  harness.getNode('#task-sections').dispatchEvent({ type: 'click', target: row.querySelector('.delete-button') });
  assert.equal(harness.getSavedTasks().length, 0);
  assert.equal(harness.pendingTimers(15000), 2, 'Both delayed attachment cleanup and notification expiry are scheduled');

  harness.updateTasksFromOtherTab([task]);
  assert.equal(harness.getNode('#undo-button').hidden, true);
  await harness.runTimers(15000);

  assert.equal(harness.pendingTimers(15000), 0, 'The pending cleanup callback really ran');
  assert.deepEqual(harness.attachmentCalls.delete, []);
  assert.equal(harness.getSavedTasks()[0].attachments[0].id, 'restored-attachment');
  assert.ok(harness.getTaskRow(task.id));
});

test('Week view renders seven dates and previous/next callbacks navigate whole weeks', () => {
  const clock = new Date(2031, 11, 30, 12).getTime();
  const harness = createHarness({ now: clock });
  harness.getNode('[data-view="calendar"]').dispatchEvent({ type: 'click' });
  harness.getNode('#calendar-mode').value = 'week';
  harness.getNode('#calendar-mode').dispatchEvent({ type: 'change' });
  const initial = harness.getNode('#month-grid').children.map(cell => cell.dataset.date);
  assert.equal(initial.length, 7);
  assert.equal(new Set(initial).size, 7);
  assert.equal(new Date(`${initial[0]}T12:00:00`).getDay(), 1);
  assert.equal(new Date(`${initial[6]}T12:00:00`).getDay(), 0);
  assert.equal(harness.getNode('#planner-panel').getAttribute('aria-label'), '週曆');
  assert.equal(harness.getNode('#next-month').getAttribute('aria-label'), '下一週');
  harness.getNode('#next-month').dispatchEvent({ type: 'click' });
  const next = harness.getNode('#month-grid').children.map(cell => cell.dataset.date);
  assert.equal(next.length, 7);
  const first = new Date(`${initial[0]}T12:00:00`);
  first.setDate(first.getDate() + 7);
  assert.equal(next[0], `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(first.getDate()).padStart(2, '0')}`);
  harness.getNode('#previous-month').dispatchEvent({ type: 'click' });
  assert.deepEqual(harness.getNode('#month-grid').children.map(cell => cell.dataset.date), initial);
});

test('A repeating task requires a time before creation can save its series', async () => {
  const harness = createHarness();
  harness.getNode('#task-input').value = '買早餐';
  harness.getNode('#task-repeat').value = 'daily';
  await harness.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.deepEqual(harness.getSavedTasks(), []);
  assert.equal(harness.getNode('#notification-text').textContent, '重複任務需要提醒時間；請填入時間或改為不重複。');
  const year = new Date().getFullYear() + 1;
  harness.getNode('#task-time').value = `${year}-01-05T08:00`;
  await harness.getNode('#task-form').dispatchAsync({ type: 'submit' });
  const saved = harness.getSavedTasks();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].repeat, 'daily');
  assert.equal(saved[0].seriesId, saved[0].id);
  assert.equal(saved[0].reminderAt, new Date(year, 0, 5, 8).toISOString());
  assert.equal(harness.getNode('#task-repeat').value, 'none');
});

function setCompletionThroughCallback(harness, id, completed) {
  const row = harness.getTaskRow(id);
  assert.ok(row, 'The task must be visible to change completion');
  const checkbox = row.querySelector('input');
  checkbox.checked = completed;
  harness.getNode('#task-sections').dispatchEvent({ type: 'change', target: checkbox });
}

test('Completing a repeat saves parent and next occurrence atomically and never creates a second child', () => {
  const parent = syntheticTask({ id: 'repeat-parent', repeat: 'daily', seriesId: 'repeat-parent', notes: '保留此備註',
    destination: { id: 'apple', provider: 'apple', name: 'Apple 行事曆匯出', source: 'builtin' } });
  const harness = createHarness({ initialTasks: [parent] });
  const beforeWrites = harness.getTaskWriteCount();
  setCompletionThroughCallback(harness, parent.id, true);
  const saved = harness.getSavedTasks();
  assert.equal(harness.getTaskWriteCount(), beforeWrites + 1);
  assert.equal(saved.length, 2);
  assert.equal(saved.find(task => task.id === parent.id).completed, true);
  const child = saved.find(task => task.repeatParentId === parent.id);
  assert.ok(child);
  assert.equal(child.completed, false);
  assert.equal(child.seriesId, parent.seriesId);
  assert.equal(child.notes, parent.notes);
  assert.deepEqual(child.destination, parent.destination);
  const expected = new Date(parent.reminderAt);
  expected.setDate(expected.getDate() + 1);
  assert.equal(child.reminderAt, expected.toISOString());
  setCompletionThroughCallback(harness, parent.id, false);
  setCompletionThroughCallback(harness, parent.id, true);
  const afterRecompletion = harness.getSavedTasks();
  assert.equal(afterRecompletion.length, 2);
  assert.deepEqual(afterRecompletion.find(task => task.id === child.id), child);
});

test('Repeat editing keeps untouched time precision, can stop repeating, and rejects an untimed repeat', () => {
  const parent = syntheticTask({ repeat: 'monthly', repeatDay: 31, seriesId: 'monthly-series' });
  const harness = createHarness({ initialTasks: [parent] });
  editThroughRegisteredCallbacks(harness, parent.id, { notes: '保留原時間與每月日期' });
  assert.equal(harness.getSavedTasks()[0].reminderAt, parent.reminderAt);
  assert.equal(harness.getSavedTasks()[0].repeatDay, 31);

  const row = harness.getTaskRow(parent.id);
  harness.getNode('#task-sections').dispatchEvent({ type: 'click', target: row.querySelector('.edit-button') });
  const beforeInvalidEdit = harness.getStoredJSON();
  harness.getNode('#edit-time').value = '';
  harness.getNode('#edit-form').dispatchEvent({ type: 'submit' });
  assert.equal(harness.getNode('#edit-dialog').open, true);
  assert.equal(harness.getStoredJSON(), beforeInvalidEdit);
  assert.equal(harness.getNode('#edit-time').validationMessage, '重複任務需要提醒時間；請填入時間或改為不重複。');

  harness.getNode('#edit-repeat').value = 'none';
  harness.getNode('#edit-repeat').dispatchEvent({ type: 'change' });
  harness.getNode('#edit-form').dispatchEvent({ type: 'submit' });
  const stopped = harness.getSavedTasks()[0];
  assert.equal(stopped.repeat, 'none');
  assert.equal(stopped.reminderAt, null);
  assert.equal('repeatDay' in stopped, false);
  assert.equal('seriesId' in stopped, false);
});

test('Editing a February monthly occurrence time retains its original day-31 anchor', () => {
  const parent = syntheticTask({
    id: 'february-child', reminderAt: new Date(2030, 1, 28, 9, 0, 31, 345).toISOString(),
    repeat: 'monthly', repeatDay: 31, seriesId: 'monthly-series', repeatParentId: 'earlier-parent',
  });
  const harness = createHarness({ initialTasks: [parent] });
  editThroughRegisteredCallbacks(harness, parent.id, { time: '2030-02-28T10:00' });
  assert.equal(harness.getSavedTasks()[0].repeatDay, 31);
  setCompletionThroughCallback(harness, parent.id, true);
  const next = harness.getSavedTasks().find(task => task.repeatParentId === parent.id);
  assert.equal(next.reminderAt, new Date(2030, 2, 31, 10).toISOString());
});

test('Apple export forwards the current selected alarm minutes, including zero and none', () => {
  const task = syntheticTask({ destination: { id: 'apple', provider: 'apple', name: 'Apple 行事曆匯出', source: 'builtin' } });
  const harness = createHarness({ initialTasks: [task], initialSettings: { calendarTarget: 'apple', calendarAlarmMinutes: 30 } });
  function exportCurrentTask() {
    const button = harness.getTaskRow(task.id).querySelector('.apple-button');
    assert.equal(button.hidden, false);
    harness.getNode('#task-sections').dispatchEvent({ type: 'click', target: button });
  }
  exportCurrentTask();
  assert.equal(harness.calendarDownloads[0].options.alarmMinutes, 30);
  harness.getNode('#calendar-alarm').value = '0';
  harness.getNode('#calendar-alarm').dispatchEvent({ type: 'change' });
  exportCurrentTask();
  assert.equal(harness.calendarDownloads[1].options.alarmMinutes, 0);
  harness.getNode('#calendar-alarm').value = 'none';
  harness.getNode('#calendar-alarm').dispatchEvent({ type: 'change' });
  exportCurrentTask();
  assert.equal(harness.calendarDownloads[2].options.alarmMinutes, null);
  assert.equal(harness.calendarDownloads[2].task.id, task.id);
});

test('Loading remembered channel settings never requests permission or creates an audio context', async () => {
  const clock = Date.parse('2026-10-13T08:00:00.000Z');
  const overdue = syntheticTask({ reminderAt: new Date(clock - 60_000).toISOString() });
  const harness = createHarness({
    now: clock, initialTasks: [overdue], initialSettings: { soundEnabled: true, systemNotifications: true },
    audio: true, notifications: { permission: 'granted' },
  });
  await harness.runIntervals(5000);
  assert.equal(harness.channelCalls.audioContexts, 0);
  assert.equal(harness.channelCalls.notificationRequests, 0);
  assert.equal(harness.channelCalls.tones, 0);
  assert.deepEqual(harness.channelCalls.notifications, []);
  assert.equal(harness.getNode('#due-alert').hidden, false);
});

test('Explicit channel activation and newly due timers produce one alert and keep the page banner', async () => {
  const clock = Date.parse('2026-10-13T08:00:00.000Z');
  const upcoming = syntheticTask({ title: '測試喝水', reminderAt: new Date(clock + 60_000).toISOString() });
  const harness = createHarness({ now: clock, initialTasks: [upcoming], audio: true, notifications: true });
  assert.equal(harness.channelCalls.audioContexts, 0);
  assert.equal(harness.channelCalls.notificationRequests, 0);
  await harness.getNode('#enable-sound').dispatchAsync({ type: 'click' });
  await harness.getNode('#enable-system-notifications').dispatchAsync({ type: 'click' });
  assert.equal(harness.channelCalls.audioContexts, 1);
  assert.equal(harness.channelCalls.tones, 1);
  assert.equal(harness.channelCalls.notificationRequests, 1);
  assert.equal(harness.channelCalls.notifications.length, 1);
  assert.equal(harness.getSavedSettings().soundEnabled, true);
  assert.equal(harness.getSavedSettings().systemNotifications, true);

  harness.setNow(clock + 60_000);
  await harness.runIntervals(5000);
  assert.equal(harness.channelCalls.tones, 2);
  assert.equal(harness.channelCalls.notifications.length, 2);
  assert.equal(harness.channelCalls.notifications[1].title, '待辦任務已到期');
  assert.equal(harness.channelCalls.notifications[1].options.body, '測試喝水');
  assert.equal(harness.getNode('#due-alert').hidden, false);
  assert.equal(harness.getNode('#due-alert-text').textContent, '1 件任務已到期');
  await harness.runIntervals(5000);
  await harness.runIntervals(15000);
  assert.equal(harness.channelCalls.tones, 2);
  assert.equal(harness.channelCalls.notifications.length, 2);
  setCompletionThroughCallback(harness, upcoming.id, true);
  assert.equal(harness.getNode('#due-alert').hidden, true);
});

test('Sound activation failures and denied notification permission retain page-alert fallback', async () => {
  const clock = Date.parse('2026-10-13T08:00:00.000Z');
  const upcoming = syntheticTask({ reminderAt: new Date(clock + 60_000).toISOString() });
  const harness = createHarness({
    now: clock, initialTasks: [upcoming], audio: { resumeReject: true }, notifications: { result: 'denied' },
  });
  await harness.getNode('#enable-sound').dispatchAsync({ type: 'click' });
  assert.equal(harness.getSavedSettings().soundEnabled, false);
  assert.equal(harness.channelCalls.tones, 0);
  assert.match(harness.getNode('#reminder-status').textContent, /無法啟用響鈴/);
  await harness.getNode('#enable-system-notifications').dispatchAsync({ type: 'click' });
  assert.equal(harness.getSavedSettings().systemNotifications, false);
  assert.equal(harness.getNode('#enable-system-notifications').disabled, true);
  assert.equal(harness.channelCalls.notificationRequests, 1);
  assert.deepEqual(harness.channelCalls.notifications, []);
  harness.setNow(clock + 60_000);
  await harness.runIntervals(5000);
  assert.equal(harness.getNode('#due-alert').hidden, false);
  assert.equal(harness.channelCalls.tones, 0);
  assert.match(harness.getNode('#reminder-status').textContent, /請使用頁面提示或行事曆提醒/);
});

test('Unreadable tasks prevent automatic sounds and notifications after explicit channel activation', async () => {
  const clock = Date.parse('2026-10-13T08:00:00.000Z');
  const upcoming = syntheticTask({ reminderAt: new Date(clock + 60_000).toISOString() });
  const harness = createHarness({ now: clock, initialTasks: [upcoming], audio: true, notifications: true });
  await harness.getNode('#enable-sound').dispatchAsync({ type: 'click' });
  await harness.getNode('#enable-system-notifications').dispatchAsync({ type: 'click' });
  // A readable upcoming task plus a damaged sibling enters read-only mode.
  // Without the guard, that still-readable task would become due and alert.
  harness.updateTaskJSONFromOtherTab(JSON.stringify([upcoming, { id: 'synthetic-invalid-sibling' }]));
  harness.setNow(clock + 60_000);
  await harness.runIntervals(5000);
  await harness.runIntervals(15000);
  assert.equal(harness.channelCalls.tones, 1, 'Only the explicitly requested test tone may have played');
  assert.equal(harness.channelCalls.notifications.length, 1, 'Only the explicitly requested test notification may have been sent');
  assert.equal(harness.getNode('#add-button').disabled, true);
});

test('Create, delete, and undo preserve other-tab tasks even before their storage event arrives', async () => {
  const original = syntheticTask({ id: 'original' });
  const other = syntheticTask({ id: 'other-tab-child', repeatParentId: 'external-parent' });
  const harness = createHarness({ initialTasks: [original] });
  harness.updateTasksFromOtherTab([original, other], { notify: false });
  harness.getNode('#task-input').value = '新增備忘';
  await harness.getNode('#task-form').dispatchAsync({ type: 'submit' });
  let saved = harness.getSavedTasks();
  assert.equal(saved.length, 3);
  assert.ok(saved.some(task => task.id === other.id));
  assert.ok(saved.some(task => task.title === '新增備忘'));

  const newer = syntheticTask({ id: 'newer-other-tab-child' });
  harness.updateTasksFromOtherTab([...saved, newer], { notify: false });
  const button = harness.getTaskRow(original.id).querySelector('.delete-button');
  harness.getNode('#task-sections').dispatchEvent({ type: 'click', target: button });
  saved = harness.getSavedTasks();
  assert.equal(saved.length, 3);
  assert.ok(saved.some(task => task.id === newer.id));
  assert.equal(saved.some(task => task.id === original.id), false);

  const latest = syntheticTask({ id: 'latest-other-tab-child' });
  harness.updateTasksFromOtherTab([...saved, latest], { notify: false });
  harness.getNode('#undo-button').dispatchEvent({ type: 'click' });
  saved = harness.getSavedTasks();
  assert.equal(saved.length, 5);
  for (const id of [original.id, other.id, newer.id, latest.id]) assert.ok(saved.some(task => task.id === id));
  assert.ok(saved.some(task => task.title === '新增備忘'));
});

function googleDestination(name = '工作') {
  return { id: 'google-work-label', provider: 'google', name, source: 'local-label' };
}

test('Consecutive voice tasks use fresh sessions and preserve their own chosen destinations', async () => {
  const work = googleDestination();
  const app = createHarness({ initialSettings: { googleDestinationLabels: [work] } });
  assert.equal(app.getNode('#task-destination').value, 'local');
  app.getNode('#task-destination').value = work.id;
  app.getNode('#task-destination').dispatchEvent({ type: 'change' });
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  const first = app.recognition;
  first.onstart();
  assert.equal(app.getNode('#task-destination').disabled, true);
  first.onresult(finalResult('十分鐘後提醒我喝水'));
  first.onend();
  assert.equal(app.getNode('#task-destination').disabled, false);
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.deepEqual(app.getSavedTasks()[0].destination, work);
  assert.equal(app.getNode('#task-destination').value, work.id);

  app.getNode('#task-destination').value = 'apple';
  app.getNode('#task-destination').dispatchEvent({ type: 'change' });
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  const second = app.recognition;
  assert.notEqual(second, first);
  assert.equal(app.recognitions.length, 2);
  second.onstart();
  second.onresult(finalResult('明天早上八點提醒我買早餐'));
  const previewTime = app.getNode('#preview-time').textContent;
  first.onresult(finalResult('睡前提醒我錯誤任務'));
  first.onerror({ error: 'network' });
  first.onend();
  assert.equal(app.getNode('#task-input').value, '明天早上八點提醒我買早餐');
  assert.equal(app.getNode('#preview-title').textContent, '買早餐');
  assert.equal(app.getNode('#preview-time').textContent, previewTime);
  assert.equal(app.getNode('#add-button').disabled, true);
  assert.equal(app.getNode('#task-destination').disabled, true);
  second.onend();
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  const tasks = app.getSavedTasks();
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0].destination, work);
  assert.deepEqual(tasks[1].destination, { id: 'apple', provider: 'apple', name: 'Apple 行事曆匯出', source: 'builtin' });
  assert.equal(tasks[0].title, '喝水');
  assert.equal(tasks[1].title, '買早餐');
});

test('Renamed and removed local labels cannot rewrite an existing task destination snapshot', () => {
  const original = googleDestination('原本工作名稱');
  const renamed = { ...original, name: '改名後的本機名稱' };
  const task = syntheticTask({ destination: original });
  // Reload with a renamed preferences record while keeping the original task.
  const app = createHarness({ initialTasks: [task], initialSettings: { googleDestinationLabels: [renamed] } });
  const originalTaskJSON = app.getStoredJSON();
  assert.match(app.getTaskRow(task.id).querySelector('.task-destination').textContent, /原本工作名稱/);
  assert.deepEqual(app.getSavedTasks()[0].destination, original);
  const remove = app.getNode('#destination-list').querySelector('[data-destination-id]');
  app.getNode('#destination-list').dispatchEvent({ type: 'click', target: remove });
  assert.deepEqual(app.getSavedSettings().googleDestinationLabels, []);
  assert.equal(app.getStoredJSON(), originalTaskJSON);
  assert.deepEqual(app.getSavedTasks()[0].destination, original);
  assert.match(app.getTaskRow(task.id).querySelector('.task-destination').textContent, /原本工作名稱/);
  assert.equal(app.getTaskRow(task.id).querySelector('.google-button').hidden, false);
});

test('Removing a label during recording preserves the destination captured before speech started', async () => {
  const work = googleDestination();
  const app = createHarness({ initialSettings: { googleDestinationLabels: [work] } });
  app.getNode('#task-destination').value = work.id;
  app.getNode('#task-destination').dispatchEvent({ type: 'change' });
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  const recognition = app.recognition;
  recognition.onstart();
  const remove = app.getNode('#destination-list').querySelector('[data-destination-id]');
  app.getNode('#destination-list').dispatchEvent({ type: 'click', target: remove });
  assert.deepEqual(app.getSavedSettings().googleDestinationLabels, []);
  assert.equal(app.getNode('#task-destination').value, work.id);
  assert.equal(app.getNode('#task-destination').disabled, true);
  recognition.onresult(finalResult('十分鐘後提醒我喝水'));
  recognition.onend();
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.deepEqual(app.getSavedTasks()[0].destination, work);
});

test('Google uses one native same-tab link without a second dialog or invented calendar ID', () => {
  const work = googleDestination();
  const task = syntheticTask({ destination: work });
  const app = createHarness({ initialTasks: [task], initialSettings: { googleDestinationLabels: [work] } });
  const link = app.getTaskRow(task.id).querySelector('.google-button');
  assert.equal(link.hidden, false);
  let prevented = false;
  app.getNode('#task-sections').dispatchEvent({
    type: 'click', target: link, preventDefault() { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.equal(link.target, '_self');
  assert.equal(app.getTaskRow(task.id).querySelector('.apple-button').hidden, true);
  assert.match(app.getTaskRow(task.id).querySelector('.calendar-export-note').textContent, /儲存/);
  const url = new URL(link.href);
  assert.equal(url.origin, 'https://calendar.google.com');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), task.title);
  for (const key of ['calendarId', 'calendarid', 'src', 'cid']) assert.equal(url.searchParams.has(key), false);
  assert.equal([...url.searchParams.values()].includes(work.id), false);
  assert.deepEqual(app.navigationCalls, []);
  assert.deepEqual(app.popupCalls, []);
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="calendar-confirm(?:ation|-)/);
  assert.doesNotMatch(source, /\$\('#calendar-confirm/);
});

test('Editing preserves unspecified legacy destinations until an explicit per-task choice is saved', () => {
  const legacy = syntheticTask();
  const app = createHarness({ initialTasks: [legacy] });
  editThroughRegisteredCallbacks(app, legacy.id, { notes: '仍未選目的地' });
  assert.equal(app.getSavedTasks()[0].destination, null);
  assert.equal(app.getTaskRow(legacy.id).querySelector('.calendar-actions').hidden, true);
  editThroughRegisteredCallbacks(app, legacy.id, { destination: 'apple' });
  assert.deepEqual(app.getSavedTasks()[0].destination, { id: 'apple', provider: 'apple', name: 'Apple 行事曆匯出', source: 'builtin' });
  assert.equal(app.getTaskRow(legacy.id).querySelector('.apple-button').hidden, false);
  assert.equal(app.getTaskRow(legacy.id).querySelector('.google-button').hidden, true);
});

function chooseDestination(app, id) {
  app.getNode('#task-destination').value = id;
  app.getNode('#task-destination').dispatchEvent({ type: 'change' });
}

function enterDraft(app, text = '十分鐘後提醒我喝水') {
  app.getNode('#task-input').value = text;
  app.getNode('#task-input').dispatchEvent({ type: 'input' });
}

test('Selecting a provider and recognizing speech only previews; confirmation saves before Google navigation', async () => {
  const app = createHarness();
  chooseDestination(app, 'google-draft');
  assert.equal(app.navigationCalls.length, 0);
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  app.recognition.onstart();
  app.recognition.onresult(finalResult('十分鐘後提醒我喝水'));
  app.recognition.onend();
  assert.equal(app.navigationCalls.length, 0);
  assert.equal(app.getSavedTasks().length, 0);
  assert.equal(app.getNode('#add-label').textContent, '確認並前往 Google Calendar');
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.equal(app.navigationCalls.length, 1);
  assert.deepEqual(app.navigationCalls[0].savedTasks, app.getSavedTasks());
  const saved = app.getSavedTasks()[0];
  assert.equal(saved.title, '喝水');
  assert.equal(app.navigationCalls[0].url, createGoogleCalendarUrl(saved));
  assert.equal(app.getTaskRow(saved.id).querySelector('.apple-button').hidden, true);
  assert.deepEqual(app.calendarDownloads, []);
  assert.deepEqual(app.popupCalls, []);
});

test('Deferred attachment storage prevents early handoff and duplicate submits for either provider', async () => {
  for (const destination of ['google-draft', 'apple']) {
    let finish;
    let attachmentCalls = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const app = createHarness({ initialSettings: { preferredDestinationId: destination, calendarAlarmMinutes: 30 },
      attachmentSave: () => { attachmentCalls += 1; return pending; } });
    enterDraft(app);
    const submitting = app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    assert.equal(app.getNode('#add-button').disabled, true);
    assert.equal(app.getSavedTasks().length, 0);
    assert.equal(app.navigationCalls.length + app.calendarDownloads.length, 0);
    await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    assert.equal(attachmentCalls, 1);
    app.getNode('#calendar-alarm').value = '0';
    app.getNode('#calendar-alarm').dispatchEvent({ type: 'change' });
    finish([]);
    await submitting;
    assert.equal(app.getSavedTasks().length, 1);
    assert.equal(app.navigationCalls.length + app.calendarDownloads.length, 1);
    assert.equal(app.getNode('#add-button').disabled, false);
    if (destination === 'apple') {
      assert.equal(app.calendarDownloads[0].options.alarmMinutes, 30, 'Use the confirmed draft alarm snapshot');
      assert.deepEqual(app.calendarDownloads[0].savedTasks, app.getSavedTasks());
    }
    await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    assert.equal(app.getSavedTasks().length, 1);
    assert.equal(app.navigationCalls.length + app.calendarDownloads.length, 1);
    assert.deepEqual(app.popupCalls, []);
  }
});

test('Attachment and task-storage failures keep the draft and never hand off', async () => {
  for (const destination of ['google-draft', 'apple']) {
    for (const failure of ['attachment', 'task']) {
      const app = createHarness({ initialSettings: { preferredDestinationId: destination },
        taskSaveFailure: failure === 'task',
        attachmentSave: async () => {
          if (failure === 'attachment') throw new Error('Synthetic attachment failure');
          return ['stored-attachment'];
        } });
      enterDraft(app);
      app.getNode('#task-notes').value = '保留草稿備註';
      await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
      assert.equal(app.getSavedTasks().length, 0);
      assert.equal(app.navigationCalls.length + app.calendarDownloads.length, 0);
      assert.equal(app.getNode('#task-input').value, '十分鐘後提醒我喝水');
      assert.equal(app.getNode('#task-notes').value, '保留草稿備註');
      assert.equal(app.getNode('#task-destination').value, destination);
      if (failure === 'task') assert.deepEqual(app.attachmentCalls.delete, [['stored-attachment']]);
    }
  }
});

test('A read-only record arriving during attachment await prevents both handoffs and rolls back attachment IDs', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = createHarness({ initialSettings: { preferredDestinationId: 'google-draft' }, attachmentSave: () => pending });
  enterDraft(app);
  const submitting = app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  const unsafeJSON = '{"unexpected":"newer format"}';
  app.updateTaskJSONFromOtherTab(unsafeJSON);
  finish(['stored-attachment']);
  await submitting;
  assert.equal(app.getStoredJSON(), unsafeJSON);
  assert.equal(app.navigationCalls.length + app.calendarDownloads.length, 0);
  assert.deepEqual(app.attachmentCalls.delete, [['stored-attachment']]);
  assert.equal(app.getNode('#task-input').value, '十分鐘後提醒我喝水');
});

test('Failed Google navigation retains one saved task and its native same-tab retry link', async () => {
  const app = createHarness({ initialSettings: { preferredDestinationId: 'google-draft' }, navigationFailure: true });
  enterDraft(app);
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  const saved = app.getSavedTasks()[0];
  assert.equal(app.getSavedTasks().length, 1);
  assert.match(app.getNode('#notification-text').textContent, /任務已保留.*重試/);
  const link = app.getTaskRow(saved.id).querySelector('.google-button');
  assert.equal(link.href, createGoogleCalendarUrl(saved));
  assert.equal(link.target, '_self');
  let prevented = false;
  app.getNode('#task-sections').dispatchEvent({ type: 'click', target: link, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'The native link is usable with a new user gesture');
  assert.equal(app.getSavedTasks().length, 1);
  assert.deepEqual(app.popupCalls, []);
});

test('Apple download failures keep the task and a fresh click retries the same ICS without adding another task', async () => {
  const app = createHarness({ initialSettings: { preferredDestinationId: 'apple' }, downloadFailure: true });
  enterDraft(app, '明天早上八點提醒我買早餐');
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  const saved = app.getSavedTasks()[0];
  assert.equal(app.getSavedTasks().length, 1);
  assert.match(app.getNode('#notification-text').textContent, /任務已保留.*尚未加入/);
  assert.equal(app.getTaskRow(saved.id).querySelector('.google-button').hidden, true);
  app.rejectDownloads(false);
  app.getNode('#task-sections').dispatchEvent({ type: 'click', target: app.getTaskRow(saved.id).querySelector('.apple-button') });
  assert.equal(app.calendarDownloads.length, 2);
  assert.equal(app.calendarDownloads[1].task.id, saved.id);
  assert.equal(app.getSavedTasks().length, 1);
  assert.match(app.getNode('#notification-text').textContent, /尚待匯入/);
  assert.deepEqual(app.navigationCalls, []);
});

test('Memos and later edits, completion, recurring next tasks, and reload never auto-export', async () => {
  for (const destination of ['google-draft', 'apple']) {
    const app = createHarness({ initialSettings: { preferredDestinationId: destination } });
    enterDraft(app, '睡前提醒我吃藥');
    assert.equal(app.getNode('#add-label').textContent, '儲存備忘');
    await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    const memo = app.getSavedTasks()[0];
    assert.equal(memo.reminderAt, null);
    assert.equal(app.getTaskRow(memo.id).querySelector('.calendar-actions').hidden, true);
    editThroughRegisteredCallbacks(app, memo.id, { time: '2030-01-05T08:00', repeat: 'daily' });
    setCompletionThroughCallback(app, memo.id, true);
    assert.equal(app.getSavedTasks().length, 2);
    assert.equal(app.navigationCalls.length + app.calendarDownloads.length, 0);
    const reloaded = createHarness({ initialTasks: app.getSavedTasks(), storedSettingsJSON: app.getStoredSettingsJSON() });
    assert.equal(reloaded.navigationCalls.length + reloaded.calendarDownloads.length, 0);
  }
});

test('Local tasks and a hidden Apple action on a Google task cannot download ICS', async () => {
  const app = createHarness();
  enterDraft(app);
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  const local = app.getSavedTasks()[0];
  assert.equal(app.getTaskRow(local.id).querySelector('.calendar-actions').hidden, true);
  const googleTask = syntheticTask({ destination: destinations.resolveDestination('google-draft', {}) });
  app.updateTasksFromOtherTab([local, googleTask]);
  app.getNode('#task-sections').dispatchEvent({ type: 'click', target: app.getTaskRow(googleTask.id).querySelector('.apple-button') });
  assert.equal(app.navigationCalls.length + app.calendarDownloads.length, 0);
});

function visibleText(node) {
  if (!node || node.hidden) return '';
  return [node.textContent, ...(node.children || []).map(visibleText)].join(' ');
}

test('The preferred destination survives consecutive additions and a fresh App initialization', async () => {
  const app = createHarness({ initialSettings: { preferredDestinationId: 'apple' } });
  assert.equal(app.getNode('#task-destination').value, 'apple');
  chooseDestination(app, 'google-draft');
  assert.equal(app.getSavedSettings().preferredDestinationId, 'google-draft');
  for (const text of ['十分鐘後提醒我喝水', '明早提醒我買早餐']) {
    app.getNode('#task-input').value = text;
    await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    assert.equal(app.getNode('#task-destination').value, 'google-draft');
  }
  assert.equal(app.getSavedTasks().length, 2);
  for (const task of app.getSavedTasks()) {
    assert.deepEqual(task.destination, destinations.resolveDestination('google-draft', {}));
  }
  const refreshed = createHarness({ initialTasks: app.getSavedTasks(), storedSettingsJSON: app.getStoredSettingsJSON() });
  assert.equal(refreshed.getNode('#task-destination').value, 'google-draft');
  assert.match(refreshed.getNode('#destination-hint').textContent, /Google.*未連線/);
});

test('A missing stored preference falls back visibly without rewriting the original settings on load', () => {
  const raw = JSON.stringify({ ...normalizeSettings({}), preferredDestinationId: 'deleted-label' });
  const app = createHarness({ storedSettingsJSON: raw });
  assert.equal(app.getNode('#task-destination').value, 'local');
  assert.match(app.getNode('#destination-hint').textContent, /不存在.*本機/);
  assert.equal(app.getStoredSettingsJSON(), raw);
});

test('Deleting the selected local label falls back to local for the next task and persisted preference', async () => {
  const work = googleDestination();
  const app = createHarness({ initialSettings: { googleDestinationLabels: [work], preferredDestinationId: work.id } });
  assert.equal(app.getNode('#task-destination').value, work.id);
  const remove = app.getNode('#destination-list').querySelector('[data-destination-id]');
  app.getNode('#destination-list').dispatchEvent({ type: 'click', target: remove });
  assert.equal(app.getSavedSettings().preferredDestinationId, 'local');
  assert.equal(app.getNode('#task-destination').value, 'local');
  assert.match(app.getNode('#destination-hint').textContent, /不存在.*本機/);
  app.getNode('#task-input').value = '先存一筆備忘';
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.equal(app.getSavedTasks()[0].destination.provider, 'local');
});

test('A recording snapshot survives label deletion and duplicate start before the next task falls back', async () => {
  const work = googleDestination();
  const app = createHarness({ initialSettings: { googleDestinationLabels: [work], preferredDestinationId: work.id } });
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  const recognition = app.recognition;
  // The first active callback is emitted before the browser sends onstart.
  const remove = app.getNode('#destination-list').querySelector('[data-destination-id]');
  app.getNode('#destination-list').dispatchEvent({ type: 'click', target: remove });
  assert.equal(app.getSavedSettings().preferredDestinationId, 'local');
  assert.equal(app.getNode('#task-destination').value, work.id);
  recognition.onstart();
  recognition.onstart();
  assert.equal(app.getNode('#task-destination').value, work.id);
  recognition.onresult(finalResult('十分鐘後提醒我喝水'));
  recognition.onerror({ error: 'network' });
  assert.equal(app.getNode('#task-destination').value, work.id);
  recognition.onend();
  assert.equal(app.getNode('#task-destination').value, work.id);
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.deepEqual(app.getSavedTasks()[0].destination, work);
  assert.equal(app.getNode('#task-destination').value, 'local');
  app.getNode('#task-input').value = '下一輪備忘';
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.equal(app.getSavedTasks()[1].destination.provider, 'local');
});

test('Destination changes during listening are rejected without saving a different preference', async () => {
  const work = googleDestination();
  const app = createHarness({ initialSettings: { googleDestinationLabels: [work], preferredDestinationId: work.id } });
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  const recognition = app.recognition;
  recognition.onstart();
  const writes = app.getSettingsWriteCount();
  chooseDestination(app, 'apple');
  assert.equal(app.getNode('#task-destination').value, work.id);
  assert.equal(app.getSavedSettings().preferredDestinationId, work.id);
  assert.equal(app.getSettingsWriteCount(), writes);
  recognition.onresult(finalResult('明早提醒我買早餐'));
  recognition.onend();
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.deepEqual(app.getSavedTasks()[0].destination, work);
});

test('An error followed by manual destination change and delayed end cannot reroute the next voice task', async () => {
  const work = googleDestination();
  const app = createHarness({ initialSettings: { googleDestinationLabels: [work], preferredDestinationId: work.id } });
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  const first = app.recognition;
  first.onstart();
  first.onerror({ error: 'network' });
  chooseDestination(app, 'apple');
  assert.equal(app.getNode('#task-destination').value, 'apple');
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  assert.equal(app.recognitions.length, 2, 'An error must allow an immediate new session');
  first.onend();
  assert.equal(app.getNode('#task-destination').value, 'apple');
  const second = app.recognition;
  second.onstart();
  first.onresult(finalResult('舊的錯誤備忘'));
  first.onend();
  second.onresult(finalResult('明早提醒我買早餐'));
  second.onend();
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.equal(app.getSavedTasks().length, 1);
  assert.equal(app.getSavedTasks()[0].destination.provider, 'apple');
  assert.equal(app.getSavedTasks()[0].title, '買早餐');
});

test('Failed preference writes keep this page selection across additions and show the persistence warning', async () => {
  const app = createHarness({ initialSettings: { preferredDestinationId: 'local' }, settingsSaveFailure: true });
  chooseDestination(app, 'google-draft');
  assert.equal(app.getNode('#task-destination').value, 'google-draft');
  assert.equal(app.getSavedSettings().preferredDestinationId, 'local');
  assert.match(app.getNode('#destination-hint').textContent, /本頁.*偏好未儲存/);
  for (const text of ['第一則備忘', '第二則備忘']) {
    app.getNode('#task-input').value = text;
    await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    assert.equal(app.getNode('#task-destination').value, 'google-draft');
    assert.equal(app.getNode('#storage-warning').hidden, false);
    assert.match(app.getNode('#storage-warning').textContent, /偏好設定未儲存/);
  }
  assert.ok(app.getSavedTasks().every(task => task.destination.id === 'google-draft'));
  const refreshed = createHarness({ initialTasks: app.getSavedTasks(), storedSettingsJSON: app.getStoredSettingsJSON() });
  assert.equal(refreshed.getNode('#task-destination').value, 'local');
});

test('Google and Apple memos keep their selected destinations and visibly require scheduling before export', async () => {
  for (const destinationId of ['google-draft', 'apple']) {
    const app = createHarness({ initialSettings: { preferredDestinationId: destinationId } });
    app.getNode('#task-input').value = '睡前提醒我吃藥';
    await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    const task = app.getSavedTasks()[0];
    assert.equal(task.reminderAt, null);
    assert.equal(task.destination.id, destinationId);
    const row = app.getTaskRow(task.id);
    assert.equal(row.querySelector('.calendar-actions').hidden, true);
    assert.match(visibleText(row), /保留目的地.*設定提醒時間/);
  }
});

test('Editing one task destination does not alter the preferred destination or the next draft', () => {
  const task = syntheticTask({ destination: destinations.resolveDestination('local', {}) });
  const app = createHarness({ initialTasks: [task], initialSettings: { preferredDestinationId: 'google-draft' } });
  app.getNode('#task-input').value = '下一則尚未儲存的備忘';
  const writes = app.getSettingsWriteCount();
  editThroughRegisteredCallbacks(app, task.id, { destination: 'apple' });
  assert.equal(app.getSavedTasks()[0].destination.id, 'apple');
  assert.equal(app.getSavedSettings().preferredDestinationId, 'google-draft');
  assert.equal(app.getSettingsWriteCount(), writes);
  assert.equal(app.getNode('#task-destination').value, 'google-draft');
  assert.equal(app.getNode('#task-input').value, '下一則尚未儲存的備忘');
});

test('A pending submission locks the composer and voice until completion and refuses duplicate submits', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const app = createHarness({
    initialSettings: { preferredDestinationId: 'google-draft' },
    attachmentSave: () => { calls += 1; return calls === 1 ? pending : Promise.resolve([]); },
  });
  app.getNode('#task-input').value = '第一則備忘';
  app.getNode('#task-notes').value = '需要保留的備註';
  const submitting = app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  for (const selector of ['#task-input', '#task-notes', '#task-destination', '#voice-button', '#add-button', '#attachment-input']) {
    assert.equal(app.getNode(selector).disabled, true, `${selector} must be locked while saving`);
  }
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  app.getNode('#voice-button').dispatchEvent({ type: 'click' });
  assert.equal(calls, 1);
  assert.equal(app.recognitions.length, 0);
  finish([]);
  await submitting;
  assert.equal(app.getSavedTasks().length, 1);
  assert.equal(app.getSavedTasks()[0].notes, '需要保留的備註');
  for (const selector of ['#task-input', '#task-notes', '#voice-button', '#add-button']) assert.equal(app.getNode(selector).disabled, false);
  assert.equal(app.getNode('#task-destination').value, 'google-draft');
  app.getNode('#task-input').value = '第二則備忘';
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.deepEqual(app.getSavedTasks().map(task => task.title), ['第一則備忘', '第二則備忘']);
});

test('A failed submission retains the whole draft and restores controls without enabling unsupported speech', async () => {
  const app = createHarness({ supported: false, taskSaveFailure: true, initialSettings: { preferredDestinationId: 'apple' } });
  app.getNode('#task-input').value = '尚未保存的備忘';
  app.getNode('#task-notes').value = '失敗時請保留';
  app.getNode('#task-no-time').checked = true;
  app.getNode('#task-no-time').dispatchEvent({ type: 'change' });
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.equal(app.getSavedTasks().length, 0);
  assert.equal(app.getNode('#task-input').value, '尚未保存的備忘');
  assert.equal(app.getNode('#task-notes').value, '失敗時請保留');
  assert.equal(app.getNode('#task-destination').value, 'apple');
  assert.equal(app.getNode('#task-input').disabled, false);
  assert.equal(app.getNode('#add-button').disabled, false);
  assert.equal(app.getNode('#task-time').disabled, true);
  assert.equal(app.getNode('#voice-button').disabled, true);
  assert.match(app.getNode('#notification-text').textContent, /儲存失敗/);
  app.rejectTaskWrites(false);
  await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.equal(app.getSavedTasks()[0].title, '尚未保存的備忘');
  assert.equal(app.getSavedTasks()[0].destination.id, 'apple');
});

function deliverLocation(request, kind, latitude = 25.033, longitude = 121.565) {
  if (kind === 'success') request.success({ coords: { latitude, longitude } });
  else request.error({ code: 1, message: 'Synthetic old location failure' });
}

test('Old location success and error callbacks cannot unlock a pending submission or refill the next draft', async () => {
  for (const kind of ['success', 'error']) {
    for (const phase of ['during-save', 'after-save']) {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const app = createHarness({ geolocation: true, attachmentSave: () => pending });
      app.getNode('#task-input').value = '保留手動地點的備忘';
      app.getNode('#task-location').value = '台北車站手動地址';
      app.getNode('#location-button').dispatchEvent({ type: 'click' });
      assert.equal(app.locationRequests.length, 1);
      assert.equal(app.getNode('#location-button').disabled, true);
      const request = app.locationRequests[0];
      const submitting = app.getNode('#task-form').dispatchAsync({ type: 'submit' });
      assert.equal(app.getNode('#task-location').disabled, true);
      assert.equal(app.getNode('#location-button').disabled, true);
      if (phase === 'during-save') {
        const message = app.getNode('#notification-text').textContent;
        deliverLocation(request, kind);
        assert.equal(app.getNode('#task-location').value, '台北車站手動地址');
        assert.equal(app.getNode('#location-button').disabled, true);
        assert.equal(app.getNode('#notification-text').textContent, message);
      }
      finish([]);
      await submitting;
      assert.equal(app.getSavedTasks()[0].locationAddress, '台北車站手動地址');
      assert.equal(app.getSavedTasks()[0].locationLat, null);
      assert.equal(app.getSavedTasks()[0].locationLng, null);
      assert.equal(app.getNode('#location-button').disabled, false);
      assert.equal(app.getNode('#task-location').value, '');
      app.getNode('#task-input').value = '下一則尚未保存';
      app.getNode('#task-location').value = '下一則的手動地址';
      if (phase === 'after-save') {
        const message = app.getNode('#notification-text').textContent;
        deliverLocation(request, kind);
        assert.equal(app.getNode('#notification-text').textContent, message);
      }
      assert.equal(app.getNode('#task-location').value, '下一則的手動地址');
      assert.equal(app.getNode('#task-input').value, '下一則尚未保存');
      assert.equal(app.getNode('#task-location').dataset.latitude, undefined);
      assert.equal(app.getNode('#location-button').disabled, false);
    }
  }
});

test('An older invalidated location callback cannot finish or overwrite a newer location request', async () => {
  for (const kind of ['success', 'error']) {
    const app = createHarness({ geolocation: true });
    app.getNode('#location-button').dispatchEvent({ type: 'click' });
    const oldRequest = app.locationRequests[0];
    app.getNode('#task-input').value = '先保存這則備忘';
    await app.getNode('#task-form').dispatchAsync({ type: 'submit' });
    app.getNode('#task-input').value = '新的尚未保存備忘';
    app.getNode('#task-location').value = '新草稿地址';
    app.getNode('#location-button').dispatchEvent({ type: 'click' });
    assert.equal(app.locationRequests.length, 2);
    const currentRequest = app.locationRequests[1];
    const message = app.getNode('#notification-text').textContent;
    deliverLocation(oldRequest, kind, 22.627, 120.301);
    assert.equal(app.getNode('#location-button').disabled, true);
    assert.equal(app.getNode('#task-location').value, '新草稿地址');
    assert.equal(app.getNode('#notification-text').textContent, message);
    deliverLocation(currentRequest, 'success', 24.147, 120.673);
    assert.equal(app.getNode('#location-button').disabled, false);
    assert.equal(app.getNode('#task-location').value, '目前位置（24.14700, 120.67300）');
    assert.equal(app.getNode('#task-location').dataset.latitude, '24.147');
    assert.equal(app.getNode('#task-location').dataset.longitude, '120.673');
    assert.equal(app.getNode('#task-input').value, '新的尚未保存備忘');
    assert.equal(app.getSavedTasks().length, 1);
    assert.equal(app.getSavedTasks()[0].locationAddress, '');
  }
});

test('An attachment draft cannot be removed while its task is being submitted', async () => {
  let finish;
  let draftsBeingSaved;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = createHarness({ attachmentSave: (taskId, drafts) => { draftsBeingSaved = drafts; return pending; } });
  const file = { name: '保留附件.txt', type: 'text/plain', size: 12 };
  app.getNode('#attachment-input').files = [file];
  app.getNode('#attachment-input').dispatchEvent({ type: 'change' });
  const list = app.getNode('#attachment-draft-list');
  assert.equal(list.children.length, 1);
  const remove = list.querySelector('.remove-attachment');
  app.getNode('#task-input').value = '保留附件的備忘';
  const submitting = app.getNode('#task-form').dispatchAsync({ type: 'submit' });
  assert.equal(remove.disabled, true);
  list.dispatchEvent({ type: 'click', target: remove });
  assert.equal(list.children.length, 1);
  assert.equal(draftsBeingSaved.length, 1);
  assert.equal(draftsBeingSaved[0].metadata.name, file.name);
  finish([draftsBeingSaved[0].metadata.id]);
  await submitting;
  assert.equal(app.getSavedTasks()[0].attachments.length, 1);
  assert.equal(app.getSavedTasks()[0].attachments[0].name, file.name);
  assert.equal(list.children.length, 0);
});
