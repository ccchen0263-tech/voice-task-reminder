export const THEME_KEY = 'voice-task-reminder.theme.v1';

/** Set up local light/dark preferences without requesting browser permissions. */
export function setupTheme({
  button,
  root = globalThis.document?.documentElement,
  storage,
  media,
  onError,
} = {}) {
  if (!root || typeof root.setAttribute !== 'function') {
    throw new TypeError('主題設定需要有效的文件根元素。');
  }

  let activeStorage = storage;
  let activeMedia = media;
  let theme = 'light';
  let explicitChoice = false;
  let saveError = false;
  let destroyed = false;
  let removeMediaListener = () => {};

  function report(message, error) {
    if (typeof onError !== 'function') return;
    try { onError(message, error); } catch { /* A status callback must not stop the App. */ }
  }

  function apply(nextTheme) {
    theme = nextTheme;
    root.setAttribute('data-theme', theme);
    if (root.style) root.style.colorScheme = theme;
    if (!button) return;
    const current = theme === 'dark' ? '深色' : '淺色';
    const action = `切換${theme === 'dark' ? '淺色' : '深色'}`;
    button.textContent = action;
    button.setAttribute('aria-pressed', String(theme === 'dark'));
    button.setAttribute('aria-label', `${action}模式，目前為${current}${saveError ? '，主題偏好未保存' : ''}`);
    button.setAttribute('data-save-error', String(saveError));
    button.setAttribute('title', saveError ? `${action}；無法存取儲存空間，主題偏好僅本次使用` : action);
  }

  try {
    if (activeStorage === undefined) activeStorage = globalThis.localStorage;
    const stored = activeStorage?.getItem?.(THEME_KEY);
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
      explicitChoice = true;
    }
  } catch (error) {
    saveError = true;
    report('無法讀取主題偏好，將使用裝置的外觀設定。', error);
  }

  try {
    if (activeMedia === undefined) {
      const browser = globalThis.window;
      activeMedia = browser?.matchMedia?.('(prefers-color-scheme: dark)');
    }
    if (!explicitChoice) theme = activeMedia?.matches ? 'dark' : 'light';
  } catch (error) {
    report('無法讀取裝置外觀設定，已使用淺色模式。', error);
  }
  apply(theme);

  function setTheme(nextTheme) {
    if (destroyed || (nextTheme !== 'light' && nextTheme !== 'dark')) {
      return { theme, saved: false };
    }
    explicitChoice = true;
    let saved = false;
    try {
      if (!activeStorage || typeof activeStorage.setItem !== 'function') throw new Error('Storage unavailable');
      activeStorage.setItem(THEME_KEY, nextTheme);
      saved = true;
      saveError = false;
    } catch (error) {
      saveError = true;
      // Applying the chosen appearance still works when localStorage is blocked.
      apply(nextTheme);
      report('目前外觀已切換，但主題偏好無法儲存。', error);
    }
    apply(nextTheme);
    return { theme, saved };
  }

  const onClick = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  button?.addEventListener?.('click', onClick);
  const onMediaChange = event => {
    if (!destroyed && !explicitChoice) apply(event.matches ? 'dark' : 'light');
  };
  try {
    if (typeof activeMedia?.addEventListener === 'function') {
      activeMedia.addEventListener('change', onMediaChange);
      removeMediaListener = () => activeMedia.removeEventListener?.('change', onMediaChange);
    } else if (typeof activeMedia?.addListener === 'function') {
      activeMedia.addListener(onMediaChange);
      removeMediaListener = () => activeMedia.removeListener?.(onMediaChange);
    }
  } catch (error) {
    report('無法自動跟隨裝置外觀，仍可使用按鈕切換主題。', error);
  }

  return {
    getTheme: () => theme,
    setTheme,
    destroy() {
      destroyed = true;
      button?.removeEventListener?.('click', onClick);
      try { removeMediaListener(); } catch { /* Optional browser listener cleanup. */ }
    },
  };
}
