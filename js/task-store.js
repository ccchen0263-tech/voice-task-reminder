import { normalizeTaskCategory } from './task-view.js';
import { normalizeDestination } from './destinations.js';
import { normalizeRepeat, REPEAT_OPTIONS } from './recurrence.js';

export const STORAGE_KEY = 'voice-task-reminder.tasks.v1';

/** Accept complete ISO timestamps and reject dates such as February 30. */
function isoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = parts;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (month < 1 || month > 12 || day < 1 || calendarDate.getUTCMonth() !== month - 1
      || calendarDate.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeCoordinate(value, min, max) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeAttachmentMetadata(value) {
  if (!Array.isArray(value)) return { attachments: [], invalid: value !== undefined && value !== null };
  const attachments = [];
  let invalid = false;
  for (const item of value) {
    if (!item || typeof item !== 'object'
        || typeof item.id !== 'string' || !item.id.trim()
        || typeof item.name !== 'string' || !item.name.trim()
        || typeof item.type !== 'string' || !item.type.trim()
        || !Number.isFinite(Number(item.size)) || Number(item.size) <= 0
        || !['image', 'file'].includes(item.kind)
        || !isoTimestamp(item.createdAt)) {
      invalid = true;
      continue;
    }
    attachments.push({
      id: item.id.trim(),
      name: item.name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 120) || '附件',
      type: item.type.trim().slice(0, 160),
      size: Number(item.size),
      kind: item.kind,
      createdAt: isoTimestamp(item.createdAt),
    });
  }
  return { attachments: attachments.slice(0, 3), invalid };
}

function inspectTasks(value) {
  if (!Array.isArray(value)) return { tasks: [], issues: 1 };
  const tasks = [];
  const ids = new Set();
  let issues = 0;

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.id !== 'string' || !item.id.trim()
        || typeof item.title !== 'string' || !item.title.trim()
        || typeof item.originalInput !== 'string' || !item.originalInput.trim()
        || typeof item.completed !== 'boolean') {
      issues += 1;
      continue;
    }
    const id = item.id.trim();
    const createdAt = isoTimestamp(item.createdAt);
    if (!createdAt || ids.has(id)) {
      issues += 1;
      continue;
    }
    ids.add(id);
    const reminderAt = item.reminderAt === null ? null : isoTimestamp(item.reminderAt);
    if (item.reminderAt !== null && !reminderAt) issues += 1;
    const attachmentResult = normalizeAttachmentMetadata(item.attachments);
    if (attachmentResult.invalid) issues += 1;
    const location = typeof item.location === 'string' ? item.location.trim().slice(0, 300) : '';
    const locationAddress = typeof item.locationAddress === 'string' ? item.locationAddress.trim().slice(0, 400) : '';
    const notes = typeof item.notes === 'string' ? item.notes.slice(0, 2000) : '';
    if ((item.notes != null && typeof item.notes !== 'string') || (typeof item.notes === 'string' && item.notes.length > 2000)) issues += 1;
    const repeat = normalizeRepeat(item.repeat);
    const destination = normalizeDestination(item.destination);
    if (item.destination != null && !destination) issues += 1;
    if (item.repeat !== undefined && item.repeat !== 'once' && !REPEAT_OPTIONS.some(option => option.value === item.repeat)) issues += 1;
    if (repeat !== 'none' && !reminderAt) issues += 1;
    const normalized = {
      id,
      title: item.title.trim(),
      originalInput: item.originalInput,
      reminderAt,
      completed: item.completed,
      createdAt,
      category: normalizeTaskCategory(item.category),
      notes,
      repeat,
      mode: 'personal',
      location,
      locationAddress,
      locationLat: safeCoordinate(item.locationLat, -90, 90),
      locationLng: safeCoordinate(item.locationLng, -180, 180),
      attachments: attachmentResult.attachments,
    };
    if (destination) normalized.destination = destination;
    else if (item.destination === null) normalized.destination = null;
    if (repeat !== 'none') {
      const seriesId = typeof item.seriesId === 'string' && item.seriesId.trim() ? item.seriesId.trim() : id;
      if (item.seriesId !== undefined && (typeof item.seriesId !== 'string' || !item.seriesId.trim())) issues += 1;
      normalized.seriesId = seriesId;
      if (repeat === 'monthly' || repeat === 'yearly') {
        const validDay = Number.isInteger(item.repeatDay) && item.repeatDay >= 1 && item.repeatDay <= 31;
        if (item.repeatDay !== undefined && !validDay) issues += 1;
        if (reminderAt) normalized.repeatDay = validDay ? item.repeatDay : new Date(reminderAt).getDate();
      }
      if (repeat === 'yearly') {
        const validMonth = Number.isInteger(item.repeatMonth) && item.repeatMonth >= 1 && item.repeatMonth <= 12;
        if (item.repeatMonth !== undefined && !validMonth) issues += 1;
        if (reminderAt) normalized.repeatMonth = validMonth ? item.repeatMonth : new Date(reminderAt).getMonth() + 1;
      }
    }
    // Keep generation history even when a child is moved to memo or stops repeating.
    if (item.repeatParentId !== undefined) {
      if (typeof item.repeatParentId === 'string' && item.repeatParentId.trim()) normalized.repeatParentId = item.repeatParentId.trim();
      else issues += 1;
    }
    const updatedAt = isoTimestamp(item.updatedAt);
    if (updatedAt) normalized.updatedAt = updatedAt;
    tasks.push(normalized);
  }
  return { tasks, issues };
}

/** A damaged record never causes an automatic overwrite of the original data. */
export function loadTasks(storage) {
  try {
    const activeStorage = storage ?? globalThis.localStorage;
    if (!activeStorage || typeof activeStorage.getItem !== 'function') {
      throw new Error('Storage unavailable');
    }
    const raw = activeStorage.getItem(STORAGE_KEY);
    if (raw === null) return { tasks: [], error: null, readOnly: false };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        tasks: [],
        error: '已儲存的任務資料無法讀取。原始資料已保留，目前已停用修改，避免覆寫。',
        readOnly: true,
      };
    }
    const { tasks, issues } = inspectTasks(parsed);
    return {
      tasks,
      error: issues ? '部分已儲存的任務資料不完整或格式錯誤。已顯示可讀取的任務，原始資料已保留，目前已停用修改。' : null,
      readOnly: issues > 0,
    };
  } catch {
    return {
      tasks: [],
      error: '無法讀取本機儲存資料，請確認瀏覽器允許儲存資料。目前已停用修改，避免覆寫。',
      readOnly: true,
    };
  }
}

export function saveTasks(tasks, storage) {
  const inspected = inspectTasks(tasks);
  if (inspected.issues) {
    return { ok: false, error: '任務資料不完整或格式錯誤，未儲存任何變更。' };
  }
  try {
    const activeStorage = storage ?? globalThis.localStorage;
    if (!activeStorage || typeof activeStorage.setItem !== 'function') {
      throw new Error('Storage unavailable');
    }
    activeStorage.setItem(STORAGE_KEY, JSON.stringify(inspected.tasks));
    return { ok: true, error: null };
  } catch (error) {
    if (error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return { ok: false, error: '本機儲存空間不足，這次變更未儲存。請釋出空間後再試。' };
    }
    return { ok: false, error: '無法儲存任務，這次變更未儲存。請確認瀏覽器允許儲存資料。' };
  }
}

function timestamp(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : Number.POSITIVE_INFINITY;
}

function sameLocalDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** Completion wins over due dates; equal-to-now reminders are already due. */
export function classifyTasks(tasks, now = new Date()) {
  const groups = { overdue: [], today: [], pending: [], completed: [] };
  const nowTime = now.getTime();
  for (const task of tasks) {
    if (task.completed) {
      groups.completed.push(task);
      continue;
    }
    const reminderTime = timestamp(task.reminderAt);
    if (reminderTime <= nowTime) groups.overdue.push(task);
    else if (Number.isFinite(reminderTime) && sameLocalDay(new Date(reminderTime), now)) groups.today.push(task);
    else groups.pending.push(task);
  }
  for (const group of Object.values(groups)) {
    group.sort((left, right) => {
      const leftReminder = timestamp(left.reminderAt);
      const rightReminder = timestamp(right.reminderAt);
      if (leftReminder !== rightReminder) return leftReminder < rightReminder ? -1 : 1;
      const leftCreated = timestamp(left.createdAt);
      const rightCreated = timestamp(right.createdAt);
      return leftCreated === rightCreated ? 0 : leftCreated < rightCreated ? -1 : 1;
    });
  }
  return groups;
}
