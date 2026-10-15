import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_DESTINATIONS, normalizeDestination, normalizeDestinationLabels,
  availableDestinations, resolveDestination, destinationLabel,
} from '../js/destinations.js';

const google = (id, name) => ({ id, provider: 'google', name, source: 'local-label' });

test('Built-in destinations include a disconnected Google draft and retain canonical local and Apple names', () => {
  assert.deepEqual(availableDestinations(), [
    { id: 'local', provider: 'local', name: '本機任務', source: 'builtin' },
    { id: 'apple', provider: 'apple', name: 'Apple 行事曆匯出', source: 'builtin' },
    { id: 'google-draft', provider: 'google', name: 'Google Calendar 草稿', source: 'builtin' },
  ]);
  assert.deepEqual(normalizeDestination({ id: 'local', provider: 'local', name: '冒充 Google' }), BUILTIN_DESTINATIONS[0]);
  assert.deepEqual(resolveDestination('apple', {}), BUILTIN_DESTINATIONS[1]);
  assert.equal(destinationLabel(null), '未指定（請編輯選擇）');
  assert.equal(destinationLabel(resolveDestination('apple')), 'Apple 行事曆（ICS 匯出）');
  assert.equal(destinationLabel(resolveDestination('google-draft')), 'Google 草稿（未連線）');
  const available = availableDestinations();
  available[0].name = '修改複本';
  assert.equal(BUILTIN_DESTINATIONS[0].name, '本機任務');
});

test('Google names contain only local label fields and never claim a connected calendar ID', () => {
  const input = { ...google(' google-work ', ' 工作行程 '), calendarId: 'example-external-id', authenticated: true, shared: true };
  const normalized = normalizeDestination(input);
  assert.deepEqual(normalized, google('google-work', '工作行程'));
  assert.deepEqual(Object.keys(normalized).sort(), ['id', 'name', 'provider', 'source']);
  assert.equal(destinationLabel(normalized), 'Google 草稿：工作行程（本機名稱，未連線）');
  assert.equal(input.id, ' google-work ', 'Normalization must not mutate the source');
});

test('Unknown providers, connected sources, reserved IDs, and malformed labels are rejected', () => {
  const valid = google('google-work', '工作');
  for (const input of [
    null, [], 'google', {}, { ...valid, provider: 'future-provider' },
    { ...valid, source: 'oauth' }, { ...valid, source: 'remote-calendar' },
    { ...valid, source: undefined }, { ...valid, id: 'local' }, { ...valid, id: ' apple ' },
    { ...valid, id: 'google-draft' }, { ...valid, id: ' google-draft ' },
    { ...valid, id: '' }, { ...valid, id: 'id'.repeat(81) },
    { ...valid, name: '' }, { ...valid, name: '名稱'.repeat(41) }, { ...valid, name: 123 },
    { id: 'local', provider: 'local', source: 'local-label' },
    { id: 'apple', provider: 'google', name: 'Apple', source: 'builtin' },
    { id: 'google-draft', provider: 'google', name: '已連線', source: 'oauth' },
    { id: 'google-draft', provider: 'apple', name: 'Google', source: 'builtin' },
  ]) assert.equal(normalizeDestination(input), null);
});

test('Local name CRUD keeps stable IDs and does not mutate previous settings snapshots', () => {
  const original = { googleDestinationLabels: [google('google-work', '工作')] };
  const created = { googleDestinationLabels: normalizeDestinationLabels([...original.googleDestinationLabels, google('google-life', '生活')]) };
  assert.equal(resolveDestination('google-life', created).name, '生活');
  const renamed = { googleDestinationLabels: normalizeDestinationLabels(created.googleDestinationLabels.map(item =>
    item.id === 'google-work' ? { ...item, name: '客戶會議' } : item)) };
  assert.equal(resolveDestination('google-work', renamed).name, '客戶會議');
  assert.equal(resolveDestination('google-work', original).name, '工作');
  const removed = { googleDestinationLabels: normalizeDestinationLabels(renamed.googleDestinationLabels.filter(item => item.id !== 'google-work')) };
  assert.equal(resolveDestination('google-work', removed), null);
  assert.equal(resolveDestination('google-life', removed).name, '生活');
  assert.deepEqual(availableDestinations(removed).map(item => item.id), ['local', 'apple', 'google-draft', 'google-life']);
});

test('Labels are deduplicated by stable ID, capped at thirty, and built-ins cannot be replaced', () => {
  const labels = normalizeDestinationLabels([
    google(' shared-id ', '第一個名稱'), google('shared-id', '第二個名稱'),
    { ...BUILTIN_DESTINATIONS[0] }, google('local', '假的本機'),
    { ...BUILTIN_DESTINATIONS[2] }, google('google-draft', '假的Google草稿'),
    ...Array.from({ length: 40 }, (_, index) => google(`google-${index}`, `名稱 ${index}`)),
  ]);
  assert.equal(labels.length, 30);
  assert.deepEqual(labels[0], google('shared-id', '第一個名稱'));
  assert.equal(new Set(labels.map(item => item.id)).size, 30);
  assert.ok(labels.every(item => item.provider === 'google' && item.source === 'local-label'));
  assert.deepEqual(normalizeDestinationLabels({ labels: [] }), []);
});

test('Untrusted names remain plain label text with the explicit disconnected notice', () => {
  const name = '<img src=x onerror=alert(1)> & 客戶';
  const value = google('google-untrusted', name);
  const label = destinationLabel(value);
  assert.equal(typeof label, 'string');
  assert.equal(label, `Google 草稿：${name}（本機名稱，未連線）`);
  assert.deepEqual(resolveDestination(value.id, { googleDestinationLabels: [value] }), value);
  // The UI must use textContent; this pure API does not return or execute HTML.
});

test('built-in Google normalization strips untrusted external fields and never grants a connected source', () => {
  const canonical = { id: 'google-draft', provider: 'google', name: 'Google Calendar 草稿', source: 'builtin' };
  for (const source of [undefined, 'builtin']) {
    const input = { id: 'google-draft', provider: 'google', source, name: '冒充真實Google行事曆', calendarId: 'private-calendar-id', authenticated: true, token: 'not-a-token' };
    assert.deepEqual(normalizeDestination(input), canonical);
    assert.deepEqual(Object.keys(normalizeDestination(input)).sort(), ['id', 'name', 'provider', 'source']);
  }
  assert.deepEqual(normalizeDestinationLabels([canonical]), []);
  assert.deepEqual(availableDestinations({ googleDestinationLabels: [canonical] }), availableDestinations());
  assert.equal(normalizeDestination({ ...canonical, source: 'local-label' }), null);
  assert.equal(normalizeDestination({ ...canonical, id: 'private-calendar-id' }), null);
  assert.equal(BUILTIN_DESTINATIONS.find(item => item.id === 'apple').name, 'Apple 行事曆匯出');
});
