import { getRecurrenceRule, nextRepeatTime, normalizeRepeat, repeatLabel } from './recurrence.js';
import { destinationLabel } from './destinations.js';

const EVENT_LENGTH_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();

function getEventDates(task) {
  if (!task || typeof task.reminderAt !== 'string' || !task.reminderAt.trim()) {
    throw new TypeError('此任務尚未設定有效的提醒時間。');
  }

  const start = new Date(task.reminderAt);
  const end = new Date(start.getTime() + EVENT_LENGTH_MS);
  const parts = task.reminderAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  const dateOnly = new Date(0);
  if (parts) dateOnly.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  if (!parts || Number(parts[1]) < 1 || Number(parts[2]) < 1 || Number(parts[2]) > 12 || Number(parts[3]) < 1
      || dateOnly.getUTCMonth() !== Number(parts[2]) - 1 || dateOnly.getUTCDate() !== Number(parts[3])
      || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59
      || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new TypeError('此任務尚未設定有效的提醒時間。');
  }
  return { start, end };
}

function formatUTC(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError('行事曆日期無效。');
  }
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) {
    throw new RangeError('行事曆日期超出支援範圍。');
  }
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(year, 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function formatLocal(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999) {
    throw new RangeError('行事曆日期超出支援範圍。');
  }
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function matchesRecurrenceStart(task, date, rule) {
  const repeat = normalizeRepeat(task.repeat);
  if (repeat === 'weekdays') return ![0, 6].includes(date.getDay());
  if (repeat !== 'monthly' && repeat !== 'yearly') return true;
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(date.getFullYear(), date.getMonth() + 1, 0);
  const anchorDay = Number(rule.match(/(?:^|;)BYMONTHDAY=(\d+)/)[1]);
  const matchingDay = date.getDate() === Math.min(anchorDay, monthEnd.getUTCDate());
  if (repeat === 'monthly') return matchingDay;
  const anchorMonth = Number(rule.match(/(?:^|;)BYMONTH=(\d+)/)[1]);
  return matchingDay && date.getMonth() + 1 === anchorMonth;
}

function getDescription(task, { google = false, weekendException = false, anchorException = false } = {}) {
  const categoryLabels = { work: '工作', life: '生活', health: '健康', other: '其他' };
  const recurring = normalizeRepeat(task.repeat) !== 'none';
  const category = String(task.category ?? '').trim();
  const notes = String(task.notes ?? '').trim();
  const location = String(task.locationAddress || task.location || '').trim();
  return [
    `原始輸入：${String(task.originalInput ?? '')}`,
    ...(category ? [`分類：${categoryLabels[category] || category}`] : []),
    ...(notes ? [`備註：${notes}`] : []),
    ...(location ? [`地點：${location}`] : []),
    ...(task.destination ? [`目的地：${destinationLabel(task.destination)}`] : []),
    ...(task.destination?.provider === 'google' ? ['Google 目的地是本機名稱，未連線；請自行在草稿選擇實際行事曆。'] : []),
    ...(recurring ? [`重複任務：${repeatLabel(task.repeat)}`] : []),
    ...(recurring && google ? ['Google 草稿未自動設定重複，請在 Google 行事曆確認設定；完整系列可使用 .ics。'] : []),
    ...(recurring && !google ? ['重複系列依匯入裝置當地時間，跨時區保持鐘點而非同一瞬間。'] : []),
    ...(weekendException ? ['首次週末行程作為例外保留，後續系列從下一個平日開始。'] : []),
    ...(anchorException ? ['目前提醒日與系列錨點不同，首次行程作為例外保留，後續依重複規則。'] : []),
    '由語音待辦提醒系統建立。',
  ].join('\n');
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

// RFC 5545 limits physical lines to 75 UTF-8 octets, including the folding space.
// Iterating by Unicode code point avoids splitting a multi-byte character.
function foldLine(line) {
  const parts = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const length = encoder.encode(character).length;
    if (octets + length > 75) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += character;
    octets += length;
  }
  parts.push(current);
  return parts.join('\r\n');
}

function getUID(task) {
  if (task.id === undefined || task.id === null || String(task.id) === '') {
    throw new TypeError('匯出行事曆需要任務 ID。');
  }
  // Encoding the complete ID keeps it stable and prevents property/CRLF injection.
  const seriesId = normalizeRepeat(task.repeat) !== 'none' && typeof task.seriesId === 'string' && task.seriesId.trim()
    ? task.seriesId.trim() : String(task.id);
  const id = Array.from(encoder.encode(seriesId), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `task-${id}@voice-task-reminder.local`;
}

/** Return the Google Calendar event editor URL. Invalid/missing times throw TypeError. */
export function createGoogleCalendarUrl(task) {
  const { start, end } = getEventDates(task);
  // Google documents a one-off TEMPLATE link, not a recurrence URL parameter.
  const url = new URL('https://calendar.google.com/calendar/r/eventedit');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', String(task.title ?? ''));
  url.searchParams.set('dates', `${formatUTC(start)}/${formatUTC(end)}`);
  url.searchParams.set('details', getDescription(task, { google: true }));
  const location = String(task.locationAddress || task.location || '').trim();
  if (location) url.searchParams.set('location', location);
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  url.searchParams.set('stz', timeZone);
  url.searchParams.set('etz', timeZone);
  return url.href;
}

/** Build a user-clicked map search link; this does not request location permission. */
export function createMapUrl(task) {
  const validCoordinate = (value, minimum, maximum) => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
  };
  const latitude = validCoordinate(task?.locationLat, -90, 90);
  const longitude = validCoordinate(task?.locationLng, -180, 180);
  const query = latitude !== null && longitude !== null
    ? `${latitude},${longitude}`
    : String(task?.locationAddress || task?.location || '').trim();
  if (!query) return null;
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', query);
  return url.href;
}

/** Build a one-off UTC event or a floating local series, with an optional display alarm. */
export function createICS(task, now = new Date(), { alarmMinutes = null } = {}) {
  if (![null, 0, 10, 30].includes(alarmMinutes)) {
    throw new RangeError('行事曆提醒僅支援不設定、準時、10 分鐘前或 30 分鐘前。');
  }
  const { start, end } = getEventDates(task);
  const rule = getRecurrenceRule(task);
  if (normalizeRepeat(task.repeat) !== 'none' && !rule) throw new RangeError('重複系列的日期超出支援範圍。');
  const weekendException = normalizeRepeat(task.repeat) === 'weekdays' && [0, 6].includes(start.getDay());
  const firstException = rule && !matchesRecurrenceStart(task, start, rule);
  const anchorException = Boolean(firstException && !weekendException);
  let seriesStart = start;
  if (firstException) {
    const next = nextRepeatTime(task, new Date(start.getTime() - 1));
    if (!next) throw new RangeError('此重複系列無法產生有效的後續時間。');
    seriesStart = new Date(next);
  }
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Voice Task Reminder//TW',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${getUID(task)}`,
    `DTSTAMP:${formatUTC(now)}`,
    ...(rule ? [
      `DTSTART:${formatLocal(seriesStart)}`,
      'DURATION:PT30M',
      `RRULE:${rule}`,
      ...(firstException ? [`RDATE:${formatLocal(start)}`] : []),
    ] : [`DTSTART:${formatUTC(start)}`, `DTEND:${formatUTC(end)}`]),
    `SUMMARY:${escapeText(task.title)}`,
    `DESCRIPTION:${escapeText(getDescription(task, { weekendException, anchorException }))}`,
    ...(alarmMinutes === null ? [] : [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:${alarmMinutes === 0 ? 'PT0M' : `-PT${alarmMinutes}M`}`,
      `DESCRIPTION:${escapeText(task.title || '待辦任務提醒')}`,
      'END:VALARM',
    ]),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Download an .ics file for importing into iPhone/macOS Calendar. */
export function downloadICS(task, { alarmMinutes = null } = {}) {
  const content = createICS(task, new Date(), { alarmMinutes });
  const safeTitle = Array.from(String(task.title ?? '任務'))
    .filter((character) => !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(character))
    .slice(0, 64)
    .join('')
    .trim()
    .replace(/[. ]+$/g, '') || '任務';
  const filename = `行事曆-${safeTitle}.ics`;
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // iOS may still be opening the file when click() returns.
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return filename;
}
