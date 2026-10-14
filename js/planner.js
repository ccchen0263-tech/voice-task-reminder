const pad = (value, length = 2) => String(value).padStart(length, '0');

function dateKey(year, monthIndex, day) {
  return `${pad(year, 4)}-${pad(monthIndex + 1)}-${pad(day)}`;
}

function validCivilTime(year, month, day, hour, minute, second = 0) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12
    && day >= 1 && day <= monthDays[month - 1]
    && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59;
}

function readISO(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', zone] = match;
  if (!validCivilTime(...[year, month, day, hour, minute, second].map(Number))) return null;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function readDateKey(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (!validCivilTime(year, month, day, 0, 0)) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

function unfinishedCounts(tasks) {
  const counts = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || task.completed === true) continue;
    const reminder = readISO(task.reminderAt);
    const key = reminder ? toLocalDateKey(reminder) : '';
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function civilCells(first, length, today, counts, isInMonth) {
  const todayKey = toLocalDateKey(today);
  return Array.from({ length }, (_, offset) => {
    const date = new Date(first);
    date.setUTCDate(first.getUTCDate() + offset);
    const year = date.getUTCFullYear();
    const monthIndex = date.getUTCMonth();
    const day = date.getUTCDate();
    const key = dateKey(year, monthIndex, day);
    return {
      dateKey: key, day, year, monthIndex,
      inMonth: isInMonth(year, monthIndex), isToday: key === todayKey,
      taskCount: counts.get(key) ?? 0,
    };
  });
}

/** Format a Date using the device's local calendar day; invalid dates return ''. */
export function toLocalDateKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  if (year < 1 || year > 9999) return '';
  return dateKey(year, date.getMonth(), date.getDate());
}

/** Convert a saved ISO instant into a local datetime-local input value. */
export function toDateTimeLocal(iso) {
  const date = readISO(iso);
  const key = date ? toLocalDateKey(date) : '';
  return key ? `${key}T${pad(date.getHours())}:${pad(date.getMinutes())}` : '';
}

/** Parse a local minute value without allowing JavaScript's invalid-date rollover. */
export function parseDateTimeLocal(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (!validCivilTime(year, month, day, hour, minute)) return null;

  // setFullYear avoids Date constructor's special treatment of years 00–99.
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year
      || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  return date.toISOString();
}

/** Normalize a month offset across year boundaries. Month indexes are zero-based. */
export function shiftMonth(year, monthIndex, delta) {
  if (![year, monthIndex, delta].every(Number.isSafeInteger)) {
    throw new TypeError('年月與月份位移必須為整數。');
  }
  const total = year * 12 + monthIndex + delta;
  if (!Number.isSafeInteger(total)) throw new RangeError('月份超出支援範圍。');
  const shiftedYear = Math.floor(total / 12);
  if (shiftedYear < 1 || shiftedYear > 9999) throw new RangeError('年份超出支援範圍。');
  return { year: shiftedYear, monthIndex: total - shiftedYear * 12 };
}

/** Move a civil date without adding 24-hour durations across daylight saving changes. */
export function shiftDateKey(key, days) {
  const date = readDateKey(key);
  if (!date || !Number.isSafeInteger(days)) return '';
  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 1 || year > 9999) return '';
  return dateKey(year, date.getUTCMonth(), date.getUTCDate());
}

/** Return the selected civil week's seven Monday-first days; invalid keys return []. */
export function getWeekDays(selectedDateKey, { today = new Date(), tasks = [] } = {}) {
  const first = readDateKey(selectedDateKey);
  if (!first) return [];
  first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
  const cells = civilCells(first, 7, today, unfinishedCounts(tasks), () => true);
  return cells.every(cell => cell.year >= 1 && cell.year <= 9999) ? cells : [];
}

/** Return six Monday-first weeks. Only unfinished, scheduled tasks are counted. */
export function getMonthDays(year, monthIndex, { today = new Date(), tasks = [] } = {}) {
  const month = shiftMonth(year, monthIndex, 0);
  const counts = unfinishedCounts(tasks);

  // UTC is used only for Gregorian grid arithmetic, so DST cannot skip a cell.
  // Task instants and the today marker above always use the device's local day.
  const first = new Date(0);
  first.setUTCFullYear(month.year, month.monthIndex, 1);
  first.setUTCHours(12, 0, 0, 0);
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(1 - mondayOffset);

  return civilCells(first, 42, today, counts, (year, monthIndex) =>
    year === month.year && monthIndex === month.monthIndex);
}
