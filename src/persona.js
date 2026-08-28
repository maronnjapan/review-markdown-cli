import { MAX_PERSONA_INPUT_CHARS } from './aiLimits.js';
import { PERSONA_SCHEMA, personaPrompt } from './prompts/persona.js';
import { composedReaderBlock, writtenReaderBlock } from './prompts/readingContext.js';

/**
 * 読み手ペルソナは「この原稿を誰が読むのか」を1人に決めたものです。
 *
 * 決め方は2通りあります。
 *   - AIで組み立てる（source: 'ai'）: 走り書きを AI が立場・前提知識・目的・気にする点へ
 *     組み直します。組み直した結果は必ず画面へ出すので、何を補ったか確認できます。
 *   - そのまま使う（source: 'manual'）: 書いた文章をそのまま読み手の説明として渡します。
 *     AI は呼びません。読み手が既に固まっている原稿では、組み直しは手間なだけだからです。
 *
 * どちらもレビューはその1人を基準に読みます。違いは「書いた文章を AI が整えるか」だけです。
 *
 * ペルソナは読み取りコンテキストの一部として、翻訳・AIチャット・指摘の配置にも渡します。
 * 「誰に向けた原稿か」は、レビュー以外の読み方も変えるからです。
 *
 * このモジュールが持つのは検証と正規化です。モデルへ渡す文面と組み立ての指示は
 * `prompts/readingContext.js` と `prompts/persona.js` にあります。
 */

export { MAX_PERSONA_INPUT_CHARS, PERSONA_SCHEMA, personaPrompt };

/** そのまま使うペルソナの呼び名は、書き出しから作ります。 */
const MANUAL_LABEL_CHARS = 24;
/**
 * 組み直した答えに掛ける上限。プロンプトは「5項目まで」と頼んでいますが、
 * わずかに超えた答えを捨てるより切り詰めて受け取るほうが、レビュアーの手数が減ります。
 */
const MAX_LIST_ITEMS = 8;
const MAX_ITEM_CHARS = 200;
const MAX_TEXT_CHARS = 400;
/** ISO 8601 の日時が収まる長さ。ここへ長い文字列を書かれても切り詰めるためだけの上限です。 */
const TIMESTAMP_CHARS = 40;

export const PERSONA_FIELD_LABELS = {
  background: '立場・経験',
  knowledge: '持っている前提知識',
  gaps: '持っていない知識',
  goals: 'この文書を読む目的',
  concerns: '気にする点・つまずく点'
};

/** レビュアーが書いた走り書き。長すぎるものは受け付けません。 */
export function normalizePersonaInput(value, source = '読み手ペルソナ') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${source} は文字列で入力してください`);
  const text = value.trim();
  if (text.length > MAX_PERSONA_INPUT_CHARS) {
    throw new Error(`${source} が長すぎます（${MAX_PERSONA_INPUT_CHARS}文字まで）`);
  }
  return text;
}

/**
 * 保存・送信されたペルソナを、こちらが扱う形へ揃えます。
 * 中身が何も残らなければ null を返し、「ペルソナ未設定」として扱います。
 */
export function normalizePersona(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value.source === 'manual' ? 'manual' : 'ai';
  const persona = {
    source,
    label: text(value.label),
    background: text(value.background),
    knowledge: list(value.knowledge),
    gaps: list(value.gaps),
    goals: list(value.goals),
    concerns: list(value.concerns),
    summary: text(value.summary),
    assumptions: list(value.assumptions),
    input: normalizePersonaInput(value.input),
    updatedAt: text(value.updatedAt, TIMESTAMP_CHARS)
  };
  // そのまま使うペルソナは走り書きが中身なので、呼び名だけ書き出しから補います。
  if (source === 'manual' && !persona.label) persona.label = manualLabel(persona.input);
  return hasPersonaContent(persona) ? persona : null;
}

export function hasPersonaContent(persona) {
  if (!persona) return false;
  // そのまま使うペルソナは、書かれた説明そのものが読み手の中身です。
  if (persona.source === 'manual') return Boolean(persona.input);
  return Boolean(
    persona.label || persona.background || persona.summary
    || persona.knowledge?.length || persona.gaps?.length
    || persona.goals?.length || persona.concerns?.length
  );
}

/** そのまま使うペルソナ。AIを呼ばないので、走り書きだけで組み立てられます。 */
export function buildManualPersona(input, now = new Date()) {
  const notes = normalizePersonaInput(input);
  if (!notes) throw new Error('読み手ペルソナの説明を入力してください');
  return { ...normalizePersona({ source: 'manual', input: notes }), updatedAt: now.toISOString() };
}

/** ペルソナをモデルが読む形にしたもの。未設定なら '' を返します。 */
export function personaBlock(persona) {
  if (!hasPersonaContent(persona)) return '';
  return persona.source === 'manual'
    ? writtenReaderBlock(persona.input)
    : composedReaderBlock(persona);
}

/** モデルの答えを保存できる形にします。走り書きは AI ではなく入力から持ちます。 */
export function buildPersona(answer, input, now = new Date()) {
  const persona = normalizePersona({ ...answer, input, source: 'ai' });
  if (!persona) throw new Error('読み手ペルソナを組み立てられませんでした');
  return { ...persona, updatedAt: now.toISOString() };
}

/** 走り書きの1行目。長い説明でも一覧やコメントに載る短い呼び名になります。 */
function manualLabel(input) {
  const firstLine = String(input || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const label = firstLine.trim();
  return label.length > MANUAL_LABEL_CHARS ? `${label.slice(0, MANUAL_LABEL_CHARS)}…` : label;
}

function text(value, limit = MAX_TEXT_CHARS) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => text(entry, MAX_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}
