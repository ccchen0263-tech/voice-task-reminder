const ERROR_MESSAGES = {
  'not-allowed': '無法使用麥克風，請檢查瀏覽器權限；也可改用鍵盤麥克風或打字。',
  'service-not-allowed': '目前環境無法使用語音服務，請改用鍵盤麥克風或打字。',
  'no-speech': '沒有聽到聲音，請再試一次，或直接打字。',
  'audio-capture': '找不到可用的麥克風，請確認裝置設定。',
  network: '語音辨識服務無法連線，請檢查網路或改用打字。',
  aborted: '已結束語音輸入。',
};

/** Bind one voice button. Recognition starts only after a user clicks it. */
export function setupSpeechInput({
  input, voiceButton, voiceLabel, speechStatus,
  onListening = () => {}, isReadOnly = () => false, windowObject = globalThis.window,
}) {
  const Recognition = windowObject?.SpeechRecognition || windowObject?.webkitSpeechRecognition;
  let state = 'idle';
  let session = null;
  let applyingTranscript = false;
  let destroyed = false;
  const setTimer = windowObject?.setTimeout?.bind(windowObject) || globalThis.setTimeout;
  const clearTimer = windowObject?.clearTimeout?.bind(windowObject) || globalThis.clearTimeout;

  function updateListening(active) {
    voiceButton.setAttribute('aria-pressed', String(active));
    voiceLabel.textContent = active ? '聆聽中...' : '語音輸入';
    onListening(active);
  }

  function current(record) {
    return !destroyed && session === record && !record.ended;
  }

  function finish(record, { abort = false, message } = {}) {
    if (record && !current(record)) return;
    // Invalidate first: abort() can synchronously deliver error/end callbacks.
    if (record) {
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
      if (current(record)) finish(record, { abort: true, message });
    }, milliseconds);
  }

  function completedMessage(record) {
    return record.finalTranscript ? '辨識完成，請確認任務與時間後新增。'
      : '尚未辨識到文字，請再試一次或改用打字。';
  }

  function reset(message = '已重設語音，可以再錄下一筆。') {
    finish(session, { abort: true, message });
  }

  function pageHide() {
    if (session) reset('已停止語音。返回頁面後可重新開始。');
  }

  function pageShow() {
    if (session || state !== 'idle') reset('已恢復語音按鈕，請重新開始。');
    else updateListening(false);
  }

  updateListening(false);
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
    if (!applyingTranscript && session?.hasAppliedFinal) session.manualCorrection = true;
  }
  input.addEventListener('input', markManualCorrection);

  function startSession() {
    let record = null;
    try {
      // Reusing an ended recognizer lets delayed events contaminate the next task.
      const recognition = new Recognition();
      recognition.lang = 'zh-TW';
      recognition.continuous = false;
      recognition.interimResults = true;
      record = {
        recognition, ended: false, hadError: false, finalTranscript: '',
        hasAppliedFinal: false, manualCorrection: false, lastAppliedValue: '',
        timer: null,
      };
      session = record;

      recognition.onstart = () => {
        if (!current(record) || state !== 'starting') return;
        state = 'listening';
        updateListening(true);
        speechStatus.textContent = '請說出你的待辦事項，再點一次可結束聆聽。';
        armRecovery(record, 60_000, '語音已結束；可以確認文字或重新開始。');
      };
      recognition.onresult = event => {
        if (!current(record) || record.hadError || !event.results) return;
        let finalTranscript = '';
        let interim = '';
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = result?.[0]?.transcript || '';
          if (result?.isFinal) finalTranscript += text;
          else interim += text;
        }
        if (finalTranscript) record.finalTranscript = finalTranscript;
        if (record.hasAppliedFinal && input.value !== record.lastAppliedValue) record.manualCorrection = true;
        if (finalTranscript && !record.manualCorrection) {
          input.value = finalTranscript;
          record.hasAppliedFinal = true;
          record.lastAppliedValue = finalTranscript;
          const InputEvent = windowObject?.Event || globalThis.Event;
          applyingTranscript = true;
          try { input.dispatchEvent(new InputEvent('input', { bubbles: true })); }
          finally { applyingTranscript = false; }
          // Some browsers deliver final text without a matching end event.
          armRecovery(record, 2000, completedMessage(record));
        }
        if (interim) speechStatus.textContent = `辨識中：${interim}`;
      };
      recognition.onerror = event => {
        if (!current(record)) return;
        record.hadError = true;
        state = 'ending';
        speechStatus.textContent = ERROR_MESSAGES[event.error] || '語音輸入暫時無法使用，請改用打字。';
        // Restore typing now; end or the bounded watchdog releases voice retry.
        updateListening(false);
        armRecovery(record, 2000, speechStatus.textContent);
      };
      recognition.onend = () => {
        if (!current(record)) return;
        finish(record, { message: record.hadError ? undefined : completedMessage(record) });
      };

      state = 'starting';
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
    if (state === 'listening' && session) {
      const record = session;
      state = 'stopping';
      armRecovery(record, 2000, completedMessage(record));
      try { record.recognition.stop(); }
      catch {
        if (!current(record)) return;
        record.hadError = true;
        state = 'ending';
        updateListening(false);
        speechStatus.textContent = '無法結束語音輸入，請稍後再試或改用打字。';
        armRecovery(record, 2000, speechStatus.textContent);
      }
      return;
    }
    if (state !== 'idle' || isReadOnly()) return;
    startSession();
  }
  voiceButton.addEventListener('click', clickVoice);
  windowObject?.addEventListener?.('pagehide', pageHide);
  windowObject?.addEventListener?.('pageshow', pageShow);

  return {
    supported: true, get state() { return state; }, reset,
    destroy() {
      reset('');
      destroyed = true;
      input.removeEventListener?.('input', markManualCorrection);
      voiceButton.removeEventListener?.('click', clickVoice);
      windowObject?.removeEventListener?.('pagehide', pageHide);
      windowObject?.removeEventListener?.('pageshow', pageShow);
    },
  };
}
