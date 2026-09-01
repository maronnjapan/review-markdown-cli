import crypto from 'node:crypto';
import { MAX_AI_CONTEXT_CHARS } from './aiLimits.js';
import { contextNotesBlock, hasContextNotes, readContextNotes } from './contextNotes.js';
import { documentBriefBlock, hasDocumentBrief, readDocumentBrief } from './documentBrief.js';
import { hasPersonaContent, normalizePersona, personaBlock } from './persona.js';
import { readingContextBlock } from './prompts/readingContext.js';
import { hasReferenceFiles, readReferenceEntries, referenceFilesBlock } from './referenceFiles.js';

/**
 * 「この文書をAIはどんな前提で読むべきか」を書き留めたものが読み取りコンテキストです。
 *
 * 対象読者、原稿の位置づけ、守りたい用語など、本文からは読み取れない前提を渡すと、
 * 翻訳・AIチャット・指摘の配置・AIレビューが同じ前提の上で動きます。
 *
 * コンテキストは6か所から集めます。
 *   - project : 設定ファイルの `aiContext`（`--ai-context` で上書きできる。全文書に効く）
 *   - document: レビューファイルへ保存した文書ごとのコンテキスト
 *   - brief   : 資料の管理者が決めた目的・ストーリー・期待値（`documentBrief.js`）
 *   - notes   : レビューファイルへ残したコンテキストメモ（`contextNotes.js`）
 *   - persona : レビューファイルへ保存した読み手ペルソナ（`persona.js`）
 *   - files   : 同階層以下から添えた参照ファイルの中身（`referenceFiles.js`）
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
 * Merges the six sources into the object every prompt builder takes.
 * `revision` changes whenever any of them changes, and stays empty while all are unset.
 *
 * `files` は読み終えた参照ファイルです。ここでファイルを開かないのは、この関数を
 * 同期のままにしておくためで、他の5つと同じく「保存済みの値を受け取って確かめる」
 * 形に揃えています。読むのは `aiService.readingContext()` です。
 */
export function resolveAiContext({ project, document, brief, notes, persona, files } = {}) {
  const context = {
    project: normalizeAiContext(project, 'aiContext'),
    document: normalizeAiContext(document, '読み取りコンテキスト'),
    // ここへ来るのは保存済みの値なので、上限では断りません（断るのは受け取る側）。
    brief: readDocumentBrief(brief),
    notes: readContextNotes(notes),
    persona: normalizePersona(persona),
    files: readReferenceEntries(files)
  };
  return { ...context, revision: revisionOf(context) };
}

export function hasAiContext(context) {
  return Boolean(
    context?.project || context?.document || hasDocumentBrief(context?.brief)
    || hasContextNotes(context?.notes) || hasPersonaContent(context?.persona)
    || hasReferenceFiles(context?.files)
  );
}

/** The context as the model reads it. Returns '' when the reviewer set none. */
export function aiContextBlock(context) {
  if (!hasAiContext(context)) return '';
  return readingContextBlock({
    project: context.project,
    document: context.document,
    brief: documentBriefBlock(context.brief),
    notes: contextNotesBlock(context.notes),
    persona: personaBlock(context.persona),
    files: referenceFilesBlock(context.files)
  });
}

/**
 * 前提が変わったかどうかは「モデルが読む文面が変わったか」で決めます。
 * ペルソナを同じ内容で組み直しただけなら、翻訳キャッシュも会話も据え置きです。
 * メモを1件足せば文面が変わるので、会話は次の質問からその前提を読み直します。
 *
 * 参照ファイルは中身そのものが文面に入るので、添えたファイルを書き換えただけでも
 * 前提が変わったことになります。用語集を直したあとの翻訳がやり直しになるのは、
 * 意図した動きです。古い訳語のまま残るほうが困ります。
 */
function revisionOf(context) {
  if (!hasAiContext(context)) return '';
  return crypto.createHash('sha256').update(aiContextBlock(context)).digest('hex');
}
