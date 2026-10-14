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

  function updateListening(active) {
    voiceButton.setAttribute('aria-pressed', String(active));
    voiceLabel.textContent = active ? '聆聽中...' : '語音輸入';
    onListening(active);
  }

  function current(record) {
    return session === record && !record.ended;
  }

  updateListening(false);
  if (!Recognition) {
    voiceButton.disabled = true;
    speechStatus.textContent = '此瀏覽器不支援語音輸入，請改用打字';
    return { supported: false, get state() { return state; } };
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
      };
      session = record;

      recognition.onstart = () => {
        if (!current(record) || state !== 'starting') return;
        state = 'listening';
        updateListening(true);
        speechStatus.textContent = '請說出你的待辦事項，再點一次可結束聆聽。';
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
        }
        if (interim) speechStatus.textContent = `辨識中：${interim}`;
      };
      recognition.onerror = event => {
        if (!current(record)) return;
        record.hadError = true;
        state = 'ending';
        speechStatus.textContent = ERROR_MESSAGES[event.error] || '語音輸入暫時無法使用，請改用打字。';
        // Restore typing immediately, but wait for onend before a new session.
        updateListening(false);
      };
      recognition.onend = () => {
        if (!current(record)) return;
        record.ended = true;
        session = null;
        state = 'idle';
        updateListening(false);
        if (!record.hadError) {
          speechStatus.textContent = record.finalTranscript
            ? '辨識完成，請確認任務與時間後新增。'
            : '尚未辨識到文字，請再試一次或改用打字。';
        }
      };

      state = 'starting';
      updateListening(true);
      speechStatus.textContent = '正在開啟麥克風…';
      recognition.start();
    } catch {
      if (record && !current(record)) return;
      if (record) record.ended = true;
      session = null;
      state = 'idle';
      updateListening(false);
      speechStatus.textContent = '無法啟動語音輸入，請稍後再試或改用打字。';
    }
  }

  voiceButton.addEventListener('click', () => {
    if (state === 'listening' && session) {
      const record = session;
      state = 'stopping';
      try { record.recognition.stop(); }
      catch {
        if (!current(record)) return;
        record.hadError = true;
        state = 'ending';
        updateListening(false);
        speechStatus.textContent = '無法結束語音輸入，請稍後再試或改用打字。';
      }
      return;
    }
    if (state !== 'idle' || isReadOnly()) return;
    startSession();
  });

  return { supported: true, get state() { return state; } };
}
