import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, loadTasks, saveTasks, classifyTasks } from '../js/task-store.js';

function memoryStorage(initial = null) {
  let raw = initial;
  let writes = 0;
  return {
    getItem(key) { assert.equal(key, STORAGE_KEY); return raw; },
    setItem(key, value) { assert.equal(key, STORAGE_KEY); raw = value; writes += 1; },
    get raw() { return raw; },
    get writes() { return writes; },
  };
}

function task(id, reminderAt = null, extra = {}) {
  return {
    id, title: `任務 ${id}`, originalInput: `提醒我任務 ${id}`, reminderAt,
    completed: false, createdAt: '2026-10-11T00:00:00.000Z', mode: 'personal',
    location: '', locationAddress: '', locationLat: null, locationLng: null, attachments: [], ...extra,
  };
}

test('an empty storage is editable and save/load retains task details', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadTasks(storage), { tasks: [], error: null, readOnly: false });
  const tasks = [task('water', '2026-10-11T04:10:00.000Z'), task('done', null, { completed: true })];
  assert.deepEqual(saveTasks(tasks, storage), { ok: true, error: null });
  assert.deepEqual(loadTasks(storage), { tasks, error: null, readOnly: false });
  assert.equal(storage.writes, 1);
});

test('invalid JSON or a non-array never overwrites stored data', () => {
  for (const raw of ['{ broken JSON', '', 'null', '{}', '42']) {
    const storage = memoryStorage(raw);
    const result = loadTasks(storage);
    assert.equal(result.readOnly, true);
    assert.ok(result.error);
    assert.deepEqual(result.tasks, []);
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
  }
});

test('damaged records and duplicate IDs retain readable tasks in read-only mode', () => {
  const raw = JSON.stringify([
    task('valid'), task('valid', null, { title: '重複任務' }),
    task(123), task('missing', null, { originalInput: undefined }),
    task('bad-created', null, { createdAt: '2026-02-30T00:00:00.000Z' }),
    task('bad-reminder', 'invalid'),
    task('bad-boolean', null, { completed: 'false' }), null,
  ]);
  const storage = memoryStorage(raw);
  const result = loadTasks(storage);
  assert.equal(result.readOnly, true);
  assert.ok(result.error);
  assert.deepEqual(result.tasks.map(item => item.id), ['valid', 'bad-reminder']);
  assert.equal(result.tasks[1].reminderAt, null);
  assert.equal(storage.raw, raw);
  assert.equal(storage.writes, 0);
});

test('a missing reminder is repaired to null and protected from overwrite', () => {
  const item = task('missing');
  delete item.reminderAt;
  const result = loadTasks(memoryStorage(JSON.stringify([item])));
  assert.equal(result.tasks[0].reminderAt, null);
  assert.equal(result.readOnly, true);
  assert.ok(result.error);
});

test('ISO timestamps with an offset are normalized, impossible dates are invalid', () => {
  const result = loadTasks(memoryStorage(JSON.stringify([
    task('offset', '2026-10-11T12:30:00+08:00', { createdAt: '2026-10-11T08:00:00+08:00' }),
  ])));
  assert.equal(result.readOnly, false);
  assert.equal(result.tasks[0].reminderAt, '2026-10-11T04:30:00.000Z');
  assert.equal(result.tasks[0].createdAt, '2026-10-11T00:00:00.000Z');
  for (const date of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-11T24:00:00Z', '2026-10-11']) {
    const invalid = loadTasks(memoryStorage(JSON.stringify([task('invalid', date)])));
    assert.equal(invalid.readOnly, true);
    assert.equal(invalid.tasks[0].reminderAt, null);
  }
});

test('security and quota errors are reported without claiming successful writes', () => {
  const secured = {
    getItem() { throw Object.assign(new Error('blocked'), { name: 'SecurityError' }); },
    setItem() { throw Object.assign(new Error('blocked'), { name: 'SecurityError' }); },
  };
  assert.equal(loadTasks(secured).readOnly, true);
  assert.ok(loadTasks(secured).error);
  assert.equal(saveTasks([task('a')], secured).ok, false);
  const full = { setItem() { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); } };
  const result = saveTasks([task('a')], full);
  assert.equal(result.ok, false);
  assert.match(result.error, /空間不足/);
});

test('save refuses malformed tasks or duplicate IDs before touching storage', () => {
  for (const input of [null, {}, [task('a'), task('a')], [task('a', 'bad date')], [task('a', null, { title: '' })]]) {
    const storage = memoryStorage('original');
    const result = saveTasks(input, storage);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(storage.raw, 'original');
    assert.equal(storage.writes, 0);
  }
});

test('classification uses all four sections, with completion and exact due time taking priority', () => {
  const now = new Date(2026, 9, 11, 12);
  const tasks = [
    task('done-past', new Date(2026, 9, 10, 12).toISOString(), { completed: true }),
    task('due-now', now.toISOString()), task('today', new Date(2026, 9, 11, 13).toISOString()),
    task('tomorrow', new Date(2026, 9, 12, 8).toISOString()), task('unset'),
  ];
  const groups = classifyTasks(tasks, now);
  assert.deepEqual(groups.overdue.map(item => item.id), ['due-now']);
  assert.deepEqual(groups.today.map(item => item.id), ['today']);
  assert.deepEqual(groups.pending.map(item => item.id), ['tomorrow', 'unset']);
  assert.deepEqual(groups.completed.map(item => item.id), ['done-past']);
});

test('the same day-of-month in a future month or year is not a today task', () => {
  const now = new Date(2026, 9, 11, 12);
  const groups = classifyTasks([
    task('next-month', new Date(2026, 10, 11, 13).toISOString()),
    task('next-year', new Date(2027, 9, 11, 13).toISOString()),
  ], now);
  assert.equal(groups.today.length, 0);
  assert.deepEqual(groups.pending.map(item => item.id), ['next-month', 'next-year']);
});

test('sorting places unset times last and breaks equal times by creation date stably', () => {
  const reminder = new Date(2026, 9, 12, 8).toISOString();
  const tasks = [
    task('unset'), task('newer', reminder, { createdAt: '2026-10-11T01:00:00.000Z' }),
    task('old-a', reminder), task('old-b', reminder),
  ];
  const groups = classifyTasks(tasks, new Date(2026, 9, 11, 12));
  assert.deepEqual(groups.pending.map(item => item.id), ['old-a', 'old-b', 'newer', 'unset']);
  assert.deepEqual(tasks.map(item => item.id), ['unset', 'newer', 'old-a', 'old-b']);
});

test('local day boundaries are classified correctly across midnight', () => {
  const now = new Date(2026, 9, 31, 23, 59);
  const groups = classifyTasks([
    task('one-minute-later', new Date(2026, 10, 1, 0, 0).toISOString()),
    task('same-night', new Date(2026, 9, 31, 23, 59, 30).toISOString()),
  ], now);
  assert.deepEqual(groups.today.map(item => item.id), ['same-night']);
  assert.deepEqual(groups.pending.map(item => item.id), ['one-minute-later']);
});

test('extended personal task fields round-trip without changing legacy fields', () => {
  const storage = memoryStorage();
  const extended = task('meeting', '2026-10-11T04:10:00.000Z', {
    location: '公司', locationAddress: '台北市信義區', locationLat: 25.033,
    locationLng: 121.565, attachments: [{
      id: 'attachment-1', name: 'agenda.pdf', type: 'application/pdf', size: 1200,
      kind: 'file', createdAt: '2026-10-11T00:01:00.000Z',
    }],
  });
  assert.equal(saveTasks([extended], storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, [extended]);
});
