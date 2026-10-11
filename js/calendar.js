const EVENT_LENGTH_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();

function getEventDates(task) {
  if (!task || typeof task.reminderAt !== 'string' || !task.reminderAt.trim()) {
    throw new TypeError('此任務尚未設定有效的提醒時間。');
  }

  const start = new Date(task.reminderAt);
  const end = new Date(start.getTime() + EVENT_LENGTH_MS);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
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

function getDescription(task) {
  return `原始輸入：${String(task.originalInput ?? '')}\n由語音待辦提醒系統建立。`;
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
  const id = Array.from(encoder.encode(String(task.id)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `task-${id}@voice-task-reminder.local`;
}

/** Return the Google Calendar event editor URL. Invalid/missing times throw TypeError. */
export function createGoogleCalendarUrl(task) {
  const { start, end } = getEventDates(task);
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', String(task.title ?? ''));
  url.searchParams.set('dates', `${formatUTC(start)}/${formatUTC(end)}`);
  url.searchParams.set('details', getDescription(task));
  url.searchParams.set('ctz', 'Asia/Taipei');
  return url.href;
}

/** Build an RFC 5545 event. Invalid/missing times throw TypeError. */
export function createICS(task, now = new Date()) {
  const { start, end } = getEventDates(task);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Voice Task Reminder//TW',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${getUID(task)}`,
    `DTSTAMP:${formatUTC(now)}`,
    `DTSTART:${formatUTC(start)}`,
    `DTEND:${formatUTC(end)}`,
    `SUMMARY:${escapeText(task.title)}`,
    `DESCRIPTION:${escapeText(getDescription(task))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Download an .ics file for importing into iPhone/macOS Calendar. */
export function downloadICS(task) {
  const content = createICS(task);
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
