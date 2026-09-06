import { commentTargetText } from './comments.js';
import { createRangeFor, findTextRange, targetTextOf } from './textAnchor.js';
import { createId, normalizeText, truncate } from './util.js';

const BLOCK_SELECTOR = 'p, li, blockquote, pre';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/* ------------------------------------------------------------------ *
 * Comment mode: highlight what already has comments
 * ------------------------------------------------------------------ */

/**
 * Marks every place that already carries a comment. Each highlight names the
 * comments it stands for in `data-comment-indexes`, so a click on it can bring
 * them up without matching the text a second time.
 *
 * `blockSelector` は段落・見出しに付いたコメントを探す先です。コメントモードでは
 * コメントを足せる印（`.review-target`）が付いているのでそれを使い、編集モードの
 * プレビューには印が無いので要素の種類そのもので探します。
 */
export function renderCommentHighlights(root, comments, { blockSelector = '.review-target' } = {}) {
  clearCommentHighlights(root);
  const entries = comments.map((comment, index) => ({ comment, index }));
  highlightBlockTargets(root, entries, blockSelector);
  highlightTextSelections(root, entries);
}

/** The comments a highlighted place stands for, as indexes into the comment list. */
export function commentIndexesAt(element) {
  return String(element?.dataset?.commentIndexes || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0);
}

function clearCommentHighlights(root) {
  root.querySelectorAll('.comment-marker').forEach((marker) => marker.remove());
  root.querySelectorAll('.comment-highlight-text').forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent?.normalize();
  });
  root.querySelectorAll('.comment-highlight-target').forEach((element) => {
    element.classList.remove('comment-highlight-target');
    element.removeAttribute('data-comment-count');
    element.removeAttribute('data-comment-indexes');
  });
}

function highlightBlockTargets(root, entries, blockSelector) {
  root.querySelectorAll(blockSelector).forEach((element) => {
    const elementText = normalizeText(targetTextOf(element));
    if (!elementText) return;
    const matches = entries.filter(({ comment }) => blockCommentMatches(comment, element, elementText));
    if (matches.length === 0) return;
    element.classList.add('comment-highlight-target');
    element.dataset.commentCount = String(matches.length);
    element.dataset.commentIndexes = indexList(matches);
    element.append(commentMarker(root.ownerDocument, matches));
  });
}

/**
 * The badge on a commented block. A yellow background says a comment exists;
 * this says how many, and that they are there to be read.
 */
function commentMarker(document, matches) {
  const marker = document.createElement('button');
  marker.type = 'button';
  // `inline-target-action` is what every text extraction here strips, and a
  // <button> is what the text search skips. The marker must stay out of both.
  marker.className = 'comment-marker inline-target-action';
  marker.textContent = `${matches.length}件`;
  marker.title = highlightTitle(matches);
  marker.setAttribute('aria-label', highlightTitle(matches));
  return marker;
}

function blockCommentMatches(comment, element, elementText) {
  const isHeading = /^H[1-6]$/.test(element.tagName);
  if (comment.type === 'paragraph' && !isHeading) return normalizeText(commentTargetText(comment)) === elementText;
  if (comment.type === 'section' && isHeading) return normalizeText(commentTargetText(comment)) === elementText;
  return false;
}

function highlightTextSelections(root, entries) {
  const commented = entries.filter(({ comment }) => commentTargetText(comment));
  for (const group of groupBySelection(commented, (entry) => entry.comment)) {
    markTextSelection(root, group);
  }
}

function markTextSelection(root, matches) {
  const reference = matches[0].comment;
  const match = findTextRange(root, commentTargetText(reference), reference.contextBefore, reference.contextAfter);
  if (!match) return;

  const mark = root.ownerDocument.createElement('mark');
  mark.className = 'comment-highlight-text';
  mark.tabIndex = 0;
  mark.dataset.commentIndexes = indexList(matches);
  mark.title = highlightTitle(matches);

  const range = createRangeFor(root, match);
  mark.append(range.extractContents());
  range.insertNode(mark);
}

function indexList(matches) {
  return matches.map(({ index }) => index).join(' ');
}

/** What the reviewer gets for hovering: the comment itself, when there is one. */
function highlightTitle(matches) {
  if (matches.length !== 1) return `コメント${matches.length}件を確認`;
  const text = normalizeText(matches[0].comment.comment || '');
  return text ? `コメントを確認: ${truncate(text, 40)}` : 'コメントを確認';
}

/* ------------------------------------------------------------------ *
 * Edit mode: check what the comments still point at
 * ------------------------------------------------------------------ */

/**
 * いま組み上がっている本文に照らして、コメントの指す先がまだ在るかを引き直します。
 *
 * 生のMarkdownを直に書く編集モードには、打つたびに追いかけられる目印がありません。
 * 代わりに、隣に出している組み上がりの上で毎回引き直します。編集の途中経過ではなく
 * 「いまの本文で見つかるかどうか」で決まるので、直したつもりで外れていたコメントに、
 * 保存を待たずに気づけます。
 */
export function refreshCommentAttachment(root, comments) {
  for (const comment of comments) {
    // 手で書いたレビューファイルにはidが無いことがあります。数える前に振っておきます。
    if (!comment.id) comment.id = createId();
    if (comment.type === 'document' || findCommentTarget(root, comment)) delete comment.targetDetached;
    else comment.targetDetached = true;
  }
}

function findCommentTarget(root, comment) {
  const wanted = commentTargetText(comment);
  if (!normalizeText(wanted)) return null;
  if (comment.type !== 'paragraph' && comment.type !== 'section') {
    return findTextRange(root, wanted, comment.contextBefore, comment.contextAfter);
  }
  const selector = comment.type === 'section' ? HEADING_SELECTOR : BLOCK_SELECTOR;
  return [...root.querySelectorAll(selector)]
    .find((element) => normalizeText(targetTextOf(element)) === normalizeText(wanted)) || null;
}

/** Comments on identical text share one anchor element, and one highlight. */
function groupBySelection(items, commentOf) {
  const groups = new Map();
  for (const item of items) {
    const comment = commentOf(item);
    if (comment.type !== 'text-selection') continue;
    const key = selectionKey(comment);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups.values();
}

function selectionKey(comment) {
  return [
    normalizeText(commentTargetText(comment)),
    normalizeText(comment.contextBefore || ''),
    normalizeText(comment.contextAfter || '')
  ].join('\n---\n');
}

