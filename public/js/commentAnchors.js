import { commentTargetText } from './comments.js';
import {
  collectHeadingPath,
  contextAroundNode,
  createRangeFor,
  findTextRange,
  targetTextOf
} from './textAnchor.js';
import { createId, cssEscape, normalizeText } from './util.js';

const BLOCK_SELECTOR = 'p, li, blockquote, pre';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/* ------------------------------------------------------------------ *
 * Comment mode: highlight what already has comments
 * ------------------------------------------------------------------ */

export function renderCommentHighlights(root, comments, { onSelectExisting }) {
  clearCommentHighlights(root);
  highlightBlockTargets(root, comments);
  highlightTextSelections(root, comments, onSelectExisting);
}

function clearCommentHighlights(root) {
  root.querySelectorAll('.comment-highlight-text').forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent?.normalize();
  });
  root.querySelectorAll('.comment-highlight-target').forEach((element) => {
    element.classList.remove('comment-highlight-target');
    element.removeAttribute('data-comment-count');
  });
}

function highlightBlockTargets(root, comments) {
  root.querySelectorAll('.review-target').forEach((element) => {
    const elementText = normalizeText(targetTextOf(element));
    if (!elementText) return;
    const matches = comments.filter((comment) => blockCommentMatches(comment, element, elementText));
    if (matches.length === 0) return;
    element.classList.add('comment-highlight-target');
    element.dataset.commentCount = String(matches.length);
  });
}

function blockCommentMatches(comment, element, elementText) {
  const isHeading = /^H[1-6]$/.test(element.tagName);
  if (comment.type === 'paragraph' && !isHeading) return normalizeText(commentTargetText(comment)) === elementText;
  if (comment.type === 'section' && isHeading) return normalizeText(commentTargetText(comment)) === elementText;
  return false;
}

function highlightTextSelections(root, comments, onSelectExisting) {
  const seen = new Set();
  for (const comment of comments) {
    if (comment.type !== 'text-selection' || !commentTargetText(comment)) continue;
    const key = selectionKey(comment);
    if (seen.has(key)) continue;
    seen.add(key);
    markTextSelection(root, comment, onSelectExisting);
  }
}

function markTextSelection(root, comment, onSelectExisting) {
  const match = findTextRange(root, commentTargetText(comment), comment.contextBefore, comment.contextAfter);
  if (!match) return;

  const mark = root.ownerDocument.createElement('mark');
  mark.className = 'comment-highlight-text';
  mark.tabIndex = 0;
  mark.title = 'この対象にコメントを追加';
  mark.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectExisting(comment);
  });
  mark.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelectExisting(comment);
  });

  const range = createRangeFor(root, match);
  mark.append(range.extractContents());
  range.insertNode(mark);
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

  for (const group of groupSelectionComments(comments)) {
    anchorSelectionGroup(root, group, commentBlocks);
  }
  return commentBlocks;
}

/** Comments on identical text share one anchor element. */
function groupSelectionComments(comments) {
  const groups = new Map();
  for (const comment of comments) {
    if (comment.type !== 'text-selection') continue;
    const key = selectionKey(comment);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(comment);
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
