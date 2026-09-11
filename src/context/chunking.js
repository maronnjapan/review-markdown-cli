/**
 * Contextの本文を、検索に載せる単位（Chunk）へ切ります。
 *
 * ContextとVectorは同じものではありません（仕様5.4）。Contextは「ユーザーが残した判断」
 * 1件で、Chunkはそれを引くための索引です。1件が長いと、後ろのほうに書いた条件が
 * ベクトルの中で薄まって引けなくなるので、切ってから索引にします。
 *
 * 切れ目は段落、次に文の終わりを選びます。文の途中で切ると、切れた側の断片が
 * それだけで検索に当たり、ユーザーには「そんなことは書いていない」ものがヒットして
 * 見えます。どうしても収まらないときだけ、長さで切ります。
 *
 * 前後を少し重ねるのは、切れ目をまたいだ言い回し（「〜については、次のように決めた」）が
 * どちらのChunkからも引けるようにするためです。
 *
 * 検索結果はChunkではなくContext単位で返します（`scope.js` の `rankContexts`）。
 * ここで切った単位が、そのままユーザーの目に触れることはありません。
 */

/** 1Chunkの目安。日本語で2〜3段落ぶんです。 */
export const CHUNK_CHARS = 400;

/** 前のChunkから重ねる長さ。切れ目をまたいだ言い回しを、両側から引けるようにします。 */
export const CHUNK_OVERLAP_CHARS = 80;

/** これ以下なら切りません。切っても索引が増えるだけで、引けるものは変わりません。 */
const MIN_SPLIT_CHARS = CHUNK_CHARS + CHUNK_OVERLAP_CHARS;

/**
 * @param {string} content Contextの本文。
 * @returns {string[]} 1件以上のChunk。本文が空のときだけ空配列です。
 */
export function chunkContent(content, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP_CHARS } = {}) {
  const text = String(content || '').trim();
  if (!text) return [];
  if (text.length <= MIN_SPLIT_CHARS) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    const cut = end >= text.length ? text.length : breakPoint(text, start, end);
    const chunk = text.slice(start, cut).trim();
    if (chunk) chunks.push(chunk);
    if (cut >= text.length) break;
    // 重なりぶん戻します。戻しすぎて進まなくなることはありません（overlap < size）。
    start = Math.max(cut - overlap, start + 1);
  }
  return chunks;
}

/**
 * `end` の手前で、いちばん後ろにある切れ目を探します。
 * 段落 → 文の終わり → 諦めて長さで切る、の順です。
 */
function breakPoint(text, start, end) {
  const window = text.slice(start, end);
  // 切れ目は後ろから探します。前から探すと、最初の段落だけの短いChunkが並びます。
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > window.length / 2) return start + paragraph + 2;
  const sentence = lastSentenceEnd(window);
  if (sentence > window.length / 2) return start + sentence;
  return end;
}

/** 文の終わり。日本語の句点と、英文のピリオドの両方を見ます。 */
function lastSentenceEnd(window) {
  let last = -1;
  for (let index = 0; index < window.length; index += 1) {
    const character = window[index];
    if (character === '。' || character === '\n') last = index + 1;
    // 英文のピリオドは、後ろが空白のときだけ文末と見なします（`v1.2` で切らないため）。
    if ((character === '.' || character === '!' || character === '?') && /\s/.test(window[index + 1] || ' ')) {
      last = index + 1;
    }
  }
  return last;
}
