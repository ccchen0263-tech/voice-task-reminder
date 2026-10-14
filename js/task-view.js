export const DEFAULT_CATEGORY = 'other';

export const TASK_CATEGORIES = Object.freeze([
  Object.freeze({ code: 'work', label: '工作', color: '#415ad7' }),
  Object.freeze({ code: 'life', label: '生活', color: '#ad6326' }),
  Object.freeze({ code: 'health', label: '健康', color: '#287565' }),
  Object.freeze({ code: 'other', label: '其他', color: '#657487' }),
]);

const CATEGORY_CODES = new Set(TASK_CATEGORIES.map(category => category.code));

export function normalizeTaskCategory(value) {
  return CATEGORY_CODES.has(value) ? value : DEFAULT_CATEGORY;
}

/** Use local date components; ISO's first ten characters represent a UTC date. */
export function localDateKey(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function validSelectedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return localDateKey(date) === value;
}

function searchableText(task) {
  const fields = [task.title, task.originalInput, task.notes, task.location, task.locationAddress];
  if (Array.isArray(task.attachments)) fields.push(...task.attachments.map(attachment => attachment?.name));
  return fields.filter(value => typeof value === 'string').join('\n').toLocaleLowerCase('zh-TW');
}

/** Filter without changing stored tasks, their order, or their object identities. */
export function filterTasks(tasks, {
  query = '', category = 'all', view = 'agenda', selectedDate = null, includeCompleted = true,
} = {}) {
  if (!Array.isArray(tasks)) return [];
  const search = typeof query === 'string' ? query.trim().toLocaleLowerCase('zh-TW') : '';
  const dateIsValid = view !== 'calendar' || validSelectedDate(selectedDate);
  if (!dateIsValid) return [];

  return tasks.filter(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
    if (!includeCompleted && task.completed) return false;
    if (category !== 'all' && normalizeTaskCategory(task.category) !== category) return false;
    const reminderDate = localDateKey(task.reminderAt);
    if (view === 'memo' && reminderDate !== null) return false;
    if (view === 'calendar' && reminderDate !== selectedDate) return false;
    return !search || searchableText(task).includes(search);
  });
}
