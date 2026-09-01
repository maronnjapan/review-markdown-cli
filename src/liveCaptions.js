/**
 * Google Meetの字幕拡張機能（meet-captions-memo）から届いた1行を、レビュー対象
 * ディレクトリ内のMarkdownファイルへ追記します。
 *
 * 呼び出し元（`src/routes.js`）が既にパスをレビュー対象ディレクトリの内側へ
 * 正規化しているので、ここではファイルの作成と追記だけを扱います。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_SPEAKER_LENGTH = 200;
const MAX_TEXT_LENGTH = 4000;
const MAX_TIME_LENGTH = 32;
const MAX_META_LENGTH = 200;

/**
 * 直前に書いた1行を絶対パスごとに覚えておき、拡張機能が再送してきた同じ発言を
 * 重ねて書き込まないためのものです。プロセスを跨いでは持たず、サーバー起動中だけ効きます。
 */
const lastEntryByFile = new Map();

export function normalizeCaptionEntry(body = {}) {
  const speaker = trimTo(body.speaker, MAX_SPEAKER_LENGTH);
  const text = trimTo(body.text, MAX_TEXT_LENGTH);
  if (!speaker || !text) {
    throw Object.assign(new Error('speaker and text are required'), { statusCode: 400 });
  }
  return {
    speaker,
    text,
    time: trimTo(body.time, MAX_TIME_LENGTH) || nowTimeLabel(),
    title: trimTo(body.title, MAX_META_LENGTH),
    meetingCode: trimTo(body.meetingCode, MAX_META_LENGTH),
    startedAt: trimTo(body.startedAt, MAX_META_LENGTH)
  };
}

/**
 * @param {string} rootDir レビュー対象ディレクトリの絶対パス。
 * @param {string} relativeFile `normalizeRelativePath` を通した、rootDir内のMarkdownパス。
 * @param {ReturnType<typeof normalizeCaptionEntry>} entry
 */
export async function appendCaptionEntry(rootDir, relativeFile, entry) {
  const filePath = path.join(rootDir, relativeFile);
  const last = lastEntryByFile.get(filePath);
  if (last && last.speaker === entry.speaker && last.text === entry.text) {
    return { path: relativeFile, created: false, skipped: true };
  }
  lastEntryByFile.set(filePath, { speaker: entry.speaker, text: entry.text });

  const created = !(await fileExists(filePath));
  if (created) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, documentHeader(entry), 'utf8');
  }
  await fs.appendFile(filePath, formatCaptionLine(entry), 'utf8');
  return { path: relativeFile, created, skipped: false };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatCaptionLine({ speaker, text, time }) {
  return `**${speaker}** \`[${time}]\`\n${text}\n\n`;
}

function documentHeader({ title, meetingCode, startedAt }) {
  const heading = title || meetingCode || '会議メモ';
  const lines = [`# ${heading}`, ''];
  if (meetingCode) lines.push(`- 会議コード: ${meetingCode}`);
  if (startedAt) lines.push(`- 開始: ${startedAt}`);
  lines.push('', '---', '');
  return `${lines.join('\n')}\n`;
}

function trimTo(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function nowTimeLabel() {
  return new Date().toLocaleTimeString('ja-JP', { hour12: false });
}
