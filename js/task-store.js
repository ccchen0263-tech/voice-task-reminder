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
    tasks.push({
      id,
      title: item.title.trim(),
      originalInput: item.originalInput,
      reminderAt,
      completed: item.completed,
      createdAt,
    });
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
