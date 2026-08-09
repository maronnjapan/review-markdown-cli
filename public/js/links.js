/**
 * Client half of relative-link support. The server has already classified every
 * link (see src/links.js) and written the verdict into `data-link-state`, so all
 * that is left is to honour it: navigate inside the app, or explain the refusal.
 */
export function createLinkNavigator({ root, state, onError }) {
  root.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href]');
    if (!anchor || !root.contains(anchor)) return;

    // Clicking inside contenteditable should place the caret, never navigate.
    if (state.mode === 'edit') {
      event.preventDefault();
      return;
    }

    const linkState = anchor.dataset.linkState;
    if (linkState === 'outside' || linkState === 'filtered') {
      event.preventDefault();
      onError(anchor.dataset.linkError || 'このリンクは開けません。');
    }
  });

  return {
    /** Scrolls to the heading a `#hash` names, once the document is rendered. */
    scrollToAnchor(hash) {
      if (!hash) return false;
      const id = hash.replace(/^#/, '');
      if (!id) return false;
      const target = findAnchorTarget(root, id);
      if (!target) return false;
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      return true;
    }
  };
}

function findAnchorTarget(root, id) {
  for (const candidate of anchorIdSpellings(id)) {
    const escaped = cssAttrValue(candidate);
    const found = root.querySelector(`[id="${escaped}"], [name="${escaped}"]`);
    if (found) return found;
  }
  // Fall back to matching the heading text, which is what the author actually wrote.
  const wanted = decodeSafely(id).replace(/\s+/g, '').toLowerCase();
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .find((heading) => heading.textContent.replace(/\s+/g, '').toLowerCase() === wanted) || null;
}

function anchorIdSpellings(id) {
  const decoded = decodeSafely(id);
  return decoded === id ? [id] : [id, decoded];
}

function decodeSafely(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cssAttrValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
