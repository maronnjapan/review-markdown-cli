import crypto from 'node:crypto';
import { MAX_CONTEXT_NOTES, MAX_CONTEXT_NOTE_CHARS } from './aiLimits.js';
import { recordedNotesBlock } from './prompts/readingContext.js';

/**
 * コンテキストメモは、その文書について分かったことを1件ずつ残したものです。
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
 * ── 読むときは通し、書くときだけ断る ──────────────────────
 * 関数が2つあるのは、壊れた値の扱いを読み書きで変えているからです。
 * `readContextNotes` は保存済みの値を読むためのもので、何が入っていても投げません。
 * ここで投げると、レビューファイルを手で直した1文字で、その文書が画面から開けなくなります
 * （`readReview` は本文の表示にも通る道です）。`aiContext` を読むときに長さを見ていないのも
 * 同じ理由です。上限を守らせるのは、レビュアーが送ってきた値を受け取る側だけにします。
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
 * idの長さ。こちらが振るidは30文字ほどで、これは手で書かれた長いidを切るためだけの上限です。
 * idはモデルへ渡さないので、短くしても前提の量は変わりません。
 */
const ID_CHARS = 80;

/**
 * 保存済みのメモを読みます。何が入っていても投げません。
 *
 * 読めなかったものは落とします。落としたことを数えて伝えないのは、ここへ来るのが
 * 「この画面が書いたもの」か「人が手で直したもの」のどちらかで、後者はレビューファイルを
 * 開けば見えるからです。
 */
export function readContextNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.map(readContextNote).filter(Boolean);
}

/**
 * レビュアーが送ってきたメモを受け取ります。上限を超えていれば断ります。
 *
 * 超えた分を黙って捨てないのは、何件か落ちた状態でレビューを走らせると、レビュアーは
 * 残したはずの決定が効いていないことに気づけないからです。数えるのは落とす前です。
 * 本文の無いメモを先に落として数えると、その分だけ上限を超えた入力が通ってしまいます。
 */
export function normalizeContextNotes(value, source = 'コンテキストメモ') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${source} は配列で指定してください`);
  if (value.length > MAX_CONTEXT_NOTES) {
    throw new Error(`${source}は${MAX_CONTEXT_NOTES}件までです。古いものを消すか、まとめてください`);
  }
  for (const entry of value) assertBodyFits(entry?.body, source);
  return readContextNotes(value);
}

/** 本文の無いメモは、残す意味がないので落とします（null を返します）。 */
function readContextNote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (!body) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, ID_CHARS) : createContextNoteId(),
    kind: CONTEXT_NOTE_LABELS[value.kind] ? value.kind : DEFAULT_KIND,
    body,
    source: SOURCES.includes(value.source) ? value.source : 'reviewer',
    // 日時は補いません。無いものを読むたびに「今」で埋めると、日付をまたぐたびに
    // 前提が変わったことになり、翻訳と会話が理由もなくやり直しになります。
    // 新しいメモへ日時を付けるのは、コメントと同じく `reviewStore.js` の保存時です。
    ...(timestamp(value.createdAt) ? { createdAt: timestamp(value.createdAt) } : {}),
    ...(timestamp(value.updatedAt) ? { updatedAt: timestamp(value.updatedAt) } : {})
  };
}

/** メモ1件の本文。長すぎるものは、切り詰めずに断ります。 */
function assertBodyFits(value, source) {
  if (typeof value !== 'string') return;
  if (value.trim().length > MAX_CONTEXT_NOTE_CHARS) {
    throw new Error(`${source}が長すぎます（1件${MAX_CONTEXT_NOTE_CHARS}文字まで）`);
  }
}

export function hasContextNotes(notes) {
  return Array.isArray(notes) && notes.length > 0;
}

/** メモをモデルが読む形にしたもの。1件も無ければ '' を返します。 */
export function contextNotesBlock(notes) {
  if (!hasContextNotes(notes)) return '';
  return recordedNotesBlock(notes.map((note, index) => {
    // 日付だけにします。時刻まで渡しても読み方は変わらず、前提の文字数が増えるだけです。
    const recordedAt = String(note.updatedAt || note.createdAt || '').slice(0, 10);
    return {
      n: index + 1,
      kind: note.kind,
      note: note.body,
      ...(recordedAt ? { recordedAt } : {})
    };
  }));
}

export function createContextNoteId() {
  return `note-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function timestamp(value) {
  return typeof value === 'string' ? value.trim().slice(0, TIMESTAMP_CHARS) : '';
}
