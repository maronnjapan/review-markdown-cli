import { normalizeText } from './util.js';

/**
 * Comments are stored as text plus surrounding context rather than as offsets,
 * so they survive edits elsewhere in the document. Everything in this module is
 * about finding that text again inside the rendered DOM.
 */

const CONTEXT_LENGTH = 120;

export function findTextRange(root, selectedText, contextBefore = '', contextAfter = '') {
  const nodes = collectTextNodes(root);
  const fullText = nodes.map(({ node }) => node.nodeValue).join('');
  const match = findBestTextMatch(fullText, selectedText, contextBefore, contextAfter);
  if (!match) return null;

  const start = locateTextOffset(nodes, match.start);
  const end = locateTextOffset(nodes, match.end, true);
  if (!start || !end) return null;
  return { startNode: start.node, startOffset: start.offset, endNode: end.node, endOffset: end.offset };
}

export function createRangeFor(root, match) {
  const range = root.ownerDocument.createRange();
  range.setStart(match.startNode, match.startOffset);
  range.setEnd(match.endNode, match.endOffset);
  return range;
}

/** The text immediately before and after a node, used to disambiguate repeats. */
export function contextAroundNode(root, node) {
  const document = root.ownerDocument;
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEndBefore(node);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(root);
  afterRange.setStartAfter(node);
  return {
    before: beforeRange.toString().slice(-CONTEXT_LENGTH).trim(),
    after: afterRange.toString().slice(0, CONTEXT_LENGTH).trim()
  };
}

/**
 * The rendered text of a review target, without the affordances the review UI
 * injected into it. Comments store this, so the buttons must never leak in.
 */
export function targetTextOf(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.inline-target-action').forEach((button) => button.remove());
  return clone.textContent || '';
}

/** The heading trail above an element, so a comment can name its section. */
export function collectHeadingPath(root, element) {
  const headings = [];
  const elementTop = documentTop(element);
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (documentTop(heading) > elementTop) break;
    const level = Number(heading.tagName.slice(1));
    headings[level - 1] = targetTextOf(heading).trim();
    headings.length = level;
  }
  return headings.filter(Boolean);
}

function documentTop(element) {
  const scrollY = element.ownerDocument?.defaultView?.scrollY || 0;
  return element.getBoundingClientRect().top + scrollY;
}

function collectTextNodes(root) {
  const nodes = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('button, script, style')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push({ node, length: node.nodeValue.length });
    node = walker.nextNode();
  }
  return nodes;
}

/** Exact match first; fall back to a whitespace-insensitive match. */
function findBestTextMatch(fullText, selectedText, contextBefore, contextAfter) {
  const exactIndex = findBestTextIndex(fullText, selectedText, contextBefore, contextAfter);
  if (exactIndex > -1) return { start: exactIndex, end: exactIndex + selectedText.length };

  const normalized = buildNormalizedTextIndex(fullText);
  const normalizedSelectedText = normalizeText(selectedText);
  if (!normalizedSelectedText) return null;
  const normalizedIndex = findBestTextIndex(normalized.text, normalizedSelectedText, contextBefore, contextAfter);
  if (normalizedIndex < 0) return null;
  return {
    start: normalized.starts[normalizedIndex],
    end: normalized.ends[normalizedIndex + normalizedSelectedText.length - 1]
  };
}

function findBestTextIndex(fullText, selectedText, contextBefore, contextAfter) {
  let index = fullText.indexOf(selectedText);
  let bestIndex = index;
  let bestScore = -1;
  while (index !== -1) {
    const before = fullText.slice(Math.max(0, index - 200), index);
    const after = fullText.slice(index + selectedText.length, index + selectedText.length + 200);
    const score = scoreContextMatch(before, after, contextBefore, contextAfter);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
    index = fullText.indexOf(selectedText, index + selectedText.length);
  }
  return bestIndex;
}

/** Maps every character of the whitespace-collapsed text back to the original. */
function buildNormalizedTextIndex(text) {
  let normalized = '';
  const starts = [];
  const ends = [];
  let index = 0;

  while (index < text.length) {
    if (/\s/.test(text[index])) {
      const start = index;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      if (normalized && !normalized.endsWith(' ')) {
        normalized += ' ';
        starts.push(start);
        ends.push(index);
      }
      continue;
    }
    normalized += text[index];
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }

  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text: normalized, starts, ends };
}

function scoreContextMatch(before, after, contextBefore, contextAfter) {
  let score = 0;
  const beforeText = normalizeText(before);
  const afterText = normalizeText(after);
  const expectedBefore = normalizeText(contextBefore).slice(-60);
  const expectedAfter = normalizeText(contextAfter).slice(0, 60);
  if (expectedBefore && beforeText.endsWith(expectedBefore)) score += 2;
  else if (expectedBefore && beforeText.includes(expectedBefore)) score += 1;
  if (expectedAfter && afterText.startsWith(expectedAfter)) score += 2;
  else if (expectedAfter && afterText.includes(expectedAfter)) score += 1;
  return score;
}

function locateTextOffset(nodes, offset, preferPrevious = false) {
  let current = 0;
  for (const { node, length } of nodes) {
    const nodeEnd = current + length;
    if (offset < nodeEnd || (preferPrevious && offset === nodeEnd)) {
      return { node, offset: offset - current };
    }
    current = nodeEnd;
  }
  const last = nodes.at(-1);
  return last && offset === current ? { node: last.node, offset: last.length } : null;
}
