export const ALERTS_KEY = 'voice-task-reminder.alerts.v1';
export const MAX_ALERT_RECORDS = 2000;

function validReminderTime(value) {
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
  return Number.isFinite(date.getTime()) ? date : null;
}

/** A time edit receives a new identity; equivalent ISO offsets keep one identity. */
export function reminderKey(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
      || typeof task.id !== 'string' || !task.id.trim()) return null;
  const date = validReminderTime(task.reminderAt);
  return date ? JSON.stringify([task.id, date.toISOString()]) : null;
}

/** Return original unfinished task references whose valid time has arrived. */
export function getOverdueTasks(tasks, now = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Array.isArray(tasks) || !Number.isFinite(timestamp)) return [];
  return tasks.filter(task => {
    if (!reminderKey(task) || task.completed === true) return false;
    return new Date(task.reminderAt).getTime() <= timestamp;
  });
}

function validLedgerKey(key) {
  if (typeof key !== 'string') return false;
  try {
    const value = JSON.parse(key);
    return Array.isArray(value) && value.length === 2
      && reminderKey({ id: value[0], reminderAt: value[1] }) === key;
  } catch {
    return false;
  }
}

/**
 * Tracks page-open reminders only. Call prime once at startup, then poll as time
 * changes. Shared storage reduces duplicate alerts across tabs, but localStorage
 * cannot make simultaneous read/write operations in separate tabs atomic.
 */
export function createReminderTracker({ storage, now = () => Date.now() } = {}) {
  const seen = new Set();
  const delivered = new Set();
  let activeStorage = null;
  let dirty = false;
  let writable = false;
  let error = null;
  let errorKind = null;

  function setError(kind, message) {
    errorKind = kind;
    error = message;
  }

  try {
    activeStorage = storage ?? globalThis.localStorage;
  } catch {
    // A blocked localStorage getter is handled like any other storage failure.
  }

  function refreshLedger() {
    writable = false;
    try {
      if (!activeStorage || typeof activeStorage.getItem !== 'function') throw new Error('Storage unavailable');
      const raw = activeStorage.getItem(ALERTS_KEY);
      const keys = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(keys) || keys.length > MAX_ALERT_RECORDS || !keys.every(validLedgerKey)) {
        setError('corrupt', '提醒紀錄格式錯誤，已保留原始資料；目前僅在此分頁避免重複提醒。');
        return;
      }
      for (const key of keys) {
        seen.add(key);
        delivered.add(key);
      }
      writable = true;
      if (errorKind !== 'write') { error = null; errorKind = null; }
    } catch (cause) {
      setError(cause instanceof SyntaxError ? 'corrupt' : 'read', cause instanceof SyntaxError
        ? '提醒紀錄格式錯誤，已保留原始資料；目前僅在此分頁避免重複提醒。'
        : '無法讀取提醒紀錄；目前僅在此分頁避免重複提醒。');
    }
  }

  function persistLedger() {
    if (!dirty || !writable) return;
    try {
      if (typeof activeStorage.setItem !== 'function') throw new Error('Storage unavailable');
      activeStorage.setItem(ALERTS_KEY, JSON.stringify([...delivered].slice(-MAX_ALERT_RECORDS)));
      dirty = false;
      error = null;
      errorKind = null;
    } catch {
      setError('write', '無法儲存提醒紀錄；此分頁仍會避免重複提醒，其他分頁或重新開啟後可能再次提示。');
    }
  }

  function markDue(tasks) {
    const due = [];
    for (const task of getOverdueTasks(tasks, now())) {
      const key = reminderKey(task);
      if (seen.has(key)) continue;
      seen.add(key);
      delivered.add(key);
      dirty = true;
      due.push(task);
    }
    persistLedger();
    return due;
  }

  refreshLedger();
  return {
    get error() { return error; },
    prime(tasks) {
      refreshLedger();
      // Opening a new page stays quiet without silencing an already-open page.
      for (const task of getOverdueTasks(tasks, now())) seen.add(reminderKey(task));
    },
    poll(tasks) {
      refreshLedger();
      return markDue(tasks);
    },
  };
}
