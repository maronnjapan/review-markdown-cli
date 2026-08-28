import { load } from 'cheerio';
import markdownToHtml from 'zenn-markdown-html';
import { decodeMarkdownPath } from './urlPath.js';

export async function renderMarkdown(markdown, options = {}) {
  if (options.editableBlocks) {
    const blocks = parseMarkdownBlocks(markdown);
    const renderedBlocks = await Promise.all(blocks.map(async (block) => {
      const content = await renderMarkdownFragment(block.source, {
        ...options,
        editorSourceAttrs: true
      });
      return `<div class="markdown-block" data-block-id="${block.id}" data-block-kind="${block.kind}" data-source-start="${block.start}" data-source-end="${block.end}">${content}</div>`;
    }));
    return renderedBlocks.join('\n');
  }

  return renderMarkdownFragment(markdown, options);
}

/**
 * ブロックの種類と、その終わりの見つけ方の表です。上から順に当てて、最初に一致した
 * ものをそのブロックの種類にします。どれにも当たらなければ段落です。
 *
 * 1つの表にしてあるのは、以前は「ブロックの始まりを見分ける判定」が2か所にあり、
 * 片方だけ直すと段落が次のブロックを飲み込んだからです。いまは `startsNewBlock` も
 * この表を読むので、ずれようがありません。
 */
const BLOCK_KINDS = [
  {
    match: matchFence,
    // Mermaidは描画のしかたが違うので、コードブロックと分けて数えます。
    kindOf: (fence) => (fence.language === 'mermaid' ? 'mermaid' : 'code'),
    scan: (lines, index, fence) => scanUntil(lines, index, (line) => matchesClosingFence(line, fence))
  },
  {
    match: isZennContainerStart,
    kindOf: () => 'container',
    scan: (lines, index) => scanUntil(lines, index, isZennContainerEnd)
  },
  { match: isHeading, kindOf: () => 'heading', scan: scanOneLine },
  { match: isTableRow, kindOf: () => 'table', scan: scanWhile(isTableRow) },
  { match: isBlockquote, kindOf: () => 'blockquote', scan: scanWhile(isBlockquote) },
  { match: isListItem, kindOf: () => 'list', scan: scanWhile(isListItem) },
  { match: isThematicBreak, kindOf: () => 'thematic-break', scan: scanOneLine }
];

export function parseMarkdownBlocks(markdown) {
  const source = String(markdown);
  const lines = splitSourceLines(source);
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index].text.trim() === '') {
      index += 1;
      continue;
    }

    const startIndex = index;
    const firstLine = lines[index].text;
    const entry = BLOCK_KINDS.map((kind) => ({ kind, matched: kind.match(firstLine) }))
      .find(({ matched }) => matched);
    // 表のどれにも当たらない行は段落です。次のブロックが始まるところまでが本文になります。
    const [kind, end] = entry
      ? [entry.kind.kindOf(entry.matched), entry.kind.scan(lines, index, entry.matched)]
      : ['paragraph', scanUntilNewBlock(lines, index)];
    index = end;

    const first = lines[startIndex];
    const last = lines[index - 1];
    blocks.push({
      id: `block-${blocks.length}`,
      kind,
      start: first.start,
      end: last.contentEnd,
      source: source.slice(first.start, last.contentEnd)
    });
  }

  return blocks;
}

/** 閉じる行までを含めます。閉じないまま終わっても、そこまでを1つのブロックにします。 */
function scanUntil(lines, index, isClosing) {
  let next = index + 1;
  while (next < lines.length) {
    const closing = isClosing(lines[next].text);
    next += 1;
    if (closing) break;
  }
  return next;
}

/** 同じ形の行が続くかぎり伸ばします。表・引用・箇条書きはこれです。 */
function scanWhile(isSameKind) {
  return (lines, index) => {
    let next = index + 1;
    while (next < lines.length && isSameKind(lines[next].text)) next += 1;
    return next;
  };
}

function scanOneLine(lines, index) {
  return index + 1;
}

/** 段落。空行か、別のブロックの始まりに出会うまでが本文です。 */
function scanUntilNewBlock(lines, index) {
  let next = index + 1;
  while (next < lines.length && !startsNewBlock(lines[next].text)) next += 1;
  return next;
}

async function renderMarkdownFragment(markdown, options) {
  const html = await markdownToHtml(String(markdown), {
    customEmbed: {
      mermaid(source) {
        return `<div class="mermaid">${escapeHtml(source)}</div>`;
      }
    }
  });

  return rewriteDestinations(html, options);
}

/**
 * Rewrites the destinations Markdown authors wrote (image sources, link hrefs)
 * into something the review UI can serve, keeping the original spelling in a
 * `data-markdown-*` attribute so the editor can write it back unchanged.
 */
function rewriteDestinations(html, options) {
  if (!options.resolveImageSrc && !options.resolveLink && !options.editorSourceAttrs) return html;

  const $ = load(html, null, false);
  $('img[src]').each((_index, image) => {
    const element = $(image);
    const source = element.attr('src');
    if (!source) return;
    if (options.editorSourceAttrs) element.attr('data-markdown-src', decodeMarkdownPath(source));
    if (options.resolveImageSrc) element.attr('src', options.resolveImageSrc(source));
  });

  if (options.resolveLink) {
    $('a[href]').each((_index, anchor) => {
      const element = $(anchor);
      const href = element.attr('href');
      const resolved = href && options.resolveLink(href);
      if (!resolved) return;
      if (options.editorSourceAttrs) element.attr('data-markdown-href', decodeMarkdownPath(href));
      applyLinkAttributes(element, resolved);
    });
  }
  return $.html();
}

function applyLinkAttributes(element, resolved) {
  element.attr('href', resolved.href);
  element.attr('data-link-state', resolved.state);
  if (resolved.path) element.attr('data-link-path', resolved.path);

  if (resolved.state === 'asset') {
    element.attr('target', '_blank');
    element.attr('rel', 'noreferrer');
    return;
  }
  if (resolved.state === 'internal') return;

  element.attr('data-link-error', resolved.message);
  element.attr('title', resolved.message);
  element.addClass('md-link-unavailable');
}

function splitSourceLines(source) {
  const lines = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|$)/g;
  let match;
  while ((match = linePattern.exec(source)) && (match[0] || linePattern.lastIndex < source.length)) {
    const start = match.index;
    const text = match[1];
    lines.push({
      text,
      start,
      contentEnd: start + text.length
    });
    if (!match[2]) break;
  }
  return lines;
}

function matchFence(line) {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s:]*)/);
  if (!match) return null;
  return {
    marker: match[1][0],
    length: match[1].length,
    language: String(match[2] || '').toLowerCase()
  };
}

function matchesClosingFence(line, fence) {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function isZennContainerStart(line) {
  return /^:::(?:message(?:\s+alert)?|details(?:\s+.+)?)\s*$/.test(line);
}

function isZennContainerEnd(line) {
  return /^:::\s*$/.test(line);
}

function isHeading(line) {
  return /^#{1,6}\s+/.test(line);
}

function isTableRow(line) {
  return /^\|.+\|\s*$/.test(line);
}

function isBlockquote(line) {
  return /^>\s?/.test(line);
}

function isListItem(line) {
  return /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

function isThematicBreak(line) {
  return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

/** 段落を切る行かどうか。判定は BLOCK_KINDS の表そのものを使います。 */
function startsNewBlock(line) {
  return line.trim() === '' || BLOCK_KINDS.some(({ match }) => Boolean(match(line)));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
