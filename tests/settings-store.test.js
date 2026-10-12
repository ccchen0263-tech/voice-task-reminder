import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_KEY, loadSettings, saveSettings } from '../js/settings-store.js';

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
