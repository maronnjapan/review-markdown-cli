import crypto from 'node:crypto';
import { MAX_CHAT_COMMENTS, MAX_CHAT_COMMENT_CHARS, MAX_CHAT_QUOTE_CHARS } from './aiLimits.js';
import { reviewCommentsBlock } from './prompts/readingContext.js';
import { readReview } from './reviewStore.js';

/**
 * The review comments an AI conversation is allowed to read.
 *
 * A reviewer asking 「この指摘はどう直す？」 expects the AI to already know what the
 * comment says, so every comment saved for the open document travels with the
 * conversation. `attached` marks the ones that point at the text being
 * discussed, because that is what the question is usually about.
 *
 * 何件まで渡すか、1件をどこまで切り詰めるかは `aiLimits.js`。モデルが読む文面は
 * `prompts/readingContext.js` にあります。ここが持つのは「どれを選ぶか」だけです。
 */

export async function collectCommentContext(rootDir, documentPath, target) {
  const { comments = [] } = await readReview(rootDir, documentPath);
  const marked = comments
    .filter((comment) => String(comment?.comment || '').trim())
    .map((comment) => ({ comment, attached: attachedToTarget(comment, target) }));
  // Dropping the comments about other places first keeps the discussed ones.
  const kept = marked.length > MAX_CHAT_COMMENTS
    ? [...marked.filter((entry) => entry.attached), ...marked.filter((entry) => !entry.attached)].slice(0, MAX_CHAT_COMMENTS)
    : marked;
  const entries = kept.map(({ comment, attached }, index) => promptComment(comment, attached, index + 1));
  return { entries, dropped: marked.length - kept.length, revision: revisionOf(entries) };
}

/** The comments as the model reads them. Empty is stated rather than left out. */
export function commentContextBlock(context) {
  return reviewCommentsBlock(context);
}

function promptComment(comment, attached, number) {
  const headingPath = Array.isArray(comment.headingPath) ? comment.headingPath.filter(Boolean) : [];
  const quote = targetTextOf(comment);
  return {
    n: number,
    attached,
    type: comment.type || 'text-selection',
    status: comment.status === 'resolved' ? 'resolved' : 'open',
    ...(headingPath.length ? { headingPath } : {}),
    ...(quote ? { quote: truncate(quote, MAX_CHAT_QUOTE_CHARS) } : {}),
    comment: truncate(String(comment.comment).trim(), MAX_CHAT_COMMENT_CHARS)
  };
}

/** True when the comment points at the text the conversation is about. */
function attachedToTarget(comment, target) {
  if (!target || target.type === 'document') return true;
  if (comment.type === 'document') return false;

  const commentText = normalizeText(targetTextOf(comment));
  const targetText = normalizeText(targetTextOf(target));
  if (commentText && targetText && (targetText.includes(commentText) || commentText.includes(targetText))) return true;
  return coversSameSection(comment, target);
}

/** A section comment reaches everything under its heading, and the reverse. */
function coversSameSection(comment, target) {
  if (comment.type === 'section' && startsWith(headingPathOf(target), headingPathOf(comment))) return true;
  return target.type === 'section' && startsWith(headingPathOf(comment), headingPathOf(target));
}

function startsWith(headingPath, prefix) {
  return prefix.length > 0 && prefix.every((heading, index) => headingPath[index] === heading);
}

function headingPathOf(entry) {
  return Array.isArray(entry?.headingPath) ? entry.headingPath.filter(Boolean) : [];
}

function targetTextOf(entry) {
  return String(entry?.selectedText || entry?.targetText || entry?.heading || '');
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function revisionOf(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
