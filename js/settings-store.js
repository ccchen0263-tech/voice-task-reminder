export const SETTINGS_KEY = 'voice-task-reminder.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'personal',
  calendarTarget: 'google',
  commonPlaces: [],
});

const CALENDAR_TARGETS = new Set(['google', 'apple', 'local']);

function normalizePlace(place) {
  if (!place || typeof place !== 'object') return null;
  const name = typeof place.name === 'string' ? place.name.trim() : '';
  const address = typeof place.address === 'string' ? place.address.trim() : '';
  if (!name || !address) return null;
  const lat = Number.isFinite(Number(place.lat)) ? Number(place.lat) : null;
  const lng = Number.isFinite(Number(place.lng)) ? Number(place.lng) : null;
  return {
    id: typeof place.id === 'string' && place.id.trim() ? place.id.trim() : `place-${name}`,
    name: name.slice(0, 80),
    address: address.slice(0, 300),
    lat: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
    lng: lng !== null && lng >= -180 && lng <= 180 ? lng : null,
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
  };
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
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

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    if (!storage || typeof storage.setItem !== 'function') throw new Error('Storage unavailable');
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: '偏好設定未儲存，請確認瀏覽器允許本機儲存。' };
  }
}
