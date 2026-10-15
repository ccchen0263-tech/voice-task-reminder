import { parseTaskInput } from './time-parser.js';
import { createGoogleCalendarUrl, createMapUrl, downloadICS } from './calendar.js';
import { STORAGE_KEY, loadTasks, saveTasks, classifyTasks } from './task-store.js';
import { SETTINGS_KEY, loadSettings, saveSettings, normalizeSettings } from './settings-store.js';
import { TASK_CATEGORIES, filterTasks } from './task-view.js';
import { getMonthDays, getWeekDays, shiftDateKey, toLocalDateKey, toDateTimeLocal, parseDateTimeLocal, shiftMonth } from './planner.js';
import { REPEAT_OPTIONS, normalizeRepeat, repeatLabel, createNextOccurrence } from './recurrence.js';
import { createReminderTracker, getOverdueTasks } from './reminders.js';
import { availableDestinations, resolveDestination, normalizeDestination, destinationLabel } from './destinations.js';
import { setupSpeechInput } from './speech-input.js';
import { setupTheme } from './theme.js';
import { deleteAttachments, getAttachment, listAttachments, MAX_ATTACHMENTS_PER_TASK, saveAttachmentBatch, sanitizeAttachmentName, validateAttachment } from './attachment-store.js';

const $ = selector => document.querySelector(selector);
const form = $('#task-form');
const input = $('#task-input');
const voiceButton = $('#voice-button');
const voiceLabel = $('#voice-label');
const speechStatus = $('#speech-status');
const addButton = $('#add-button');
const warning = $('#storage-warning');
const notification = $('#notification');
const undoButton = $('#undo-button');
const template = $('#task-template');
const locationInput = $('#task-location');
const locationButton = $('#location-button');
const attachmentInput = $('#attachment-input');
const attachmentDraftList = $('#attachment-draft-list');
const taskDestination = $('#task-destination');
const destinationName = $('#destination-name');
const destinationList = $('#destination-list');
let recordingDestination = null;
const placeName = $('#place-name');
const placeAddress = $('#place-address');
const commonPlaces = $('#common-places');
const commonPlaceList = $('#common-place-list');
const attachmentDialog = $('#attachment-dialog');
const attachmentDialogTitle = $('#attachment-dialog-title');
const attachmentPreviewImage = $('#attachment-preview-image');
const attachmentPreviewNote = $('#attachment-preview-note');
const attachmentDownload = $('#attachment-download');
const cleanupAttachmentsButton = $('#cleanup-attachments');
const taskCategory = $('#task-category');
const taskNotes = $('#task-notes');
const taskTime = $('#task-time');
const taskNoTime = $('#task-no-time');
const taskRepeat = $('#task-repeat');
const pageAlerts = $('#page-alerts');
const soundButton = $('#enable-sound');
const systemNotificationButton = $('#enable-system-notifications');
const reminderStatus = $('#reminder-status');
const calendarAlarm = $('#calendar-alarm');
const searchInput = $('#search-input');
const categoryFilter = $('#category-filter');
const includeCompleted = $('#include-completed');
const editDialog = $('#edit-dialog');
const editForm = $('#edit-form');
let editingTaskId = null;
let editingTaskSnapshot = null;
const initialDay = new Date();
const viewState = { view: 'agenda', calendarMode: 'month', selectedDate: toLocalDateKey(initialDay), year: initialDay.getFullYear(), monthIndex: initialDay.getMonth() };
const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
let { tasks, error: loadError, readOnly } = loadTasks();
let { settings, error: settingsError, destinationWarning } = loadSettings();
let destinationNotice = destinationWarning || '';
const reminderTracker = createReminderTracker();
reminderTracker.prime(tasks);
let audioContext = null;
let reminderActionStatus = '';
let attachmentDrafts = [];
let attachmentObjectUrls = [];
let dialogObjectUrl = null;
let listening = false;
let submitting = false;
let locationRequestVersion = 0;
let composing = false;
let deletedTask = null;
let notificationTimer;
const deletedAttachmentCleanupTimers = new Map();

function formatTime(iso) {
  return iso ? dateFormatter.format(new Date(iso)).replace(/24:/, '00:') : '未設定';
}

function renderDueBanner(sourceTasks = tasks) {
  const overdue = getOverdueTasks(sourceTasks);
  $('#due-alert').hidden = !settings.pageAlertsEnabled || overdue.length === 0;
  const summary = `${overdue.length} 件任務已到期`;
  if ($('#due-alert-text').textContent !== summary) $('#due-alert-text').textContent = summary;
  const names = overdue.slice(0, 3).map(task => task.title).join('、');
  const details = `${names}${overdue.length > 3 ? `，以及另外 ${overdue.length - 3} 件` : ''}`;
  if ($('#due-alert-tasks').textContent !== details) $('#due-alert-tasks').textContent = details;
}

function notificationSupport() {
  return typeof window.Notification === 'function' && window.isSecureContext !== false
    && typeof window.Notification.requestPermission === 'function';
}

function renderReminderControls() {
  pageAlerts.checked = settings.pageAlertsEnabled;
  calendarAlarm.value = settings.calendarAlarmMinutes === null ? 'none' : String(settings.calendarAlarmMinutes);
  const AudioAPI = window.AudioContext || window.webkitAudioContext;
  soundButton.disabled = !AudioAPI;
  const soundReady = Boolean(settings.soundEnabled && audioContext?.state === 'running');
  soundButton.textContent = soundReady ? '關閉響鈴' : '啟用／測試響鈴';
  soundButton.setAttribute('aria-pressed', String(soundReady));
  const supported = notificationSupport();
  const permission = supported ? window.Notification.permission : 'unsupported';
  systemNotificationButton.disabled = !supported || permission === 'denied';
  const systemReady = settings.systemNotifications && permission === 'granted';
  systemNotificationButton.textContent = systemReady ? '關閉系統通知' : '啟用系統通知';
  systemNotificationButton.setAttribute('aria-pressed', String(systemReady));
  const notes = [settings.pageAlertsEnabled ? '頁面提示已開啟。' : '頁面提示已關閉。',
    !AudioAPI ? '此瀏覽器不支援響鈴。' : soundReady ? '響鈴已就緒。' : '響鈴需要在這次開啟頁面後點擊啟用。',
    !supported ? '此環境不支援頁面系統通知。' : permission === 'denied' ? '系統通知被封鎖，請在瀏覽器設定調整。'
      : systemReady ? '系統通知已開啟。' : '系統通知尚未啟用。'];
  if (reminderTracker.error) notes.push(reminderTracker.error);
  if (reminderActionStatus) notes.push(reminderActionStatus);
  reminderStatus.textContent = notes.join(' ');
}

function playReminderTone() {
  if (!audioContext || audioContext.state !== 'running') return false;
  try {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const start = audioContext.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
    gain.gain.setValueAtTime(0.15, start + 0.35);
    gain.gain.linearRampToValueAtTime(0, start + 0.5);
    oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start); oscillator.stop(start + 0.52);
    return true;
  } catch { return false; }
}

function checkReminders() {
  const latest = loadTasks();
  if (readOnly || latest.readOnly) return;
  const newlyDue = reminderTracker.poll(latest.tasks);
  renderDueBanner(latest.tasks);
  if (!newlyDue.length) return;
  if (settings.soundEnabled && !playReminderTone()) {
    reminderActionStatus = '瀏覽器暫停了響鈴；請回到設定點擊啟用／測試響鈴。';
  }
  if (settings.systemNotifications && notificationSupport() && window.Notification.permission === 'granted') {
    try {
      const titles = newlyDue.slice(0, 3).map(task => task.title).join('、');
      new window.Notification('待辦任務已到期', { body: titles, tag: `voice-task-reminder-${Date.now()}` });
    } catch {
      reminderActionStatus = '此裝置無法送出頁面系統通知，請查看頁面提示或使用行事曆提醒。';
    }
  }
  renderReminderControls();
}

pageAlerts.addEventListener('change', () => {
  if (persistSettings({ ...settings, pageAlertsEnabled: pageAlerts.checked })) renderDueBanner();
  else renderReminderControls();
});
calendarAlarm.addEventListener('change', () => {
  const minutes = calendarAlarm.value === 'none' ? null : Number(calendarAlarm.value);
  if (!persistSettings({ ...settings, calendarAlarmMinutes: minutes })) renderReminderControls();
});
soundButton.addEventListener('click', async () => {
  if (settings.soundEnabled && audioContext?.state === 'running') {
    if (persistSettings({ ...settings, soundEnabled: false })) {
      reminderActionStatus = '響鈴已關閉。'; renderReminderControls();
    }
    return;
  }
  const AudioAPI = window.AudioContext || window.webkitAudioContext;
  if (!AudioAPI) return;
  try {
    audioContext ||= new AudioAPI();
    await audioContext.resume();
    if (!playReminderTone()) throw new Error('sound-unavailable');
    if (persistSettings({ ...settings, soundEnabled: true })) reminderActionStatus = '已播放測試聲音；請確認裝置音量。';
  } catch { reminderActionStatus = '無法啟用響鈴，請確認瀏覽器與裝置音量設定。'; }
  renderReminderControls();
});
systemNotificationButton.addEventListener('click', async () => {
  if (!notificationSupport()) return;
  if (settings.systemNotifications && window.Notification.permission === 'granted') {
    if (persistSettings({ ...settings, systemNotifications: false })) {
      reminderActionStatus = 'App 系統通知已關閉。'; renderReminderControls();
    }
    return;
  }
  try {
    const permission = window.Notification.permission === 'granted' ? 'granted' : await window.Notification.requestPermission();
    if (permission === 'granted') {
      new window.Notification('待辦提醒測試', { body: '頁面開啟時，到期任務可以在此顯示。', tag: 'voice-task-reminder-test' });
      if (persistSettings({ ...settings, systemNotifications: true })) reminderActionStatus = '已送出測試通知；顯示方式依作業系統設定。';
    } else reminderActionStatus = '尚未取得通知權限，請使用頁面提示或行事曆提醒。';
  } catch { reminderActionStatus = '此裝置無法使用頁面系統通知，請使用頁面提示或行事曆提醒。'; }
  renderReminderControls();
});
$('#view-overdue').addEventListener('click', () => {
  viewState.view = 'agenda'; searchInput.value = ''; categoryFilter.value = 'all'; includeCompleted.checked = false;
  renderTasks(); $('[data-group="overdue"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function showNotification(message, canUndo = false) {
  clearTimeout(notificationTimer);
  $('#notification-text').textContent = message;
  undoButton.hidden = !canUndo;
  notification.hidden = false;
  notificationTimer = setTimeout(() => { notification.hidden = true; }, canUndo ? 15000 : 5000);
}

function updateStorageWarning(message = loadError || settingsError) {
  warning.hidden = !message;
  warning.textContent = message ? `${message}${readOnly ? ' 已停用資料修改，原始儲存內容仍保留。' : ''}` : '';
  addButton.disabled = readOnly || listening || submitting;
  cleanupAttachmentsButton.disabled = readOnly;
}

function renderDestinationSelector(select, current = null, allowBlank = false) {
  const options = availableDestinations(settings);
  if (current && !options.some(item => item.id === current.id)) options.push(current);
  select.replaceChildren();
  if (allowBlank) {
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '未指定（保留舊任務）'; select.append(empty);
  }
  for (const destination of options) {
    const option = document.createElement('option'); option.value = destination.id; option.textContent = destinationLabel(destination); select.append(option);
  }
  select.value = current?.id || (allowBlank ? '' : 'local');
}

function updateDestinationHint() {
  const selected = recordingDestination?.id === taskDestination.value ? recordingDestination : resolveDestination(taskDestination.value, settings);
  const exportHint = selected?.provider === 'google' ? '只能開啟草稿或下載 ICS，尚未連線或指定寫入 Google。'
    : selected?.provider === 'apple' ? '下載後自行選行事曆匯入。' : '不匯出到外部行事曆。';
  const memoHint = selected && selected.provider !== 'local' ? '未定時間可先存備忘，設定時間後才能匯出。' : '';
  $('#destination-hint').textContent = `${destinationNotice ? `${destinationNotice} ` : ''}這次新增：${destinationLabel(selected)}。${exportHint}${memoHint}`;
}

function renderDestinations() {
  const previousId = taskDestination.value;
  const current = recordingDestination || resolveDestination(previousId, settings)
    || resolveDestination(previousId ? 'local' : settings.preferredDestinationId, settings) || resolveDestination('local', settings);
  if (previousId && !recordingDestination && !resolveDestination(previousId, settings)) {
    destinationNotice = '原目的地已不存在，已改用本機任務，請重新選擇。';
  }
  renderDestinationSelector(taskDestination, current);
  taskDestination.disabled = listening || submitting;
  updateDestinationHint();
  destinationList.replaceChildren(...settings.googleDestinationLabels.map(destination => {
    const item = document.createElement('li');
    const label = document.createElement('span'); label.textContent = `${destination.name}（本機名稱，未連線）`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-place';
    remove.dataset.destinationId = destination.id; remove.textContent = '移除名稱'; item.append(label, remove); return item;
  }));
}

taskDestination.addEventListener('change', () => {
  if (listening || submitting) {
    if (recordingDestination) taskDestination.value = recordingDestination.id;
    return;
  }
  recordingDestination = null;
  const selected = resolveDestination(taskDestination.value, settings);
  const destination = selected || resolveDestination('local', settings);
  taskDestination.value = destination.id;
  destinationNotice = selected ? '' : '原目的地已不存在，已改用本機任務，請重新選擇。';
  if (!persistSettings({ ...settings, preferredDestinationId: destination.id })) {
    destinationNotice = '本頁仍使用此目的地；偏好未儲存，重新整理後可能恢復上次選擇。';
  }
  updateDestinationHint();
});
$('#save-destination').addEventListener('click', () => {
  const name = destinationName.value.trim();
  if (!name) { showNotification('請輸入本機 Google 行事曆名稱。'); destinationName.focus(); return; }
  if (settings.googleDestinationLabels.length >= 30) { showNotification('最多保存 30 個本機目的地名稱。'); return; }
  const destination = { id: `google-${newId()}`, provider: 'google', name, source: 'local-label' };
  if (persistSettings({ ...settings, googleDestinationLabels: [...settings.googleDestinationLabels, destination] })) {
    destinationName.value = ''; renderDestinations(); showNotification('已保存本機名稱，請在錄音前選擇本次目的地。');
  }
});
destinationList.addEventListener('click', event => {
  const button = event.target.closest('[data-destination-id]');
  if (!button) return;
  const removingCurrent = taskDestination.value === button.dataset.destinationId;
  if (persistSettings({ ...settings,
    preferredDestinationId: removingCurrent ? 'local' : settings.preferredDestinationId,
    googleDestinationLabels: settings.googleDestinationLabels.filter(item => item.id !== button.dataset.destinationId) })) {
    if (taskDestination.value === button.dataset.destinationId) {
      destinationNotice = recordingDestination ? '這個名稱已移除；本輪錄音保留原選擇，下一輪改用本機任務。'
        : '原目的地已不存在，已改用本機任務，請重新選擇。';
    }
    renderDestinations(); showNotification('已移除本機名稱；既有任務的目的地仍保留。');
  }
});

function persistSettings(nextSettings) {
  const result = saveSettings(nextSettings);
  if (!result.ok) {
    settingsError = result.error;
    updateStorageWarning();
    return false;
  }
  settings = normalizeSettings(nextSettings);
  settingsError = null;
  updateStorageWarning();
  renderReminderControls();
  return true;
}

function renderPlaces() {
  commonPlaces.replaceChildren(...settings.commonPlaces.map(place => {
    const option = document.createElement('option');
    option.value = `${place.name}｜${place.address}`;
    return option;
  }));
  commonPlaceList.replaceChildren(...settings.commonPlaces.map(place => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${place.name}：${place.address}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-place';
    remove.dataset.placeId = place.id;
    remove.textContent = '移除';
    item.append(label, remove);
    return item;
  }));
}

function commit(nextTasks) {
  if (readOnly) { showNotification('目前儲存資料無法安全修改。'); return false; }
  const result = saveTasks(nextTasks);
  if (!result.ok) {
    loadError = result.error || '儲存失敗，請確認瀏覽器允許本機儲存。';
    updateStorageWarning();
    showNotification('儲存失敗，這次變更尚未套用。');
    return false;
  }
  tasks = nextTasks;
  loadError = null;
  updateStorageWarning();
  renderTasks();
  checkReminders();
  return true;
}

function updatePreview() {
  const raw = input.value.trim();
  $('#parse-preview').hidden = !raw;
  input.setCustomValidity('');
  if (!raw || composing) return;
  const parsed = parseTaskInput(raw);
  const reminderAt = taskNoTime.checked ? null : (taskTime.value ? parseDateTimeLocal(taskTime.value) : parsed.reminderAt);
  $('#preview-title').textContent = parsed.title || '請補上待辦事項';
  $('#preview-time').textContent = formatTime(reminderAt);
  $('#preview-note').textContent = taskNoTime.checked ? '先保存在備忘；時間確定後可編輯安排。'
    : taskTime.value ? (reminderAt ? '使用你指定的時間。' : '請確認指定的日期與時間。')
    : reminderAt ? `${new Date(reminderAt).getTime() <= Date.now() ? '這個時間已到期。' : ''}${parsed.explanation || '新增時會依當下時間計算。'}`
    : (parsed.explanation || '尚未找到明確時間；仍可新增為待辦任務。');
}

function createTaskElement(task) {
  const fragment = template.content.cloneNode(true);
  const row = fragment.querySelector('.task-row');
  row.dataset.id = task.id;
  row.classList.toggle('is-completed', task.completed);
  const checkbox = row.querySelector('input');
  checkbox.checked = task.completed;
  checkbox.disabled = readOnly;
  checkbox.setAttribute('aria-label', `${task.completed ? '標記未完成' : '標記完成'}：${task.title}`);
  row.querySelector('.task-title').textContent = task.title;
  const category = TASK_CATEGORIES.find(item => item.code === task.category) || TASK_CATEGORIES.find(item => item.code === 'other');
  row.dataset.category = category.code;
  const tag = document.createElement('span');
  tag.className = 'task-category';
  tag.textContent = category.label;
  row.querySelector('.task-title').after(tag);
  const destination = normalizeDestination(task.destination);
  const destinationNote = document.createElement('p'); destinationNote.className = 'task-destination';
  destinationNote.textContent = `目的地：${destinationLabel(destination)}`;
  row.querySelector('.task-original').after(destinationNote);
  if (!task.reminderAt && destination && destination.provider !== 'local') {
    const pending = document.createElement('p'); pending.className = 'field-hint calendar-pending-note';
    pending.textContent = '已保留目的地；請編輯並設定提醒時間後，再開啟草稿或匯出行事曆。';
    destinationNote.after(pending);
  }
  if (normalizeRepeat(task.repeat) !== 'none') {
    const repeat = document.createElement('span');
    repeat.className = 'repeat-label';
    repeat.textContent = `↻ ${repeatLabel(task.repeat)}`;
    tag.after(repeat);
  }
  if (task.notes) {
    const notes = document.createElement('p');
    notes.className = 'task-notes';
    notes.textContent = task.notes;
    row.querySelector('.task-original').after(notes);
  }
  row.querySelector('.original-text').textContent = task.originalInput;
  const location = String(task.locationAddress || task.location || '').trim();
  if (location) {
    const locationRow = document.createElement('p');
    locationRow.className = 'task-location';
    const label = document.createElement('span');
    label.textContent = `地點：${location}`;
    const mapLink = document.createElement('a');
    mapLink.className = 'map-link';
    mapLink.target = '_blank';
    mapLink.rel = 'noopener noreferrer';
    mapLink.href = createMapUrl(task);
    mapLink.textContent = '開啟地圖';
    locationRow.append(label, mapLink);
    row.querySelector('.task-original').after(locationRow);
  }
  const attachmentMetadata = Array.isArray(task.attachments) ? task.attachments : [];
  if (attachmentMetadata.length) {
    const attachmentRow = document.createElement('div');
    attachmentRow.className = 'task-attachments';
    const label = document.createElement('span');
    label.className = 'attachment-label';
    label.textContent = '附件';
    const list = document.createElement('div');
    list.className = 'attachment-list';
    for (const attachment of attachmentMetadata) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'attachment-button';
      button.dataset.attachmentId = attachment.id;
      button.textContent = `${attachment.kind === 'image' ? '圖片' : '檔案'}：${sanitizeAttachmentName(attachment.name)}（${Math.ceil(attachment.size / 1024)} KB）`;
      list.append(button);
    }
    attachmentRow.append(label, list);
    row.querySelector('.task-original').after(attachmentRow);
  }
  const time = row.querySelector('time');
  time.textContent = formatTime(task.reminderAt);
  if (task.reminderAt) time.dateTime = task.reminderAt;
  else row.querySelector('.task-time').classList.add('no-time');
  const deleteButton = row.querySelector('.delete-button');
  deleteButton.setAttribute('aria-label', `刪除任務：${task.title}`);
  deleteButton.disabled = readOnly;
  if (task.reminderAt) {
    const googleButton = row.querySelector('.google-button');
    const appleButton = row.querySelector('.apple-button');
    googleButton.href = createGoogleCalendarUrl(task);
    row.querySelector('.google-button').setAttribute('aria-label', `開啟 Google Calendar 草稿：${task.title}`);
    row.querySelector('.apple-button').setAttribute('aria-label', `加入 Apple 行事曆：${task.title}`);
    googleButton.hidden = destination?.provider !== 'google';
    appleButton.hidden = !destination || destination.provider === 'local';
    if (destination?.provider === 'google') appleButton.textContent = '下載 ICS（可匯入行事曆）';
    row.querySelector('.calendar-actions').hidden = !destination || destination.provider === 'local';
  } else row.querySelector('.calendar-actions').hidden = true;
  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'edit-button';
  editButton.textContent = task.reminderAt ? '編輯任務' : '編輯／安排時間';
  editButton.setAttribute('aria-label', `編輯任務：${task.title}`);
  editButton.disabled = readOnly;
  row.querySelector('.task-content').append(editButton);
  return fragment;
}

function currentFilters() {
  return { query: searchInput.value, category: categoryFilter.value, view: viewState.view,
    selectedDate: viewState.selectedDate, includeCompleted: includeCompleted.checked };
}

function renderPlanner() {
  const panel = $('#planner-panel');
  panel.hidden = viewState.view !== 'calendar';
  if (panel.hidden) return;
  const visibleTasks = filterTasks(tasks, { ...currentFilters(), view: 'agenda' });
  const week = viewState.calendarMode === 'week';
  const days = week ? getWeekDays(viewState.selectedDate, { tasks: visibleTasks })
    : getMonthDays(viewState.year, viewState.monthIndex, { tasks: visibleTasks });
  const weekRange = days.length ? `${days[0].dateKey} — ${days.at(-1).dateKey}` : '';
  $('#month-label').textContent = week && days.length ? `${days[0].monthIndex + 1}/${days[0].day} — ${days.at(-1).monthIndex + 1}/${days.at(-1).day}` : `${viewState.year} 年 ${viewState.monthIndex + 1} 月`;
  $('#month-label').setAttribute('aria-label', week ? weekRange : $('#month-label').textContent);
  $('#previous-month').disabled = week ? !shiftDateKey(viewState.selectedDate, -7) : viewState.year === 1 && viewState.monthIndex === 0;
  $('#next-month').disabled = week ? !shiftDateKey(viewState.selectedDate, 7) : viewState.year === 9999 && viewState.monthIndex === 11;
  $('#previous-month').setAttribute('aria-label', week ? '上一週' : '上一個月');
  $('#next-month').setAttribute('aria-label', week ? '下一週' : '下一個月');
  panel.setAttribute('aria-label', week ? '週曆' : '月曆');
  panel.classList.toggle('is-week', week);
  $('#month-grid').replaceChildren(...days.map(day => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    button.dataset.date = day.dateKey;
    button.disabled = day.year < 1 || day.year > 9999;
    button.classList.toggle('outside-month', !day.inMonth);
    button.classList.toggle('is-today', day.isToday);
    button.setAttribute('aria-pressed', String(day.dateKey === viewState.selectedDate));
    button.setAttribute('aria-label', `${day.dateKey}，${day.taskCount} 件待完成行程`);
    const number = document.createElement('span');
    number.className = 'day-number';
    number.textContent = day.day;
    const count = document.createElement('span');
    count.className = 'day-count';
    count.textContent = day.taskCount ? `${day.taskCount} 件` : '';
    button.append(number, count);
    return button;
  }));
}

function renderTasks() {
  const visibleTasks = filterTasks(tasks, currentFilters());
  const groups = classifyTasks(visibleTasks);
  const filtered = viewState.view !== 'agenda' || searchInput.value.trim() || categoryFilter.value !== 'all' || !includeCompleted.checked;
  for (const [group, groupTasks] of Object.entries(groups)) {
    const section = $(`[data-group="${group}"]`);
    section.hidden = Boolean(filtered && groupTasks.length === 0);
    section.querySelector('.section-count').textContent = groupTasks.length;
    section.querySelector('.empty-state').hidden = groupTasks.length > 0;
    section.querySelector('.task-list').replaceChildren(...groupTasks.map(createTaskElement));
  }
  $('#task-summary').textContent = `${visibleTasks.length} 筆 · ${tasks.filter(task => !task.completed).length} 件待完成`;
  $('#task-sections').hidden = Boolean(filtered && visibleTasks.length === 0);
  $('#filter-empty').hidden = !filtered || visibleTasks.length > 0;
  $('#filter-empty').textContent = searchInput.value.trim() || categoryFilter.value !== 'all'
    ? '沒有符合條件的任務。試著清除搜尋或切換分類。'
    : viewState.view === 'memo' ? '沒有未定時間的備忘。新增時可選「先存為未定時間的備忘」。'
    : '這天還沒有行程。你可以新增任務，或編輯備忘安排時間。';
  $('#view-heading').textContent = viewState.view === 'calendar' ? `${viewState.selectedDate} 的行程` : viewState.view === 'memo' ? '未定時間的備忘' : '我的行程';
  $('#view-description').textContent = viewState.view === 'calendar' ? '選一天，專心安排當天的事。' : viewState.view === 'memo' ? '時間確定後，點「編輯／安排時間」就能移到行事曆。' : '已到期、今天、接下來的安排，都在同一張清單。';
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === viewState.view)));
  renderPlanner();
  renderDueBanner();
  $('#today-label').textContent = new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());
}

function revealTask(task) {
  searchInput.value = '';
  categoryFilter.value = 'all';
  includeCompleted.checked = true;
  if (!task.reminderAt && viewState.view === 'calendar') viewState.view = 'memo';
  else if (task.reminderAt && viewState.view === 'memo') viewState.view = 'calendar';
  if (task.reminderAt && viewState.view === 'calendar') {
    const date = new Date(task.reminderAt);
    viewState.selectedDate = toLocalDateKey(date);
    viewState.year = date.getFullYear();
    viewState.monthIndex = date.getMonth();
  }
  renderTasks();
}

function taskFingerprint(task) {
  return JSON.stringify([task.id, task.title, task.originalInput, task.reminderAt ?? null, task.completed,
    task.createdAt, task.updatedAt ?? null, task.category || 'other', task.notes || '',
    normalizeRepeat(task.repeat), task.repeatDay ?? null, task.repeatMonth ?? null, task.seriesId ?? null, task.repeatParentId ?? null,
    task.destination ? [task.destination.id, task.destination.provider, task.destination.name, task.destination.source] : null,
    task.location || '', task.locationAddress || '', task.locationLat ?? null, task.locationLng ?? null,
    (task.attachments || []).map(item => [item.id, item.name, item.type, item.kind, item.size])]);
}

function openTaskEditor(task) {
  if (readOnly) return;
  editingTaskId = task.id;
  editingTaskSnapshot = taskFingerprint(task);
  $('#edit-title').value = task.title;
  $('#edit-time').value = toDateTimeLocal(task.reminderAt);
  $('#edit-category').value = task.category || 'other';
  renderDestinationSelector($('#edit-destination'), normalizeDestination(task.destination), true);
  $('#edit-repeat').value = normalizeRepeat(task.repeat);
  $('#edit-title').setCustomValidity('');
  $('#edit-time').setCustomValidity('');
  $('#edit-notes').value = task.notes || '';
  $('#edit-location').value = task.locationAddress || task.location || '';
  editDialog.showModal();
  $('#edit-title').focus();
}

editForm.addEventListener('submit', event => {
  event.preventDefault();
  // Re-read storage so a not-yet-delivered cross-tab event cannot overwrite newer data.
  const latest = loadTasks();
  const task = latest.tasks.find(item => item.id === editingTaskId);
  if (!task || readOnly || latest.readOnly || taskFingerprint(task) !== editingTaskSnapshot) {
    tasks = latest.tasks; loadError = latest.error; readOnly = latest.readOnly;
    updateStorageWarning(); renderTasks();
    editDialog.close();
    showNotification(readOnly ? '目前資料無法安全修改，請先確認本機儲存狀態。'
      : !task ? '這筆任務已不存在，請重新確認清單。'
      : '這筆任務已在其他分頁更新，請重新開啟編輯，避免覆寫。');
    return;
  }
  const title = $('#edit-title').value.trim();
  if (!title) { $('#edit-title').setCustomValidity('請輸入任務名稱'); $('#edit-title').reportValidity(); return; }
  const timeValue = $('#edit-time').value;
  const reminderAt = timeValue === toDateTimeLocal(task.reminderAt) ? task.reminderAt : parseDateTimeLocal(timeValue);
  if (timeValue && !reminderAt) { $('#edit-time').setCustomValidity('請輸入有效日期與時間'); $('#edit-time').reportValidity(); return; }
  const repeat = normalizeRepeat($('#edit-repeat').value);
  if (repeat !== 'none' && !reminderAt) {
    $('#edit-time').setCustomValidity('重複任務需要提醒時間；請填入時間或改為不重複。');
    $('#edit-time').reportValidity(); return;
  }
  const location = $('#edit-location').value.trim();
  const sameLocation = location === (task.locationAddress || task.location || '');
  const destinationId = $('#edit-destination').value;
  const destination = destinationId === task.destination?.id ? normalizeDestination(task.destination) : resolveDestination(destinationId, settings);
  if (destinationId && !destination) { showNotification('目的地已不存在，請重新選擇。'); return; }
  const nextTask = { ...task, title, reminderAt, repeat, category: $('#edit-category').value, notes: $('#edit-notes').value.trim(),
    destination,
    location: sameLocation ? task.location : location, locationAddress: location,
    locationLat: sameLocation ? task.locationLat : null, locationLng: sameLocation ? task.locationLng : null,
    updatedAt: new Date().toISOString() };
  if (repeat === 'none') { delete nextTask.seriesId; delete nextTask.repeatDay; delete nextTask.repeatMonth; }
  else {
    nextTask.seriesId = task.seriesId || task.id;
    if (repeat === 'monthly' || repeat === 'yearly') nextTask.repeatDay = task.repeat === repeat
      && toLocalDateKey(new Date(reminderAt)) === toLocalDateKey(new Date(task.reminderAt))
      ? (task.repeatDay || new Date(reminderAt).getDate()) : new Date(reminderAt).getDate();
    else delete nextTask.repeatDay;
    if (repeat === 'yearly') nextTask.repeatMonth = task.repeat === 'yearly'
      && toLocalDateKey(new Date(reminderAt)) === toLocalDateKey(new Date(task.reminderAt))
      ? (task.repeatMonth || new Date(reminderAt).getMonth() + 1) : new Date(reminderAt).getMonth() + 1;
    else delete nextTask.repeatMonth;
  }
  if (commit(latest.tasks.map(item => item.id === task.id ? nextTask : item))) {
    editDialog.close();
    revealTask(nextTask);
    showNotification(`已更新「${title}」`);
  }
});
['#edit-title', '#edit-time'].forEach(selector => $(selector).addEventListener('input', event => event.target.setCustomValidity('')));
$('#edit-repeat').addEventListener('change', () => $('#edit-time').setCustomValidity(''));
['#close-edit', '#cancel-edit'].forEach(selector => $(selector).addEventListener('click', () => editDialog.close()));
editDialog.addEventListener('close', () => { editingTaskId = null; editingTaskSnapshot = null; });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  viewState.view = button.dataset.view;
  renderTasks();
  const target = viewState.view === 'calendar' ? $('#planner-panel') : $('#view-heading');
  target.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth', block: 'start' });
}));
$('#quick-add').addEventListener('click', () => {
  $('#composer-title').scrollIntoView?.({ behavior: 'auto', block: 'start' });
  input.focus();
});
[searchInput, categoryFilter, includeCompleted].forEach(control => control.addEventListener(control === searchInput ? 'input' : 'change', renderTasks));
function navigateMonth(delta) {
  if (viewState.calendarMode === 'week') {
    const nextDay = shiftDateKey(viewState.selectedDate, delta * 7);
    if (!nextDay) { showNotification('已達支援的年份範圍。'); return; }
    const date = new Date(`${nextDay}T12:00:00`);
    viewState.selectedDate = nextDay;
    viewState.year = date.getFullYear(); viewState.monthIndex = date.getMonth();
    renderTasks(); return;
  }
  let next;
  try { next = shiftMonth(viewState.year, viewState.monthIndex, delta); }
  catch { showNotification('已達支援的年份範圍。'); return; }
  Object.assign(viewState, next);
  const firstDay = new Date(0);
  firstDay.setFullYear(viewState.year, viewState.monthIndex, 1);
  firstDay.setHours(12, 0, 0, 0);
  viewState.selectedDate = toLocalDateKey(firstDay);
  renderTasks();
}
$('#previous-month').addEventListener('click', () => navigateMonth(-1));
$('#next-month').addEventListener('click', () => navigateMonth(1));
$('#calendar-mode').addEventListener('change', event => {
  viewState.calendarMode = event.target.value === 'week' ? 'week' : 'month';
  renderTasks();
});
$('#go-today').addEventListener('click', () => {
  const today = new Date();
  viewState.selectedDate = toLocalDateKey(today);
  viewState.year = today.getFullYear(); viewState.monthIndex = today.getMonth();
  renderTasks();
});
$('#month-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-date]');
  if (!button) return;
  viewState.selectedDate = button.dataset.date;
  const date = new Date(`${viewState.selectedDate}T12:00:00`);
  viewState.year = date.getFullYear(); viewState.monthIndex = date.getMonth();
  renderTasks();
  $('#month-grid').querySelector(`[data-date="${viewState.selectedDate}"]`)?.focus();
});
$('#month-grid').addEventListener('keydown', event => {
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  const button = event.target.closest('[data-date]');
  if (!button || !(event.key in offsets)) return;
  event.preventDefault();
  const nextDate = shiftDateKey(button.dataset.date, offsets[event.key]);
  if (!nextDate) return;
  const date = new Date(`${nextDate}T12:00:00`);
  viewState.selectedDate = nextDate;
  viewState.year = date.getFullYear(); viewState.monthIndex = date.getMonth();
  renderTasks();
  $('#month-grid').querySelector(`[data-date="${viewState.selectedDate}"]`)?.focus();
});
taskTime.addEventListener('input', () => { taskTime.setCustomValidity(''); updatePreview(); });
taskNoTime.addEventListener('change', () => { taskTime.disabled = taskNoTime.checked; updatePreview(); });
document.querySelectorAll('select.task-category-select').forEach(select => {
  for (const category of TASK_CATEGORIES) {
    const option = document.createElement('option');
    option.value = category.code; option.textContent = category.label;
    select.append(option);
  }
  select.value = 'other';
});
document.querySelectorAll('select.task-repeat-select').forEach(select => {
  for (const repeat of REPEAT_OPTIONS) {
    const option = document.createElement('option');
    option.value = repeat.value; option.textContent = repeat.label;
    select.append(option);
  }
  select.value = 'none';
});
for (const category of TASK_CATEGORIES) {
  const option = document.createElement('option');
  option.value = category.code; option.textContent = category.label;
  categoryFilter.append(option);
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function formatBytes(size) {
  return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function clearAttachmentDrafts() {
  for (const url of attachmentObjectUrls) URL.revokeObjectURL(url);
  attachmentObjectUrls = [];
  attachmentDrafts = [];
  attachmentInput.value = '';
  attachmentDraftList.replaceChildren();
}

function renderAttachmentDrafts() {
  for (const url of attachmentObjectUrls) URL.revokeObjectURL(url);
  attachmentObjectUrls = [];
  attachmentDraftList.replaceChildren(...attachmentDrafts.map((draft, index) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${draft.metadata.name}（${formatBytes(draft.metadata.size)}）`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-attachment';
    remove.dataset.attachmentIndex = String(index);
    remove.textContent = '移除';
    item.append(label, remove);
    if (draft.metadata.kind === 'image') {
      const preview = document.createElement('img');
      const url = URL.createObjectURL(draft.file);
      attachmentObjectUrls.push(url);
      preview.src = url;
      preview.alt = `附件預覽：${draft.metadata.name}`;
      preview.loading = 'lazy';
      item.prepend(preview);
    }
    return item;
  }));
}

function getLocationData() {
  const value = locationInput.value.trim();
  if (!value) return { location: '', locationAddress: '', locationLat: null, locationLng: null };
  const selected = settings.commonPlaces.find(place => value === place.name || value === `${place.name}｜${place.address}`);
  if (selected) return { location: selected.name, locationAddress: selected.address, locationLat: selected.lat, locationLng: selected.lng };
  const latitude = Number(locationInput.dataset.latitude);
  const longitude = Number(locationInput.dataset.longitude);
  return {
    location: value,
    locationAddress: value,
    locationLat: Number.isFinite(latitude) ? latitude : null,
    locationLng: Number.isFinite(longitude) ? longitude : null,
  };
}

async function persistTaskAttachments(task) {
  try {
    return await saveAttachmentBatch(task.id, [...attachmentDrafts]);
  } catch (error) {
    showNotification(error?.message || '附件只可儲存在此裝置，這次任務尚未新增。');
    return null;
  }
}

function scheduleDeletedTaskAttachmentCleanup(task) {
  if (!task.attachments?.length) return;
  const timer = setTimeout(async () => {
    const latest = loadTasks();
    if (!readOnly && !latest.readOnly) {
      const referenced = new Set(latest.tasks.flatMap(item => (item.attachments || []).map(attachment => attachment.id)));
      const unreferenced = task.attachments.map(attachment => attachment.id).filter(id => !referenced.has(id));
      if (unreferenced.length) await deleteAttachments(unreferenced).catch(() => {});
    }
    deletedAttachmentCleanupTimers.delete(task.id);
    if (deletedTask?.id === task.id) deletedTask = null;
  }, 15000);
  deletedAttachmentCleanupTimers.set(task.id, timer);
}

async function cleanupOrphanAttachments() {
  if (readOnly) { showNotification('任務資料無法完整讀取，已停用附件清理，避免刪除仍被使用的檔案。'); return; }
  try {
    const records = await listAttachments();
    const latest = loadTasks();
    if (readOnly || latest.readOnly) { showNotification('任務資料無法完整讀取，已停用附件清理。'); return; }
    const referenced = new Set(latest.tasks.flatMap(task => (task.attachments || []).map(attachment => attachment.id)));
    const orphanIds = records.filter(record => !referenced.has(record.id)).map(record => record.id);
    await deleteAttachments(orphanIds);
    showNotification(orphanIds.length ? `已清理 ${orphanIds.length} 個未連結的本機附件。` : '沒有未連結的本機附件。');
  } catch (error) {
    showNotification(error?.message || '無法清理本機附件。');
  }
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBackup() {
  downloadJson(`voice-task-reminder-${new Date().toISOString().slice(0, 10)}.json`, {
    format: 'voice-task-reminder.task-backup.v1',
    exportedAt: new Date().toISOString(),
    storage: 'localStorage; attachment blobs are not included',
    tasks,
  });
  showNotification('已下載任務 JSON；附件內容未包含在檔案內。');
}

async function openAttachment(task, attachmentId) {
  const metadata = (task.attachments || []).find(item => item.id === attachmentId);
  if (!metadata) return;
  try {
    const record = await getAttachment(attachmentId);
    if (!record?.blob) throw new Error('找不到此附件內容；它可能已被清除。');
    if (dialogObjectUrl) URL.revokeObjectURL(dialogObjectUrl);
    dialogObjectUrl = URL.createObjectURL(record.blob);
    attachmentDialogTitle.textContent = sanitizeAttachmentName(metadata.name);
    attachmentDownload.href = dialogObjectUrl;
    attachmentDownload.download = sanitizeAttachmentName(metadata.name);
    attachmentPreviewImage.hidden = metadata.kind !== 'image';
    attachmentPreviewImage.alt = `附件預覽：${metadata.name}`;
    attachmentPreviewImage.src = metadata.kind === 'image' ? dialogObjectUrl : '';
    attachmentPreviewNote.textContent = metadata.kind === 'image'
      ? '圖片以本機 Blob URL 預覽，不會執行檔案內容。'
      : '此檔案不在頁面內執行，請下載後使用可信任的應用程式開啟。';
    attachmentDialog.showModal();
  } catch (error) {
    showNotification(error?.message || '附件無法開啟。');
  }
}

attachmentInput.addEventListener('change', () => {
  if (submitting) return;
  const selected = Array.from(attachmentInput.files ?? []);
  if (attachmentDrafts.length + selected.length > MAX_ATTACHMENTS_PER_TASK) {
    showNotification(`每個任務最多 ${MAX_ATTACHMENTS_PER_TASK} 個附件。`);
    attachmentInput.value = '';
    return;
  }
  const accepted = [];
  for (const file of selected) {
    const result = validateAttachment(file);
    if (!result.ok) showNotification(`${file.name || '附件'}：${result.error}`);
    else accepted.push({ file, metadata: result.metadata });
  }
  attachmentDrafts.push(...accepted);
  attachmentInput.value = '';
  renderAttachmentDrafts();
});

attachmentDraftList.addEventListener('click', event => {
  if (submitting) return;
  const button = event.target.closest('.remove-attachment');
  if (!button) return;
  attachmentDrafts.splice(Number(button.dataset.attachmentIndex), 1);
  renderAttachmentDrafts();
});

locationButton.addEventListener('click', () => {
  if (submitting) return;
  if (!navigator.geolocation) {
    showNotification('此瀏覽器不支援定位；請直接輸入地址。');
    return;
  }
  const requestVersion = ++locationRequestVersion;
  locationButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    position => {
      if (requestVersion !== locationRequestVersion) return;
      const { latitude, longitude } = position.coords;
      locationInput.value = `目前位置（${latitude.toFixed(5)}, ${longitude.toFixed(5)}）`;
      locationInput.dataset.latitude = String(latitude);
      locationInput.dataset.longitude = String(longitude);
      locationButton.disabled = false;
      showNotification('已取得目前位置；新增任務前仍可手動修改。');
    },
    () => {
      if (requestVersion !== locationRequestVersion) return;
      locationButton.disabled = false;
      showNotification('定位未完成；請確認權限或直接輸入地址。');
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
});
locationInput.addEventListener('input', () => {
  delete locationInput.dataset.latitude;
  delete locationInput.dataset.longitude;
});

document.querySelector('#save-place').addEventListener('click', () => {
  const name = placeName.value.trim();
  const address = placeAddress.value.trim();
  if (!name || !address) {
    showNotification('請填寫常用地點名稱與地址。');
    return;
  }
  const place = { id: newId(), name, address, lat: null, lng: null };
  if (persistSettings({ ...settings, commonPlaces: [...settings.commonPlaces, place].slice(-20) })) {
    placeName.value = '';
    placeAddress.value = '';
    renderPlaces();
    showNotification(`已儲存常用地點「${name}」。`);
  }
});

commonPlaceList.addEventListener('click', event => {
  const button = event.target.closest('.remove-place');
  if (!button) return;
  const nextPlaces = settings.commonPlaces.filter(place => place.id !== button.dataset.placeId);
  if (persistSettings({ ...settings, commonPlaces: nextPlaces })) {
    renderPlaces();
    showNotification('已移除常用地點。');
  }
});

document.querySelector('#export-backup').addEventListener('click', exportBackup);
cleanupAttachmentsButton.addEventListener('click', cleanupOrphanAttachments);

document.querySelector('#close-attachment').addEventListener('click', () => attachmentDialog.close());
attachmentDialog.addEventListener('close', () => {
  if (dialogObjectUrl) URL.revokeObjectURL(dialogObjectUrl);
  dialogObjectUrl = null;
  attachmentPreviewImage.removeAttribute('src');
  attachmentDownload.removeAttribute('href');
});

input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; updatePreview(); });
input.addEventListener('input', updatePreview);
input.addEventListener('change', updatePreview);
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (listening || readOnly || composing || submitting) return;
  const originalInput = input.value.trim();
  const parsed = parseTaskInput(originalInput);
  if (!parsed.title) {
    input.setCustomValidity('請輸入待辦事項，例如：10分鐘後提醒我喝水');
    input.reportValidity();
    input.focus();
    return;
  }
  const location = getLocationData();
  const reminderAt = taskNoTime.checked ? null : (taskTime.value ? parseDateTimeLocal(taskTime.value) : parsed.reminderAt);
  if (!taskNoTime.checked && taskTime.value && !reminderAt) {
    taskTime.setCustomValidity('請輸入有效日期與時間'); taskTime.reportValidity(); return;
  }
  const repeat = normalizeRepeat(taskRepeat.value);
  if (repeat !== 'none' && !reminderAt) {
    showNotification('重複任務需要提醒時間；請填入時間或改為不重複。'); taskTime.focus(); return;
  }
  const destination = recordingDestination?.id === taskDestination.value ? normalizeDestination(recordingDestination)
    : resolveDestination(taskDestination.value, settings);
  if (!destination) { showNotification('請先選擇這次任務目的地。'); taskDestination.focus(); return; }
  const task = {
    id: newId(), title: parsed.title, originalInput, reminderAt, repeat, destination,
    category: taskCategory.value || 'other', notes: taskNotes.value.trim(),
    completed: false, createdAt: new Date().toISOString(), mode: 'personal', ...location,
    attachments: attachmentDrafts.map(draft => draft.metadata),
  };
  if (repeat !== 'none') task.seriesId = task.id;
  if (repeat === 'monthly' || repeat === 'yearly') task.repeatDay = new Date(reminderAt).getDate();
  if (repeat === 'yearly') task.repeatMonth = new Date(reminderAt).getMonth() + 1;
  // Keep this draft stable while attachment storage yields, and reject double submits.
  // A late geolocation result must not refill the next draft after this one is saved.
  locationRequestVersion += 1;
  locationButton.disabled = false;
  const controls = [input, voiceButton, taskDestination, addButton, locationInput, locationButton,
    attachmentInput, taskCategory, taskNotes, taskTime, taskNoTime, taskRepeat,
    ...attachmentDraftList.querySelectorAll('.remove-attachment'),
    ...document.querySelectorAll('[data-example]')];
  const disabledBeforeSubmit = controls.map(control => control.disabled);
  submitting = true;
  controls.forEach(control => { control.disabled = true; });
  try {
    const storedAttachmentIds = await persistTaskAttachments(task);
    if (storedAttachmentIds === null) return;
    // Attachment storage yields; use the latest task list before appending.
    const latest = loadTasks();
    if (latest.readOnly) {
      tasks = latest.tasks; readOnly = true; loadError = latest.error;
      updateStorageWarning(); renderTasks();
      await deleteAttachments(storedAttachmentIds).catch(() => {});
      showNotification('目前資料無法安全修改，這筆任務尚未新增。'); return;
    }
    if (commit([...latest.tasks, task])) {
      input.value = '';
      locationInput.value = '';
      delete locationInput.dataset.latitude;
      delete locationInput.dataset.longitude;
      clearAttachmentDrafts();
      taskTime.value = ''; taskNoTime.checked = false; taskTime.disabled = false;
      taskCategory.value = 'other'; taskNotes.value = ''; taskRepeat.value = 'none';
      recordingDestination = null; renderDestinations();
      updatePreview();
      revealTask(task);
      input.focus();
      showNotification(`已新增「${task.title}」`);
    } else {
      await deleteAttachments(storedAttachmentIds).catch(() => {});
    }
  } finally {
    submitting = false;
    controls.forEach((control, index) => { control.disabled = disabledBeforeSubmit[index]; });
    taskTime.disabled = taskNoTime.checked;
    taskDestination.disabled = listening;
    updateStorageWarning();
    input.focus();
  }
});

document.querySelectorAll('[data-example]').forEach(button => {
  button.addEventListener('click', () => {
    if (submitting) return;
    input.value = button.dataset.example;
    updatePreview();
    input.focus();
  });
});

$('#task-sections').addEventListener('change', event => {
  if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return;
  const id = event.target.closest('.task-row')?.dataset.id;
  const latest = loadTasks();
  if (readOnly || latest.readOnly) { renderTasks(); showNotification('目前資料無法安全修改。'); return; }
  const task = latest.tasks.find(item => item.id === id);
  if (!task) { tasks = latest.tasks; renderTasks(); return; }
  const completed = event.target.checked;
  const next = completed && !task.completed ? createNextOccurrence(task, { id: newId(), existingTasks: latest.tasks }) : null;
  const nextTasks = latest.tasks.map(item => item.id === id ? { ...item, completed } : item);
  if (next) nextTasks.push(next);
  if (commit(nextTasks)) {
    const hasChild = latest.tasks.some(item => item.repeatParentId === task.id);
    showNotification(next ? `已完成，下一筆安排於 ${formatTime(next.reminderAt)}`
      : completed && task.repeat !== 'none' ? hasChild ? '已標記完成；既有下一筆保持原安排。' : '已標記完成，未建立下一筆；請確認重複任務時間。'
      : completed ? '已標記完成，做得好。' : hasChild ? '已移回未完成；既有下一筆仍保留。' : '已移回未完成任務。');
  } else renderTasks();
});

$('#task-sections').addEventListener('click', event => {
  const google = event.target.closest('.google-button');
  if (google) {
    event.preventDefault();
    const task = tasks.find(item => item.id === google.closest('.task-row')?.dataset.id);
    if (!task || normalizeDestination(task.destination)?.provider !== 'google') return;
    $('#calendar-confirm-destination').textContent = `任務「${task.title}」的目的地：${destinationLabel(task.destination)}`;
    $('#calendar-confirm-link').href = createGoogleCalendarUrl(task);
    $('#calendar-confirmation').showModal(); return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.closest('.task-row')?.dataset.id;
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  if (button.classList.contains('edit-button')) {
    openTaskEditor(task);
  } else if (button.classList.contains('delete-button')) {
    const latest = loadTasks();
    if (latest.readOnly || readOnly) { showNotification('目前資料無法安全修改。'); return; }
    const currentTask = latest.tasks.find(item => item.id === id);
    if (!currentTask) { tasks = latest.tasks; renderTasks(); return; }
    if (commit(latest.tasks.filter(item => item.id !== id))) {
      deletedTask = currentTask;
      scheduleDeletedTaskAttachmentCleanup(currentTask);
      showNotification(`已刪除「${currentTask.title}」`, true);
    }
  } else if (button.classList.contains('attachment-button')) {
    openAttachment(task, button.dataset.attachmentId);
  } else if (button.classList.contains('apple-button')) {
    if (!task.destination || task.destination.provider === 'local') { showNotification('請先編輯這筆任務，選擇行事曆目的地。'); return; }
    try { downloadICS(task, { alarmMinutes: settings.calendarAlarmMinutes }); showNotification('已產生行事曆檔案，請確認目的地、重複規則與提醒設定後匯入。'); }
    catch { showNotification('行事曆檔案產生失敗，請確認提醒時間。'); }
  }
});
$('#calendar-confirm-cancel').addEventListener('click', () => $('#calendar-confirmation').close());
$('#calendar-confirm-link').addEventListener('click', () => $('#calendar-confirmation').close());

undoButton.addEventListener('click', () => {
  if (!deletedTask) return;
  const latest = loadTasks();
  if (latest.readOnly || readOnly) { showNotification('目前資料無法安全修改。'); return; }
  if (latest.tasks.some(task => task.id === deletedTask.id)) { showNotification('任務已存在。'); return; }
  if (commit([...latest.tasks, deletedTask])) {
    clearTimeout(deletedAttachmentCleanupTimers.get(deletedTask.id));
    deletedAttachmentCleanupTimers.delete(deletedTask.id);
    deletedTask = null;
    showNotification('已復原刪除的任務。');
  }
});

setupSpeechInput({
  input, voiceButton, voiceLabel, speechStatus, isReadOnly: () => readOnly || submitting,
  onListening: active => {
    if (active && !listening) {
      recordingDestination = resolveDestination(taskDestination.value, settings)
        || resolveDestination(settings.preferredDestinationId, settings) || resolveDestination('local', settings);
      renderDestinationSelector(taskDestination, recordingDestination);
    }
    listening = active;
    addButton.disabled = readOnly || active || submitting;
    taskDestination.disabled = active || submitting;
    updateDestinationHint();
  },
});
window.addEventListener('storage', event => {
  if (event.key === SETTINGS_KEY || event.key === null) {
    const loadedSettings = loadSettings();
    settings = loadedSettings.settings; settingsError = loadedSettings.error;
    destinationNotice = loadedSettings.destinationWarning || '';
    renderDestinations(); renderPlaces(); renderReminderControls(); updateStorageWarning();
  }
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  const loaded = loadTasks();
  tasks = loaded.tasks;
  loadError = loaded.error;
  readOnly = loaded.readOnly;
  deletedTask = null;
  undoButton.hidden = true;
  updateStorageWarning();
  renderTasks();
});
function refreshTime() { checkReminders(); renderTasks(); updatePreview(); renderReminderControls(); }
setInterval(checkReminders, 5000);
setInterval(() => { if (!document.hidden && !composing) refreshTime(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTime(); });
window.addEventListener('focus', refreshTime);
updateStorageWarning();
renderDestinations();
setupTheme({ button: $('#theme-toggle'), onError: message => showNotification(message) });
renderReminderControls();
renderPlaces();
renderTasks();
