import { parseTaskInput } from './time-parser.js';
import { toDateTimeLocal, parseDateTimeLocal } from './planner.js';
import { createGoogleCalendarDraftURL } from './google-calendar.js';
import { setupSpeechInput } from './speech-input.js';

/** Google-only entry. Deliberately never opens the legacy storage modules. */
export function setupGoogleApp({ documentObject = globalThis.document, windowObject = globalThis.window, now = () => new Date() } = {}) {
  const $ = selector => documentObject.querySelector(selector);
  const form = $('#task-form');
  const input = $('#task-input');
  const time = $('#task-time');
  const notes = $('#task-notes');
  const location = $('#task-location');
  const repeat = $('#task-repeat');
  const add = $('#add-button');
  const voice = $('#voice-button');
  const status = $('#app-status');
  const retry = $('#google-retry');
  const resetVoice = $('#reset-voice');
  const root = documentObject.documentElement;
  const formatter = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  let speech = null;
  let listening = false;
  let composing = false;
  let manualTime = false;
  let navigating = false;
  let handedOff = false;
  let navigationTimer = null;
  let lastURL = '';
  let draftRevision = 0;
  let preparedRevision = null;
  let preparedSnapshot = '';
  let handoffRevision = null;
  let handoffSnapshot = '';

  function draftSnapshot() { return JSON.stringify([input.value, time.value, notes.value, location.value, repeat.value, manualTime]); }
  function draftChanged() { draftRevision += 1; releaseNavigation(); }

  function renderControls() {
    add.disabled = listening || navigating;
    voice.disabled = !speech?.supported || navigating;
    resetVoice.disabled = !speech?.supported || navigating;
  }

  function releaseNavigation() {
    windowObject.clearTimeout(navigationTimer);
    navigationTimer = null;
    navigating = false;
    renderControls();
  }

  function parsedDraft() {
    const parsed = parseTaskInput(input.value.trim(), now());
    return { ...parsed, reminderAt: manualTime ? parseDateTimeLocal(time.value) : parsed.reminderAt };
  }

  function updatePreview() {
    input.setCustomValidity(''); time.setCustomValidity('');
    if (composing) return;
    const raw = input.value.trim();
    $('#parse-preview').hidden = !raw;
    const parsed = parsedDraft();
    if (!manualTime) time.value = toDateTimeLocal(parsed.reminderAt);
    $('#preview-title').textContent = parsed.title || '請補上待辦事項';
    $('#preview-time').textContent = parsed.reminderAt ? formatter.format(new Date(parsed.reminderAt)).replace(/24:/, '00:') : '請補上開始時間';
    $('#preview-note').textContent = !parsed.reminderAt ? '沒有明確時間，請在下方指定開始時間後再開啟 Google Calendar。'
      : manualTime ? '使用你指定的時間；結束時間為 30 分鐘後。' : `${parsed.explanation || ''}相對時間會在確認時重新計算。`;
  }

  function clearDraft() {
    draftRevision += 1;
    releaseNavigation();
    handedOff = false;
    speech.reset('可以開始下一筆語音輸入。');
    input.value = ''; time.value = ''; notes.value = ''; location.value = ''; repeat.value = 'none';
    manualTime = false; composing = false;
    updatePreview();
    input.focus();
  }

  speech = setupSpeechInput({
    input, voiceButton: voice, voiceLabel: $('#voice-label'), speechStatus: $('#speech-status'), windowObject, documentObject,
    continuous: true,
    onProgress(seconds, limit) {
      const format = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
      $('#speech-timer').textContent = `${format(seconds)} / ${format(limit)}`;
    },
    isReadOnly: () => navigating,
    onListening(active) { if (active && !listening) draftRevision += 1; listening = active; renderControls(); },
  });

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; draftChanged(); updatePreview(); });
  input.addEventListener('input', () => { draftChanged(); updatePreview(); });
  time.addEventListener('input', () => { manualTime = true; draftChanged(); updatePreview(); });
  time.addEventListener('change', () => { manualTime = true; draftChanged(); updatePreview(); });
  for (const field of [notes, location, repeat]) {
    field.addEventListener('input', draftChanged); field.addEventListener('change', draftChanged);
  }
  $('#use-parsed-time').addEventListener('click', () => { manualTime = false; draftChanged(); updatePreview(); });
  resetVoice.addEventListener('click', () => { speech.reset(); releaseNavigation(); });
  $('#clear-draft').addEventListener('click', () => { clearDraft(); status.textContent = '已清空本分頁草稿，可以輸入下一筆。'; });
  documentObject.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
    speech.reset('請確認內容後開啟 Google Calendar。');
    draftChanged(); manualTime = false;
    input.value = button.dataset.example; updatePreview(); input.focus();
  }));

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (navigating || listening || composing) return;
    const parsed = parsedDraft();
    if (!input.value.trim() || !parsed.title) {
      input.setCustomValidity('請輸入待辦事項。'); input.reportValidity(); input.focus(); return;
    }
    if (!parsed.reminderAt) {
      time.setCustomValidity('請先指定有效的開始時間。'); time.reportValidity(); time.focus();
      status.textContent = '尚未開啟 Google Calendar：請補上開始時間。'; return;
    }
    let url;
    try {
      url = createGoogleCalendarDraftURL({ title: parsed.title, reminderAt: parsed.reminderAt,
        originalInput: input.value.trim(), notes: notes.value, location: location.value, repeat: repeat.value });
    } catch (error) { status.textContent = error.message; return; }
    speech.reset('語音已結束，返回後可以開始下一筆。');
    lastURL = url;
    preparedRevision = draftRevision; preparedSnapshot = draftSnapshot();
    handoffRevision = preparedRevision; handoffSnapshot = preparedSnapshot;
    retry.href = url;
    $('#google-handoff').hidden = false;
    $('#handoff-title').textContent = parsed.title;
    status.textContent = 'Google 草稿已準備，尚待你在 Google Calendar 按下儲存。';
    navigating = true; handedOff = true; renderControls();
    // No await, local task write or attachment storage before navigation.
    // If navigation is silently blocked, controls recover and the native link remains.
    navigationTimer = windowObject.setTimeout(releaseNavigation, 2500);
    try { windowObject.location.assign(url); }
    catch {
      handedOff = false; releaseNavigation();
      status.textContent = '無法前往 Google Calendar；草稿仍在本頁，可用下方連結重試。尚未儲存事件。';
    }
  });

  retry.addEventListener('click', () => {
    if (!lastURL) return;
    speech.reset('語音已結束，返回後可以開始下一筆。');
    handedOff = true;
    handoffRevision = preparedRevision; handoffSnapshot = preparedSnapshot;
  });
  windowObject.addEventListener('pagehide', releaseNavigation);
  windowObject.addEventListener('pageshow', () => {
    releaseNavigation();
    if (handedOff) {
      handedOff = false;
      if (draftRevision === handoffRevision && draftSnapshot() === handoffSnapshot) {
        clearDraft();
        status.textContent = '可以開始下一筆；上一筆是否已儲存，請以 Google Calendar 為準。';
      } else {
        updatePreview();
        status.textContent = '已返回；你正在修改的內容仍保留。上一筆是否儲存請以 Google Calendar 為準。';
      }
    } else updatePreview();
  });

  const dark = windowObject.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
  root.dataset.theme = dark ? 'dark' : 'light';
  function renderThemeButton() { $('#theme-toggle').textContent = root.dataset.theme === 'dark' ? '切換淺色' : '切換深色'; }
  $('#theme-toggle').addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; renderThemeButton();
  });
  renderThemeButton(); renderControls(); updatePreview();
  return { speech, get pendingNavigation() { return navigating; } };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') setupGoogleApp();
