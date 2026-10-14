import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, loadTasks, saveTasks, classifyTasks } from '../js/task-store.js';
import { SETTINGS_KEY, loadSettings, saveSettings } from '../js/settings-store.js';
import { resolveDestination } from '../js/destinations.js';

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
    completed: false, createdAt: '2026-10-11T00:00:00.000Z', category: 'other', notes: '', repeat: 'none', mode: 'personal',
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

test('legacy tasks receive optional field defaults without losing existing identity or completion', () => {
  const legacy = {
    id: 'old-record', title: '買早餐', originalInput: '明早提醒我買早餐',
    reminderAt: '2026-10-13T00:00:00.000Z', completed: true,
    createdAt: '2026-10-11T00:00:00.000Z',
  };
  const storage = memoryStorage(JSON.stringify([legacy]));
  const loaded = loadTasks(storage);
  assert.equal(loaded.error, null);
  assert.equal(loaded.readOnly, false);
  assert.deepEqual(loaded.tasks, [task('old-record', legacy.reminderAt, {
    title: legacy.title, originalInput: legacy.originalInput, completed: true,
  })]);
  assert.equal(storage.writes, 0);
  assert.equal(saveTasks(loaded.tasks, storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, loaded.tasks);
});

test('category, multiline notes and updatedAt persist while edits retain all existing metadata', () => {
  const storage = memoryStorage();
  const existing = task('weekly-meeting', '2026-10-14T01:00:00.000Z', {
    category: 'work', notes: '帶報告\n確認 Q4 budget，保留換行。', completed: true,
    updatedAt: '2026-10-13T12:30:00+08:00', location: '公司', locationAddress: '台北市信義區',
    locationLat: 25.033, locationLng: 121.565,
    attachments: [{ id: 'keep-file', name: 'Budget.pdf', type: 'application/pdf', size: 1200, kind: 'file', createdAt: '2026-10-11T00:01:00.000Z' }],
  });
  assert.equal(saveTasks([existing], storage).ok, true);
  const firstLoad = loadTasks(storage).tasks[0];
  assert.deepEqual(firstLoad, { ...existing, updatedAt: '2026-10-13T04:30:00.000Z' });
  const changed = { ...firstLoad, title: '修改會議名稱', notes: '新的備忘，附件與時間都保留。', category: 'life' };
  assert.equal(saveTasks([changed], storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, [changed]);
});

test('unknown categories and absent notes migrate safely, valid updatedAt is optional', () => {
  for (const category of [undefined, null, 'unknown', 1]) {
    const item = task('migration', null, { category, notes: undefined, updatedAt: 'bad date' });
    const result = loadTasks(memoryStorage(JSON.stringify([item])));
    assert.equal(result.readOnly, false);
    assert.equal(result.tasks[0].category, 'other');
    assert.equal(result.tasks[0].notes, '');
    assert.equal(Object.hasOwn(result.tasks[0], 'updatedAt'), false);
  }
  for (const category of ['work', 'life', 'health', 'other']) {
    const storage = memoryStorage();
    assert.equal(saveTasks([task(category, null, { category })], storage).ok, true);
    assert.equal(loadTasks(storage).tasks[0].category, category);
  }
});

test('notes accept 2000 characters and protect oversized or non-text saved notes', () => {
  const storage = memoryStorage();
  const valid = task('notes', null, { notes: '備'.repeat(2000) });
  assert.equal(saveTasks([valid], storage).ok, true);
  assert.equal(loadTasks(storage).tasks[0].notes.length, 2000);
  for (const notes of ['備'.repeat(2001), { text: 'incorrect shape' }, 100]) {
    const raw = JSON.stringify([task('bad-notes', null, { notes })]);
    const damaged = memoryStorage(raw);
    const loaded = loadTasks(damaged);
    assert.equal(loaded.readOnly, true);
    assert.ok(loaded.error);
    assert.ok(loaded.tasks[0].notes.length <= 2000);
    assert.equal(damaged.raw, raw);
    assert.equal(damaged.writes, 0);
    assert.equal(saveTasks([task('bad-notes', null, { notes })], damaged).ok, false);
    assert.equal(damaged.raw, raw);
  }
});

test('task coordinates distinguish missing values from real zero', () => {
  for (const missing of [undefined, null, '', ' ', false, [], {}]) {
    const storage = memoryStorage();
    assert.equal(saveTasks([task('no-coordinate', null, { locationLat: missing, locationLng: missing })], storage).ok, true);
    const loaded = loadTasks(storage).tasks[0];
    assert.equal(loaded.locationLat, null);
    assert.equal(loaded.locationLng, null);
  }
  for (const zero of [0, '0']) {
    const storage = memoryStorage();
    assert.equal(saveTasks([task('zero-coordinate', null, { locationLat: zero, locationLng: zero })], storage).ok, true);
    const loaded = loadTasks(storage).tasks[0];
    assert.equal(loaded.locationLat, 0);
    assert.equal(loaded.locationLng, 0);
  }
});

test('recurring task metadata round-trips without generating tasks on load', () => {
  const reminderAt = new Date(2026, 0, 31, 9).toISOString();
  const recurring = task('month-root', reminderAt, { repeat: 'monthly', repeatDay: 31, seriesId: 'month-root' });
  const storage = memoryStorage();
  assert.equal(saveTasks([recurring], storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, [recurring]);
  assert.equal(loadTasks(storage).tasks.length, 1);
  assert.equal(storage.writes, 1);
  const child = task('month-child', new Date(2026, 1, 28, 9).toISOString(), {
    repeat: 'monthly', repeatDay: 31, seriesId: 'month-root', repeatParentId: 'month-root',
  });
  assert.equal(saveTasks([recurring, child], storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, [recurring, child]);
});

test('active repeat fields safely default a series ID and monthly day from the local reminder', () => {
  const reminderAt = new Date(2026, 0, 31, 9).toISOString();
  for (const repeat of ['daily', 'weekly', 'weekdays', 'monthly', 'yearly']) {
    const result = loadTasks(memoryStorage(JSON.stringify([task('root', reminderAt, { repeat })])));
    assert.equal(result.readOnly, false);
    assert.equal(result.tasks[0].seriesId, 'root');
    assert.equal(result.tasks[0].repeat, repeat);
    assert.equal(result.tasks[0].repeatDay, repeat === 'monthly' || repeat === 'yearly' ? 31 : undefined);
    assert.equal(result.tasks[0].repeatMonth, repeat === 'yearly' ? 1 : undefined);
  }
  const missingRepeat = task('old-task');
  delete missingRepeat.repeat;
  const legacy = loadTasks(memoryStorage(JSON.stringify([missingRepeat])));
  assert.equal(legacy.readOnly, false);
  assert.equal(legacy.tasks[0].repeat, 'none');
  assert.equal(Object.hasOwn(legacy.tasks[0], 'seriesId'), false);
});

test('unknown repeat or active recurrence without a reminder protects raw storage and refuses save', () => {
  for (const invalid of [
    task('unknown', null, { repeat: 'fortnightly' }),
    task('wrong-type', null, { repeat: 2 }),
    task('no-time', null, { repeat: 'daily' }),
    task('bad-series', '2026-10-14T01:00:00.000Z', { repeat: 'weekly', seriesId: '' }),
    task('bad-parent', '2026-10-14T01:00:00.000Z', { repeat: 'weekly', repeatParentId: {} }),
    task('bad-day', '2026-10-14T01:00:00.000Z', { repeat: 'monthly', repeatDay: 32 }),
    task('bad-month', '2026-10-14T01:00:00.000Z', { repeat: 'yearly', repeatMonth: 13 }),
  ]) {
    const raw = JSON.stringify([invalid]);
    const storage = memoryStorage(raw);
    const loaded = loadTasks(storage);
    assert.equal(loaded.readOnly, true);
    assert.ok(loaded.error);
    assert.equal(storage.raw, raw);
    assert.equal(saveTasks([invalid], storage).ok, false);
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
  }
});

test('a generated child keeps its parent history when repeating is disabled or time is cleared', () => {
  const storage = memoryStorage();
  const memoChild = task('memo-child', null, { repeat: 'none', repeatParentId: 'root' });
  assert.equal(saveTasks([memoChild], storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, [memoChild]);
});

test('yearly February 29 anchors survive non-leap reminders and once aliases migrate safely', () => {
  const storage = memoryStorage();
  const yearly = task('leap-year', new Date(2025, 1, 28, 9).toISOString(), {
    repeat: 'yearly', repeatMonth: 2, repeatDay: 29, seriesId: 'leap-root', repeatParentId: 'previous-leap',
  });
  assert.equal(saveTasks([yearly], storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, [yearly]);
  const once = task('once', null, { repeat: 'once' });
  const legacyRaw = JSON.stringify([once]);
  const legacyStorage = memoryStorage(legacyRaw);
  const loaded = loadTasks(legacyStorage);
  assert.equal(loaded.readOnly, false);
  assert.equal(loaded.tasks[0].repeat, 'none');
  assert.equal(legacyStorage.raw, legacyRaw);
  assert.equal(legacyStorage.writes, 0);
  assert.equal(saveTasks(loaded.tasks, legacyStorage).ok, true);
  assert.equal(loadTasks(legacyStorage).tasks[0].repeat, 'none');
});

test('Legacy or explicitly unspecified destinations never inherit the current global calendar target', () => {
  const legacy = task('legacy');
  delete legacy.destination;
  const storage = memoryStorage(JSON.stringify([legacy, task('explicit-null', null, { destination: null })]));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sharedStorage = {
    getItem(key) {
      return key === SETTINGS_KEY ? JSON.stringify({ calendarTarget: 'apple' }) : storage.getItem(key);
    },
    setItem(key, value) { storage.setItem(key, value); },
  };
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: sharedStorage });
    assert.equal(loadSettings().settings.calendarTarget, 'apple');
    const loaded = loadTasks();
    assert.equal(loaded.readOnly, false);
    assert.equal(Object.hasOwn(loaded.tasks[0], 'destination'), false);
    assert.equal(loaded.tasks[1].destination, null);
    assert.equal(storage.writes, 0);
    assert.equal(saveTasks(loaded.tasks).ok, true);
    const reloaded = loadTasks();
    assert.equal(Object.hasOwn(reloaded.tasks[0], 'destination'), false);
    assert.equal(reloaded.tasks[1].destination, null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('Two tasks retain distinct local destination snapshots through save and reload', () => {
  const first = { id: 'google-work', provider: 'google', name: '工作', source: 'local-label' };
  const second = { id: 'google-life', provider: 'google', name: '生活', source: 'local-label' };
  const tasks = [task('work-task', '2026-10-14T01:00:00.000Z', { destination: first }),
    task('life-task', '2026-10-14T02:00:00.000Z', { destination: second })];
  const storage = memoryStorage();
  assert.equal(saveTasks(tasks, storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks, tasks);
  const loaded = loadTasks(storage);
  assert.notEqual(loaded.tasks[0].destination, first, 'Saved destinations are snapshots, not original object references');
  first.name = '修改來源物件';
  assert.equal(loadTasks(storage).tasks[0].destination.name, '工作');
  assert.equal(loadTasks(storage).tasks[1].destination.name, '生活');
});

test('Renaming or removing global local names leaves existing task destinations untouched', () => {
  const destination = { id: 'google-work', provider: 'google', name: '原始工作名稱', source: 'local-label' };
  let settingsRaw = null;
  const settingsStorage = {
    getItem(key) { assert.equal(key, SETTINGS_KEY); return settingsRaw; },
    setItem(key, value) { assert.equal(key, SETTINGS_KEY); settingsRaw = value; },
  };
  assert.equal(saveSettings({ calendarTarget: 'google', googleDestinationLabels: [destination] }, settingsStorage).ok, true);
  const initialSettings = loadSettings(settingsStorage).settings;
  const storage = memoryStorage();
  const existing = task('keep-snapshot', '2026-10-14T01:00:00.000Z', {
    destination: resolveDestination(destination.id, initialSettings),
  });
  assert.equal(saveTasks([existing], storage).ok, true);
  const taskRaw = storage.raw;

  assert.equal(saveSettings({ ...initialSettings, calendarTarget: 'apple',
    googleDestinationLabels: [{ ...destination, name: '新名稱' }] }, settingsStorage).ok, true);
  assert.equal(resolveDestination(destination.id, loadSettings(settingsStorage).settings).name, '新名稱');
  assert.deepEqual(loadTasks(storage).tasks[0].destination, destination);
  assert.equal(saveSettings({ ...loadSettings(settingsStorage).settings, googleDestinationLabels: [] }, settingsStorage).ok, true);
  assert.equal(resolveDestination(destination.id, loadSettings(settingsStorage).settings), null);
  assert.deepEqual(loadTasks(storage).tasks[0].destination, destination);
  assert.equal(storage.raw, taskRaw);
  assert.equal(storage.writes, 1, 'Global preferences must never write task storage');
});

test('Unknown destination providers or sources protect raw tasks and are refused before writes', () => {
  const valid = { id: 'google-work', provider: 'google', name: '工作', source: 'local-label' };
  for (const destination of [
    { ...valid, provider: 'future-provider' }, { ...valid, source: 'oauth' },
    { ...valid, source: 'remote-calendar' }, { ...valid, name: '' }, 'google-work', {},
  ]) {
    const invalid = task('future-destination', '2026-10-14T01:00:00.000Z', { destination });
    const raw = JSON.stringify([invalid]);
    const storage = memoryStorage(raw);
    const loaded = loadTasks(storage);
    assert.equal(loaded.readOnly, true);
    assert.ok(loaded.error);
    assert.equal(loaded.tasks[0].id, invalid.id, 'Readable task data remains available');
    assert.equal(Object.hasOwn(loaded.tasks[0], 'destination'), false);
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
    assert.equal(saveTasks([invalid], storage).ok, false);
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
  }
});

test('Destination snapshots normalize local fields while preserving untrusted names as plain data', () => {
  const destination = {
    id: ' google-name ', provider: 'google', name: '<img src=x onerror=alert(1)>', source: 'local-label',
    calendarId: 'example-external-id', authenticated: true,
  };
  const storage = memoryStorage();
  assert.equal(saveTasks([task('plain-name', null, { destination })], storage).ok, true);
  assert.deepEqual(loadTasks(storage).tasks[0].destination, {
    id: 'google-name', provider: 'google', name: '<img src=x onerror=alert(1)>', source: 'local-label',
  });
  assert.equal(storage.raw.includes('calendarId'), false);
  assert.equal(storage.raw.includes('authenticated'), false);
});
