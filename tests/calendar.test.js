import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleCalendarUrl, createICS, createMapUrl } from '../js/calendar.js';

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
  assert.equal(url.pathname, '/calendar/render');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), task.title);
  assert.equal(url.searchParams.get('dates'), '20261011T070000Z/20261011T073000Z');
  assert.equal(url.searchParams.get('ctz'), 'Asia/Taipei');
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
  for (const reminderAt of [null, undefined, '', 'invalid date']) {
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
