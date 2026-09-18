/**
 * ページの本文を、検索に載せる単位（Chunk）へ切ります。
 *
 * Context（`../chunking.js`）は段落と文の切れ目だけを見ますが、ページは見出しを持つ文書です。
 * 見出しをまたいで切ると、「認証」の節の末尾と「課金」の節の冒頭が1つのChunkになり、
 * 認証について聞いたのに課金の話が根拠として出てきます。だから先に見出しで節に分け、
 * 節の中だけを長さで切ります。
 *
 * ── 埋め込む文と、見せる文を分ける ─────────────────────
 * 埋め込むときは、ページの題名と見出しの経路を頭に付けます（`embedText`）。
 * 「有効期限は15分」という節の本文だけでは、何の有効期限か分からず、
 * 「トークンの有効期限は？」という質問に当たりません。題名「認証の設計」と見出し「トークン」を
 * 付けて埋め込むと当たるようになります。画面に出す抜粋（`text`）には付けません。
 * 本文に書いていない字が抜粋に混ざると、書いた本人が「そんなことは書いていない」と感じるからです。
 */

import { chunkContent } from '../chunking.js';

const HEADING_PATTERN = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_PATTERN = /^\s*(```|~~~)/;

/**
 * @param {object} page `{ title, content }`。
 * @returns {Array<{text: string, heading: string, embedText: string}>}
 *   本文も題名も空のときだけ空配列です。
 */
export function chunkPage({ title = '', content = '' } = {}) {
  const pageTitle = String(title || '').trim();
  const chunks = [];
  for (const section of splitSections(String(content || ''))) {
    const heading = section.headingPath.join(' › ');
    for (const text of chunkContent(section.text)) {
      chunks.push({ text, heading, embedText: embedTextFor(pageTitle, section.headingPath, text) });
    }
  }
  // 題名だけのページも、題名で引けるようにします。抜粋は空です。
  if (chunks.length === 0 && pageTitle) chunks.push({ text: '', heading: '', embedText: pageTitle });
  return chunks;
}

/**
 * 見出しごとの節に分けます。コードブロックの中の `#` は見出しではありません。
 * 本文の無い見出し（見出しの直後に次の見出しが来る）は、見出しの文字そのものを本文にします。
 * 章立てだけを書いたページも、章の名前で引けるようにするためです。
 *
 * @returns {Array<{headingPath: string[], text: string}>}
 */
export function splitSections(content) {
  const sections = [];
  let headingPath = [];
  let lines = [];
  let fence = null;

  const flush = () => {
    const text = lines.join('\n').trim();
    const fallback = headingPath.length ? headingPath[headingPath.length - 1] : '';
    if (text || fallback) sections.push({ headingPath: [...headingPath], text: text || fallback });
    lines = [];
  };

  for (const line of content.split('\n')) {
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1] === fence) fence = null;
      lines.push(line);
      continue;
    }
    const heading = fence ? null : line.match(HEADING_PATTERN);
    if (!heading) {
      lines.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    headingPath = [...headingPath.slice(0, level - 1), heading[2].trim()];
  }
  flush();
  return sections;
}

function embedTextFor(title, headingPath, text) {
  return [title, headingPath.join(' > '), text].filter(Boolean).join('\n');
}
