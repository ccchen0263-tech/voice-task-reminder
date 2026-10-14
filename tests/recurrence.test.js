import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createNextOccurrence, getRecurrenceRule, nextRepeatTime, normalizeRepeat, repeatLabel, REPEAT_OPTIONS } from '../js/recurrence.js';
import { loadTasks, saveTasks } from '../js/task-store.js';

const localISO = (year, monthIndex, day, hour = 9, minute = 0, second = 0) => new Date(year, monthIndex, day, hour, minute, second).toISOString();
function task(extra = {}) {
  return {
    id: 'root', title: '喝水', originalInput: '明早九點提醒我喝水', notes: '先準備杯子', category: 'health',
    location: '公司', locationAddress: '台北市', locationLat: 25, locationLng: 121, mode: 'personal',
    completed: false, reminderAt: localISO(2026, 9, 13), repeat: 'daily', seriesId: 'root',
    createdAt: '2026-10-11T00:00:00.000Z', attachments: [], ...extra,
  };
}

test('repeat choices normalize missing or unknown values to none and have Taiwan labels', () => {
  assert.deepEqual(REPEAT_OPTIONS.map(option => option.value), ['none', 'daily', 'weekly', 'weekdays', 'monthly', 'yearly']);
  assert.equal(normalizeRepeat(undefined), 'none');
  assert.equal(normalizeRepeat('yearly'), 'yearly');
  assert.equal(normalizeRepeat('once'), 'none');
  assert.equal(repeatLabel('none'), '一次（不重複）');
  assert.equal(repeatLabel('once'), '一次（不重複）');
  assert.equal(repeatLabel('weekdays'), '週一至週五');
  assert.ok(Object.isFrozen(REPEAT_OPTIONS));
});

test('daily recurrence is strictly after both its original time and now', () => {
  const original = task({ reminderAt: localISO(2026, 9, 13, 9, 20, 45) });
  for (const now of [new Date(2026, 9, 12, 8), new Date(2026, 9, 13, 9, 20, 45)]) {
    assert.equal(nextRepeatTime(original, now), localISO(2026, 9, 14, 9, 20, 45));
  }
  assert.equal(nextRepeatTime(original, new Date(2026, 9, 15, 8)), localISO(2026, 9, 15, 9, 20, 45));
  assert.equal(nextRepeatTime(original, new Date(2026, 9, 15, 9, 20, 45)), localISO(2026, 9, 16, 9, 20, 45));
});

test('weekly recurrence keeps its weekday and skips old weeks directly', () => {
  const original = task({ repeat: 'weekly', reminderAt: localISO(2026, 9, 13, 10, 15) });
  assert.equal(nextRepeatTime(original, new Date(2026, 9, 13, 11)), localISO(2026, 9, 20, 10, 15));
  assert.equal(nextRepeatTime(original, new Date(2026, 10, 5, 8)), localISO(2026, 10, 10, 10, 15));
});

test('weekdays skips Saturday and Sunday, including old tasks completed during a weekend', () => {
  const original = task({ repeat: 'weekdays', reminderAt: localISO(2026, 9, 16, 8) });
  assert.equal(nextRepeatTime(original, new Date(2026, 9, 16, 9)), localISO(2026, 9, 19, 8));
  assert.equal(nextRepeatTime(original, new Date(2026, 9, 24, 12)), localISO(2026, 9, 26, 8));
});

test('monthly short-month clamping retains the January 31 anchor through March', () => {
  const original = task({ repeat: 'monthly', repeatDay: 31, reminderAt: localISO(2026, 0, 31, 10) });
  const february = createNextOccurrence(original, { id: 'feb', now: new Date(2026, 0, 31, 11) });
  assert.equal(february.reminderAt, localISO(2026, 1, 28, 10));
  assert.equal(february.repeatDay, 31);
  assert.equal(february.repeatParentId, 'root');
  const march = createNextOccurrence(february, { id: 'mar', now: new Date(2026, 1, 28, 11) });
  assert.equal(march.reminderAt, localISO(2026, 2, 31, 10));
  assert.equal(march.repeatDay, 31);
  assert.equal(march.repeatParentId, 'feb');
  assert.equal(march.seriesId, 'root');
});

test('monthly leap years and same-day clocks select the next strictly future occurrence', () => {
  const leap = task({ repeat: 'monthly', repeatDay: 31, reminderAt: localISO(2024, 0, 31, 10) });
  assert.equal(nextRepeatTime(leap, new Date(2024, 0, 31, 11)), localISO(2024, 1, 29, 10));
  assert.equal(nextRepeatTime(leap, new Date(2024, 1, 29, 9)), localISO(2024, 1, 29, 10));
  assert.equal(nextRepeatTime(leap, new Date(2024, 1, 29, 10)), localISO(2024, 2, 31, 10));
  assert.equal(nextRepeatTime(leap, new Date(2025, 1, 28, 11)), localISO(2025, 2, 31, 10));
});

test('stale recurrences jump directly to one future task without generating a backlog', () => {
  const original = task({ reminderAt: localISO(2000, 0, 1, 9) });
  const now = new Date(2099, 9, 13, 12);
  const next = createNextOccurrence(original, { id: 'future', now });
  assert.equal(next.reminderAt, localISO(2099, 9, 14, 9));
  assert.equal(next.completed, false);
  assert.equal(next.createdAt, now.toISOString());
  assert.equal(next.seriesId, 'root');
});

test('generated tasks preserve metadata and attachment IDs without mutating the parent', () => {
  const attachment = { id: 'file-1', name: 'memo.pdf', type: 'application/pdf', size: 100, kind: 'file', createdAt: '2026-10-11T00:00:00.000Z' };
  const original = Object.freeze(task({ completed: true, attachments: Object.freeze([Object.freeze(attachment)]), updatedAt: '2026-10-12T00:00:00.000Z' }));
  const next = createNextOccurrence(original, { id: 'child', now: new Date(2026, 9, 13, 10) });
  for (const field of ['title', 'originalInput', 'notes', 'category', 'location', 'locationAddress', 'locationLat', 'locationLng', 'mode']) {
    assert.equal(next[field], original[field]);
  }
  assert.deepEqual(next.attachments, original.attachments);
  assert.notEqual(next.attachments, original.attachments);
  assert.notEqual(next.attachments[0], attachment);
  assert.equal(next.repeatParentId, 'root');
  assert.equal(next.completed, false);
  assert.equal(Object.hasOwn(next, 'updatedAt'), false);
});

test('duplicate series occurrence or duplicate IDs are rejected regardless of completion', () => {
  const original = task();
  const now = new Date(2026, 9, 13, 10);
  const existing = createNextOccurrence(original, { id: 'existing', now });
  for (const completed of [false, true]) {
    assert.equal(createNextOccurrence(original, { id: 'duplicate', now, existingTasks: [{ ...existing, repeatParentId: undefined, completed }] }), null);
  }
  assert.equal(createNextOccurrence(original, { id: 'existing', now, existingTasks: [task({ id: 'existing', seriesId: 'another' })] }), null);
  assert.equal(createNextOccurrence(original, { id: 'root', now }), null);
  assert.equal(createNextOccurrence(original, { id: '', now }), null);
});

test('uncheck and recheck never generates another child after time advances or the existing child is moved', () => {
  const original = task();
  const child = createNextOccurrence(original, { id: 'child', now: new Date(2026, 9, 13, 10) });
  for (const completed of [false, true]) {
    const editedChild = { ...child, completed, reminderAt: localISO(2026, 9, 30, 16) };
    assert.equal(createNextOccurrence(original, {
      id: 'another-child', now: new Date(2026, 9, 20, 12), existingTasks: [editedChild],
    }), null);
  }
  const memoChild = { ...child, reminderAt: null, repeat: 'none' };
  assert.equal(createNextOccurrence(original, {
    id: 'another-child', now: new Date(2026, 9, 20, 12), existingTasks: [memoChild],
  }), null);
});

test('missing or invalid times, nonrecurring tasks and exhausted year bounds return null', () => {
  for (const original of [task({ repeat: 'none' }), task({ repeat: 'fortnightly' }), task({ reminderAt: null }), task({ reminderAt: '2026-02-30T01:00:00Z' })]) {
    assert.equal(nextRepeatTime(original, new Date(2026, 9, 13, 10)), null);
    assert.equal(createNextOccurrence(original, { id: 'no-child', now: new Date(2026, 9, 13, 10) }), null);
  }
  assert.equal(nextRepeatTime(task(), new Date(NaN)), null);
  assert.equal(nextRepeatTime(task({ reminderAt: '9999-12-31T12:00:00.000Z' }), new Date('9999-12-31T12:00:00.000Z')), null);
});

test('local wall clocks survive daily, weekly and monthly DST changes', () => {
  const moduleUrl = new URL('../js/recurrence.js', import.meta.url).href;
  const script = `
    import { nextRepeatTime } from ${JSON.stringify(moduleUrl)};
    const cases = [
      ['daily', new Date(2026, 2, 7, 9, 15), new Date(2026, 2, 7, 10)],
      ['weekly', new Date(2026, 2, 4, 9, 15), new Date(2026, 2, 4, 10)],
      ['monthly', new Date(2026, 1, 28, 9, 15), new Date(2026, 2, 28, 8)],
      ['daily', new Date(2026, 9, 31, 9, 15), new Date(2026, 9, 31, 10)]
    ];
    process.stdout.write(JSON.stringify(cases.map(([repeat, original, now]) => {
      const next = new Date(nextRepeatTime({ repeat, reminderAt: original.toISOString() }, now));
      return [next.getMonth(), next.getDate(), next.getHours(), next.getMinutes(), (next - original) / 3600000];
    })));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), [
    [2, 8, 9, 15, 23], [2, 11, 9, 15, 167], [2, 28, 9, 15, 671], [10, 1, 9, 15, 25],
  ]);
});

test('a parent completion and next occurrence can be stored together, and failed writes leave original data', () => {
  const original = task();
  let raw = JSON.stringify([original]);
  const before = raw;
  let writes = 0;
  const storage = {
    getItem() { return raw; },
    setItem(key, value) { writes++; raw = value; },
  };
  const next = createNextOccurrence(original, { id: 'child', now: new Date(2026, 9, 13, 10) });
  const transaction = [{ ...original, completed: true }, next];
  assert.equal(saveTasks(transaction, storage).ok, true);
  assert.equal(writes, 1);
  assert.equal(loadTasks(storage).tasks.length, 2);
  assert.equal(loadTasks(storage).tasks[0].completed, true);
  raw = before;
  storage.setItem = () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); };
  assert.equal(saveTasks(transaction, storage).ok, false);
  assert.equal(raw, before);
});

test('yearly February 29 clamps non-leap years without losing its month or day anchors', () => {
  const original = task({ repeat: 'yearly', repeatMonth: 2, repeatDay: 29, reminderAt: localISO(2024, 1, 29, 9, 10, 15) });
  const next = createNextOccurrence(original, { id: '2025', now: new Date(2024, 1, 29, 10) });
  assert.equal(next.reminderAt, localISO(2025, 1, 28, 9, 10, 15));
  assert.equal(next.repeatMonth, 2);
  assert.equal(next.repeatDay, 29);
  assert.equal(next.seriesId, 'root');
  assert.equal(next.repeatParentId, 'root');
  assert.equal(nextRepeatTime(next, new Date(2028, 1, 28, 10)), localISO(2028, 1, 29, 9, 10, 15));
  assert.equal(nextRepeatTime(next, new Date(2028, 1, 29, 9, 10, 15)), localISO(2029, 1, 28, 9, 10, 15));
  const defaultAnchors = createNextOccurrence(task({ repeat: 'yearly', reminderAt: localISO(2024, 1, 29) }), { id: 'default', now: new Date(2024, 1, 29, 10) });
  assert.equal(defaultAnchors.repeatMonth, 2);
  assert.equal(defaultAnchors.repeatDay, 29);
});

test('recurrence rules express exact short-month clamping and yearly anchors', () => {
  assert.equal(getRecurrenceRule(task()), 'FREQ=DAILY');
  assert.equal(getRecurrenceRule(task({ repeat: 'weekly' })), 'FREQ=WEEKLY');
  assert.equal(getRecurrenceRule(task({ repeat: 'weekdays' })), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(getRecurrenceRule(task({ repeat: 'monthly', repeatDay: 31 })), 'FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1');
  assert.equal(getRecurrenceRule(task({ repeat: 'yearly', repeatMonth: 2, repeatDay: 29 })), 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29,-1;BYSETPOS=1');
  assert.equal(getRecurrenceRule(task({ repeat: 'none' })), null);
  assert.equal(getRecurrenceRule(task({ reminderAt: null })), null);
});

test('nonexistent DST wall clocks are skipped rather than shifted in daily, weekly, monthly and yearly recurrences', () => {
  const moduleUrl = new URL('../js/recurrence.js', import.meta.url).href;
  const script = `
    import { nextRepeatTime } from ${JSON.stringify(moduleUrl)};
    const cases = [
      ['daily', new Date(2026, 2, 7, 2, 30), new Date(2026, 2, 7, 3)],
      ['weekly', new Date(2026, 2, 1, 2, 30), new Date(2026, 2, 1, 3)],
      ['monthly', new Date(2026, 1, 8, 2, 30), new Date(2026, 1, 8, 3)],
      ['yearly', new Date(2025, 2, 8, 2, 30), new Date(2025, 2, 8, 3)]
    ];
    const result = cases.map(([repeat, original, now]) => {
      const next = new Date(nextRepeatTime({ repeat, reminderAt: original.toISOString() }, now));
      return [next.getFullYear(), next.getMonth() + 1, next.getDate(), next.getHours(), next.getMinutes()];
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), [
    [2026, 3, 9, 2, 30], [2026, 3, 15, 2, 30], [2026, 4, 8, 2, 30], [2027, 3, 8, 2, 30],
  ]);
});
