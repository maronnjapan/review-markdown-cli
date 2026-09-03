import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeAiContext } from './aiContext.js';
import { SEVERITY_LABELS } from './aiVocabulary.js';
import {
  TASK_KIND_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_ORDER,
  TASK_STATUS_LABELS
} from './autoTaskVocabulary.js';
import { CONTEXT_NOTE_LABELS, normalizeContextNotes, readContextNotes } from './contextNotes.js';
import { BRIEF_FIELDS, normalizeDocumentBrief, readDocumentBrief } from './documentBrief.js';
import { PERSONA_FIELD_LABELS, normalizePersona } from './persona.js';
import { normalizeReferenceFiles, readReferenceFilePaths } from './referenceFiles.js';

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
      // 管理者の3点を持たないレビューファイルは、この機能より前に書かれたものです。
      // 未設定として読みます。
      brief: readDocumentBrief(parsed.brief),
      // メモを持たないレビューファイルは、この機能より前に書かれたものです。空の一覧として読みます。
      // 壊れた値でも投げません。ここで投げると、その文書は画面から開けなくなります。
      contextNotes: readContextNotes(parsed.contextNotes),
      persona: normalizePersona(parsed.persona),
      // 添えた参照ファイルも、壊れた値や同階層以下から外れたパスでは投げません。
      // 落とす理由はメモと同じで、レビューファイルの1行でその文書が開けなくなるのを避けるためです。
      referenceFiles: readReferenceFilePaths(parsed.referenceFiles, targetFile),
      updatedAt: parsed.updatedAt
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      targetFile, comments: [], aiContext: '', brief: null, contextNotes: [], persona: null, referenceFiles: []
    };
  }
}

/**
 * Replaces the comments of one review.
 *
 * 本文以外の5つ、読み取りコンテキスト（`aiContext`）・資料の管理者（`brief`）・
 * コンテキストメモ（`contextNotes`）・読み手ペルソナ（`persona`）・参照ファイル
 * （`referenceFiles`）は、渡さなければファイルにあるものを据え置きます。コメントだけを
 * 保存するとき（画面を離れるときのビーコンもそうです）に、書いた前提が黙って消えない
 * ようにするためです。
 */
export async function writeReview(
  rootDir,
  relativeFile,
  comments,
  { aiContext, brief, contextNotes, persona, referenceFiles } = {}
) {
  const requestedTargetFile = relativeFile.split(path.sep).join('/');
  const { filePath, targetFile } = await findExistingReviewLocation(rootDir, requestedTargetFile);
  // 1つでも省かれていれば、据え置く値を知るために現在の中身を読みます。
  // 条件を `a === undefined || b === undefined` と書き足していくと、項目が増えたときに
  // 足し忘れて、保存のたびに前提が消えるようになります。
  const saved = [aiContext, brief, contextNotes, persona, referenceFiles].some((value) => value === undefined)
    ? await readReview(rootDir, requestedTargetFile)
    : null;
  const nextAiContext = aiContext === undefined ? saved.aiContext : normalizeAiContext(aiContext);
  const nextBrief = brief === undefined ? saved.brief : normalizeDocumentBrief(brief);
  const nextNotes = contextNotes === undefined ? saved.contextNotes : normalizeContextNotes(contextNotes);
  const nextPersona = persona === undefined ? saved.persona : normalizePersona(persona);
  // 「同階層以下」を測る起点は `targetFile` ではなく、頼まれたパスのほうです。
  // レビューファイルが対象ディレクトリより上にあると `targetFile` はその上からの
  // パスになり（`docs/guide.md`）、画面が送ってくる対象ディレクトリからのパス
  // （`glossary.md`）を、隣にあるのに同階層の外だと断ってしまいます。
  // 読むとき（`readReview`）が見ているのも、同じく頼まれたパスです。
  const nextReferenceFiles = referenceFiles === undefined
    ? saved.referenceFiles
    : normalizeReferenceFiles(referenceFiles, requestedTargetFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    targetFile,
    updatedAt: new Date().toISOString(),
    ...(nextAiContext ? { aiContext: nextAiContext } : {}),
    ...(nextBrief ? { brief: nextBrief } : {}),
    ...(nextNotes.length ? { contextNotes: nextNotes.map(withNoteTimestamp) } : {}),
    ...(nextPersona ? { persona: nextPersona } : {}),
    ...(nextReferenceFiles.length ? { referenceFiles: nextReferenceFiles } : {}),
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

/**
 * 残した日時。読むときには補わないので、初めて保存するここで付けます。
 * コメントの `createdAt` と同じ扱いです。
 */
function withNoteTimestamp(note) {
  return { ...note, createdAt: note.createdAt || new Date().toISOString() };
}

function withCommentStatus(comment) {
  return {
    ...comment,
    // Reviews written before statuses were introduced are still actionable.
    status: comment?.status === 'resolved' ? 'resolved' : 'open'
  };
}

/**
 * コメントの種類ごとの見出しと書き出し方。ここが並び順そのものです。
 * 種類を足すときは、この表へ1行足すだけで済みます。
 */
const COMMENT_GROUPS = [
  { type: 'document', title: '文書全体へのコメント', render: renderDocumentComment },
  { type: 'text-selection', title: '範囲選択コメント', render: renderSelectionComment },
  { type: 'paragraph', title: '段落コメント', render: renderParagraphComment },
  { type: 'section', title: 'セクションコメント', render: renderSectionComment }
];

/** 表に無い種類のコメント。古いレビューファイルや、まだ知らない種類がここへ来ます。 */
const OTHER_GROUP = { title: 'その他のコメント', render: renderGenericComment };

export function buildReviewMarkdown(review) {
  const grouped = groupByType(Array.isArray(review.comments) ? review.comments : []);
  const pdfReview = /\.pdf$/i.test(review.targetFile || '');
  const statusLabels = pdfReview
    ? { open: '未確認', resolved: '確認済み' }
    : { open: '未解決', resolved: '解決済み' };

  const lines = [`# Review for ${review.targetFile}`, ''];
  if (pdfReview) {
    lines.push('> 対象PDFは読み取り専用です。コメントの対応はPDF外で行い、状態は確認状況を表します。', '');
  }
  appendDocumentBrief(lines, review.brief);
  // 効く範囲の広いほうから書きます。読む人は、この文書だけの前提が
  // 「ディレクトリ全体の前提に何を足したものか」として読めます。
  if (review.directoryAiContext) {
    lines.push('## 読み取りコンテキスト（ディレクトリ全体）', '', review.directoryAiContext, '');
  }
  if (review.aiContext) lines.push('## 読み取りコンテキスト', '', review.aiContext, '');
  appendContextNotes(lines, review.contextNotes);
  appendPersona(lines, review.persona);
  appendReferenceFiles(lines, review.referenceFiles);
  appendAutoTasks(lines, review.tasks);
  for (const group of [...COMMENT_GROUPS, OTHER_GROUP]) {
    appendCommentGroup(lines, group.title, grouped.get(group) || [], group.render, statusLabels);
  }
  return `${lines.join('\n').trim()}\n`;
}

/** コメントを1度だけ走査して、種類ごとに振り分けます。 */
function groupByType(comments) {
  const byType = new Map(COMMENT_GROUPS.map((group) => [group.type, group]));
  const grouped = new Map();
  for (const comment of comments) {
    const group = byType.get(comment.type) || OTHER_GROUP;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(comment);
  }
  return grouped;
}

/**
 * 資料の管理者が決めた3点。レビュー結果を渡す相手が最初に読むべきものなので、
 * 読み取りコンテキストより前に置きます。この資料が何を目指していたかを知らないまま
 * 指摘だけを読むと、直すべきかどうかを決められないからです。
 */
function appendDocumentBrief(lines, brief) {
  if (!brief) return;
  lines.push('## 資料の管理者', '');
  for (const { id, label } of BRIEF_FIELDS) {
    if (!brief[id]) continue;
    // 改行を含む欄は、2文字下げて同じ箇条書きの中に収めます。
    lines.push(...indentedListItem(`${label}: ${brief[id]}`));
  }
  lines.push('');
}

/**
 * 残したコンテキストメモ。レビュー結果を渡す相手には、指摘そのものと同じくらい
 * 「何が決まっていて、何がまだ決まっていないか」が要ります。
 * 種類と日付を添えるのは、画面で読むときと同じ手掛かりを紙の上でも残すためです。
 */
function appendContextNotes(lines, notes) {
  if (!notes?.length) return;
  lines.push('## コンテキストメモ', '');
  for (const note of notes) {
    const recordedAt = String(note.updatedAt || note.createdAt || '').slice(0, 10);
    const head = `${CONTEXT_NOTE_LABELS[note.kind] || note.kind}${recordedAt ? `（${recordedAt}）` : ''}`;
    // 改行を含むメモは、2文字下げて同じ箇条書きの中に収めます。
    // そのまま繋ぐと、2行目以降が箇条書きから外れて別の段落として読まれます。
    lines.push(...indentedListItem(`${head}: ${note.body}`));
  }
  lines.push('');
}

/** レビュー結果を渡す相手にも、どの読み手を基準に読んだかが要ります。 */
function appendPersona(lines, persona) {
  if (!persona) return;
  lines.push('## 読み手ペルソナ', '');
  // そのまま使うペルソナは、レビュアーが書いた文章そのものが読み手の説明です。
  if (persona.source === 'manual') {
    lines.push('レビュアーが書いた説明をそのまま使いました。', '', quoteBlock(persona.input), '');
    return;
  }
  if (persona.label) lines.push(`- 読み手: ${persona.label}`);
  if (persona.summary) lines.push(`- 要約: ${persona.summary}`);
  for (const [key, label] of Object.entries(PERSONA_FIELD_LABELS)) {
    const value = persona[key];
    if (Array.isArray(value) ? value.length : value) {
      lines.push(`- ${label}: ${Array.isArray(value) ? value.join(' / ') : value}`);
    }
  }
  if (persona.assumptions?.length) lines.push(`- AIが補った前提: ${persona.assumptions.join(' / ')}`);
  lines.push('');
}

/**
 * 添えた参照ファイル。中身ではなくパスだけを書き出します。
 *
 * レビュー結果を渡す相手には「この指摘は何を読んだうえでの指摘か」が要りますが、
 * 隣にあるファイルは相手も開けます。中身まで写すと、レビューMarkdownがリポジトリの
 * 写しになり、しかも写した時点で古くなります。
 */
function appendReferenceFiles(lines, referenceFiles) {
  if (!referenceFiles?.length) return;
  lines.push('## 参照ファイル', '');
  lines.push('この文書と一緒にAIへ読ませたファイルです。');
  lines.push('');
  for (const referenceFile of referenceFiles) lines.push(`- ${referenceFile}`);
  lines.push('');
}

/**
 * 自動タスクが起こしたタスクと、今すべきこと。渡す相手（人でもAIエージェントでも）が
 * 「何が残っているか」を、コメントを読む前に掴めるようにします。結果の本文は写しません。
 * 長いうえに、採るかどうかをまだレビュアーが決めていないものだからです。
 * 有効でないときは `tasks` が来ないので、この節ごと出ません。
 */
function appendAutoTasks(lines, tasks) {
  if (!tasks || (!tasks.focus && tasks.tasks.length === 0)) return;
  lines.push('## 自動タスク', '');
  if (tasks.focus) {
    lines.push(...indentedListItem(`今すべきこと: ${tasks.focus.now}${tasks.focus.reason ? `（${tasks.focus.reason}）` : ''}`), '');
  }
  const statusOrder = { ready: 0, open: 1, running: 2, done: 3, dismissed: 4 };
  const sorted = [...tasks.tasks].sort((a, b) => (
    (statusOrder[a.status] - statusOrder[b.status])
    || (TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority])
  ));
  for (const task of sorted) {
    const box = task.status === 'done' ? '[x]' : '[ ]';
    const head = `${TASK_STATUS_LABELS[task.status] || task.status}／${TASK_KIND_LABELS[task.kind] || task.kind}／${TASK_PRIORITY_LABELS[task.priority] || task.priority}`;
    // 2行目以降の字下げは indentedListItem に任せます。ここで下げると二重に下がります。
    const body = [
      `${box} ${task.title}（${head}${task.owner ? `／担当: ${task.owner}` : ''}）`,
      task.detail || '',
      task.quote ? `引用: ${task.quote}` : '',
      task.result?.summary ? `AIの結果: ${task.result.summary}` : ''
    ].filter(Boolean).join('\n');
    lines.push(...indentedListItem(body));
  }
  lines.push('');
}

function appendCommentGroup(lines, title, comments, renderer, statusLabels) {
  if (comments.length === 0) return;
  lines.push(`## ${title}`, '');
  comments.forEach((comment, index) => {
    lines.push(`### コメント${index + 1}`, '');
    lines.push(`状態: ${comment.status === 'resolved' ? statusLabels.resolved : statusLabels.open}`, '');
    lines.push(...renderReviewOrigin(comment));
    lines.push(...renderer(comment));
    lines.push('');
  });
}

/**
 * AIレビューから追加したコメントは、どのスキルがどの読み手として読んだ指摘かを添えます。
 * レビューされた部分そのものは、対象テキストとして各コメントの本体が書き出します。
 */
function renderReviewOrigin(comment) {
  if (!comment.review) return [];
  const { skillName, persona, severity, reason } = comment.review;
  const parts = [
    skillName ? `スキル: ${skillName}` : '',
    persona ? `読み手: ${persona}` : '',
    SEVERITY_LABELS[severity] ? `重大度: ${SEVERITY_LABELS[severity]}` : ''
  ].filter(Boolean);
  const lines = [];
  if (parts.length) lines.push(`AIレビュー: ${parts.join(' / ')}`, '');
  if (reason) lines.push(`判断理由: ${reason}`, '');
  return lines;
}

function renderDocumentComment(comment) {
  return [comment.comment || '(コメント本文なし)'];
}

function renderSelectionComment(comment) {
  const lines = [];
  if (comment.documentType === 'pdf' || comment.pageNumber) lines.push(`ページ: ${comment.pageNumber || '(不明)'}`, '');
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
  lines.push('コメント:', '', comment.comment || '(コメント本文なし)');
  return lines;
}

function renderGenericComment(comment) {
  return ['```json', JSON.stringify(comment, null, 2), '```'];
}

/** 1件の箇条書き。2行目以降は2文字下げて、同じ項目の続きとして読ませます。 */
function indentedListItem(text) {
  const [first, ...rest] = String(text).split('\n');
  return [`- ${first}`, ...rest.map((line) => `  ${line}`)];
}

function quoteBlock(text) {
  return String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
