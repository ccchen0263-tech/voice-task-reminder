import { parseTaskInput } from './time-parser.js';
import { createGoogleCalendarUrl, createMapUrl, downloadICS } from './calendar.js';
import { STORAGE_KEY, loadTasks, saveTasks, classifyTasks } from './task-store.js';
import { loadSettings, saveSettings } from './settings-store.js';
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
const calendarTarget = $('#calendar-target');
const calendarTargetNote = $('#calendar-target-note');
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
const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
let { tasks, error: loadError, readOnly } = loadTasks();
let { settings, error: settingsError } = loadSettings();
let attachmentDrafts = [];
let attachmentObjectUrls = [];
let dialogObjectUrl = null;
let listening = false;
let composing = false;
let deletedTask = null;
let notificationTimer;
const deletedAttachmentCleanupTimers = new Map();

function formatTime(iso) {
  return iso ? dateFormatter.format(new Date(iso)).replace(/24:/, '00:') : '未設定';
}

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
  addButton.disabled = readOnly || listening;
}

function setCalendarTargetNote() {
  const notes = {
    google: '只會建立可編輯的 TEMPLATE 草稿；未連線或儲存 Google calendarId，也不會自動建立事件。',
    apple: '只會下載 .ics 草稿檔；請在 Apple 行事曆介面自行確認匯入。',
    local: '只保留在本機任務清單；不會匯出到外部行事曆。',
  };
  calendarTargetNote.textContent = notes[settings.calendarTarget] || notes.google;
}

function persistSettings(nextSettings) {
  const result = saveSettings(nextSettings);
  if (!result.ok) {
    settingsError = result.error;
    updateStorageWarning();
    return false;
  }
  settings = nextSettings;
  settingsError = null;
  updateStorageWarning();
  setCalendarTargetNote();
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
    updateStorageWarning(result.error || '儲存失敗，請確認瀏覽器允許本機儲存。');
    showNotification('儲存失敗，這次變更尚未套用。');
    return false;
  }
  tasks = nextTasks;
  loadError = null;
  updateStorageWarning(null);
  renderTasks();
  return true;
}

function updatePreview() {
  const raw = input.value.trim();
  $('#parse-preview').hidden = !raw;
  input.setCustomValidity('');
  if (!raw || composing) return;
  const parsed = parseTaskInput(raw);
  $('#preview-title').textContent = parsed.title || '請補上待辦事項';
  $('#preview-time').textContent = formatTime(parsed.reminderAt);
  $('#preview-note').textContent = parsed.reminderAt
    ? `${new Date(parsed.reminderAt).getTime() <= Date.now() ? '這個時間已到期。' : ''}${parsed.explanation || '新增時會依當下時間計算。'}`
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
    googleButton.hidden = settings.calendarTarget !== 'google';
    appleButton.hidden = settings.calendarTarget !== 'apple';
    row.querySelector('.calendar-actions').hidden = settings.calendarTarget === 'local';
  } else row.querySelector('.calendar-actions').hidden = true;
  return fragment;
}

function renderTasks() {
  const groups = classifyTasks(tasks);
  for (const [group, groupTasks] of Object.entries(groups)) {
    const section = $(`[data-group="${group}"]`);
    section.querySelector('.section-count').textContent = groupTasks.length;
    section.querySelector('.empty-state').hidden = groupTasks.length > 0;
    section.querySelector('.task-list').replaceChildren(...groupTasks.map(createTaskElement));
  }
  $('#task-summary').textContent = `${tasks.filter(task => !task.completed).length} 件待完成`;
  $('#today-label').textContent = new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());
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
    return await saveAttachmentBatch(task.id, attachmentDrafts);
  } catch (error) {
    showNotification(error?.message || '附件只可儲存在此裝置，這次任務尚未新增。');
    return null;
  }
}

function scheduleDeletedTaskAttachmentCleanup(task) {
  if (!task.attachments?.length) return;
  const timer = setTimeout(async () => {
    await deleteAttachments(task.attachments.map(attachment => attachment.id)).catch(() => {});
    deletedAttachmentCleanupTimers.delete(task.id);
    if (deletedTask?.id === task.id) deletedTask = null;
  }, 15000);
  deletedAttachmentCleanupTimers.set(task.id, timer);
}

async function cleanupOrphanAttachments() {
  try {
    const records = await listAttachments();
    const referenced = new Set(tasks.flatMap(task => (task.attachments || []).map(attachment => attachment.id)));
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
  const button = event.target.closest('.remove-attachment');
  if (!button) return;
  attachmentDrafts.splice(Number(button.dataset.attachmentIndex), 1);
  renderAttachmentDrafts();
});

locationButton.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showNotification('此瀏覽器不支援定位；請直接輸入地址。');
    return;
  }
  locationButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;
      locationInput.value = `目前位置（${latitude.toFixed(5)}, ${longitude.toFixed(5)}）`;
      locationInput.dataset.latitude = String(latitude);
      locationInput.dataset.longitude = String(longitude);
      locationButton.disabled = false;
      showNotification('已取得目前位置；新增任務前仍可手動修改。');
    },
    () => {
      locationButton.disabled = false;
      showNotification('定位未完成；請確認權限或直接輸入地址。');
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
});

calendarTarget.addEventListener('change', () => {
  if (persistSettings({ ...settings, calendarTarget: calendarTarget.value })) renderTasks();
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
  if (listening || readOnly || composing) return;
  const originalInput = input.value.trim();
  const parsed = parseTaskInput(originalInput);
  if (!parsed.title) {
    input.setCustomValidity('請輸入待辦事項，例如：10分鐘後提醒我喝水');
    input.reportValidity();
    input.focus();
    return;
  }
  const location = getLocationData();
  const task = {
    id: newId(), title: parsed.title, originalInput, reminderAt: parsed.reminderAt,
    completed: false, createdAt: new Date().toISOString(), mode: 'personal', ...location,
    attachments: attachmentDrafts.map(draft => draft.metadata),
  };
  const storedAttachmentIds = await persistTaskAttachments(task);
  if (storedAttachmentIds === null) return;
  if (commit([...tasks, task])) {
    input.value = '';
    locationInput.value = '';
    delete locationInput.dataset.latitude;
    delete locationInput.dataset.longitude;
    clearAttachmentDrafts();
    updatePreview();
    input.focus();
    showNotification(`已新增「${task.title}」`);
  } else {
    await deleteAttachments(storedAttachmentIds).catch(() => {});
  }
});

document.querySelectorAll('[data-example]').forEach(button => {
  button.addEventListener('click', () => {
    input.value = button.dataset.example;
    updatePreview();
    input.focus();
  });
});

$('#task-sections').addEventListener('change', event => {
  if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return;
  const id = event.target.closest('.task-row').dataset.id;
  const completed = event.target.checked;
  if (commit(tasks.map(task => task.id === id ? { ...task, completed } : task))) {
    showNotification(completed ? '已標記完成，做得好。' : '已移回未完成任務。');
  } else renderTasks();
});

$('#task-sections').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.closest('.task-row')?.dataset.id;
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  if (button.classList.contains('delete-button')) {
    if (commit(tasks.filter(item => item.id !== id))) {
      deletedTask = task;
      scheduleDeletedTaskAttachmentCleanup(task);
      showNotification(`已刪除「${task.title}」`, true);
    }
  } else if (button.classList.contains('attachment-button')) {
    openAttachment(task, button.dataset.attachmentId);
  } else if (button.classList.contains('apple-button')) {
    try { downloadICS(task); showNotification('已產生行事曆檔案，請開啟並確認加入。'); }
    catch { showNotification('行事曆檔案產生失敗，請確認提醒時間。'); }
  }
});

undoButton.addEventListener('click', () => {
  if (!deletedTask) return;
  if (tasks.some(task => task.id === deletedTask.id)) { showNotification('任務已存在。'); return; }
  if (commit([...tasks, deletedTask])) {
    clearTimeout(deletedAttachmentCleanupTimers.get(deletedTask.id));
    deletedAttachmentCleanupTimers.delete(deletedTask.id);
    deletedTask = null;
    showNotification('已復原刪除的任務。');
  }
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) {
  voiceButton.disabled = true;
  speechStatus.textContent = '此瀏覽器不支援語音輸入，請改用打字';
} else {
  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-TW';
  recognition.continuous = false;
  recognition.interimResults = true;
  let finalTranscript = '';
  let hadError = false;
  const setListening = active => {
    listening = active;
    voiceButton.setAttribute('aria-pressed', String(active));
    voiceLabel.textContent = active ? '聆聽中...' : '語音輸入';
    addButton.disabled = readOnly || active;
  };
  recognition.onstart = () => {
    setListening(true);
    speechStatus.textContent = '請說出你的待辦事項，再點一次可結束聆聽。';
  };
  recognition.onresult = event => {
    let interim = '';
    finalTranscript = '';
    for (let i = 0; i < event.results.length; i++) {
      if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
      else interim += event.results[i][0].transcript;
    }
    if (finalTranscript) {
      input.value = finalTranscript;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (interim) speechStatus.textContent = `辨識中：${interim}`;
  };
  recognition.onerror = event => {
    hadError = true;
    const messages = {
      'not-allowed': '無法使用麥克風，請檢查瀏覽器權限；也可改用鍵盤麥克風或打字。',
      'service-not-allowed': '目前環境無法使用語音服務，請改用鍵盤麥克風或打字。',
      'no-speech': '沒有聽到聲音，請再試一次，或直接打字。',
      'audio-capture': '找不到可用的麥克風，請確認裝置設定。',
      network: '語音辨識服務無法連線，請檢查網路或改用打字。',
      aborted: '已結束語音輸入。',
    };
    speechStatus.textContent = messages[event.error] || '語音輸入暫時無法使用，請改用打字。';
    setListening(false);
  };
  recognition.onend = () => {
    setListening(false);
    if (finalTranscript) {
      // onresult already applied the transcript; preserve any manual correction.
      if (!hadError) speechStatus.textContent = '辨識完成，請確認任務與時間後新增。';
    } else if (!hadError) speechStatus.textContent = '尚未辨識到文字，請再試一次或改用打字。';
  };
  voiceButton.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    finalTranscript = '';
    hadError = false;
    try { recognition.start(); setListening(true); speechStatus.textContent = '正在開啟麥克風…'; }
    catch { setListening(false); speechStatus.textContent = '無法啟動語音輸入，請稍後再試或改用打字。'; }
  });
}

window.addEventListener('storage', event => {
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
function refreshTime() { renderTasks(); updatePreview(); }
setInterval(() => { if (!document.hidden && !composing) refreshTime(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTime(); });
window.addEventListener('focus', refreshTime);
updateStorageWarning();
calendarTarget.value = settings.calendarTarget;
setCalendarTargetNote();
renderPlaces();
renderTasks();
