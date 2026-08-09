/** Shared helpers for the link and image destinations written inside Markdown. */

const EXTERNAL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function isExternalUrl(value) {
  return EXTERNAL_PATTERN.test(String(value || '').trim());
}

/** Splits `./a b.md?v=1#top` into its path, query and hash parts. */
export function splitUrl(value) {
  const raw = String(value || '').trim();
  const hashIndex = raw.indexOf('#');
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : raw.slice(hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  return {
    path: queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex),
    query: queryIndex === -1 ? '' : withoutHash.slice(queryIndex),
    hash
  };
}

/**
 * The renderer percent-encodes destinations, so `./図/1.png` comes back escaped.
 * Restore the readable spelling whenever decoding cannot change how the
 * destination parses — the editor writes this value straight back into Markdown.
 */
export function decodeMarkdownPath(value) {
  const source = String(value || '');
  let decoded;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    // A stray '%' is part of the file name rather than an escape sequence.
    return source;
  }
  if (decoded === source || /[\s<>()\\]/.test(decoded)) return source;
  return decoded;
}
