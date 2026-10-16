const ERROR_MESSAGES = {
  'not-allowed': '無法使用麥克風，請檢查瀏覽器權限；也可改用鍵盤麥克風或打字。',
  'service-not-allowed': '目前環境無法使用語音服務，請改用鍵盤麥克風或打字。',
  'no-speech': '沒有聽到聲音，請再試一次，或直接打字。',
  'audio-capture': '找不到可用的麥克風，請確認裝置設定。',
  network: '語音辨識服務無法連線，請檢查網路或改用打字。',
  aborted: '已結束語音輸入。',
};

const MAX_RECORDING_MS = 120_000;
const SETTLE_MS = 2000;

/** Bind one voice button. Recognition starts only after a user clicks it. */
export function setupSpeechInput({
  input, voiceButton, voiceLabel, speechStatus,
  onListening = () => {}, isReadOnly = () => false, windowObject = globalThis.window,
  continuous = false, onProgress = () => {}, documentObject = windowObject?.document,
}) {
  const Recognition = windowObject?.SpeechRecognition || windowObject?.webkitSpeechRecognition;
  let state = 'idle';
  let session = null;
  let applyingTranscript = false;
  let destroyed = false;
  const setTimer = windowObject?.setTimeout?.bind(windowObject) || globalThis.setTimeout;
  const clearTimer = windowObject?.clearTimeout?.bind(windowObject) || globalThis.clearTimeout;
  const clock = () => windowObject?.performance?.now?.() ?? Date.now();

  function updateListening(active) {
    voiceButton.setAttribute('aria-pressed', String(active));
    voiceLabel.textContent = state === 'starting' ? '開啟中，點擊取消'
      : state === 'stopping' ? '結束中...'
        : active ? '聆聽中...' : '語音輸入';
    onListening(active);
  }

  function current(record) {
    return !destroyed && session === record && !record.ended;
  }

  function reportProgress(record) {
    if (record.startedAt !== null && !record.clockStopped) {
      record.elapsedSeconds = Math.min(MAX_RECORDING_MS / 1000, Math.floor(Math.max(0, clock() - record.startedAt) / 1000));
    }
    onProgress(record.elapsedSeconds, MAX_RECORDING_MS / 1000);
  }

  function stopClock(record) {
    reportProgress(record);
    record.clockStopped = true;
    clearTimer(record.durationTimer);
    clearTimer(record.progressTimer);
  }

  function tick(record) {
    if (!current(record) || state !== 'listening') return;
    reportProgress(record);
    if (record.elapsedSeconds >= MAX_RECORDING_MS / 1000) { stopSession(record, true); return; }
    record.progressTimer = setTimer(() => tick(record), 1000);
  }

  function finish(record, { abort = false, message } = {}) {
    if (record && !current(record)) return;
    // Invalidate first: abort() can synchronously deliver error/end callbacks.
    if (record) {
      stopClock(record);
      record.ended = true;
      clearTimer(record.timer);
    }
    session = null;
    state = 'idle';
    if (abort && record) {
      try { record.recognition.abort?.(); } catch { /* Already stopped or unavailable. */ }
    }
    updateListening(false);
    if (message !== undefined) speechStatus.textContent = message;
  }

  function armRecovery(record, milliseconds, message) {
    clearTimer(record.timer);
    record.timer = setTimer(() => {
      if (current(record)) finish(record, { abort: true, message: message ?? completedMessage(record) });
    }, milliseconds);
  }

  function completedMessage(record) {
    const message = record.finalTranscript ? '辨識完成，請確認任務與時間後新增。'
      : '尚未辨識到文字，請再試一次或改用打字。';
    return record.limitReached ? `已達 120 秒錄音上限。${message}` : message;
  }

  function stopSession(record, limitReached = false) {
    if (!current(record) || state !== 'listening') return;
    state = 'stopping';
    record.limitReached = limitReached;
    if (limitReached) { record.elapsedSeconds = 120; record.clockStopped = true; }
    stopClock(record);
    updateListening(true);
    speechStatus.textContent = limitReached ? '已達 120 秒，正在取得最後辨識結果…' : '正在結束聆聽，請稍候…';
    // Keep the wait bounded even if final results continue arriving after stop().
    armRecovery(record, SETTLE_MS);
    try { record.recognition.stop(); }
    catch {
      finish(record, { abort: true, message: '無法結束語音輸入，已重設；可再次點語音輸入。' });
    }
  }

  function reset(message = '已重設語音，可以再錄下一筆。') {
    finish(session, { abort: true, message });
    onProgress(0, MAX_RECORDING_MS / 1000);
  }

  function pageHide() {
    if (session) reset('已停止語音。返回頁面後可重新開始。');
  }

  function pageShow() {
    if (session || state !== 'idle') reset('已恢復語音按鈕，請重新開始。');
    else updateListening(false);
  }

  function visibilityChange() {
    // Home-screen apps can enter the background without firing pagehide.
    if (documentObject?.visibilityState === 'hidden' && session) {
      reset('已停止背景錄音；回到畫面後可再次點語音輸入。');
    }
  }

  updateListening(false);
  onProgress(0, MAX_RECORDING_MS / 1000);
  if (!Recognition) {
    voiceButton.disabled = true;
    speechStatus.textContent = '此瀏覽器不支援語音輸入，請改用打字';
    return { supported: false, get state() { return state; }, reset() {}, destroy() {} };
  }
  if (windowObject?.isSecureContext === false) {
    voiceButton.disabled = true;
    speechStatus.textContent = '語音輸入需要安全連線，請使用 HTTPS 網址；也可改用手機鍵盤麥克風或打字。';
    return { supported: false, get state() { return state; }, reset() {}, destroy() {} };
  }

  function markManualCorrection() {
    if (!applyingTranscript && session) session.manualCorrection = true;
  }
  input.addEventListener('input', markManualCorrection);

  function startSession() {
    let record = null;
    try {
      // Reusing an ended recognizer lets delayed events contaminate the next task.
      const recognition = new Recognition();
      recognition.lang = 'zh-TW';
      recognition.continuous = continuous;
      recognition.interimResults = true;
      record = {
        recognition, ended: false, finalTranscript: '',
        manualCorrection: false, lastAppliedValue: input.value,
        timer: null, durationTimer: null, progressTimer: null,
        startedAt: null, elapsedSeconds: 0, clockStopped: false, limitReached: false,
      };
      session = record;

      recognition.onstart = () => {
        if (!current(record) || state !== 'starting') return;
        state = 'listening';
        clearTimer(record.timer);
        record.startedAt = clock();
        updateListening(true);
        speechStatus.textContent = '請說出你的待辦事項，最多 120 秒；再點一次可提前停止。';
        record.durationTimer = setTimer(() => stopSession(record, true), MAX_RECORDING_MS);
        tick(record);
      };
      recognition.onresult = event => {
        if (!current(record) || !event.results) return;
        let finalTranscript = '';
        let interim = '';
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = result?.[0]?.transcript || '';
          if (result?.isFinal) finalTranscript += text;
          else interim += text;
        }
        if (finalTranscript) record.finalTranscript = finalTranscript;
        // Preserve edits made after recording started, even before the first
        // final result (including autofill that did not dispatch an input event).
        if (input.value !== record.lastAppliedValue) record.manualCorrection = true;
        if (finalTranscript && !record.manualCorrection) {
          input.value = finalTranscript;
          record.lastAppliedValue = finalTranscript;
          const InputEvent = windowObject?.Event || globalThis.Event;
          applyingTranscript = true;
          try { input.dispatchEvent(new InputEvent('input', { bubbles: true })); }
          finally { applyingTranscript = false; }
        }
        // A preserved manual edit must not prevent single-utterance recovery.
        // Continuous recording keeps its independent duration limit.
        if (finalTranscript && !continuous && state === 'listening') armRecovery(record, SETTLE_MS);
        if (interim) speechStatus.textContent = `辨識中：${interim}`;
        else if (finalTranscript && state === 'listening') speechStatus.textContent = '已辨識文字；可以繼續說，或再點語音按鈕停止。';
      };
      recognition.onerror = event => {
        if (!current(record)) return;
        // Invalidate immediately: a button labeled "語音輸入" must accept retry,
        // even when this recognizer never delivers its matching end callback.
        finish(record, { abort: true, message: ERROR_MESSAGES[event.error] || '語音輸入暫時無法使用，請改用打字。' });
      };
      recognition.onaudioend = () => {
        if (!current(record) || state !== 'listening') return;
        state = 'stopping';
        stopClock(record);
        updateListening(true);
        speechStatus.textContent = '錄音已停止，正在取得最後辨識結果…';
        armRecovery(record, SETTLE_MS);
      };
      recognition.onend = () => {
        if (!current(record)) return;
        finish(record, { message: completedMessage(record) });
      };

      state = 'starting';
      onProgress(0, MAX_RECORDING_MS / 1000);
      updateListening(true);
      speechStatus.textContent = '正在開啟麥克風…';
      armRecovery(record, 10_000, '麥克風啟動逾時，請重新開始或改用打字。');
      recognition.start();
    } catch {
      if (record && !current(record)) return;
      finish(record, { abort: true, message: '無法啟動語音輸入，請稍後再試或改用打字。' });
    }
  }

  function clickVoice() {
    if (destroyed) return;
    if (state === 'starting') {
      reset('已取消開啟麥克風，可再次點語音輸入。');
      return;
    }
    if (state === 'listening' && session) {
      stopSession(session);
      return;
    }
    if (state !== 'idle' || isReadOnly()) return;
    startSession();
  }
  voiceButton.addEventListener('click', clickVoice);
  windowObject?.addEventListener?.('pagehide', pageHide);
  windowObject?.addEventListener?.('pageshow', pageShow);
  documentObject?.addEventListener?.('visibilitychange', visibilityChange);

  return {
    supported: true, get state() { return state; }, reset,
    destroy() {
      reset('');
      destroyed = true;
      input.removeEventListener?.('input', markManualCorrection);
      voiceButton.removeEventListener?.('click', clickVoice);
      windowObject?.removeEventListener?.('pagehide', pageHide);
      windowObject?.removeEventListener?.('pageshow', pageShow);
      documentObject?.removeEventListener?.('visibilitychange', visibilityChange);
    },
  };
}
