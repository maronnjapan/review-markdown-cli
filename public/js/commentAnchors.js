import { commentTargetText } from './comments.js';
import { createRangeFor, findTextRange, targetTextOf } from './textAnchor.js';
import { createId, normalizeText, truncate } from './util.js';

/**
 * 本文のどこに何が付いているかを、組み上がったHTMLの上で引き直します。
 *
 * 付くものは2種類あります。書き手やAIエージェントへの依頼であるコメントと、
 * レビュアーが自分のために残したメモ（`memos.js`）です。持ち方は同じ「対象」なので、
 * 探し方もここ1本にまとめてあります。違うのは見え方と、押したときに開くタブだけです。
 */

const BLOCK_SELECTOR = 'p, li, blockquote, pre';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/* ------------------------------------------------------------------ *
 * Comment mode: highlight what already has comments
 * ------------------------------------------------------------------ */

/**
 * Marks every place that already carries a comment or a memo. Each highlight
 * names what it stands for in `data-comment-indexes` / `data-memo-indexes`, so a
 * click on it can bring them up without matching the text a second time.
 *
 * コメントとメモを1度で引くのは、同じ文字に両方が付いているときに、片方の印を
 * もう片方の印の中へ入れ子で差し込んでしまわないようにするためです。
 */
export function renderCommentHighlights(root, comments, memos = []) {
  clearCommentHighlights(root);
  const entries = [
    ...comments.map((comment, index) => ({ kind: 'comment', target: comment, index })),
    ...memos.map((memo, index) => ({ kind: 'memo', target: memo, index }))
  ];
  highlightBlockTargets(root, entries);
  highlightTextSelections(root, entries);
}

/** 印を付けた場所が指すコメントとメモを、それぞれの一覧での位置で返します。 */
export function highlightIndexesAt(element) {
  return {
    comments: indexesFrom(element?.dataset?.commentIndexes),
    memos: indexesFrom(element?.dataset?.memoIndexes)
  };
}

function indexesFrom(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0);
}

function clearCommentHighlights(root) {
  root.querySelectorAll('.comment-marker').forEach((marker) => marker.remove());
  root.querySelectorAll('.comment-highlight-text, .memo-highlight-text').forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent?.normalize();
  });
  root.querySelectorAll('.comment-highlight-target, .memo-highlight-target').forEach((element) => {
    element.classList.remove('comment-highlight-target', 'memo-highlight-target');
    element.removeAttribute('data-comment-count');
    element.removeAttribute('data-comment-indexes');
    element.removeAttribute('data-memo-count');
    element.removeAttribute('data-memo-indexes');
  });
}

function highlightBlockTargets(root, entries) {
  root.querySelectorAll('.review-target').forEach((element) => {
    const elementText = normalizeText(targetTextOf(element));
    if (!elementText) return;
    const matches = entries.filter(({ target }) => blockTargetMatches(target, element, elementText));
    if (matches.length === 0) return;
    const comments = matches.filter(({ kind }) => kind === 'comment');
    const memos = matches.filter(({ kind }) => kind === 'memo');
    if (comments.length) {
      element.classList.add('comment-highlight-target');
      element.dataset.commentCount = String(comments.length);
      element.dataset.commentIndexes = indexList(comments);
    }
    if (memos.length) {
      element.classList.add('memo-highlight-target');
      element.dataset.memoCount = String(memos.length);
      element.dataset.memoIndexes = indexList(memos);
    }
    element.append(commentMarker(root.ownerDocument, matches));
  });
}

/**
 * The badge on a commented block. A yellow background says a comment exists;
 * this says how many, and that they are there to be read.
 *
 * コメントとメモが同じ段落に付いていても、印は1つです。2つ並べると、本文の行末が
 * 印だけで埋まります。数え方だけを「2件・メモ1件」と分けて書きます。
 */
function commentMarker(document, matches) {
  const marker = document.createElement('button');
  marker.type = 'button';
  // `inline-target-action` is what every text extraction here strips, and a
  // <button> is what the text search skips. The marker must stay out of both.
  marker.className = 'comment-marker inline-target-action';
  marker.textContent = markerLabel(matches);
  marker.title = highlightTitle(matches);
  marker.setAttribute('aria-label', highlightTitle(matches));
  return marker;
}

/** 印の文字。コメントだけなら「2件」、メモが混じるときだけ「メモ」と断ります。 */
function markerLabel(matches) {
  const comments = matches.filter(({ kind }) => kind === 'comment').length;
  const memos = matches.length - comments;
  return [comments ? `${comments}件` : '', memos ? `メモ${memos}件` : ''].filter(Boolean).join('・');
}

function blockTargetMatches(target, element, elementText) {
  const isHeading = /^H[1-6]$/.test(element.tagName);
  if (target.type === 'paragraph' && !isHeading) return normalizeText(commentTargetText(target)) === elementText;
  if (target.type === 'section' && isHeading) return normalizeText(commentTargetText(target)) === elementText;
  return false;
}

function highlightTextSelections(root, entries) {
  const anchored = entries.filter(({ target }) => commentTargetText(target));
  for (const group of groupBySelection(anchored)) {
    markTextSelection(root, group);
  }
}

function markTextSelection(root, matches) {
  const reference = matches[0].target;
  const match = findTextRange(root, commentTargetText(reference), reference.contextBefore, reference.contextAfter);
  if (!match) return;

  const comments = matches.filter(({ kind }) => kind === 'comment');
  const memos = matches.filter(({ kind }) => kind === 'memo');
  const mark = root.ownerDocument.createElement('mark');
  // コメントが1件でもあれば、見え方はコメントのままにします。依頼が付いている箇所が
  // メモの色に変わると、直す先を本文の色で追えなくなります。
  mark.className = [
    comments.length ? 'comment-highlight-text' : '',
    memos.length ? 'memo-highlight-text' : ''
  ].filter(Boolean).join(' ');
  mark.tabIndex = 0;
  if (comments.length) mark.dataset.commentIndexes = indexList(comments);
  if (memos.length) mark.dataset.memoIndexes = indexList(memos);
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
  if (matches.length !== 1) {
    const comments = matches.filter(({ kind }) => kind === 'comment').length;
    const memos = matches.length - comments;
    const counted = [comments ? `コメント${comments}件` : '', memos ? `メモ${memos}件` : ''].filter(Boolean);
    return `${counted.join('と')}を確認`;
  }
  const [{ kind, target }] = matches;
  const label = kind === 'memo' ? 'メモ' : 'コメント';
  const text = normalizeText((kind === 'memo' ? target.body : target.comment) || '');
  return text ? `${label}を確認: ${truncate(text, 40)}` : `${label}を確認`;
}

/* ------------------------------------------------------------------ *
 * Edit mode: check what the comments still point at
 * ------------------------------------------------------------------ */

/**
 * いま組み上がっている本文に照らして、コメントやメモの指す先がまだ在るかを引き直します。
 *
 * 生のMarkdownを直に書く編集モードには、打つたびに追いかけられる目印がありません。
 * 代わりに、隣に出している組み上がりの上で毎回引き直します。編集の途中経過ではなく
 * 「いまの本文で見つかるかどうか」で決まるので、直したつもりで外れていたコメントに、
 * 保存を待たずに気づけます。
 */
export function refreshCommentAttachment(root, targets, idPrefix = 'comment') {
  for (const target of targets) {
    // 手で書いたレビューファイルにはidが無いことがあります。数える前に振っておきます。
    if (!target.id) target.id = createId(idPrefix);
    if (target.type === 'document' || findCommentTarget(root, target)) delete target.targetDetached;
    else target.targetDetached = true;
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
function groupBySelection(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.target.type !== 'text-selection') continue;
    const key = selectionKey(entry.target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
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
