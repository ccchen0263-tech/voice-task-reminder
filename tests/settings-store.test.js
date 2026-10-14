import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, normalizeSettings, saveSettings } from '../js/settings-store.js';

function memoryStorage(raw = null) {
  return {
    getItem(key) { assert.equal(key, SETTINGS_KEY); return raw; },
    setItem(key, value) { assert.equal(key, SETTINGS_KEY); raw = value; },
    get raw() { return raw; },
  };
}

test('settings keep personal mode and normalize calendar target and common places', () => {
  const storage = memoryStorage();
  const settings = { mode: 'shared', calendarTarget: 'apple', commonPlaces: [{ id: 'office', name: '公司', address: '台北市', lat: 25, lng: 121 }] };
  assert.equal(saveSettings(settings, storage).ok, true);
  assert.deepEqual(loadSettings(storage).settings, {
    ...DEFAULT_SETTINGS,
    mode: 'personal', calendarTarget: 'apple', commonPlaces: [{ id: 'office', name: '公司', address: '台北市', lat: 25, lng: 121 }],
  });
});

test('damaged settings fall back without overwriting original data', () => {
  const storage = memoryStorage('{ broken');
  const result = loadSettings(storage);
  assert.equal(result.settings.mode, 'personal');
  assert.equal(result.settings.calendarTarget, 'google');
  assert.ok(result.error);
  assert.equal(storage.raw, '{ broken');
});

test('common place coordinates do not turn empty or missing values into zero', () => {
  for (const missing of [undefined, null, '', ' ', '\t', false, [], {}]) {
    const normalized = normalizeSettings({ commonPlaces: [{ id: 'place', name: '公司', address: '台北市', lat: missing, lng: missing }] });
    assert.equal(normalized.commonPlaces[0].lat, null);
    assert.equal(normalized.commonPlaces[0].lng, null);
    const storage = memoryStorage();
    assert.equal(saveSettings(normalized, storage).ok, true);
    assert.deepEqual(loadSettings(storage).settings, normalized);
  }
});

test('common places preserve numeric and string zero while rejecting out-of-range coordinates', () => {
  for (const zero of [0, '0']) {
    const normalized = normalizeSettings({ commonPlaces: [{ name: '原點', address: '赤道與本初子午線', lat: zero, lng: zero }] });
    assert.equal(normalized.commonPlaces[0].lat, 0);
    assert.equal(normalized.commonPlaces[0].lng, 0);
  }
  const normalized = normalizeSettings({ commonPlaces: [{ name: '錯誤位置', address: '位置未設定', lat: 91, lng: -181 }] });
  assert.equal(normalized.commonPlaces[0].lat, null);
  assert.equal(normalized.commonPlaces[0].lng, null);
});

test('blocked localStorage access is caught even when no explicit storage argument is supplied', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw Object.assign(new Error('blocked'), { name: 'SecurityError' }); },
  });
  try {
    assert.ok(loadSettings().error);
    assert.equal(saveSettings({}).ok, false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('old settings keep calendar and places while gaining quiet channel defaults', () => {
  const oldSettings = { calendarTarget: 'apple', commonPlaces: [{ id: 'office', name: '公司', address: '台北市', lat: 25, lng: 121 }] };
  const oldJSON = JSON.stringify(oldSettings);
  const storage = memoryStorage(oldJSON);
  const loaded = loadSettings(storage);
  assert.equal(loaded.error, null);
  assert.equal(loaded.settings.calendarTarget, 'apple');
  assert.deepEqual(loaded.settings.commonPlaces, oldSettings.commonPlaces);
  assert.equal(loaded.settings.pageAlertsEnabled, true);
  assert.equal(loaded.settings.soundEnabled, false);
  assert.equal(loaded.settings.systemNotifications, false);
  assert.equal(loaded.settings.calendarAlarmMinutes, null);
  assert.equal(storage.raw, oldJSON, 'Loading defaults must not rewrite the original record');
});

test('reminder channel preferences accept only booleans and persist explicit choices', () => {
  for (const enabled of [true, false]) {
    const storage = memoryStorage();
    const preferences = { pageAlertsEnabled: enabled, soundEnabled: enabled, systemNotifications: enabled };
    assert.equal(saveSettings(preferences, storage).ok, true);
    const actual = loadSettings(storage).settings;
    assert.equal(actual.pageAlertsEnabled, enabled);
    assert.equal(actual.soundEnabled, enabled);
    assert.equal(actual.systemNotifications, enabled);
  }
  for (const invalid of ['true', 'false', 0, 1, null, undefined, [], {}]) {
    const actual = normalizeSettings({ pageAlertsEnabled: invalid, soundEnabled: invalid, systemNotifications: invalid });
    assert.equal(actual.pageAlertsEnabled, true);
    assert.equal(actual.soundEnabled, false);
    assert.equal(actual.systemNotifications, false);
  }
});

test('calendar alarm settings support none, at start, ten minutes, and thirty minutes', () => {
  for (const minutes of [null, 0, 10, 30]) {
    const storage = memoryStorage();
    assert.equal(saveSettings({ calendarAlarmMinutes: minutes }, storage).ok, true);
    assert.equal(loadSettings(storage).settings.calendarAlarmMinutes, minutes);
  }
  for (const invalid of ['0', '10', '30', -10, 1, 60, false, undefined]) {
    assert.equal(normalizeSettings({ calendarAlarmMinutes: invalid }).calendarAlarmMinutes, null);
  }
});

test('Legacy settings gain an empty local Google label list while existing preferences round-trip', () => {
  const legacy = {
    mode: 'personal', calendarTarget: 'apple',
    commonPlaces: [{ id: 'office', name: '公司', address: '台北市信義區', lat: 25.033, lng: 121.565 }],
    pageAlertsEnabled: false, soundEnabled: true, systemNotifications: false, calendarAlarmMinutes: 10,
  };
  const raw = JSON.stringify(legacy);
  const storage = memoryStorage(raw);
  const loaded = loadSettings(storage);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.settings, { ...legacy, googleDestinationLabels: [] });
  assert.equal(storage.raw, raw, 'Reading optional defaults never rewrites legacy settings');
  assert.equal(saveSettings(loaded.settings, storage).ok, true);
  assert.deepEqual(loadSettings(storage).settings, { ...legacy, googleDestinationLabels: [] });
});

test('Local Google names persist without external calendar IDs or disturbing reminder settings', () => {
  const storage = memoryStorage();
  const preferences = {
    ...DEFAULT_SETTINGS, calendarTarget: 'local', pageAlertsEnabled: false, soundEnabled: true,
    calendarAlarmMinutes: 30,
    googleDestinationLabels: [
      { id: ' google-work ', provider: 'google', name: ' 客戶會議 ', source: 'local-label', calendarId: 'example-external-id', authenticated: true },
      { id: 'google-life', provider: 'google', name: '生活', source: 'local-label' },
    ],
  };
  assert.equal(saveSettings(preferences, storage).ok, true);
  const actual = loadSettings(storage).settings;
  assert.equal(actual.calendarTarget, 'local');
  assert.equal(actual.pageAlertsEnabled, false);
  assert.equal(actual.soundEnabled, true);
  assert.equal(actual.calendarAlarmMinutes, 30);
  assert.deepEqual(actual.googleDestinationLabels, [
    { id: 'google-work', provider: 'google', name: '客戶會議', source: 'local-label' },
    { id: 'google-life', provider: 'google', name: '生活', source: 'local-label' },
  ]);
  assert.equal(storage.raw.includes('calendarId'), false);
  assert.equal(storage.raw.includes('authenticated'), false);
});

test('Reading malformed or future-source settings labels filters them without rewriting raw settings', () => {
  const valid = { id: 'google-work', provider: 'google', name: '工作', source: 'local-label' };
  const raw = JSON.stringify({
    calendarTarget: 'google', commonPlaces: [],
    googleDestinationLabels: [valid, { ...valid, id: 'future', source: 'oauth' }, { ...valid, id: 'unknown', provider: 'future-provider' }, valid],
  });
  const storage = memoryStorage(raw);
  const loaded = loadSettings(storage);
  assert.deepEqual(loaded.settings.googleDestinationLabels, [valid]);
  assert.equal(loaded.settings.calendarTarget, 'google');
  assert.equal(storage.raw, raw);
});
