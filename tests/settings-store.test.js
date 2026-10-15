import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, normalizeSettings, saveSettings } from '../js/settings-store.js';

function memoryStorage(raw = null) {
  let writes = 0;
  return {
    getItem(key) { assert.equal(key, SETTINGS_KEY); return raw; },
    setItem(key, value) { assert.equal(key, SETTINGS_KEY); raw = value; writes += 1; },
    get raw() { return raw; },
    get writes() { return writes; },
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
  assert.deepEqual(loaded.settings, { ...legacy, googleDestinationLabels: [], preferredDestinationId: 'local' });
  assert.equal(storage.raw, raw, 'Reading optional defaults never rewrites legacy settings');
  assert.equal(saveSettings(loaded.settings, storage).ok, true);
  assert.deepEqual(loadSettings(storage).settings, { ...legacy, googleDestinationLabels: [], preferredDestinationId: 'local' });
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

test('fresh preferences default to local without writing storage or guessing from calendarTarget', () => {
  const storage = memoryStorage();
  const loaded = loadSettings(storage);
  assert.equal(loaded.settings.preferredDestinationId, 'local');
  assert.equal(loaded.destinationWarning, null);
  assert.equal(storage.raw, null);
  assert.equal(storage.writes, 0);
  for (const calendarTarget of ['google', 'apple', 'local']) {
    const raw = JSON.stringify({ calendarTarget });
    const legacyStorage = memoryStorage(raw);
    const legacy = loadSettings(legacyStorage);
    assert.equal(legacy.settings.calendarTarget, calendarTarget);
    assert.equal(legacy.settings.preferredDestinationId, 'local');
    assert.equal(legacy.destinationWarning, null);
    assert.equal(legacyStorage.raw, raw);
    assert.equal(legacyStorage.writes, 0);
  }
});

test('preferred built-in Google, Apple and named Google destinations survive save and reload', () => {
  const label = { id: 'google-work', provider: 'google', name: '工作', source: 'local-label' };
  for (const preferredDestinationId of ['local', 'google-draft', 'apple', label.id]) {
    const storage = memoryStorage();
    const preferences = { preferredDestinationId, googleDestinationLabels: [label], pageAlertsEnabled: false, calendarAlarmMinutes: 10 };
    assert.equal(saveSettings(preferences, storage).ok, true);
    const loaded = loadSettings(storage);
    assert.equal(loaded.settings.preferredDestinationId, preferredDestinationId);
    assert.deepEqual(loaded.settings.googleDestinationLabels, [label]);
    assert.equal(loaded.settings.pageAlertsEnabled, false);
    assert.equal(loaded.settings.calendarAlarmMinutes, 10);
    assert.equal(loaded.destinationWarning, null);
    assert.equal(storage.writes, 1);
    assert.equal(loadSettings(storage).settings.preferredDestinationId, preferredDestinationId);
    assert.equal(storage.writes, 1, 'Reload must never mutate preferences');
  }
});

test('dangling preferred destination IDs warn and fall back to local without overwriting raw settings', () => {
  for (const preferredDestinationId of ['removed-label', 'remote-calendar-id', 'google-work']) {
    const raw = JSON.stringify({ preferredDestinationId, googleDestinationLabels: [] });
    const storage = memoryStorage(raw);
    const loaded = loadSettings(storage);
    assert.equal(loaded.settings.preferredDestinationId, 'local');
    assert.equal(loaded.error, null);
    assert.equal(loaded.destinationWarning, '上次的目的地已不存在，已改用本機任務，請重新選擇。');
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
  }
});

test('removing a selected local Google label normalizes preference to local and leaves built-ins selectable', () => {
  const label = { id: 'google-work', provider: 'google', name: '工作', source: 'local-label' };
  const before = normalizeSettings({ preferredDestinationId: label.id, googleDestinationLabels: [label] });
  const deleted = normalizeSettings({ ...before, googleDestinationLabels: [] });
  assert.equal(deleted.preferredDestinationId, 'local');
  assert.equal(before.preferredDestinationId, label.id);
  assert.deepEqual(before.googleDestinationLabels, [label]);
  const storage = memoryStorage();
  assert.equal(saveSettings(deleted, storage).ok, true);
  assert.equal(loadSettings(storage).settings.preferredDestinationId, 'local');
  assert.equal(loadSettings(storage).destinationWarning, null, 'Explicitly saving a valid local fallback needs no stale-choice warning');
  assert.equal(normalizeSettings({ preferredDestinationId: 'google-draft', googleDestinationLabels: [] }).preferredDestinationId, 'google-draft');
});

test('missing, empty or malformed preference fields never invent an external destination', () => {
  for (const preferredDestinationId of [undefined, null, '', '  ', 12, false, {}, []]) {
    const raw = JSON.stringify({ preferredDestinationId, calendarTarget: 'google' });
    const storage = memoryStorage(raw);
    const loaded = loadSettings(storage);
    assert.equal(loaded.settings.preferredDestinationId, 'local');
    assert.equal(loaded.destinationWarning, null);
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
  }
  assert.equal(normalizeSettings({ preferredDestinationId: ' google-draft ' }).preferredDestinationId, 'google-draft');
});

test('a preference cannot promote an OAuth source, a reserved label ID or an authenticated calendar field', () => {
  const raw = JSON.stringify({
    preferredDestinationId: 'remote-work',
    googleDestinationLabels: [
      { id: 'remote-work', provider: 'google', name: '工作', source: 'oauth', calendarId: 'private-calendar-id' },
      { id: 'google-draft', provider: 'google', name: '假的內建', source: 'local-label' },
      { id: 'apple', provider: 'google', name: '假的Apple', source: 'local-label' },
    ],
  });
  const storage = memoryStorage(raw);
  const loaded = loadSettings(storage);
  assert.equal(loaded.settings.preferredDestinationId, 'local');
  assert.deepEqual(loaded.settings.googleDestinationLabels, []);
  assert.ok(loaded.destinationWarning);
  assert.equal(storage.raw, raw);
  assert.equal(storage.writes, 0);
});

test('quota failure preserves the previous preferred destination and labels instead of writing empty data', () => {
  const previous = JSON.stringify({ preferredDestinationId: 'apple', googleDestinationLabels: [] });
  const backing = memoryStorage(previous);
  let attempts = 0;
  const fullStorage = {
    getItem: backing.getItem,
    setItem() { attempts += 1; throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); },
  };
  const result = saveSettings({ preferredDestinationId: 'google-draft' }, fullStorage);
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(attempts, 1);
  assert.equal(backing.raw, previous);
  assert.equal(loadSettings(backing).settings.preferredDestinationId, 'apple');
  assert.equal(backing.writes, 0);
});
