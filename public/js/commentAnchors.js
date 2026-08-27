import { commentTargetText } from './comments.js';
import {
  collectHeadingPath,
  contextAroundNode,
  createRangeFor,
  findTextRange,
  targetTextOf
} from './textAnchor.js';
import { createId, cssEscape, normalizeText, truncate } from './util.js';

const BLOCK_SELECTOR = 'p, li, blockquote, pre';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/* ------------------------------------------------------------------ *
 * Comment mode: highlight what already has comments
 * ------------------------------------------------------------------ */

/**
 * Marks every place that already carries a comment. Each highlight names the
 * comments it stands for in `data-comment-indexes`, so a click on it can bring
 * them up without matching the text a second time.
 */
export function renderCommentHighlights(root, comments) {
  clearCommentHighlights(root);
  const entries = comments.map((comment, index) => ({ comment, index }));
  highlightBlockTargets(root, entries);
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

function highlightBlockTargets(root, entries) {
  root.querySelectorAll('.review-target').forEach((element) => {
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
 * Edit mode: keep comments attached while the text underneath changes
 * ------------------------------------------------------------------ */

/**
 * Marks the elements each comment points at so edits can be tracked back to it.
 * Returns a Map of comment id to the editable block holding it; comments whose
 * target has disappeared are flagged with `targetDetached`.
 */
export function prepareEditorCommentAnchors(root, comments) {
  const commentBlocks = new Map();
  comments.forEach((comment) => {
    // A hand-written review file may omit ids; anchoring needs one per comment.
    if (!comment.id) comment.id = createId();
    delete comment.targetDetached;
  });

  for (const comment of comments) {
    if (comment.type !== 'paragraph' && comment.type !== 'section') continue;
    const selector = comment.type === 'section' ? HEADING_SELECTOR : BLOCK_SELECTOR;
    const wanted = normalizeText(commentTargetText(comment));
    const target = [...root.querySelectorAll(selector)]
      .find((element) => wanted && normalizeText(targetTextOf(element)) === wanted);

    const blockId = target?.closest('.markdown-block')?.dataset.blockId;
    if (!target || !blockId) {
      comment.targetDetached = true;
      continue;
    }
    appendDataId(target, 'blockCommentIds', comment.id);
    commentBlocks.set(comment.id, blockId);
  }

  for (const group of groupBySelection(comments, (comment) => comment)) {
    anchorSelectionGroup(root, group, commentBlocks);
  }
  return commentBlocks;
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

function anchorSelectionGroup(root, comments, commentBlocks) {
  const reference = comments[0];
  const match = findTextRange(root, commentTargetText(reference), reference.contextBefore, reference.contextAfter);
  const detachAll = () => comments.forEach((comment) => { comment.targetDetached = true; });
  if (!match) return detachAll();

  try {
    const range = createRangeFor(root, match);
    const anchor = root.ownerDocument.createElement('span');
    anchor.className = 'editor-comment-anchor';
    anchor.dataset.commentIds = comments.map((comment) => comment.id).join(' ');
    anchor.append(range.extractContents());
    range.insertNode(anchor);

    const blockId = anchor.closest('.markdown-block')?.dataset.blockId;
    if (!blockId) return detachAll();
    comments.forEach((comment) => commentBlocks.set(comment.id, blockId));
  } catch {
    // A selection spanning element boundaries cannot be wrapped in one anchor.
    detachAll();
  }
}

/**
 * After the reviewer edits a block, copy the new text back onto every comment
 * anchored inside it so the saved review keeps pointing at the right place.
 */
export function syncCommentsFromEditor(root, block, comments, commentBlocks) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));

  block.querySelectorAll('[data-block-comment-ids]').forEach((target) => {
    const text = targetTextOf(target).trim();
    if (!text) return;
    for (const comment of commentsFor(byId, target.dataset.blockCommentIds)) {
      comment.selectedText = text;
      comment.targetText = text;
      comment.headingPath = collectHeadingPath(root, target);
      if (comment.type === 'section') comment.heading = text;
      delete comment.targetDetached;
    }
  });

  block.querySelectorAll('.editor-comment-anchor[data-comment-ids]').forEach((anchor) => {
    const selectedText = anchor.textContent.trim();
    for (const comment of commentsFor(byId, anchor.dataset.commentIds)) {
      if (!selectedText) {
        comment.targetDetached = true;
        continue;
      }
      const context = contextAroundNode(root, anchor);
      comment.selectedText = selectedText;
      comment.contextBefore = context.before;
      comment.contextAfter = context.after;
      comment.headingPath = collectHeadingPath(root, anchor);
      delete comment.targetDetached;
    }
  });

  for (const comment of comments) {
    if (commentBlocks.get(comment.id) !== block.dataset.blockId) continue;
    const id = cssEscape(comment.id);
    const stillPresent = block.querySelector(
      `[data-block-comment-ids~="${id}"], .editor-comment-anchor[data-comment-ids~="${id}"]`
    );
    if (!stillPresent) comment.targetDetached = true;
  }
}

function commentsFor(byId, idList) {
  return String(idList || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => byId.get(id))
    .filter(Boolean);
}

function selectionKey(comment) {
  return [
    normalizeText(commentTargetText(comment)),
    normalizeText(comment.contextBefore || ''),
    normalizeText(comment.contextAfter || '')
  ].join('\n---\n');
}

function appendDataId(element, dataName, id) {
  const ids = new Set(String(element.dataset[dataName] || '').split(/\s+/).filter(Boolean));
  ids.add(id);
  element.dataset[dataName] = [...ids].join(' ');
}
