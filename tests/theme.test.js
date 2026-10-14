import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupTheme, THEME_KEY } from '../js/theme.js';

function node() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    style: {}, textContent: '',
    setAttribute(key, value) { attributes.set(key, String(value)); },
    getAttribute(key) { return attributes.get(key) ?? null; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    click() { listeners.get('click')?.(); },
  };
}

function storage(initial = null) {
  let value = initial;
  const writes = [];
  const reads = [];
  return {
    writes, reads,
    getItem(key) { reads.push(key); return value; },
    setItem(key, next) { value = next; writes.push([key, next]); },
  };
}

function media(matches = false, legacy = false) {
  let listener;
  const result = {
    matches,
    change(next) { this.matches = next; listener?.({ matches: next }); },
  };
  if (legacy) {
    result.addListener = callback => { listener = callback; };
    result.removeListener = callback => { if (listener === callback) listener = null; };
  } else {
    result.addEventListener = (type, callback) => { assert.equal(type, 'change'); listener = callback; };
    result.removeEventListener = (type, callback) => { if (type === 'change' && listener === callback) listener = null; };
  }
  return result;
}

test('First use follows the system theme without saving an inferred preference', () => {
  const button = node();
  const root = node();
  const local = storage();
  const theme = setupTheme({ button, root, storage: local, media: media(true) });
  assert.equal(theme.getTheme(), 'dark');
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(button.textContent, '切換淺色');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(local.reads, [THEME_KEY]);
  assert.deepEqual(local.writes, []);
});

test('A saved light choice wins over the system dark preference', () => {
  const button = node();
  const root = node();
  const system = media(true);
  const theme = setupTheme({ button, root, storage: storage('light'), media: system });
  assert.equal(theme.getTheme(), 'light');
  assert.equal(button.textContent, '切換深色');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  system.change(true);
  assert.equal(theme.getTheme(), 'light');
});

test('The button toggles appearance, saves only its own key, and reflects accessible state', () => {
  const button = node();
  const root = node();
  const local = storage('light');
  const theme = setupTheme({ button, root, storage: local, media: media() });
  button.click();
  assert.equal(theme.getTheme(), 'dark');
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(button.textContent, '切換淺色');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.getAttribute('aria-label'), /目前為深色/);
  button.click();
  assert.equal(theme.getTheme(), 'light');
  assert.deepEqual(local.writes, [[THEME_KEY, 'dark'], [THEME_KEY, 'light']]);
});

test('System changes are followed until the user makes an explicit choice', () => {
  const button = node();
  const system = media(false);
  const theme = setupTheme({ button, root: node(), storage: storage('invalid'), media: system });
  system.change(true);
  assert.equal(theme.getTheme(), 'dark');
  button.click();
  assert.equal(theme.getTheme(), 'light');
  system.change(true);
  assert.equal(theme.getTheme(), 'light');
});

test('Read/write failures still allow toggling and report that the preference was not saved', () => {
  const button = node();
  const root = node();
  const errors = [];
  const brokenStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
  };
  const theme = setupTheme({ button, root, storage: brokenStorage, media: media(false), onError: message => errors.push(message) });
  assert.equal(theme.getTheme(), 'light');
  assert.doesNotThrow(() => button.click());
  assert.equal(theme.getTheme(), 'dark');
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(button.getAttribute('data-save-error'), 'true');
  assert.match(button.getAttribute('aria-label'), /未保存/);
  assert.match(button.getAttribute('title'), /僅本次使用/);
  assert.deepEqual(errors, ['無法讀取主題偏好，將使用裝置的外觀設定。', '目前外觀已切換，但主題偏好無法儲存。']);
});

test('Blocked localStorage getters and throwing status callbacks cannot crash theme setup', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('privacy mode'); } });
    const button = node();
    let theme;
    assert.doesNotThrow(() => {
      theme = setupTheme({ button, root: node(), media: media(true), onError() { throw new Error('callback failed'); } });
    });
    assert.equal(theme.getTheme(), 'dark');
    assert.doesNotThrow(() => button.click());
    assert.equal(theme.getTheme(), 'light');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('Legacy media listeners work and destroy removes both change and click listeners', () => {
  const button = node();
  const system = media(false, true);
  const theme = setupTheme({ button, root: node(), storage: storage(), media: system });
  system.change(true);
  assert.equal(theme.getTheme(), 'dark');
  theme.destroy();
  system.change(false);
  button.click();
  assert.equal(theme.getTheme(), 'dark');
  assert.deepEqual(theme.setTheme('light'), { theme: 'dark', saved: false });
});

test('Invalid themes cannot become attributes or stored preferences', () => {
  const root = node();
  const local = storage();
  const theme = setupTheme({ button: node(), root, storage: local, media: media(false) });
  assert.deepEqual(theme.setTheme('auto'), { theme: 'light', saved: false });
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.deepEqual(local.writes, []);
});

test('Dark CSS text tokens retain readable contrast on their associated surfaces', () => {
  const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const block = css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(block, 'Dark theme tokens must exist');
  const colors = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(match => [match[1], match[2]]));
  function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map(part => parseInt(part, 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  for (const [foreground, background] of [
    ['--ink', '--surface'], ['--muted', '--surface'], ['--ink', '--field-bg'],
    ['--accent-dark', '--raised'], ['--action-ink', '--action-fill'],
    ['--warning-ink', '--warning-bg'],
  ]) {
    assert.ok(colors[foreground] && colors[background], `${foreground}/${background} exist`);
    const values = [luminance(colors[foreground]), luminance(colors[background])].sort((a, b) => a - b);
    const ratio = (values[1] + 0.05) / (values[0] + 0.05);
    assert.ok(ratio >= 4.5, `${foreground}/${background} contrast ${ratio.toFixed(2)}`);
  }
});
