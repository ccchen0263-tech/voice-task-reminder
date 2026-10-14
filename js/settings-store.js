import { normalizeDestinationLabels } from './destinations.js';

export const SETTINGS_KEY = 'voice-task-reminder.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'personal',
  calendarTarget: 'google',
  commonPlaces: [],
  pageAlertsEnabled: true,
  soundEnabled: false,
  systemNotifications: false,
  calendarAlarmMinutes: null,
  googleDestinationLabels: [],
});

const CALENDAR_TARGETS = new Set(['google', 'apple', 'local']);
const CALENDAR_ALARM_MINUTES = new Set([null, 0, 10, 30]);

function safeCoordinate(value, min, max) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizePlace(place) {
  if (!place || typeof place !== 'object') return null;
  const name = typeof place.name === 'string' ? place.name.trim() : '';
  const address = typeof place.address === 'string' ? place.address.trim() : '';
  if (!name || !address) return null;
  return {
    id: typeof place.id === 'string' && place.id.trim() ? place.id.trim() : `place-${name}`,
    name: name.slice(0, 80),
    address: address.slice(0, 300),
    lat: safeCoordinate(place.lat, -90, 90),
    lng: safeCoordinate(place.lng, -180, 180),
  };
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const commonPlaces = Array.isArray(source.commonPlaces)
    ? source.commonPlaces.map(normalizePlace).filter(Boolean).slice(0, 20)
    : [];
  return {
    mode: 'personal',
    calendarTarget: CALENDAR_TARGETS.has(source.calendarTarget) ? source.calendarTarget : DEFAULT_SETTINGS.calendarTarget,
    commonPlaces,
    pageAlertsEnabled: typeof source.pageAlertsEnabled === 'boolean' ? source.pageAlertsEnabled : DEFAULT_SETTINGS.pageAlertsEnabled,
    soundEnabled: typeof source.soundEnabled === 'boolean' ? source.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
    systemNotifications: typeof source.systemNotifications === 'boolean' ? source.systemNotifications : DEFAULT_SETTINGS.systemNotifications,
    calendarAlarmMinutes: CALENDAR_ALARM_MINUTES.has(source.calendarAlarmMinutes) ? source.calendarAlarmMinutes : DEFAULT_SETTINGS.calendarAlarmMinutes,
    googleDestinationLabels: normalizeDestinationLabels(source.googleDestinationLabels),
  };
}

export function loadSettings(storage) {
  try {
    storage ??= globalThis.localStorage;
    if (!storage || typeof storage.getItem !== 'function') throw new Error('Storage unavailable');
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw === null) return { settings: normalizeSettings(DEFAULT_SETTINGS), error: null };
    try {
      return { settings: normalizeSettings(JSON.parse(raw)), error: null };
    } catch {
      return { settings: normalizeSettings(DEFAULT_SETTINGS), error: '偏好設定無法讀取，已使用預設值；原始設定未覆寫。' };
    }
  } catch {
    return { settings: normalizeSettings(DEFAULT_SETTINGS), error: '無法讀取本機偏好設定；仍可使用目前頁面。' };
  }
}

export function saveSettings(settings, storage) {
  try {
    storage ??= globalThis.localStorage;
    if (!storage || typeof storage.setItem !== 'function') throw new Error('Storage unavailable');
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: '偏好設定未儲存，請確認瀏覽器允許本機儲存。' };
  }
}
