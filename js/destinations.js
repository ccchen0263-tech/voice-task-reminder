export const BUILTIN_DESTINATIONS = Object.freeze([
  Object.freeze({ id: 'local', provider: 'local', name: '本機任務', source: 'builtin' }),
  Object.freeze({ id: 'apple', provider: 'apple', name: 'Apple 行事曆匯出', source: 'builtin' }),
]);

/** A Google label is a local choice, never an authenticated Google calendar ID. */
export function normalizeDestination(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const builtin = BUILTIN_DESTINATIONS.find(item => item.id === value.id && item.provider === value.provider);
  if (builtin && (value.source === undefined || value.source === 'builtin')) return { ...builtin };
  if (value.provider !== 'google' || value.source !== 'local-label'
    || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 160
    || ['local', 'apple'].includes(value.id.trim())
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) return null;
  return { id: value.id.trim(), provider: 'google', name: value.name.trim(), source: 'local-label' };
}

export function normalizeDestinationLabels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(normalizeDestination).filter(item => {
    if (!item || item.provider !== 'google' || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  }).slice(0, 30);
}

export function availableDestinations(settings = {}) {
  return [...BUILTIN_DESTINATIONS.map(item => ({ ...item })), ...normalizeDestinationLabels(settings.googleDestinationLabels)];
}

export function resolveDestination(id, settings) {
  return availableDestinations(settings).find(item => item.id === id) || null;
}

export function destinationLabel(value) {
  const destination = normalizeDestination(value);
  return !destination ? '未指定（請編輯選擇）' : destination.provider === 'google'
    ? `Google：${destination.name}（本機名稱，未連線）` : destination.name;
}
