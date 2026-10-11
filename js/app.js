import { parseTaskInput } from './time-parser.js';
import { createGoogleCalendarUrl, downloadICS } from './calendar.js';
import { STORAGE_KEY, loadTasks, saveTasks, classifyTasks } from './task-store.js';

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
const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
let { tasks, error: loadError, readOnly } = loadTasks();
let listening = false;
let composing = false;
let deletedTask = null;
let notificationTimer;

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

function updateStorageWarning(message = loadError) {
  warning.hidden = !message;
  warning.textContent = message ? `${message}${readOnly ? ' 已停用資料修改，原始儲存內容仍保留。' : ''}` : '';
  addButton.disabled = readOnly || listening;
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
  const time = row.querySelector('time');
  time.textContent = formatTime(task.reminderAt);
  if (task.reminderAt) time.dateTime = task.reminderAt;
  else row.querySelector('.task-time').classList.add('no-time');
  const deleteButton = row.querySelector('.delete-button');
  deleteButton.setAttribute('aria-label', `刪除任務：${task.title}`);
  deleteButton.disabled = readOnly;
  if (task.reminderAt) {
    row.querySelector('.google-button').href = createGoogleCalendarUrl(task);
    row.querySelector('.apple-button').setAttribute('aria-label', `加入 Apple 行事曆：${task.title}`);
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

input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; updatePreview(); });
input.addEventListener('input', updatePreview);
input.addEventListener('change', updatePreview);
form.addEventListener('submit', event => {
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
  const task = {
    id: newId(), title: parsed.title, originalInput, reminderAt: parsed.reminderAt,
    completed: false, createdAt: new Date().toISOString(),
  };
  if (commit([...tasks, task])) {
    input.value = '';
    updatePreview();
    input.focus();
    showNotification(`已新增「${task.title}」`);
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
      showNotification(`已刪除「${task.title}」`, true);
    }
  } else if (button.classList.contains('apple-button')) {
    try { downloadICS(task); showNotification('已產生行事曆檔案，請開啟並確認加入。'); }
    catch { showNotification('行事曆檔案產生失敗，請確認提醒時間。'); }
  }
});

undoButton.addEventListener('click', () => {
  if (!deletedTask) return;
  if (tasks.some(task => task.id === deletedTask.id)) { showNotification('任務已存在。'); return; }
  if (commit([...tasks, deletedTask])) {
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
renderTasks();
