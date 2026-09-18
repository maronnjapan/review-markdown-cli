/**
 * Markdownを画面に描くところと、本文をブロック（段落の単位）に分けるところです。
 *
 * ── 依存を持たない小さな描き手 ───────────────────────────
 * ページはNotion風にブロックごとに編集します。編集中のブロック1つだけを入力欄にし、
 * ほかは描いたままにするので、描き手はブロック1つを速く描ければ足ります。
 * 対応するのは、見出し・段落・箇条書き（入れ子、ToDo）・番号付き・引用・コード・表・区切り線と、
 * 太字・斜体・打ち消し・コード・リンク・画像です。
 *
 * ── 出す前に必ずエスケープする ─────────────────────────
 * 本文はユーザーが書いたものですが、取り込んだファイルやAIが書いたページも混ざります。
 * `<script>` をそのまま描かないよう、先にエスケープしてから記法だけをタグに変えます。
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(\[([ xX])\]\s+)?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** コードやリンクを一時的に退避させる印。本文に現れない文字を使います。 */
const HOLD_OPEN = '';
const HOLD_CLOSE = '';

/**
 * 本文をブロックに分けます。空行が区切りで、コードブロックの中の空行は区切りにしません。
 * @param {string} text
 * @returns {string[]}
 */
export function splitBlocks(text) {
  const blocks = [];
  let current = [];
  let fence = null;
  for (const rawLine of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1] === fence) fence = null;
      current.push(line);
      continue;
    }
    if (fence) {
      current.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

/** ブロックを本文へ戻します。空のブロックは落とします。 */
export function joinBlocks(blocks) {
  const kept = blocks.map((block) => String(block ?? '').replace(/\s+$/, '')).filter((block) => block.trim());
  return kept.length ? `${kept.join('\n\n')}\n` : '';
}

/** ブロックの見た目の種類。編集中の入力欄の字の大きさなどを決めるのに使います。 */
export function blockKind(block) {
  const first = String(block || '').split('\n')[0] || '';
  if (FENCE.test(first)) return 'code';
  const heading = first.match(HEADING);
  if (heading) return `h${heading[1].length}`;
  if (/^\s*>/.test(first)) return 'quote';
  if (LIST_ITEM.test(first)) return 'list';
  if (HR.test(first)) return 'hr';
  if (first.includes('|')) return 'table';
  return 'p';
}

/** 本文全体を描きます。 */
export function renderMarkdown(text) {
  return splitBlocks(text).map(renderBlock).join('');
}

/** ブロック1つを描きます。 */
export function renderBlock(block) {
  const lines = String(block || '').split('\n');
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const language = line.slice(fenceMatch[0].length).trim().split(/\s+/)[0] || '';
      const code = [];
      index += 1;
      while (index < lines.length && !(lines[index].match(FENCE)?.[1] === fenceMatch[1])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      const languageClass = language ? ` class="language-${escapeAttribute(language)}"` : '';
      html.push(`<pre><code${languageClass}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level} id="${slug(heading[2])}">${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (HR.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quoted.join('\n')) || '<p></p>'}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(LIST_ITEM);
        if (item) {
          items.push({
            line: index,
            indent: item[1].replace(/\t/g, '  ').length,
            ordered: /\d/.test(item[2]),
            start: parseInt(item[2], 10) || 1,
            checked: item[3] ? item[4].toLowerCase() === 'x' : null,
            text: item[5]
          });
          index += 1;
        } else if (items.length && /^\s{2,}\S/.test(lines[index])) {
          // 字下げした続きの行は、前の項目の続きです。
          items[items.length - 1].text += `\n${lines[index].trim()}`;
          index += 1;
        } else {
          break;
        }
      }
      html.push(renderList(items));
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return left ? 'left' : '';
      });
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|')) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      const cellHtml = (tag, cells) => cells.map((cell, column) => {
        const align = aligns[column] ? ` style="text-align:${aligns[column]}"` : '';
        return `<${tag}${align}>${renderInline(cell)}</${tag}>`;
      }).join('');
      html.push(`<table><thead><tr>${cellHtml('th', header)}</tr></thead>`
        + `<tbody>${rows.map((row) => `<tr>${cellHtml('td', row)}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    // 段落。特別な行が来るまでを1つにまとめ、行の折り返しはそのまま改行にします。
    const paragraph = [];
    while (index < lines.length && !isSpecial(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
  }
  return html.join('');
}

function isSpecial(line) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line);
}

function renderList(items) {
  let position = 0;
  const build = (indent) => {
    const first = items[position];
    const ordered = first.ordered;
    const children = [];
    while (position < items.length && items[position].indent >= indent) {
      const item = items[position];
      if (item.indent > indent) {
        // 前の項目の下へ入れ子にします。
        const nested = build(item.indent);
        if (children.length) children[children.length - 1] += nested;
        else children.push(`<li>${nested}`);
        continue;
      }
      position += 1;
      const checkbox = item.checked === null
        ? ''
        : `<input type="checkbox" class="task-checkbox" data-line="${item.line}"${item.checked ? ' checked' : ''}> `;
      const text = item.text.split('\n').map(renderInline).join('<br>');
      const classes = item.checked === null ? '' : ` class="task-item${item.checked ? ' done' : ''}"`;
      children.push(`<li${classes}>${checkbox}${text}`);
    }
    const closed = children.map((child) => `${child}</li>`).join('');
    const tag = ordered ? 'ol' : 'ul';
    const start = ordered && first.start !== 1 ? ` start="${first.start}"` : '';
    const taskClass = items.some((item) => item.checked !== null && item.indent === indent) ? ' class="task-list"' : '';
    return `<${tag}${start}${taskClass}>${closed}</${tag}>`;
  };
  return build(items[0].indent);
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * 行の中の記法を描きます。先にエスケープし、コードとリンクは置き場所を確保してから
 * 太字などを当てます。リンクのURLの中の `_` が斜体にならないようにするためです。
 */
export function renderInline(text) {
  const held = [];
  const hold = (html) => {
    held.push(html);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };
  let value = escapeHtml(text);
  value = value.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  // URLは、括弧を1段だけ含めます（`https://ja.wikipedia.org/wiki/認証_(情報)` のような形のため）。
  value = value.replace(/!\[([^\]]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => (
    hold(`<img src="${safeUrl(src)}" alt="${alt}" loading="lazy">`)
  ));
  value = value.replace(/\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, href) => (
    hold(`<a href="${safeUrl(href)}"${linkTarget(href)}>${applyEmphasis(label)}</a>`)
  ));
  value = value.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_, before, url) => (
    `${before}${hold(`<a href="${safeUrl(url)}" target="_blank" rel="noopener">${url}</a>`)}`
  ));
  value = applyEmphasis(value);
  const restore = new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, 'g');
  return value.replace(restore, (_, index) => held[Number(index)]);
}

function applyEmphasis(value) {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
}

function linkTarget(href) {
  return /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener"' : '';
}

/** `javascript:` などのURLは描きません。 */
function safeUrl(url) {
  const value = String(url || '').trim();
  if (/^(https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return '#';
}

function slug(text) {
  return String(text || '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').slice(0, 80);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/[^\w-]/g, '');
}
