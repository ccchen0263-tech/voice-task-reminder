import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERTS_KEY, MAX_ALERT_RECORDS, createReminderTracker, getOverdueTasks, reminderKey } from '../js/reminders.js';

const INITIAL_TIME = Date.parse('2026-10-13T08:00:00.000Z');

function task(id = 'task', reminderAt = INITIAL_TIME, overrides = {}) {
  return { id, title: `Synthetic ${id}`, reminderAt: new Date(reminderAt).toISOString(), completed: false, ...overrides };
}

function memoryStorage(raw = null) {
  let writes = 0;
  return {
    getItem(key) { assert.equal(key, ALERTS_KEY); return raw; },
    setItem(key, value) { assert.equal(key, ALERTS_KEY); raw = value; writes += 1; },
    get raw() { return raw; },
    get writes() { return writes; },
  };
}

test('startup priming is quiet for existing overdue tasks but future tasks alert at equality', () => {
  let currentTime = INITIAL_TIME;
  const storage = memoryStorage();
  const tracker = createReminderTracker({ storage, now: () => currentTime });
  const old = task('overdue', INITIAL_TIME - 60_000);
  const boundary = task('already-due');
  const upcoming = task('future', INITIAL_TIME + 60_000);
  assert.equal(tracker.prime([old, boundary, upcoming]), undefined);
  assert.deepEqual(tracker.poll([old, boundary, upcoming]), []);
  currentTime += 60_000;
  assert.deepEqual(tracker.poll([old, boundary, upcoming]), [upcoming]);
  assert.deepEqual(tracker.poll([old, boundary, upcoming]), []);
});

test('a newly opened tab primes quietly without silencing the already-open tab at the due boundary', () => {
  let currentTime = INITIAL_TIME - 1;
  const storage = memoryStorage();
  const due = task();
  const alreadyOpen = createReminderTracker({ storage, now: () => currentTime });
  alreadyOpen.prime([due]);
  currentTime = INITIAL_TIME;
  const newlyOpened = createReminderTracker({ storage, now: () => currentTime });
  newlyOpened.prime([due]);
  assert.equal(storage.raw, null, 'Quiet startup suppression must not be recorded as a delivered alert');
  assert.equal(storage.writes, 0);
  assert.deepEqual(alreadyOpen.poll([due]), [due]);
  assert.ok(JSON.parse(storage.raw).includes(reminderKey(due)));
  assert.deepEqual(newlyOpened.poll([due]), []);
  assert.deepEqual(alreadyOpen.poll([due]), []);
  assert.equal(storage.writes, 1);
});

test('later real alerts do not persist this page\'s quietly primed reminders to the shared ledger', () => {
  const storage = memoryStorage();
  const quietOld = task('quiet', INITIAL_TIME - 1000);
  const realNew = task('new');
  const page = createReminderTracker({ storage, now: () => INITIAL_TIME });
  page.prime([quietOld]);
  assert.deepEqual(page.poll([quietOld, realNew]), [realNew]);
  assert.deepEqual(JSON.parse(storage.raw), [reminderKey(realNew)]);
  const otherPage = createReminderTracker({ storage, now: () => INITIAL_TIME });
  assert.deepEqual(otherPage.poll([quietOld, realNew]), [quietOld]);
  assert.deepEqual(page.poll([quietOld, realNew]), []);
});

test('only unfinished, valid timed tasks still present in the task list can become due', () => {
  const tracker = createReminderTracker({ storage: memoryStorage(), now: () => INITIAL_TIME });
  tracker.prime([]);
  const due = task();
  const completed = task('done', INITIAL_TIME, { completed: true });
  const untimed = task('memo', INITIAL_TIME, { reminderAt: null });
  const malformed = task('invalid', INITIAL_TIME, { reminderAt: '2026-02-30T08:00:00.000Z' });
  const missingId = task('', INITIAL_TIME);
  assert.deepEqual(tracker.poll([completed, untimed, malformed, missingId]), []);
  assert.deepEqual(tracker.poll([due]), [due]);
  assert.deepEqual(tracker.poll([]), [], 'Deleted tasks cannot be returned by the tracker');
});

test('each task/time pair is marked synchronously and deduplicated after reload', () => {
  const storage = memoryStorage();
  const due = task();
  const tracker = createReminderTracker({ storage, now: () => INITIAL_TIME });
  assert.deepEqual(tracker.poll([due, { ...due }]), [due]);
  assert.ok(JSON.parse(storage.raw).includes(reminderKey(due)), 'Ledger marking precedes return to alert channels');
  assert.deepEqual(tracker.poll([due]), []);
  const reloaded = createReminderTracker({ storage, now: () => INITIAL_TIME });
  assert.deepEqual(reloaded.poll([due]), []);
});

test('equivalent time offsets share a key while edited reminder times can alert once again', () => {
  const first = task();
  const offset = { ...first, reminderAt: '2026-10-13T16:00:00+08:00' };
  assert.equal(reminderKey(first), reminderKey(offset));
  const tracker = createReminderTracker({ storage: memoryStorage(), now: () => INITIAL_TIME + 60_000 });
  assert.deepEqual(tracker.poll([first]), [first]);
  assert.deepEqual(tracker.poll([offset]), []);
  const edited = task('task', INITIAL_TIME + 60_000);
  assert.notEqual(reminderKey(edited), reminderKey(first));
  assert.deepEqual(tracker.poll([edited]), [edited]);
  assert.deepEqual(tracker.poll([edited]), []);
});

test('completing and reopening a task do not repeat an already shown reminder', () => {
  const due = task();
  const tracker = createReminderTracker({ storage: memoryStorage(), now: () => INITIAL_TIME });
  assert.deepEqual(tracker.poll([{ ...due, completed: true }]), []);
  assert.deepEqual(tracker.poll([due]), [due]);
  assert.deepEqual(tracker.poll([{ ...due, completed: true }]), []);
  assert.deepEqual(tracker.poll([due]), []);
});

test('write failures keep in-memory deduplication and retry without a second alert', () => {
  const backing = memoryStorage();
  let writable = false;
  const storage = {
    getItem: key => backing.getItem(key),
    setItem(key, value) {
      if (!writable) throw Object.assign(new Error('Synthetic quota error'), { name: 'QuotaExceededError' });
      backing.setItem(key, value);
    },
  };
  const tracker = createReminderTracker({ storage, now: () => INITIAL_TIME });
  const due = task();
  assert.deepEqual(tracker.poll([due]), [due]);
  assert.ok(tracker.error);
  assert.deepEqual(tracker.poll([due]), []);
  writable = true;
  assert.deepEqual(tracker.poll([due]), []);
  assert.equal(tracker.error, null);
  assert.ok(JSON.parse(backing.raw).includes(reminderKey(due)));
});

test('read failures do not overwrite unknown ledger contents and still deduplicate in memory', () => {
  let writes = 0;
  const storage = {
    getItem() { throw Object.assign(new Error('Synthetic blocked read'), { name: 'SecurityError' }); },
    setItem() { writes += 1; },
  };
  const tracker = createReminderTracker({ storage, now: () => INITIAL_TIME });
  const due = task();
  assert.deepEqual(tracker.poll([due]), [due]);
  assert.deepEqual(tracker.poll([due]), []);
  assert.ok(tracker.error);
  assert.equal(writes, 0);
});

test('corrupt ledger JSON or records are preserved while the page uses memory deduplication', () => {
  for (const raw of ['{ broken', '{"not":"an array"}', '["invalid key"]', '[null]']) {
    const storage = memoryStorage(raw);
    const tracker = createReminderTracker({ storage, now: () => INITIAL_TIME });
    const due = task();
    assert.deepEqual(tracker.poll([due]), [due]);
    assert.deepEqual(tracker.poll([due]), []);
    assert.ok(tracker.error);
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
  }
});

test('separate trackers refresh their shared ledger before polling to reduce cross-tab duplicates', () => {
  const storage = memoryStorage();
  const firstTab = createReminderTracker({ storage, now: () => INITIAL_TIME });
  const secondTab = createReminderTracker({ storage, now: () => INITIAL_TIME });
  firstTab.prime([]);
  secondTab.prime([]);
  const first = task('first');
  assert.deepEqual(firstTab.poll([first]), [first]);
  assert.deepEqual(secondTab.poll([first]), []);
  const second = task('second');
  assert.deepEqual(secondTab.poll([first, second]), [second]);
  assert.deepEqual(firstTab.poll([first, second]), []);
  assert.equal(JSON.parse(storage.raw).length, 2);
});

test('the persistent ledger is capped while current-page memory still suppresses older reminders', () => {
  const storage = memoryStorage();
  const tasks = Array.from({ length: MAX_ALERT_RECORDS + 5 }, (_, index) => task(`task-${index}`));
  const tracker = createReminderTracker({ storage, now: () => INITIAL_TIME });
  assert.equal(tracker.poll(tasks).length, tasks.length);
  assert.equal(JSON.parse(storage.raw).length, MAX_ALERT_RECORDS);
  assert.deepEqual(tracker.poll(tasks), []);
  const reloaded = createReminderTracker({ storage, now: () => INITIAL_TIME });
  reloaded.prime(tasks);
  assert.deepEqual(reloaded.poll(tasks), [], 'Reload priming must not flood the page with old reminders');
});

test('pure helpers reject malformed times and preserve original due task references', () => {
  const due = task();
  assert.equal(getOverdueTasks([due], new Date(INITIAL_TIME))[0], due);
  assert.deepEqual(getOverdueTasks([due], NaN), []);
  assert.deepEqual(getOverdueTasks(null, INITIAL_TIME), []);
  for (const reminderAt of [null, '', 'tomorrow', '2026-10-13', '2026-10-13T25:00:00Z', '2026-02-30T08:00:00Z']) {
    assert.equal(reminderKey({ ...due, reminderAt }), null);
  }
});

test('blocked default localStorage access is caught without requesting permissions or throwing', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw Object.assign(new Error('Synthetic blocked storage'), { name: 'SecurityError' }); },
  });
  try {
    const tracker = createReminderTracker({ now: () => INITIAL_TIME });
    assert.ok(tracker.error);
    const due = task();
    assert.deepEqual(tracker.poll([due]), [due]);
    assert.deepEqual(tracker.poll([due]), []);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
