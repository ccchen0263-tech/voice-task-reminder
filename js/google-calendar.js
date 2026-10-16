import { toDateTimeLocal } from './planner.js';

export const GOOGLE_REPEAT_LABELS = {
  none: '一次（不重複）', daily: '每天', weekly: '每週', weekdays: '週一至週五', monthly: '每月', yearly: '每年',
};

/** Pure URL preparation. No account access, local task ID, storage or network request. */
export function createGoogleCalendarDraftURL(event) {
  const title = String(event?.title ?? '').trim();
  if (!title) throw new TypeError('請補上待辦事項。');
  if (!toDateTimeLocal(event?.reminderAt)) throw new TypeError('請先設定有效的開始時間。');
  const start = new Date(event.reminderAt);
  const end = new Date(start.getTime() + 30 * 60_000);
  if (!Number.isFinite(end.getTime()) || end.getUTCFullYear() > 9999) throw new RangeError('日期超出支援範圍。');
  const formatUTC = date => date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const location = String(event.location ?? '').trim();
  const notes = String(event.notes ?? '').trim();
  const repeat = Object.hasOwn(GOOGLE_REPEAT_LABELS, event.repeat) ? event.repeat : 'none';
  const details = [
    `原始輸入：${String(event.originalInput ?? '')}`,
    ...(notes ? [`備註：${notes}`] : []),
    ...(repeat !== 'none' ? [`希望重複：${GOOGLE_REPEAT_LABELS[repeat]}。請在 Google Calendar 確認重複規則後儲存。`] : []),
    '由語音行事曆準備；仍需在 Google Calendar 確認時間、行事曆與提醒並儲存。',
  ].join('\n');
  const url = new URL('https://calendar.google.com/calendar/r/eventedit');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', title);
  url.searchParams.set('dates', `${formatUTC(start)}/${formatUTC(end)}`);
  url.searchParams.set('details', details);
  if (location) url.searchParams.set('location', location);
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  url.searchParams.set('stz', timeZone);
  url.searchParams.set('etz', timeZone);
  return url.href;
}
