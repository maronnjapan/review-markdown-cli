import crypto from 'node:crypto';
import { load } from 'cheerio';
import { aiContextBlock } from './aiContext.js';
import {
  MAX_DOCUMENT_EDITS,
  MAX_EDIT_BLOCKS,
  MAX_EDIT_BLOCK_CHARS,
  MAX_EDIT_MARKDOWN_CHARS
} from './aiLimits.js';
import { DEFAULT_CONFIDENCE, isConfidence } from './aiVocabulary.js';
import { parseMarkdownBlocks, renderMarkdown } from './markdown.js';
import { REVISE_SCHEMA, revisePrompt as buildRevisePrompt, revisionRequestsBlock } from './prompts/revise.js';

/**
 * AIが作る「本文の修正案」の、材料集めと答えの検証です。
 *
 * このアプリでAIが本文へ届くのは、この道だけです。それでも書き込みはここでは起きません。
 * ここが返すのは候補で、レビュアーが承認した候補だけが `/api/file` を通って
 * ファイルへ入ります（適用そのものは編集モードと同じ `editorMarkdown.js` の道です）。
 * Codexは読み取り専用のまま、ファイルにも触れません。
 *
 * ── 指摘の配置と違うところ ──────────────────────────────────
 * `commentPlacement.js` はレンダリング後のブロックを渡します。あちらの答えは「どこに
 * コメントを付けるか」なので、ブラウザが探し直せる文字列であれば足ります。
 * こちらの答えは本文そのものになるので、Markdownの原文と、その原文がファイルの
 * どこからどこまでかを持ちます。範囲は編集モードが使っているのと同じ
 * `parseMarkdownBlocks` のものです。
 *
 * ── 版（revision）を一緒に返す理由 ──────────────────────────
 * 候補が持つのはファイル内の位置です。候補を作ってから適用するまでの間に本文が変われば、
 * その位置はもう別の場所を指します。作ったときの本文のハッシュを一緒に返し、適用のときに
 * 突き合わせて、違っていれば断ります（`routes.js` の `assertBaseRevision`）。
 *
 * モデルが読む文面と答えの形は `prompts/revise.js` にあります。
 */

export { REVISE_SCHEMA };

/** 本文の版。「候補を作ったときの本文か」を適用の直前に確かめるための値です。 */
export function documentRevision(markdown) {
  return crypto.createHash('sha256').update(String(markdown)).digest('hex');
}

/**
 * 本文を、書き換えの単位へ切ります。1つが1つの見出し・段落・リスト・表・コードブロックで、
 * `start`/`end` はその原文がファイルのどこにあるかです。
 *
 * 長い文書では先頭から `MAX_EDIT_BLOCKS` 個までにします。渡さなかったブロックは
 * 書き換えられないので、件数を `dropped` として返し、画面がそう言えるようにします。
 */
export function extractEditableBlocks(markdown) {
  const parsed = parseMarkdownBlocks(markdown);
  const headingPath = [];
  const blocks = [];

  for (const block of parsed.slice(0, MAX_EDIT_BLOCKS)) {
    if (block.kind === 'heading') {
      const heading = /^(#{1,6})\s+(.*)$/.exec(block.source.trim());
      const level = heading ? heading[1].length : 1;
      headingPath[level - 1] = heading ? heading[2].trim() : block.source.trim();
      headingPath.length = level;
    }
    blocks.push({
      index: blocks.length,
      blockId: block.id,
      kind: block.kind,
      start: block.start,
      end: block.end,
      markdown: block.source,
      // 見出し自身の階層には、その見出しを含めます（指摘の配置と同じ数え方です）。
      headingPath: headingPath.filter(Boolean)
    });
  }

  return { blocks, dropped: Math.max(0, parsed.length - blocks.length) };
}

export function revisePrompt(blocks, { instruction, comments, readingContext }) {
  return buildRevisePrompt({
    blocksJson: JSON.stringify(promptBlocks(blocks)),
    instruction,
    commentsBlock: comments?.entries?.length ? revisionRequestsBlock(comments) : '',
    readingContextBlock: aiContextBlock(readingContext)
  });
}

/**
 * ブロックをプロンプトへ載せる形にします。渡すのは原文そのものです。書き換えた結果が
 * そのまま本文になるので、表示用に整えたものを見せるわけにはいきません。
 *
 * 長すぎるブロックだけは切って渡し、切ったことを `truncated` で伝えます。プロンプトが
 * 「truncated のブロックは書き換えるな」と言っているので、見せていない残りが消えることは
 * ありません。念のため、受け取る側（`buildEditProposals`）でも同じブロックへの
 * 書き換えを断ります。
 */
export function promptBlocks(blocks) {
  return blocks.map((block) => {
    const truncated = block.markdown.length > MAX_EDIT_BLOCK_CHARS;
    return {
      i: block.index,
      kind: block.kind,
      ...(block.headingPath.length ? { headingPath: block.headingPath } : {}),
      markdown: truncated ? `${block.markdown.slice(0, MAX_EDIT_BLOCK_CHARS)}…` : block.markdown,
      ...(truncated ? { truncated: true } : {})
    };
  });
}

/**
 * モデルの答えを、渡したブロックと突き合わせて候補にします。
 *
 * 落としたものは黙って捨てず、`skipped` へ理由付きで回します。適用する側は
 * 「AIが直さなかった」と「アプリが受け取らなかった」を区別できないと、直ったつもりで
 * 直っていない箇所に気づけないからです。唯一そのまま捨てるのは、原文と同じ文字列が
 * 返ってきたときだけです。それは変更ではないので、見せるものがありません。
 */
export async function buildEditProposals(blocks, answer) {
  const proposed = list(answer?.edits);
  const skipped = list(answer?.skipped)
    .map((entry) => ({
      request: String(entry?.request || '').trim(),
      reason: String(entry?.reason || '').trim()
    }))
    .filter((entry) => entry.request);

  const accepted = [];
  const rewritten = new Set();

  for (const candidate of proposed) {
    const block = blocks[candidate?.blockIndex];
    const reason = String(candidate?.reason || '').trim();
    const refuse = (why) => skipped.push({ request: reason || '（理由の書かれていない修正案）', reason: why });

    if (!block) {
      refuse('書き換える箇所を特定できませんでした');
      continue;
    }
    if (block.markdown.length > MAX_EDIT_BLOCK_CHARS) {
      refuse('この箇所は長いため、AIへは途中までしか渡していません。手で直してください');
      continue;
    }
    if (rewritten.has(block.index)) {
      refuse('同じ箇所に複数の修正案が出たため、最初の1件だけを残しました');
      continue;
    }

    const after = replacementOf(candidate?.markdown);
    if (after.length > MAX_EDIT_MARKDOWN_CHARS) {
      refuse(`修正案が長すぎます（1件${MAX_EDIT_MARKDOWN_CHARS}文字まで）`);
      continue;
    }
    // 原文と同じものは変更ではありません。見せても、適用しても何も起きません。
    if (after === block.markdown) continue;

    rewritten.add(block.index);
    accepted.push({
      blockId: block.blockId,
      blockIndex: block.index,
      kind: block.kind,
      headingPath: block.headingPath,
      start: block.start,
      end: block.end,
      before: block.markdown,
      after,
      delete: after === '',
      reason,
      confidence: isConfidence(candidate?.confidence) ? candidate.confidence : DEFAULT_CONFIDENCE,
      target: await revealTarget(block)
    });
  }

  return {
    summary: String(answer?.summary || '').trim(),
    // 適用の順に並べます。上から読んだ順が本文の順と同じでないと、見比べる相手を探し直すことになります。
    edits: accepted.sort((a, b) => a.start - b.start).slice(0, MAX_DOCUMENT_EDITS),
    skipped,
    droppedEdits: Math.max(0, accepted.length - MAX_DOCUMENT_EDITS)
  };
}

/**
 * 適用する前に本文のどこかを見せるための対象です。持つのはレンダリング後の文字列で、
 * 画面はこれを本文から探し直します（`public/js/textAnchor.js`）。Markdownの原文のままでは
 * 記法の分だけ表示と食い違うので、そのブロックだけをもう一度レンダリングして取ります。
 */
async function revealTarget(block) {
  const text = load(await renderMarkdown(block.markdown), null, false).text().replace(/\s+/g, ' ').trim();
  return {
    type: block.kind === 'heading' ? 'section' : 'paragraph',
    selectedText: text,
    targetText: text,
    headingPath: block.headingPath,
    ...(block.kind === 'heading' ? { heading: text } : {})
  };
}

/**
 * 置き換える原文。前後の改行だけを落とします。範囲の端に改行を足すと、ブロックの間に
 * 空行が増えたり減ったりして、頼んでいない差分がファイルに残るからです。
 * 行頭の空白は落としません。字下げされたコードでは、それ自体が本文だからです。
 */
function replacementOf(value) {
  return String(value ?? '').replace(/^[\r\n]+/, '').replace(/\s+$/, '');
}

function list(value) {
  return Array.isArray(value) ? value : [];
}
