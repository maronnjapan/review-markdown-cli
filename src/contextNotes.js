import crypto from 'node:crypto';
import { MAX_CONTEXT_NOTES, MAX_CONTEXT_NOTE_CHARS } from './aiLimits.js';
import { recordedNotesBlock } from './prompts/readingContext.js';

/**
 * コンテキストメモは、その資料について分かったことを1件ずつ残したものです。
 *
 * 読み取りコンテキスト（`aiContext.js` の `document`）との違いは、書き換えるものか、
 * 積み上げるものかです。読み取りコンテキストは「この文書はこう読む」を1枚に整えたもので、
 * 気が変わるたびに書き直します。メモは「このとき、こう分かった」を足していくもので、
 * 消すまで残ります。相談していて気づいたことを書き留めるのに、1枚の前提を毎回
 * 開いて継ぎ足すのは向きません。
 *
 * どちらも同じ「前提」としてモデルへ渡します。翻訳・AIチャット・指摘の配置・AIレビューの
 * すべてが、本文より先にこれを読みます。
 *
 * ── 種類を持たせている理由 ────────────────────────────────
 * 4つの種類は、飾りではなく読み方の指示です。「決定」と書かれたメモは、レビューで
 * もう一度指摘してほしくないことで、「制約」は逆に、破っていたら指摘してほしいことです。
 * 種類のない自由文に混ぜると、モデルはどちらのつもりで書かれたのかを推測するしかありません。
 * 種類ごとに何が変わるかは `prompts/readingContext.js` の `recordedNotesBlock` にあります。
 *
 * このモジュールが持つのは検証と正規化だけです。モデルが読む文面はプロンプト側にあります。
 */

/**
 * メモの種類。`id` がレビューファイルに入る値で、`label` が画面とレビューMarkdownに出る日本語です。
 *
 * 画面側（public/js/contextNotes.js）にも同じ表がもう一組あります。ビルドを持たない構成では
 * `src/` を `public/` から import できないためで、`aiVocabulary.js` と同じ事情です。
 * 片方を変えたらもう片方も、という関係だけを覚えておいてください。
 */
export const CONTEXT_NOTE_KINDS = Object.freeze([
  Object.freeze({ id: 'background', label: '背景' }),
  Object.freeze({ id: 'decision', label: '決定' }),
  Object.freeze({ id: 'constraint', label: '制約' }),
  Object.freeze({ id: 'question', label: '未決' })
]);

export const CONTEXT_NOTE_LABELS = Object.freeze(
  Object.fromEntries(CONTEXT_NOTE_KINDS.map(({ id, label }) => [id, label]))
);

/** 種類の分からないメモの行き先。捨てるより、背景として読ませるほうが失うものが少ないからです。 */
const DEFAULT_KIND = 'background';

/** メモの出どころ。相談から残したものは、レビュアーが自分で書いたものと区別して見せます。 */
const SOURCES = Object.freeze(['reviewer', 'chat']);

/** ISO 8601 の日時が収まる長さ。長い文字列を書かれても切り詰めるためだけの上限です。 */
const TIMESTAMP_CHARS = 40;

/**
 * 保存・送信されたメモの配列を、こちらが扱う形へ揃えます。
 *
 * 上限を超えた分を黙って捨てず、投げます。捨ててしまうと、レビュアーは残したはずの
 * 決定が渡っていないことに気づけないまま、その決定を無視したレビューを読むことになります。
 */
export function normalizeContextNotes(value, source = 'コンテキストメモ') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${source} は配列で指定してください`);
  const notes = value.map((entry) => normalizeContextNote(entry, source)).filter(Boolean);
  if (notes.length > MAX_CONTEXT_NOTES) {
    throw new Error(`${source}は${MAX_CONTEXT_NOTES}件までです。古いものを消すか、まとめてください`);
  }
  return notes;
}

/** 本文の無いメモは、残す意味がないので落とします（null を返します）。 */
function normalizeContextNote(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = normalizeContextNoteBody(value.body, source);
  if (!body) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 80) : createContextNoteId(),
    kind: CONTEXT_NOTE_LABELS[value.kind] ? value.kind : DEFAULT_KIND,
    body,
    source: SOURCES.includes(value.source) ? value.source : 'reviewer',
    createdAt: timestamp(value.createdAt) || new Date().toISOString(),
    ...(timestamp(value.updatedAt) ? { updatedAt: timestamp(value.updatedAt) } : {})
  };
}

/** メモ1件の本文。長すぎるものは、切り詰めずに断ります。 */
export function normalizeContextNoteBody(value, source = 'コンテキストメモ') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${source} の本文は文字列で指定してください`);
  const body = value.trim();
  if (body.length > MAX_CONTEXT_NOTE_CHARS) {
    throw new Error(`${source}が長すぎます（1件${MAX_CONTEXT_NOTE_CHARS}文字まで）`);
  }
  return body;
}

export function hasContextNotes(notes) {
  return Array.isArray(notes) && notes.length > 0;
}

/** メモをモデルが読む形にしたもの。1件も無ければ '' を返します。 */
export function contextNotesBlock(notes) {
  if (!hasContextNotes(notes)) return '';
  return recordedNotesBlock(notes.map((note, index) => ({
    n: index + 1,
    kind: note.kind,
    note: note.body,
    // 日付だけにします。時刻まで渡しても読み方は変わらず、前提の文字数が増えるだけです。
    recordedAt: String(note.updatedAt || note.createdAt).slice(0, 10)
  })));
}

export function createContextNoteId() {
  return `note-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function timestamp(value) {
  return typeof value === 'string' ? value.trim().slice(0, TIMESTAMP_CHARS) : '';
}
