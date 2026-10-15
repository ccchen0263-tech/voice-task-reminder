import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createGoogleCalendarUrl, createICS, createMapUrl, downloadICS } from '../js/calendar.js';
import { nextRepeatTime } from '../js/recurrence.js';

const task = {
  id: 'task-123',
  title: '回覆客戶',
  reminderAt: '2026-10-11T15:00:00+08:00',
  originalInput: '今天下午三點提醒我回覆客戶',
};

const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');

test('Google Calendar includes the original content and a 30-minute UTC event', () => {
  const url = new URL(createGoogleCalendarUrl(task));
  assert.equal(url.origin, 'https://calendar.google.com');
  assert.equal(url.pathname, '/calendar/r/eventedit');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), task.title);
  assert.equal(url.searchParams.get('dates'), '20261011T070000Z/20261011T073000Z');
  assert.equal(url.searchParams.get('stz'), new Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(url.searchParams.get('etz'), new Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.match(url.searchParams.get('details'), /今天下午三點提醒我回覆客戶/);
});

test('Calendar duration correctly crosses a year boundary', () => {
  const yearEnd = { ...task, reminderAt: '2026-12-31T23:50:00Z' };
  const url = new URL(createGoogleCalendarUrl(yearEnd));
  assert.equal(url.searchParams.get('dates'), '20261231T235000Z/20270101T002000Z');
  const ics = unfold(createICS(yearEnd, new Date('2026-10-11T00:00:00Z')));
  assert.match(ics, /DTSTART:20261231T235000Z\r\n/);
  assert.match(ics, /DTEND:20270101T002000Z\r\n/);
  assert.match(ics, /DTSTAMP:20261011T000000Z\r\n/);
});

test('ICS escapes text and prevents an injected ID from adding event properties', () => {
  const special = {
    ...task,
    id: 'task\r\nATTENDEE:someone@example.com',
    title: '開會,吃飯;結束\\確認\r\n下一行',
    originalInput: '原始,內容;含\\路徑\n兩行',
  };
  const ics = unfold(createICS(special));
  assert.ok(ics.includes('SUMMARY:開會\\,吃飯\\;結束\\\\確認\\n下一行\r\n'));
  assert.ok(ics.includes('DESCRIPTION:原始輸入：原始\\,內容\\;含\\\\路徑\\n兩行\\n由語音待辦提醒系統建立。\r\n'));
  assert.ok(!ics.includes('\r\nATTENDEE:'));
  const uid = ics.split('\r\n').find((line) => line.startsWith('UID:'));
  const updated = { ...special, title: '不同名稱', originalInput: '不同原始內容' };
  assert.equal(uid, unfold(createICS(updated, new Date('2026-10-12T00:00:00Z'))).split('\r\n').find((line) => line.startsWith('UID:')));
});

test('ICS uses CRLF, folds UTF-8 to 75 octets, and preserves full Unicode text', () => {
  const longTask = {
    ...task,
    title: '下週開會與準備文件😀'.repeat(20),
    originalInput: '今天下午三點提醒我確認測試🧑‍💻'.repeat(20),
  };
  const ics = createICS(longTask);
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(ics.replace(/\r\n/g, '').includes('\r'), false);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `Line is too long: ${Buffer.byteLength(line, 'utf8')}`);
    assert.equal(line.includes('\ufffd'), false);
  }
  assert.ok(ics.includes('\r\n '));
  assert.ok(unfold(ics).includes(`SUMMARY:${longTask.title}\r\n`));
  assert.ok(unfold(ics).includes(longTask.originalInput));
});

test('Unscheduled and invalid tasks cannot generate calendar events', () => {
  for (const reminderAt of [null, undefined, '', 'invalid date', '2026-02-30T09:00:00Z', '2026-10-11']) {
    assert.throws(() => createGoogleCalendarUrl({ ...task, reminderAt }), TypeError);
    assert.throws(() => createICS({ ...task, reminderAt }), TypeError);
  }
  assert.throws(() => createICS({ ...task, id: null }), TypeError);
  assert.throws(() => createICS(task, new Date('invalid date')), TypeError);
});

test('map links use explicit coordinates or a user-entered address', () => {
  const byAddress = new URL(createMapUrl({ locationAddress: '台北車站' }));
  assert.equal(byAddress.origin, 'https://www.google.com');
  assert.equal(byAddress.searchParams.get('query'), '台北車站');
  const byCoordinates = new URL(createMapUrl({ location: '目前位置', locationLat: 25.033, locationLng: 121.565 }));
  assert.equal(byCoordinates.searchParams.get('query'), '25.033,121.565');
  assert.equal(byCoordinates.protocol, 'https:');
  assert.equal(byCoordinates.hostname, 'www.google.com');
  assert.equal(createMapUrl({}), null);
});

test('map links ignore missing, empty, and invalid coordinates but preserve real zero coordinates', () => {
  const cases = [
    { locationAddress: 'QA測試地點1012：台北車站', locationLat: null, locationLng: null },
    { locationAddress: '地址文字', locationLat: undefined, locationLng: undefined },
    { locationAddress: '空字串座標', locationLat: '', locationLng: '' },
    { locationAddress: '越界座標', locationLat: 91, locationLng: -181 },
    { locationAddress: '部分無效', locationLat: 25.033, locationLng: 'invalid' },
  ];
  for (const task of cases) {
    const url = new URL(createMapUrl(task));
    assert.equal(url.searchParams.get('query'), task.locationAddress);
  }
  const zero = new URL(createMapUrl({ location: '赤道本初子午線', locationLat: 0, locationLng: 0 }));
  assert.equal(zero.searchParams.get('query'), '0,0');
  const zeroStrings = new URL(createMapUrl({ location: '赤道本初子午線', locationLat: '0', locationLng: '0' }));
  assert.equal(zeroStrings.searchParams.get('query'), '0,0');
});

test('calendar drafts carry the entered location without binding a calendar ID', () => {
  const url = new URL(createGoogleCalendarUrl({ ...task, locationAddress: '台北車站' }));
  assert.equal(url.searchParams.get('location'), '台北車站');
  assert.equal(url.searchParams.has('calendarId'), false);
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
});

test('Google Calendar exports notes and readable categories while preserving source and location', () => {
  const enriched = { ...task, category: 'work', notes: '帶報價單\n先確認時間', locationAddress: '台北車站' };
  const url = new URL(createGoogleCalendarUrl(enriched));
  assert.equal(url.searchParams.get('details'), [
    `原始輸入：${task.originalInput}`, '分類：工作', '備註：帶報價單\n先確認時間',
    '地點：台北車站', '由語音待辦提醒系統建立。',
  ].join('\n'));
  assert.equal(url.searchParams.get('location'), '台北車站');
  assert.equal(url.searchParams.get('dates'), '20261011T070000Z/20261011T073000Z');
  for (const [category, label] of [['life', '生活'], ['health', '健康'], ['other', '其他']]) {
    const details = new URL(createGoogleCalendarUrl({ ...task, category })).searchParams.get('details');
    assert.ok(details.includes(`分類：${label}`));
  }
});

test('ICS escapes multiline notes and categories without adding event properties or alarms', () => {
  const enriched = {
    ...task, category: 'health', locationAddress: '診所,二樓',
    notes: '吃藥;記得\\確認,劑量\r\nATTENDEE:someone@example.com',
  };
  const content = createICS(enriched);
  const unfolded = unfold(content);
  assert.ok(unfolded.includes('分類：健康\\n備註：吃藥\\;記得\\\\確認\\,劑量\\nATTENDEE:someone@example.com\\n地點：診所\\,二樓'));
  assert.equal(unfolded.includes('\r\nATTENDEE:'), false);
  assert.equal(unfolded.includes('VALARM'), false);
  assert.equal(unfolded.includes('RRULE'), false);
  assert.ok(unfolded.includes(`原始輸入：${task.originalInput}`));
  for (const line of content.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
});

test('ICS alarms are opt-in and preserve the single 30-minute event', () => {
  const now = new Date('2026-10-13T00:00:00Z');
  assert.equal(createICS(task, now).includes('BEGIN:VALARM'), false);
  assert.equal(createICS(task, now, { alarmMinutes: null }).includes('BEGIN:VALARM'), false);
  for (const [minutes, trigger] of [[0, 'PT0M'], [10, '-PT10M'], [30, '-PT30M']]) {
    const content = unfold(createICS(task, now, { alarmMinutes: minutes }));
    assert.equal(content.split('BEGIN:VALARM').length - 1, 1);
    assert.ok(content.includes(`BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:${trigger}\r\nDESCRIPTION:${task.title}\r\nEND:VALARM\r\n`));
    assert.ok(content.includes('DTSTART:20261011T070000Z\r\nDTEND:20261011T073000Z\r\n'));
    assert.equal(content.split('BEGIN:VEVENT').length - 1, 1);
  }
});

test('Alarm choices reject unsupported or injectable values before producing a file', () => {
  for (const alarmMinutes of [-10, 5, 60, NaN, Infinity, '10', '10\r\nATTENDEE:someone@example.com', false, {}, []]) {
    assert.throws(() => createICS(task, new Date(), { alarmMinutes }), RangeError);
    assert.throws(() => downloadICS(task, { alarmMinutes }), RangeError);
  }
  const malicious = { ...task, title: '開會\r\nATTENDEE:someone@example.com' };
  const content = unfold(createICS(malicious, new Date(), { alarmMinutes: 10 }));
  assert.equal(content.includes('\r\nATTENDEE:'), false);
  assert.ok(content.includes('DESCRIPTION:開會\\nATTENDEE:someone@example.com\r\nEND:VALARM'));
});

test('ICS exports recurrence rules while Google stays an explicitly one-off documented draft', () => {
  const labels = { daily: '每天', weekly: '每週', weekdays: '週一至週五', monthly: '每月', yearly: '每年' };
  for (const [repeat, label] of Object.entries(labels)) {
    const repeated = { ...task, repeat };
    const expected = `重複任務：${label}`;
    const url = new URL(createGoogleCalendarUrl(repeated));
    assert.ok(url.searchParams.get('details').includes(expected));
    assert.ok(url.searchParams.get('details').includes('Google 草稿未自動設定重複'));
    for (const key of ['alarm', 'alarmMinutes', 'reminder', 'reminders', 'recur']) assert.equal(url.searchParams.has(key), false);
    const content = unfold(createICS(repeated));
    assert.ok(content.includes(expected));
    assert.equal(content.includes('此檔案只包含這次行程'), false);
    assert.equal(content.includes('\r\nRRULE:'), true);
    assert.ok(content.includes('DURATION:PT30M\r\n'));
    assert.equal(content.includes('\r\nDTEND:'), false);
    const start = content.split('\r\n').find(line => line.startsWith('DTSTART:'));
    assert.match(start, /^DTSTART:\d{8}T\d{6}$/);
    assert.ok(content.includes('重複系列依匯入裝置當地時間\\,跨時區保持鐘點而非同一瞬間。')
      || content.includes('重複系列依匯入裝置當地時間，跨時區保持鐘點而非同一瞬間。'));
    assert.equal(content.split('BEGIN:VEVENT').length - 1, 1);
    assert.equal(content.includes('BEGIN:VALARM'), false);
  }
  assert.equal(unfold(createICS({ ...task, repeat: 'none' })).includes('重複任務：'), false);
  assert.equal(unfold(createICS({ ...task, repeat: 'once' })).includes('RRULE:'), false);
});

test('Apple Calendar download forwards the selected alarm and keeps the UTF-8 calendar MIME type', async () => {
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalTimeout = globalThis.setTimeout;
  let capturedBlob;
  let revoked;
  let cleanup;
  let delay;
  let clicked = false;
  const anchor = { style: {}, click() { clicked = true; }, remove() {} };
  try {
    globalThis.document = { createElement: () => anchor, body: { append() {} } };
    URL.createObjectURL = blob => { capturedBlob = blob; return 'blob:test-calendar'; };
    URL.revokeObjectURL = url => { revoked = url; };
    globalThis.setTimeout = (callback, ms) => { cleanup = callback; delay = ms; return 1; };
    const filename = downloadICS(task, { alarmMinutes: 30 });
    assert.equal(clicked, true);
    assert.equal(anchor.href, 'blob:test-calendar');
    assert.equal(anchor.download, filename);
    assert.equal(filename, '行事曆-回覆客戶.ics');
    assert.equal(capturedBlob.type, 'text/calendar;charset=utf-8');
    assert.ok((await capturedBlob.text()).includes('TRIGGER:-PT30M\r\n'));
    assert.equal(revoked, undefined);
    assert.equal(delay, 60_000);
    cleanup();
    assert.equal(revoked, 'blob:test-calendar');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    globalThis.setTimeout = originalTimeout;
  }
});

function localField(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Independently enumerate valid calendar dates using RFC BYMONTHDAY then BYSETPOS.
function selectedRuleDay(rule, year, monthIndex) {
  const parts = Object.fromEntries(rule.split(';').map(part => part.split('=')));
  if (parts.BYMONTH && !parts.BYMONTH.split(',').map(Number).includes(monthIndex + 1)) return null;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const selectors = parts.BYMONTHDAY.split(',').map(Number);
  const dates = Array.from({ length: lastDay }, (_, index) => index + 1)
    .filter(day => selectors.some(selector => selector > 0 ? day === selector : day === lastDay + selector + 1));
  const position = Number(parts.BYSETPOS);
  return dates[position > 0 ? position - 1 : dates.length + position] ?? null;
}

test('monthly RRULE short-month selection agrees with local completion for anchors 28 through 31', () => {
  for (const anchor of [28, 29, 30, 31]) {
    let current = { ...task, repeat: 'monthly', repeatDay: anchor, reminderAt: new Date(2026, 0, anchor, 9).toISOString() };
    let now = new Date(2026, 0, anchor, 10);
    const rule = unfold(createICS(current)).split('\r\n').find(line => line.startsWith('RRULE:')).slice(6);
    assert.equal(rule, `FREQ=MONTHLY;BYMONTHDAY=${anchor},-1;BYSETPOS=1`);
    for (let offset = 1; offset <= 12; offset++) {
      const month = new Date(2026, offset, 1);
      const expectedDay = selectedRuleDay(rule, month.getFullYear(), month.getMonth());
      const expected = new Date(month.getFullYear(), month.getMonth(), expectedDay, 9).toISOString();
      const actual = nextRepeatTime(current, now);
      assert.equal(actual, expected, `anchor ${anchor}, month ${month.getMonth() + 1}`);
      current = { ...current, reminderAt: actual };
      now = new Date(new Date(actual).getTime() + 3600000);
    }
  }
});

test('yearly RRULE and a clamped February DTSTART preserve the leap-day anchor', () => {
  let current = { ...task, repeat: 'yearly', repeatMonth: 2, repeatDay: 29, reminderAt: new Date(2024, 1, 29, 9).toISOString() };
  const rule = 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29,-1;BYSETPOS=1';
  let now = new Date(2024, 1, 29, 10);
  for (let year = 2025; year <= 2029; year++) {
    const content = unfold(createICS(current));
    assert.ok(content.includes(`RRULE:${rule}\r\n`));
    assert.ok(content.includes(`DTSTART:${localField(new Date(current.reminderAt))}\r\n`));
    const expected = new Date(year, 1, selectedRuleDay(rule, year, 1), 9).toISOString();
    const actual = nextRepeatTime(current, now);
    assert.equal(actual, expected);
    current = { ...current, reminderAt: actual };
    now = new Date(new Date(actual).getTime() + 3600000);
  }
});

test('weekday series use a matching weekday DTSTART and retain a first weekend exception via floating RDATE', () => {
  const original = new Date(2026, 9, 11, 9);
  const repeated = { ...task, repeat: 'weekdays', reminderAt: original.toISOString() };
  const expectedNext = new Date(2026, 9, 12, 9);
  assert.equal(nextRepeatTime(repeated, new Date(2026, 9, 11, 10)), expectedNext.toISOString());
  const content = unfold(createICS(repeated));
  assert.ok(content.includes(`DTSTART:${localField(expectedNext)}\r\n`));
  assert.ok(content.includes(`RDATE:${localField(original)}\r\n`));
  assert.ok(content.includes('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\n'));
  assert.ok(content.includes('首次週末行程作為例外保留'));
  assert.equal(content.includes('TZID='), false);
  const weekday = unfold(createICS({ ...repeated, reminderAt: expectedNext.toISOString() }));
  assert.equal(weekday.includes('\r\nRDATE:'), false);
});

test('local children share a stable recurring UID, including safe encoding of a series ID', () => {
  const root = { ...task, repeat: 'daily', seriesId: 'series\r\nATTENDEE:example' };
  const child = { ...root, id: 'child-456', reminderAt: '2026-10-12T15:00:00+08:00' };
  const uid = unfold(createICS(root)).split('\r\n').find(line => line.startsWith('UID:'));
  assert.equal(uid, unfold(createICS(child)).split('\r\n').find(line => line.startsWith('UID:')));
  assert.equal(unfold(createICS(root)).includes('\r\nATTENDEE:'), false);
  const oneOff = unfold(createICS({ ...child, repeat: 'none' })).split('\r\n').find(line => line.startsWith('UID:'));
  assert.notEqual(oneOff, uid);
});

test('floating repeat duration stays thirty minutes through a DST fold without an invalid DTEND', () => {
  const moduleUrl = new URL('../js/calendar.js', import.meta.url).href;
  const script = `
    import { createICS, createGoogleCalendarUrl } from ${JSON.stringify(moduleUrl)};
    const source = { id: 'dst-fold', title: 'test', originalInput: 'test', repeat: 'daily', reminderAt: new Date(2026, 10, 1, 1, 50).toISOString() };
    process.stdout.write(JSON.stringify({ics:createICS(source), google:new URL(createGoogleCalendarUrl(source)).searchParams.get('stz')}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }));
  const content = unfold(result.ics);
  assert.ok(content.includes('DTSTART:20261101T015000\r\nDURATION:PT30M\r\nRRULE:FREQ=DAILY\r\n'));
  assert.equal(content.includes('\r\nDTEND:'), false);
  assert.equal(result.google, 'America/New_York');
});

test('saved destination labels are descriptive only and never create unsupported Google destination parameters', () => {
  const labeled = { ...task, destination: { id: 'private-work', provider: 'google', name: '工作行事曆', source: 'local-label' } };
  const url = new URL(createGoogleCalendarUrl(labeled));
  assert.ok(url.searchParams.get('details').includes('目的地：Google 草稿：工作行事曆（本機名稱，未連線）'));
  assert.ok(url.searchParams.get('details').includes('請自行在草稿選擇實際行事曆'));
  for (const key of ['calendarId', 'cid', 'src', 'recur']) assert.equal(url.searchParams.has(key), false);
  const content = unfold(createICS(labeled));
  assert.ok(content.includes('目的地：Google 草稿：工作行事曆（本機名稱，未連線）'));
  assert.equal(content.includes('\r\nCALENDAR-ID:'), false);
});

test('changing device zones preserves a shifted current occurrence as RDATE with a matching monthly or yearly DTSTART', () => {
  const calendarUrl = new URL('../js/calendar.js', import.meta.url).href;
  const recurrenceUrl = new URL('../js/recurrence.js', import.meta.url).href;
  const script = `
    import { createICS } from ${JSON.stringify(calendarUrl)};
    import { nextRepeatTime } from ${JSON.stringify(recurrenceUrl)};
    const cases = [
      {id:'month', title:'test', repeat:'monthly', repeatDay:31, reminderAt:'2026-01-31T01:00:00.000Z'},
      {id:'year', title:'test', repeat:'yearly', repeatMonth:2, repeatDay:29, reminderAt:'2024-02-29T01:00:00.000Z'}
    ];
    process.stdout.write(JSON.stringify(cases.map(task => ({
      ics:createICS(task), next:nextRepeatTime(task,new Date(new Date(task.reminderAt).getTime()-1))
    }))));
  `;
  const results = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }));
  const monthly = unfold(results[0].ics);
  assert.ok(monthly.includes('DTSTART:20260228T200000\r\n'));
  assert.ok(monthly.includes('RDATE:20260130T200000\r\n'));
  assert.equal(results[0].next, '2026-03-01T01:00:00.000Z');
  const yearly = unfold(results[1].ics);
  assert.ok(yearly.includes('DTSTART:20250228T200000\r\n'));
  assert.ok(yearly.includes('RDATE:20240228T200000\r\n'));
  assert.equal(results[1].next, '2025-03-01T01:00:00.000Z');
  assert.ok(yearly.includes('目前提醒日與系列錨點不同'));
});
