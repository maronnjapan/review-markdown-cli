import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeAiContext } from './aiContext.js';

export const REVIEW_DIR = '.review';

export function normalizeRelativePath(rootDir, requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw Object.assign(new Error('path is required'), { statusCode: 400 });
  }

  const absolute = path.resolve(rootDir, requestedPath);
  const relative = path.relative(rootDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('path must stay inside target directory'), { statusCode: 400 });
  }
  return relative.split(path.sep).join('/');
}

export function reviewPathFor(rootDir, relativeFile) {
  return path.join(rootDir, REVIEW_DIR, `${relativeFile}.review.json`);
}

export function exportPathFor(rootDir, relativeFile) {
  return path.join(rootDir, REVIEW_DIR, `${relativeFile}.review.md`);
}

export async function readReview(rootDir, relativeFile) {
  const targetFile = relativeFile.split(path.sep).join('/');
  const { filePath } = await findExistingReviewLocation(rootDir, targetFile);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      targetFile,
      comments: Array.isArray(parsed.comments) ? parsed.comments.map(withCommentStatus) : [],
      aiContext: typeof parsed.aiContext === 'string' ? parsed.aiContext : '',
      updatedAt: parsed.updatedAt
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { targetFile, comments: [], aiContext: '' };
  }
}

/**
 * Replaces the comments of one review.
 *
 * `aiContext` is the reviewer's reading context for this document. Leaving it
 * out keeps whatever the file already holds, so a plain comment save (or the
 * beacon on the way out of the page) never drops it.
 */
export async function writeReview(rootDir, relativeFile, comments, { aiContext } = {}) {
  const requestedTargetFile = relativeFile.split(path.sep).join('/');
  const { filePath, targetFile } = await findExistingReviewLocation(rootDir, requestedTargetFile);
  const nextAiContext = aiContext === undefined
    ? (await readReview(rootDir, requestedTargetFile)).aiContext
    : normalizeAiContext(aiContext);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    targetFile,
    updatedAt: new Date().toISOString(),
    ...(nextAiContext ? { aiContext: nextAiContext } : {}),
    comments: comments.map((comment) => ({
      ...withCommentStatus(comment),
      id: comment.id || createCommentId(),
      createdAt: comment.createdAt || new Date().toISOString()
    }))
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export async function findExistingReviewPath(rootDir, relativeFile) {
  return (await findExistingReviewLocation(rootDir, relativeFile)).filePath;
}

async function findExistingReviewLocation(rootDir, relativeFile) {
  const primaryPath = reviewPathFor(rootDir, relativeFile);
  const absoluteTargetFile = path.resolve(rootDir, relativeFile);
  let currentDir = path.resolve(rootDir);

  while (true) {
    const currentRelativeFile = path.relative(currentDir, absoluteTargetFile).split(path.sep).join('/');
    if (!currentRelativeFile.startsWith('..') && !path.isAbsolute(currentRelativeFile)) {
      const candidatePath = reviewPathFor(currentDir, currentRelativeFile);
      if (await fileExists(candidatePath)) return { filePath: candidatePath, targetFile: currentRelativeFile };
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return { filePath: primaryPath, targetFile: relativeFile };
    currentDir = parentDir;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export function createCommentId() {
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function withCommentStatus(comment) {
  return {
    ...comment,
    // Reviews written before statuses were introduced are still actionable.
    status: comment?.status === 'resolved' ? 'resolved' : 'open'
  };
}

export function buildReviewMarkdown(review) {
  const comments = Array.isArray(review.comments) ? review.comments : [];
  const documentComments = comments.filter((comment) => comment.type === 'document');
  const selectionComments = comments.filter((comment) => comment.type === 'text-selection');
  const paragraphComments = comments.filter((comment) => comment.type === 'paragraph');
  const sectionComments = comments.filter((comment) => comment.type === 'section');
  const otherComments = comments.filter(
    (comment) => !['document', 'text-selection', 'paragraph', 'section'].includes(comment.type)
  );

  const lines = [`# Review for ${review.targetFile}`, ''];
  if (review.aiContext) lines.push('## 読み取りコンテキスト', '', review.aiContext, '');
  appendCommentGroup(lines, '文書全体へのコメント', documentComments, renderDocumentComment);
  appendCommentGroup(lines, '範囲選択コメント', selectionComments, renderSelectionComment);
  appendCommentGroup(lines, '段落コメント', paragraphComments, renderParagraphComment);
  appendCommentGroup(lines, 'セクションコメント', sectionComments, renderSectionComment);
  appendCommentGroup(lines, 'その他のコメント', otherComments, renderGenericComment);
  return `${lines.join('\n').trim()}\n`;
}

function appendCommentGroup(lines, title, comments, renderer) {
  if (comments.length === 0) return;
  lines.push(`## ${title}`, '');
  comments.forEach((comment, index) => {
    lines.push(`### コメント${index + 1}`, '');
    lines.push(`状態: ${comment.status === 'resolved' ? '解決済み' : '未解決'}`, '');
    lines.push(...renderer(comment));
    lines.push('');
  });
}

function renderDocumentComment(comment) {
  return [comment.comment || '(コメント本文なし)'];
}

function renderSelectionComment(comment) {
  const lines = [];
  if (comment.headingPath?.length) lines.push(`見出し階層: ${comment.headingPath.join(' > ')}`, '');
  lines.push('対象テキスト:', '', quoteBlock(comment.selectedText || '(選択テキストなし)'), '', 'コメント:', '', comment.comment || '(コメント本文なし)');
  if (comment.contextBefore || comment.contextAfter) {
    lines.push('', '文脈:', '', `- 前: ${comment.contextBefore || ''}`, `- 後: ${comment.contextAfter || ''}`);
  }
  return lines;
}

function renderParagraphComment(comment) {
  return [
    '対象段落:',
    '',
    quoteBlock(comment.selectedText || comment.targetText || '(対象段落なし)'),
    '',
    'コメント:',
    '',
    comment.comment || '(コメント本文なし)'
  ];
}

function renderSectionComment(comment) {
  const heading = comment.heading || comment.targetText || '(対象見出しなし)';
  const lines = [`対象見出し: ${heading}`, ''];
  if (comment.headingPath?.length) lines.push(`見出し階層: ${comment.headingPath.join(' > ')}`, '');
  lines.push(comment.comment || '(コメント本文なし)');
  return lines;
}

function renderGenericComment(comment) {
  return ['```json', JSON.stringify(comment, null, 2), '```'];
}

function quoteBlock(text) {
  return String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
