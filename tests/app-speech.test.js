import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseTaskInput } from '../js/time-parser.js';

// Exercise the actual App callback registration without a browser or microphone.
// The App has three single-line imports; their collaborators are supplied below.
const source = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function createHarness({ supported = true } = {}) {
  const nodes = new Map();
  const parsedInputs = [];
  let recognition;

  function getNode(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const listeners = new Map();
    const attributes = new Map();
    const node = {
      value: '', textContent: '', hidden: false, disabled: false, dataset: {},
      addEventListener(name, listener) {
        const callbacks = listeners.get(name) ?? [];
        callbacks.push(listener);
        listeners.set(name, callbacks);
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
        return true;
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      setCustomValidity() {},
      replaceChildren() {},
      focus() {},
      querySelector(childSelector) { return getNode(`${selector} ${childSelector}`); },
    };
    nodes.set(selector, node);
    return node;
  }

  class Recognition {
    constructor() { recognition = this; this.startCount = 0; this.stopCount = 0; }
    start() { this.startCount += 1; }
    stop() { this.stopCount += 1; }
  }

  const context = {
    Date, Intl, HTMLInputElement: class {},
    Event: class { constructor(type) { this.type = type; } },
    window: {
      addEventListener() {},
      ...(supported ? { SpeechRecognition: Recognition } : {}),
    },
    document: { querySelector: getNode, querySelectorAll: () => [], addEventListener() {} },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    parseTaskInput(input) { parsedInputs.push(input); return parseTaskInput(input); },
    createGoogleCalendarUrl() {}, downloadICS() {}, STORAGE_KEY: 'speech-test',
    loadTasks: () => ({ tasks: [], error: null, readOnly: false }),
    saveTasks: () => ({ ok: true }),
    classifyTasks: () => ({ overdue: [], today: [], pending: [], completed: [] }),
  };

  vm.runInNewContext(source, context, { filename: 'js/app.js' });
  return { getNode, recognition, parsedInputs };
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
  const { getNode, recognition } = createHarness();
  assert.equal(recognition.lang, 'zh-TW');
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  assert.equal(recognition.startCount, 1);
  assert.equal(getNode('#voice-label').textContent, '聆聽中...');
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
  const { getNode, recognition, parsedInputs } = createHarness();
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  recognition.onresult(finalResult('十分鐘後提醒我喝水'));
  assert.equal(getNode('#task-input').value, '十分鐘後提醒我喝水');
  assert.ok(parsedInputs.includes('十分鐘後提醒我喝水'));
  assert.equal(getNode('#preview-title').textContent, '喝水');
  assert.notEqual(getNode('#preview-time').textContent, '未設定');
  recognition.onend();
  assert.equal(getNode('#speech-status').textContent, '辨識完成，請確認任務與時間後新增。');
});

test('Manual corrections after the final result survive recognition ending', () => {
  const { getNode, recognition } = createHarness();
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  recognition.onresult(finalResult('明早提醒我買早餐'));
  getNode('#task-input').value = '明早提醒我買午餐';
  getNode('#task-input').dispatchEvent({ type: 'input' });
  assert.equal(getNode('#preview-title').textContent, '買午餐');

  recognition.onend();
  assert.equal(getNode('#task-input').value, '明早提醒我買午餐');
  assert.equal(getNode('#preview-title').textContent, '買午餐');
});

test('Network errors restore controls and their message remains after onend', () => {
  const { getNode, recognition } = createHarness();
  getNode('#voice-button').dispatchEvent({ type: 'click' });
  recognition.onerror({ error: 'network' });
  const expected = '語音辨識服務無法連線，請檢查網路或改用打字。';
  assert.equal(getNode('#speech-status').textContent, expected);
  assert.equal(getNode('#voice-label').textContent, '語音輸入');
  assert.equal(getNode('#add-button').disabled, false);
  recognition.onend();
  assert.equal(getNode('#speech-status').textContent, expected);
});
