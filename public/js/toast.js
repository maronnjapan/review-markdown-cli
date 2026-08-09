const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Short-lived confirmations and errors. Messages stack in the corner and fade
 * out on their own; errors stay until dismissed so a failure is never missed.
 */
export function createToaster(container) {
  const document = container?.ownerDocument;

  function show(message, { tone = 'info', timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!container || !document) return null;

    const toast = document.createElement('div');
    toast.className = `toast toast-${tone}`;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');

    const text = document.createElement('p');
    text.className = 'toast-message';
    text.textContent = message;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'toast-dismiss';
    dismiss.setAttribute('aria-label', '閉じる');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => toast.remove());

    toast.append(text, dismiss);
    container.append(toast);

    if (tone !== 'error' && timeout > 0) {
      const timer = setTimeout(() => toast.remove(), timeout);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return toast;
  }

  return {
    show,
    info: (message) => show(message, { tone: 'info' }),
    success: (message) => show(message, { tone: 'success' }),
    error: (message) => show(message, { tone: 'error' }),
    clear() {
      if (container) container.replaceChildren();
    }
  };
}
