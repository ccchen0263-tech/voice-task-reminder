export const REPEAT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'none', label: '一次（不重複）' }),
  Object.freeze({ value: 'daily', label: '每天' }),
  Object.freeze({ value: 'weekly', label: '每週' }),
  Object.freeze({ value: 'weekdays', label: '週一至週五' }),
  Object.freeze({ value: 'monthly', label: '每月' }),
  Object.freeze({ value: 'yearly', label: '每年' }),
]);

const REPEAT_VALUES = new Set(REPEAT_OPTIONS.map(option => option.value));
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeRepeat(value) {
  return REPEAT_VALUES.has(value) ? value : 'none';
}

export function repeatLabel(value) {
  return REPEAT_OPTIONS.find(option => option.value === normalizeRepeat(value)).label;
}

function daysInMonth(year, monthIndex) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex];
}

function readReminder(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)
      || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return null;
  }
  const date = new Date(value);
  return supportedDate(date) ? date : null;
}

function supportedDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime())
    && date.getFullYear() >= 1 && date.getFullYear() <= 9999
    && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;
}

// Civil-day arithmetic skips elapsed calendar days without assuming 24-hour local days.
function civilDay(date) {
  const utc = new Date(0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  utc.setUTCHours(0, 0, 0, 0);
  return utc.getTime() / DAY_MS;
}

function atLocalDay(original, offset) {
  const civil = new Date(0);
  civil.setUTCFullYear(original.getFullYear(), original.getMonth(), original.getDate() + offset);
  return atLocalDate(original, civil.getUTCFullYear(), civil.getUTCMonth(), civil.getUTCDate());
}

function atLocalDate(original, year, monthIndex, day) {
  if (year < 1 || year > 9999) return null;
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, monthIndex, day);
  date.setHours(original.getHours(), original.getMinutes(), original.getSeconds(), original.getMilliseconds());
  // RFC 5545 excludes nonexistent local times instead of moving 02:30 to 03:30.
  return supportedDate(date) && date.getFullYear() === year && date.getMonth() === monthIndex
    && date.getDate() === day && date.getHours() === original.getHours()
    && date.getMinutes() === original.getMinutes() && date.getSeconds() === original.getSeconds()
    && date.getMilliseconds() === original.getMilliseconds() ? date : null;
}

function atLocalMonth(original, offset, anchorDay) {
  const total = original.getFullYear() * 12 + original.getMonth() + offset;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  if (year < 1 || year > 9999) return null;
  return atLocalDate(original, year, monthIndex, Math.min(anchorDay, daysInMonth(year, monthIndex)));
}

function monthlyAnchor(task, original) {
  return Number.isInteger(task.repeatDay) && task.repeatDay >= 1 && task.repeatDay <= 31
    ? task.repeatDay : original.getDate();
}

function yearlyMonth(task, original) {
  return Number.isInteger(task.repeatMonth) && task.repeatMonth >= 1 && task.repeatMonth <= 12
    ? task.repeatMonth : original.getMonth() + 1;
}

/** RFC 5545 candidates select the anchor day, or the month's last day if shorter. */
export function getRecurrenceRule(task) {
  const repeat = normalizeRepeat(task?.repeat);
  if (repeat === 'none') return null;
  const original = readReminder(task?.reminderAt);
  if (!original) return null;
  if (repeat === 'daily') return 'FREQ=DAILY';
  if (repeat === 'weekly') return 'FREQ=WEEKLY';
  if (repeat === 'weekdays') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  const day = monthlyAnchor(task, original);
  if (repeat === 'monthly') return `FREQ=MONTHLY;BYMONTHDAY=${day},-1;BYSETPOS=1`;
  return `FREQ=YEARLY;BYMONTH=${yearlyMonth(task, original)};BYMONTHDAY=${day},-1;BYSETPOS=1`;
}

/** Return one future occurrence, using the device's local calendar and wall-clock time. */
export function nextRepeatTime(task, now = new Date()) {
  if (!task || normalizeRepeat(task.repeat) === 'none' || !supportedDate(now)) return null;
  const original = readReminder(task.reminderAt);
  if (!original) return null;
  const repeat = normalizeRepeat(task.repeat);
  const threshold = Math.max(original.getTime(), now.getTime());

  if (repeat === 'yearly') {
    const monthIndex = yearlyMonth(task, original) - 1;
    const anchorDay = monthlyAnchor(task, original);
    let year = Math.max(original.getFullYear() + 1, now.getFullYear());
    for (let attempt = 0; attempt < 8 && year <= 9999; attempt++, year++) {
      const candidate = atLocalDate(original, year, monthIndex, Math.min(anchorDay, daysInMonth(year, monthIndex)));
      if (candidate && candidate.getTime() > threshold) return candidate.toISOString();
    }
    return null;
  }

  if (repeat === 'monthly') {
    const monthDifference = (now.getFullYear() - original.getFullYear()) * 12 + now.getMonth() - original.getMonth();
    let offset = Math.max(1, monthDifference);
    // A direct month jump plus at most one advance suffices; keep a small hard bound.
    for (let attempt = 0; attempt < 3; attempt++, offset++) {
      const candidate = atLocalMonth(original, offset, monthlyAnchor(task, original));
      if (!candidate) continue;
      if (candidate.getTime() > threshold) return candidate.toISOString();
    }
    return null;
  }

  const step = repeat === 'weekly' ? 7 : 1;
  const dayDifference = civilDay(now) - civilDay(original);
  let offset = Math.max(1, Math.floor(dayDifference / step)) * step;
  // Even old tasks jump near today first; weekday/weekend checks need at most a week.
  for (let attempt = 0; attempt < 8; attempt++, offset += step) {
    const candidate = atLocalDay(original, offset);
    if (!candidate) continue;
    if (candidate.getTime() <= threshold) continue;
    if (repeat === 'weekdays' && (candidate.getDay() === 0 || candidate.getDay() === 6)) continue;
    return candidate.toISOString();
  }
  return null;
}

/** The caller commits the completed parent and this child together in one storage write. */
export function createNextOccurrence(task, { id, now = new Date(), existingTasks = [] } = {}) {
  if (!task || typeof task.id !== 'string' || !task.id.trim()
      || typeof id !== 'string' || !id.trim() || id.trim() === task.id.trim()
      || !Array.isArray(existingTasks)) return null;
  const nextId = id.trim();
  if (existingTasks.some(existing => existing?.id === nextId)) return null;
  if (existingTasks.some(existing => existing?.repeatParentId === task.id.trim())) return null;
  const reminderAt = nextRepeatTime(task, now);
  if (!reminderAt) return null;
  const seriesId = typeof task.seriesId === 'string' && task.seriesId.trim() ? task.seriesId.trim() : task.id.trim();
  const nextTime = new Date(reminderAt).getTime();
  if (existingTasks.some(existing => {
    if (!existing || existing.seriesId !== seriesId) return false;
    return readReminder(existing.reminderAt)?.getTime() === nextTime;
  })) return null;

  const repeat = normalizeRepeat(task.repeat);
  const occurrence = {
    ...task,
    id: nextId,
    completed: false,
    createdAt: now.toISOString(),
    reminderAt,
    repeat,
    seriesId,
    repeatParentId: task.id.trim(),
    attachments: Array.isArray(task.attachments) ? task.attachments.map(attachment => ({ ...attachment })) : [],
  };
  if (repeat === 'monthly' || repeat === 'yearly') occurrence.repeatDay = monthlyAnchor(task, readReminder(task.reminderAt));
  else delete occurrence.repeatDay;
  if (repeat === 'yearly') occurrence.repeatMonth = yearlyMonth(task, readReminder(task.reminderAt));
  else delete occurrence.repeatMonth;
  delete occurrence.updatedAt;
  return occurrence;
}
