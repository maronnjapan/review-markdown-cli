import crypto from 'node:crypto';
import { MAX_AI_CONTEXT_CHARS } from './aiLimits.js';
import { hasPersonaContent, normalizePersona, personaBlock } from './persona.js';
import { readingContextBlock } from './prompts/readingContext.js';

/**
 * 「この文書をAIはどんな前提で読むべきか」を書き留めたものが読み取りコンテキストです。
 *
 * 対象読者、原稿の位置づけ、守りたい用語など、本文からは読み取れない前提を渡すと、
 * 翻訳・AIチャット・指摘の配置・AIレビューが同じ前提の上で動きます。
 *
 * コンテキストは3か所から集めます。
 *   - project : 設定ファイルの `aiContext`（`--ai-context` で上書きできる。全文書に効く）
 *   - document: レビューファイルへ保存した文書ごとのコンテキスト
 *   - persona : レビューファイルへ保存した読み手ペルソナ（`persona.js`）
 * どれも本文と同じくデータとして扱い、指示としては読ませません。
 *
 * このモジュールが持つのは「集めて検証する」ところまでです。モデルが読む文面そのものは
 * `prompts/readingContext.js` にあります。
 */

/** Trims one context string and refuses anything longer than a prompt can carry. */
export function normalizeAiContext(value, source = '読み取りコンテキスト') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${source} は文字列で指定してください: ${JSON.stringify(value)}`);
  const text = value.trim();
  if (text.length > MAX_AI_CONTEXT_CHARS) {
    throw new Error(`${source} が長すぎます（${MAX_AI_CONTEXT_CHARS}文字まで）`);
  }
  return text;
}

/**
 * Merges the three sources into the object every prompt builder takes.
 * `revision` changes whenever any of them changes, and stays empty while all are unset.
 */
export function resolveAiContext({ project, document, persona } = {}) {
  const context = {
    project: normalizeAiContext(project, 'aiContext'),
    document: normalizeAiContext(document, '読み取りコンテキスト'),
    persona: normalizePersona(persona)
  };
  return { ...context, revision: revisionOf(context) };
}

export function hasAiContext(context) {
  return Boolean(context?.project || context?.document || hasPersonaContent(context?.persona));
}

/** The context as the model reads it. Returns '' when the reviewer set none. */
export function aiContextBlock(context) {
  if (!hasAiContext(context)) return '';
  return readingContextBlock({
    project: context.project,
    document: context.document,
    persona: personaBlock(context.persona)
  });
}

/**
 * 前提が変わったかどうかは「モデルが読む文面が変わったか」で決めます。
 * ペルソナを同じ内容で組み直しただけなら、翻訳キャッシュも会話も据え置きです。
 */
function revisionOf(context) {
  if (!hasAiContext(context)) return '';
  return crypto.createHash('sha256').update(aiContextBlock(context)).digest('hex');
}
