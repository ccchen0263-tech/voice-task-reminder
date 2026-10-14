import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CATEGORY, TASK_CATEGORIES, filterTasks, localDateKey, normalizeTaskCategory } from '../js/task-view.js';

function task(id, extra = {}) {
  return {
    id, title: '會議', originalInput: '明早九點提醒我會議', notes: '',
    category: 'work', completed: false, reminderAt: null, location: '', locationAddress: '',
    attachments: [], ...extra,
  };
}

test('category definitions provide stable codes, Taiwan labels and a safe legacy default', () => {
  assert.deepEqual(TASK_CATEGORIES.map(category => [category.code, category.label]), [
    ['work', '工作'], ['life', '生活'], ['health', '健康'], ['other', '其他'],
  ]);
  assert.equal(DEFAULT_CATEGORY, 'other');
  assert.equal(normalizeTaskCategory('health'), 'health');
  assert.equal(normalizeTaskCategory(undefined), 'other');
  assert.equal(normalizeTaskCategory('unknown'), 'other');
  assert.equal(Object.isFrozen(TASK_CATEGORIES), true);
  assert.ok(TASK_CATEGORIES.every(Object.isFrozen));
});

test('agenda defaults to all tasks and filtering keeps original order and references', () => {
  const tasks = Object.freeze([
    Object.freeze(task('a', { completed: true })), Object.freeze(task('b')), Object.freeze(task('c')),
  ]);
  const result = filterTasks(tasks);
  assert.notEqual(result, tasks);
  assert.deepEqual(result, tasks);
  assert.equal(result[0], tasks[0]);
  assert.deepEqual(filterTasks(tasks, { includeCompleted: false }).map(item => item.id), ['b', 'c']);
});

test('search matches title, original input, notes, location, address and attachment names case-insensitively', () => {
  const tasks = [
    task('title', { title: 'Review Budget' }), task('original', { originalInput: '明天提醒我買早餐' }),
    task('notes', { notes: 'Q4 Project Plan\n先確認客戶需求' }), task('location', { location: '信義 Office' }),
    task('address', { locationAddress: '台北市仁愛路三段' }),
    task('attachment', { attachments: [{ id: 'a', name: 'QuarterlyReport.PDF' }] }),
  ];
  for (const [query, expected] of [
    [' budget ', 'title'], ['買早餐', 'original'], ['project plan', 'notes'], ['需求', 'notes'],
    ['office', 'location'], ['仁愛路', 'address'], ['quarterlyreport.pdf', 'attachment'],
  ]) {
    assert.deepEqual(filterTasks(tasks, { query }).map(item => item.id), [expected]);
  }
  assert.equal(filterTasks(tasks, { query: '不存在的搜尋字詞' }).length, 0);
  assert.equal(filterTasks(tasks, { query: '   ' }).length, tasks.length);
});

test('category filtering treats legacy tasks as other and combines query and incomplete filters', () => {
  const tasks = [
    task('work'), task('completed', { completed: true }), task('life', { category: 'life' }),
    task('legacy', { category: undefined }), task('unknown', { category: 'invalid' }),
  ];
  assert.deepEqual(filterTasks(tasks, { category: 'other' }).map(item => item.id), ['legacy', 'unknown']);
  assert.deepEqual(filterTasks(tasks, { query: '會議', category: 'work', includeCompleted: false }).map(item => item.id), ['work']);
  assert.deepEqual(filterTasks(tasks, { category: 'invalid' }), []);
});

test('memo includes only unscheduled tasks and honors category and completion filters', () => {
  const tasks = [
    task('unset'), task('missing', { reminderAt: undefined }), task('invalid', { reminderAt: 'invalid date' }),
    task('scheduled', { reminderAt: '2026-10-13T01:00:00.000Z' }),
    task('completed', { completed: true }), task('life', { category: 'life' }),
  ];
  assert.deepEqual(filterTasks(tasks, { view: 'memo' }).map(item => item.id), ['unset', 'missing', 'invalid', 'completed', 'life']);
  assert.deepEqual(filterTasks(tasks, { view: 'memo', category: 'work', includeCompleted: false }).map(item => item.id), ['unset', 'missing', 'invalid']);
});

test('calendar selects only reminders on a valid local date and respects completed tasks', () => {
  const today = new Date(2026, 9, 13, 9).toISOString();
  const tomorrow = new Date(2026, 9, 14, 9).toISOString();
  const tasks = [
    task('today', { reminderAt: today }), task('done-today', { reminderAt: today, completed: true }),
    task('tomorrow', { reminderAt: tomorrow }), task('unscheduled'),
  ];
  assert.deepEqual(filterTasks(tasks, { view: 'calendar', selectedDate: '2026-10-13' }).map(item => item.id), ['today', 'done-today']);
  assert.deepEqual(filterTasks(tasks, { view: 'calendar', selectedDate: '2026-10-13', includeCompleted: false }).map(item => item.id), ['today']);
  for (const selectedDate of [null, '', '2026-02-30', '2026-13-01', '2026-10-13T00:00:00Z']) {
    assert.deepEqual(filterTasks(tasks, { view: 'calendar', selectedDate }), []);
  }
});

test('calendar uses Taiwan local date across the UTC midnight boundary', () => {
  const moduleUrl = new URL('../js/task-view.js', import.meta.url).href;
  const script = `
    import { filterTasks, localDateKey } from ${JSON.stringify(moduleUrl)};
    const tasks = [
      { id: 'taipei-morning', reminderAt: '2026-10-12T23:30:00.000Z' },
      { id: 'taipei-next-day', reminderAt: '2026-10-13T16:00:00.000Z' },
      { id: 'taipei-previous-day', reminderAt: '2026-10-12T15:59:00.000Z' }
    ];
    process.stdout.write(JSON.stringify({
      date: localDateKey(tasks[0].reminderAt),
      ids: filterTasks(tasks, { view: 'calendar', selectedDate: '2026-10-13' }).map(task => task.id)
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'Asia/Taipei' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), { date: '2026-10-13', ids: ['taipei-morning'] });
});

test('incomplete source records do not crash search or date filtering', () => {
  const tasks = [null, undefined, 42, [], { id: 'minimal' }, { id: 'partial', attachments: [null, {}, { name: 'Photo.PNG' }] }];
  assert.deepEqual(filterTasks(tasks, { query: 'photo' }).map(item => item.id), ['partial']);
  assert.deepEqual(filterTasks(tasks, { view: 'memo' }).map(item => item.id), ['minimal', 'partial']);
  assert.deepEqual(filterTasks(null), []);
  for (const value of [null, undefined, '', 'not a date', 0, new Date(NaN)]) assert.equal(localDateKey(value), null);
  const date = new Date(2026, 9, 13, 23);
  assert.equal(localDateKey(date), '2026-10-13');
});
