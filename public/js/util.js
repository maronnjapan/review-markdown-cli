export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function truncate(text, length = 90) {
  const value = String(text);
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

/** Collapses every run of whitespace so DOM text and stored text compare equal. */
export function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

export function createId(prefix = 'comment') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
