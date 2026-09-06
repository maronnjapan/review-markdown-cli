/**
 * 生のMarkdownを書くための、文字列だけの操作です。
 *
 * どれも「置き換える範囲」と「置いたあとの選択範囲」を返すだけで、DOMには触りません。
 * 当てるのは呼ぶ側（`editor.js`）で、`execCommand('insertText')` を通すので、ブラウザの
 * 取り消し（Ctrl/⌘+Z）がそのまま効きます。編集履歴を自前で持たないための形です。
 *
 * @typedef {object} TextEdit
 * @property {number} start 置き換える範囲の始まり
 * @property {number} end 置き換える範囲の終わり
 * @property {string} insert そこへ入れる文字列
 * @property {number} selectionStart 置いたあとの選択の始まり
 * @property {number} selectionEnd 置いたあとの選択の終わり
 */

const BULLET_PATTERN = /^(\s*)([-*+])\s+/;
const ORDERED_PATTERN = /^(\s*)(\d+)([.)])\s+/;
const QUOTE_PATTERN = /^(\s*)>\s?/;
const HEADING_PATTERN = /^(\s*)(#{1,6})\s+/;
const TASK_PATTERN = /^\[([ xX])\]\s+/;
const INDENT = '  ';

/** 行頭の印を消したいときの並び。リストは箇条書きと番号付きをひとつの仲間として扱います。 */
const LIST_PATTERNS = [BULLET_PATTERN, ORDERED_PATTERN];

/**
 * `**太字**` のような、前後を同じ印ではさむ書き方の付け外し。
 *
 * すでに付いているかどうかは、印の連なりの長さがぴったり一致するかで見ます。`**太字**`
 * を選んで斜体を押したときに、太字の印を1つ削って壊してしまわないためです。
 *
 * @returns {TextEdit}
 */
export function toggleInlineMarker(text, start, end, marker) {
  const source = String(text);
  const width = marker.length;
  const char = marker[0];
  const trimmed = trimSelection(source, start, end);
  const inner = source.slice(trimmed.start, trimmed.end);

  if (inner.length > width * 2 && leadingRun(inner, char) === width && trailingRun(inner, char) === width) {
    const stripped = inner.slice(width, -width);
    return edit(trimmed.start, trimmed.end, stripped, trimmed.start, trimmed.start + stripped.length);
  }

  const before = trailingRun(source.slice(0, trimmed.start), char);
  const after = leadingRun(source.slice(trimmed.end), char);
  if (before === width && after === width && leadingRun(inner, char) === 0 && trailingRun(inner, char) === 0) {
    return edit(trimmed.start - width, trimmed.end + width, inner,
      trimmed.start - width, trimmed.start - width + inner.length);
  }

  return edit(trimmed.start, trimmed.end, `${marker}${inner}${marker}`,
    trimmed.start + width, trimmed.start + width + inner.length);
}

/**
 * `> `、`- `、`1. ` のような行頭の印の付け外し。選んだ範囲にかかる行すべてが対象です。
 *
 * かかった行がすべて同じ印を持っていれば外し、そうでなければ付けます。付けるときは、
 * 同じ仲間の印（箇条書きと番号付き）を先に外してから置き換えるので、`- ` の行で
 * 番号付きを押しても `- 1. ` にはなりません。番号は選んだ範囲の中で振り直します。
 *
 * @returns {TextEdit}
 */
export function toggleLinePrefix(text, start, end, prefix) {
  const source = String(text);
  const range = selectedLineRange(source, start, end);
  const lines = source.slice(range.start, range.end).split('\n');
  const kind = prefixKind(prefix);
  const written = lines.filter((line) => line.trim() !== '');
  const removing = written.length > 0 && written.every((line) => hasPrefix(line, kind));

  let ordinal = 0;
  const updated = lines.map((line) => {
    if (line.trim() === '') return line;
    const indent = line.match(/^\s*/)[0];
    const body = stripPrefix(line, kind);
    if (removing) return `${indent}${body}`;
    ordinal += 1;
    return `${indent}${kind === 'ordered' ? `${ordinal}. ` : prefix}${body}`;
  }).join('\n');

  return edit(range.start, range.end, updated, range.start, range.start + updated.length);
}

/**
 * 段落スタイルの選択欄が選ぶもの。`level` が0なら見出しを外して段落に戻します。
 *
 * 付け外しではなく指定です。「見出し2」を選んだ行が見出し3でも見出し2になります。
 *
 * @returns {TextEdit}
 */
export function setHeadingLevel(text, start, end, level) {
  const source = String(text);
  const range = selectedLineRange(source, start, end);
  const lines = source.slice(range.start, range.end).split('\n');
  const updated = lines.map((line) => {
    if (line.trim() === '') return line;
    const indent = line.match(/^\s*/)[0];
    const body = line.trimStart().replace(/^#{1,6}\s+/, '');
    return level > 0 ? `${indent}${'#'.repeat(level)} ${body}` : `${indent}${body}`;
  }).join('\n');

  return edit(range.start, range.end, updated, range.start, range.start + updated.length);
}

/**
 * 選んだ文字列をリンクにします。何も選んでいなければ、あとから書き足せる空の
 * `[](URL)` を置いて、括弧の中へカーソルを送ります。
 *
 * @returns {TextEdit}
 */
export function insertLink(text, start, end, url) {
  const source = String(text);
  const trimmed = trimSelection(source, start, end);
  const label = source.slice(trimmed.start, trimmed.end);
  const destination = String(url || '');
  const insert = `[${label}](${destination})`;
  const labelStart = trimmed.start + 1;
  return label
    ? edit(trimmed.start, trimmed.end, insert,
      labelStart + label.length + 2, labelStart + label.length + 2 + destination.length)
    : edit(trimmed.start, trimmed.end, insert, labelStart, labelStart);
}

/**
 * コードブロックの付け外し。中身にバッククォートが並んでいれば、それより長い柵にします。
 *
 * @returns {TextEdit}
 */
export function toggleCodeFence(text, start, end) {
  const source = String(text);
  const range = selectedLineRange(source, start, end);
  const lines = source.slice(range.start, range.end).split('\n');
  const opening = lines[0]?.match(/^\s*(`{3,}|~{3,})/);
  const closing = lines.length > 1 && /^\s*(`{3,}|~{3,})\s*$/.test(lines.at(-1));

  if (opening && closing) {
    const body = lines.slice(1, -1).join('\n');
    return edit(range.start, range.end, body, range.start, range.start + body.length);
  }

  const body = lines.join('\n');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  const insert = `${fence}\n${body}\n${fence}`;
  // 柵のうしろ、言語を書くところへカーソルを送ります。多くの場合そこが次に書く場所です。
  return edit(range.start, range.end, insert, range.start + fence.length, range.start + fence.length);
}

/**
 * Enterを押したときに、いま書いている箇条書き・番号付き・引用を次の行へ続けます。
 *
 * 印だけで中身のない行でEnterを押したときは続けず、1段浅くします。浅くできなければ
 * 印を消します。リストから抜ける道がEnterの押し直しだけで済むようにするためです。
 *
 * @returns {TextEdit|null} 続けるものが無ければ null（改行はブラウザに任せます）
 */
export function continueBlockOnEnter(text, start, end) {
  if (start !== end) return null;
  const source = String(text);
  const lineStart = lineStartAt(source, start);
  const line = source.slice(lineStart, start);

  const marker = listMarkerOf(line) || quoteMarkerOf(line);
  if (!marker) return null;

  if (marker.body.trim() === '') {
    const outdented = marker.indent.length >= INDENT.length
      ? `${marker.indent.slice(INDENT.length)}${marker.next}`
      : '';
    return edit(lineStart, start, outdented, lineStart + outdented.length, lineStart + outdented.length);
  }

  const insert = `\n${marker.indent}${marker.next}`;
  return edit(start, start, insert, start + insert.length, start + insert.length);
}

/**
 * Tab / Shift+Tab による、リスト項目の深さの上げ下げ。
 *
 * リストの行にいるとき（または複数行を選んでいるとき）だけ効かせます。それ以外で
 * Tabを奪うと、キーボードだけで使う人が編集欄から出られなくなるからです。
 *
 * @returns {TextEdit|null} 動かすものが無ければ null（Tabの本来の動きに任せます）
 */
export function shiftListIndent(text, start, end, { outdent = false } = {}) {
  const source = String(text);
  const range = selectedLineRange(source, start, end);
  const lines = source.slice(range.start, range.end).split('\n');
  const multiline = lines.length > 1;
  if (!multiline && !isListLine(lines[0])) return null;

  let removedFromFirst = 0;
  const updated = lines.map((line, index) => {
    if (!outdent) {
      if (line.trim() === '') return line;
      if (index === 0) removedFromFirst = -INDENT.length;
      return `${INDENT}${line}`;
    }
    const removed = line.match(/^(?: {1,2}|\t)/);
    if (index === 0) removedFromFirst = removed ? removed[0].length : 0;
    return removed ? line.slice(removed[0].length) : line;
  }).join('\n');

  if (updated === lines.join('\n')) return null;
  const shift = multiline ? 0 : -removedFromFirst;
  return multiline
    ? edit(range.start, range.end, updated, range.start, range.start + updated.length)
    : edit(range.start, range.end, updated,
      clamp(start + shift, range.start, range.start + updated.length),
      clamp(end + shift, range.start, range.start + updated.length));
}

/**
 * 貼り付けたものがURLで、置き換える先を選んでいるときは、その文字列をリンクにします。
 *
 * @returns {TextEdit|null} ふつうの貼り付けでよければ null
 */
export function linkifyPaste(text, start, end, pasted) {
  const value = String(pasted || '').trim();
  if (start === end || !/^(?:https?|mailto):\S+$/i.test(value) || /\s/.test(value)) return null;
  const selected = String(text).slice(start, end);
  if (/[\n\]]/.test(selected)) return null;
  return insertLink(text, start, end, value);
}

/** カーソルのある行の段落スタイル（`p` / `h1`〜`h6`）。書式の選択欄をそろえるために使います。 */
export function blockFormatAt(text, position) {
  const source = String(text);
  const line = source.slice(lineStartAt(source, position), lineEndAt(source, position));
  const heading = line.match(HEADING_PATTERN);
  return heading ? `h${heading[2].length}` : 'p';
}

/* ------------------------------------------------------------------ *
 * 行と印の見分け
 * ------------------------------------------------------------------ */

function listMarkerOf(line) {
  const bullet = line.match(BULLET_PATTERN);
  if (bullet) {
    const rest = line.slice(bullet[0].length);
    const task = rest.match(TASK_PATTERN);
    return {
      indent: bullet[1],
      body: task ? rest.slice(task[0].length) : rest,
      // やることの印は空のまま引き継ぎます。済んだ印まで続けると、書く前から済みになります。
      next: task ? `${bullet[2]} [ ] ` : `${bullet[2]} `
    };
  }
  const ordered = line.match(ORDERED_PATTERN);
  if (!ordered) return null;
  return {
    indent: ordered[1],
    body: line.slice(ordered[0].length),
    next: `${Number(ordered[2]) + 1}${ordered[3]} `
  };
}

function quoteMarkerOf(line) {
  const quote = line.match(QUOTE_PATTERN);
  return quote ? { indent: quote[1], body: line.slice(quote[0].length), next: '> ' } : null;
}

function isListLine(line) {
  return LIST_PATTERNS.some((pattern) => pattern.test(line));
}

function prefixKind(prefix) {
  if (ORDERED_PATTERN.test(prefix)) return 'ordered';
  if (QUOTE_PATTERN.test(prefix)) return 'quote';
  return 'bullet';
}

function hasPrefix(line, kind) {
  if (kind === 'quote') return QUOTE_PATTERN.test(line);
  if (kind === 'ordered') return ORDERED_PATTERN.test(line);
  return BULLET_PATTERN.test(line);
}

/** 同じ仲間の印を落とした残り。引用は引用だけ、リストは箇条書きと番号付きの両方を落とします。 */
function stripPrefix(line, kind) {
  const body = line.trimStart();
  return kind === 'quote' ? body.replace(/^>\s?/, '') : body.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
}

/* ------------------------------------------------------------------ *
 * 位置の計算
 * ------------------------------------------------------------------ */

function lineStartAt(text, index) {
  return text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
}

function lineEndAt(text, index) {
  const found = text.indexOf('\n', index);
  return found === -1 ? text.length : found;
}

/** 選んだ範囲がかかる行の全体。行頭で終わる選択は、その行を含めません。 */
function selectedLineRange(text, start, end) {
  const last = end > start && lineStartAt(text, end) === end ? end - 1 : end;
  return { start: lineStartAt(text, start), end: lineEndAt(text, last) };
}

/** 選択の端にある空白は印の外へ出します。「語 」を選んで押しても「**語** 」になるように。 */
function trimSelection(text, start, end) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text[from])) from += 1;
  while (to > from && /\s/.test(text[to - 1])) to -= 1;
  return from < to ? { start: from, end: to } : { start, end: start };
}

function leadingRun(text, char) {
  let count = 0;
  while (count < text.length && text[count] === char) count += 1;
  return count;
}

function trailingRun(text, char) {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === char) count += 1;
  return count;
}

function longestBacktickRun(text) {
  return Math.max(0, ...String(text).match(/`+/g)?.map((run) => run.length) || [0]);
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function edit(start, end, insert, selectionStart, selectionEnd) {
  return { start, end, insert, selectionStart, selectionEnd };
}
