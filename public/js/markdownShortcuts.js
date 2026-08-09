/**
 * Turns Markdown typed inside the editor into rendered elements as soon as it
 * is recognisable, so the reviewer never sees raw syntax in the preview.
 */

const BLOCK_SHORTCUTS = [
  {
    pattern: /^(#{1,6})\s(.*)$/s,
    kind: () => 'heading',
    prefixLength: (match) => match[1].length + 1,
    content: (match) => match[2],
    create: (document, match) => {
      const heading = document.createElement(`h${match[1].length}`);
      return { container: heading, contentTarget: heading };
    }
  },
  {
    pattern: /^>\s(.*)$/s,
    kind: () => 'blockquote',
    prefixLength: () => 2,
    content: (match) => match[1],
    create: (document) => nest(document, 'blockquote', 'p')
  },
  {
    pattern: /^[-*+]\s(.*)$/s,
    kind: () => 'list',
    prefixLength: () => 2,
    content: (match) => match[1],
    create: (document) => nest(document, 'ul', 'li')
  },
  {
    pattern: /^(\d+\.)\s(.*)$/s,
    kind: () => 'list',
    prefixLength: (match) => match[1].length + 1,
    content: (match) => match[2],
    create: (document) => nest(document, 'ol', 'li')
  },
  {
    pattern: /^```([\w-]*)\s$/,
    kind: (match) => (match[1].toLowerCase() === 'mermaid' ? 'mermaid' : 'code'),
    prefixLength: (match) => match[0].length,
    content: () => '',
    create: (document, match) => {
      const { container, contentTarget } = nest(document, 'pre', 'code');
      if (match[1]) contentTarget.className = `language-${match[1]}`;
      return { container, contentTarget };
    }
  }
];

const INLINE_PATTERN = /!\[([^\]\n]*)\]\(([^)\n]+)\)|\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g;

export function applyMarkdownShortcuts(block, options = {}) {
  applyBlockShortcut(block);
  applyInlineShortcuts(block, options);
}

function applyBlockShortcut(block) {
  if (block.children.length !== 1) return false;
  const root = block.firstElementChild;
  if (!root?.matches('p, div') || root.querySelector('.editor-comment-anchor')) return false;

  const source = root.textContent || '';
  const shortcut = BLOCK_SHORTCUTS.find((candidate) => candidate.pattern.test(source));
  if (!shortcut) return false;

  const document = block.ownerDocument;
  const match = source.match(shortcut.pattern);
  const { container, contentTarget } = shortcut.create(document, match);
  const caretOffset = getCaretTextOffset(root);

  contentTarget.textContent = shortcut.content(match) || '';
  if (!contentTarget.textContent) contentTarget.append(document.createElement('br'));
  // The comment anchored to this paragraph must follow it into its new element.
  if (root.dataset.blockCommentIds) contentTarget.dataset.blockCommentIds = root.dataset.blockCommentIds;

  root.replaceWith(container);
  block.dataset.blockKind = shortcut.kind(match);
  if (caretOffset !== null) setCaretTextOffset(contentTarget, Math.max(0, caretOffset - shortcut.prefixLength(match)));
  return true;
}

function nest(document, outerTag, innerTag) {
  const container = document.createElement(outerTag);
  const contentTarget = document.createElement(innerTag);
  container.append(contentTarget);
  return { container, contentTarget };
}

function applyInlineShortcuts(block, options) {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !/[*_`[\]]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  nodes.forEach((textNode) => replaceInlineMarkdown(textNode, options));
}

function replaceInlineMarkdown(textNode, options) {
  const source = textNode.nodeValue;
  const matches = [...source.matchAll(INLINE_PATTERN)];
  if (matches.length === 0) return;

  const document = textNode.ownerDocument;
  const selection = selectionOf(document);
  const caretOffset = selection?.isCollapsed && selection.anchorNode === textNode ? selection.anchorOffset : null;
  const fragment = document.createDocumentFragment();
  let sourceOffset = 0;
  let caretTarget = null;

  for (const match of matches) {
    if (match.index > sourceOffset) fragment.append(document.createTextNode(source.slice(sourceOffset, match.index)));
    const formatted = createInlineElement(document, match, options);
    fragment.append(formatted);
    if (caretOffset !== null && caretOffset >= match.index && caretOffset <= match.index + match[0].length) {
      caretTarget = formatted;
    }
    sourceOffset = match.index + match[0].length;
  }
  if (sourceOffset < source.length) fragment.append(document.createTextNode(source.slice(sourceOffset)));

  textNode.replaceWith(fragment);
  if (caretTarget) placeCaretAfter(caretTarget);
}

function createInlineElement(document, match, { resolveImageSource = (source) => source } = {}) {
  if (match[1] !== undefined) {
    const image = document.createElement('img');
    image.alt = match[1];
    image.dataset.markdownSrc = match[2].trim();
    image.src = resolveImageSource(match[2].trim());
    return image;
  }
  if (match[3] !== undefined) {
    const link = document.createElement('a');
    link.textContent = match[3];
    link.dataset.markdownHref = match[4].trim();
    link.href = match[4].trim();
    link.target = '_blank';
    link.rel = 'noreferrer';
    return link;
  }

  const tagName = match[5] !== undefined || match[6] !== undefined
    ? 'strong'
    : match[7] !== undefined ? 'code' : 'em';
  const element = document.createElement(tagName);
  element.textContent = match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9];
  return element;
}

export function getCaretTextOffset(element) {
  const document = element.ownerDocument;
  const selection = selectionOf(document);
  if (!selection?.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

export function setCaretTextOffset(element, requestedOffset) {
  const document = element.ownerDocument;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = requestedOffset;
  let node = walker.nextNode();
  while (node) {
    if (remaining <= node.nodeValue.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selectRange(document, range);
      return;
    }
    remaining -= node.nodeValue.length;
    node = walker.nextNode();
  }
  placeCaretAfter(element.lastChild || element);
}

export function placeCaretAfter(node) {
  const document = node.ownerDocument;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selectRange(document, range);
}

function selectRange(document, range) {
  const selection = selectionOf(document);
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectionOf(document) {
  return document?.defaultView?.getSelection?.() || null;
}
