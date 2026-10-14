import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  getMonthDays, getWeekDays, shiftDateKey, toLocalDateKey, toDateTimeLocal, parseDateTimeLocal, shiftMonth,
} from '../js/planner.js';

test('Leap February is a 42-cell Monday-first grid with both adjacent months', () => {
  const cells = getMonthDays(2024, 1, { today: new Date(2024, 1, 29, 12) });
  assert.equal(cells.length, 42);
  assert.equal(cells[0].dateKey, '2024-01-29');
  assert.equal(cells.at(-1).dateKey, '2024-03-10');
  assert.equal(cells.filter(cell => cell.inMonth).length, 29);
  assert.equal(cells.filter(cell => cell.isToday).length, 1);
  assert.equal(cells.find(cell => cell.isToday).dateKey, '2024-02-29');
  assert.equal(cells[0].inMonth, false);
  assert.equal(new Set(cells.map(cell => cell.dateKey)).size, 42);
});

test('Monday-start and Sunday-start months keep a fixed six-week calendar', () => {
  const monday = getMonthDays(2021, 1);
  assert.equal(monday[0].dateKey, '2021-02-01');
  assert.equal(monday.at(-1).dateKey, '2021-03-14');
  assert.equal(monday.filter(cell => cell.inMonth).length, 28);
  const sunday = getMonthDays(2026, 1);
  assert.equal(sunday[0].dateKey, '2026-01-26');
  assert.equal(sunday[6].dateKey, '2026-02-01');
  assert.equal(sunday.at(-1).dateKey, '2026-03-08');
});

test('December grids and month navigation correctly cross year boundaries', () => {
  const cells = getMonthDays(2026, 11);
  assert.equal(cells[0].dateKey, '2026-11-30');
  assert.equal(cells.at(-1).dateKey, '2027-01-10');
  assert.equal(cells.at(-1).year, 2027);
  assert.equal(cells.at(-1).monthIndex, 0);
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, monthIndex: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, monthIndex: 11 });
  assert.deepEqual(shiftMonth(2026, 4, -29), { year: 2023, monthIndex: 11 });
  assert.throws(() => shiftMonth(2026, 0, 0.5), TypeError);
});

test('Counts use local dates and omit completed, unscheduled, or invalid tasks', () => {
  const at = (month, day, hour) => new Date(2024, month, day, hour).toISOString();
  const tasks = [
    { reminderAt: at(1, 29, 0), completed: false },
    { reminderAt: at(1, 29, 23), completed: false },
    { reminderAt: at(1, 29, 10), completed: true },
    { reminderAt: at(2, 1, 10), completed: false },
    { reminderAt: null, completed: false },
    { reminderAt: 'invalid', completed: false },
    { reminderAt: '2024-02-30T10:00:00Z', completed: false },
    null,
  ];
  const cells = getMonthDays(2024, 1, { tasks });
  assert.equal(cells.find(cell => cell.dateKey === '2024-02-29').taskCount, 2);
  assert.equal(cells.find(cell => cell.dateKey === '2024-03-01').taskCount, 1);
  assert.equal(cells.reduce((sum, cell) => sum + cell.taskCount, 0), 3);
  assert.ok(getMonthDays(2024, 1).every(cell => cell.taskCount === 0));
});

test('Local datetime values round-trip valid leap dates without year 00–99 coercion', () => {
  const leap = parseDateTimeLocal('2024-02-29T08:05');
  assert.equal(leap, new Date(2024, 1, 29, 8, 5).toISOString());
  assert.equal(toDateTimeLocal(leap), '2024-02-29T08:05');
  assert.equal(toLocalDateKey(new Date(leap)), '2024-02-29');
  const earlyYear = parseDateTimeLocal('0026-10-13T08:05');
  assert.equal(new Date(earlyYear).getFullYear(), 26);
  assert.equal(toDateTimeLocal(earlyYear), '0026-10-13T08:05');
});

test('Malformed, blank, or rollover dates cannot silently become valid reminders', () => {
  const invalid = [
    '', ' ', null, undefined, '2026-02-29T08:00', '2024-02-30T08:00',
    '2026-04-31T08:00', '2026-00-01T08:00', '2026-13-01T08:00',
    '2026-10-00T08:00', '2026-10-13T24:00', '2026-10-13T08:60',
    '0000-10-13T08:00', '2026/10/13 08:00', '2026-10-13T08:00Z',
    '2026-10-13T08:00:00', ' 2026-10-13T08:00',
  ];
  for (const value of invalid) assert.equal(parseDateTimeLocal(value), null, String(value));
  for (const value of ['', null, 'invalid', '2026-02-30T08:00:00Z']) {
    assert.equal(toDateTimeLocal(value), '');
  }
  assert.equal(toLocalDateKey(new Date('invalid')), '');
  assert.equal(toLocalDateKey(null), '');
});

function runInTimezone(timezone, code) {
  const moduleURL = new URL('../js/planner.js', import.meta.url).href;
  const source = `import {toDateTimeLocal,parseDateTimeLocal,getMonthDays,getWeekDays,shiftDateKey} from ${JSON.stringify(moduleURL)};\n${code}`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TZ: timezone }, encoding: 'utf8',
  }));
}

test('UTC instants convert to local dates on both sides of a calendar-day boundary', () => {
  const code = `
    const instant = '2026-01-01T00:30:00.000Z';
    const local = toDateTimeLocal(instant);
    const cells = getMonthDays(2026, 0, {tasks: [{reminderAt: instant, completed: false}]});
    console.log(JSON.stringify({local, roundTrip: parseDateTimeLocal(local), counted: cells.find(cell => cell.taskCount === 1).dateKey}));
  `;
  assert.deepEqual(runInTimezone('Asia/Taipei', code), {
    local: '2026-01-01T08:30', roundTrip: '2026-01-01T00:30:00.000Z', counted: '2026-01-01',
  });
  assert.deepEqual(runInTimezone('America/Los_Angeles', code), {
    local: '2025-12-31T16:30', roundTrip: '2026-01-01T00:30:00.000Z', counted: '2025-12-31',
  });
});

test('DST gaps are rejected and calendar grids still contain 42 distinct civil days', () => {
  const result = runInTimezone('America/New_York', `
    const cells = getMonthDays(2026, 2);
    console.log(JSON.stringify({gap: parseDateTimeLocal('2026-03-08T02:30'), count: cells.length, unique: new Set(cells.map(cell => cell.dateKey)).size}));
  `);
  assert.deepEqual(result, { gap: null, count: 42, unique: 42 });
});

test('Selected weeks are Monday-first across year and leap-month boundaries', () => {
  const newYear = getWeekDays('2027-01-01');
  assert.equal(newYear.length, 7);
  assert.equal(newYear[0].dateKey, '2026-12-28');
  assert.equal(newYear.at(-1).dateKey, '2027-01-03');
  assert.ok(newYear.every(cell => cell.inMonth));
  const leap = getWeekDays('2024-02-29', { today: new Date(2024, 1, 29, 12) });
  assert.equal(leap[0].dateKey, '2024-02-26');
  assert.equal(leap.at(-1).dateKey, '2024-03-03');
  assert.equal(leap.filter(cell => cell.isToday).length, 1);
  assert.equal(leap.find(cell => cell.isToday).day, 29);
});

test('Week counts omit completed and unscheduled tasks just like monthly counts', () => {
  const reminder = new Date(2026, 11, 31, 23, 30).toISOString();
  const tasks = [
    { reminderAt: reminder, completed: false }, { reminderAt: reminder, completed: true },
    { reminderAt: null, completed: false }, { reminderAt: 'invalid', completed: false },
  ];
  const week = getWeekDays('2027-01-01', { tasks });
  assert.equal(week.find(cell => cell.dateKey === '2026-12-31').taskCount, 1);
  assert.equal(week.reduce((sum, cell) => sum + cell.taskCount, 0), 1);
});

test('Date key navigation crosses years and leap days while rejecting invalid input', () => {
  assert.equal(shiftDateKey('2026-12-31', 7), '2027-01-07');
  assert.equal(shiftDateKey('2027-01-01', -7), '2026-12-25');
  assert.equal(shiftDateKey('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDateKey('2024-02-29', 1), '2024-03-01');
  assert.equal(shiftDateKey('2026-02-28', 1), '2026-03-01');
  for (const invalid of ['', null, '2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '2026-01-01T00:00']) {
    assert.deepEqual(getWeekDays(invalid), []);
    assert.equal(shiftDateKey(invalid, 7), '');
  }
  for (const invalid of [0.5, NaN, Infinity, '7', null]) assert.equal(shiftDateKey('2026-10-13', invalid), '');
  assert.equal(shiftDateKey('0001-01-01', -1), '');
  assert.equal(shiftDateKey('9999-12-31', 1), '');
});

test('Week navigation keeps civil dates across both spring and fall DST transitions', () => {
  const result = runInTimezone('America/New_York', `
    const spring = getWeekDays('2026-03-08');
    const fall = getWeekDays('2026-11-01');
    console.log(JSON.stringify({
      springNext: shiftDateKey('2026-03-08', 7), springBack: shiftDateKey('2026-03-15', -7),
      fallNext: shiftDateKey('2026-11-01', 7), spring: spring.map(cell => cell.dateKey),
      fallFirst: fall[0].dateKey, fallLast: fall.at(-1).dateKey,
    }));
  `);
  assert.deepEqual(result, {
    springNext: '2026-03-15', springBack: '2026-03-08', fallNext: '2026-11-08',
    spring: ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'],
    fallFirst: '2026-10-26', fallLast: '2026-11-01',
  });
});
