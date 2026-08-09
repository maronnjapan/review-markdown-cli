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
    const fence = matchFence(firstLine);
    let kind = 'paragraph';

    if (fence) {
      kind = fence.language === 'mermaid' ? 'mermaid' : 'code';
      index += 1;
      while (index < lines.length) {
        const isClosingFence = matchesClosingFence(lines[index].text, fence);
        index += 1;
        if (isClosingFence) break;
      }
    } else if (isZennContainerStart(firstLine)) {
      kind = 'container';
      index += 1;
      while (index < lines.length) {
        const isClosingContainer = /^:::\s*$/.test(lines[index].text);
        index += 1;
        if (isClosingContainer) break;
      }
    } else if (/^#{1,6}\s+/.test(firstLine)) {
      kind = 'heading';
      index += 1;
    } else if (/^\|.+\|\s*$/.test(firstLine)) {
      kind = 'table';
      index += 1;
      while (index < lines.length && /^\|.+\|\s*$/.test(lines[index].text)) index += 1;
    } else if (/^>\s?/.test(firstLine)) {
      kind = 'blockquote';
      index += 1;
      while (index < lines.length && /^>\s?/.test(lines[index].text)) index += 1;
    } else if (listMatch(firstLine)) {
      kind = 'list';
      index += 1;
      while (index < lines.length && listMatch(lines[index].text)) index += 1;
    } else if (isThematicBreak(firstLine)) {
      kind = 'thematic-break';
      index += 1;
    } else {
      index += 1;
      while (index < lines.length && !startsNewBlock(lines[index].text)) index += 1;
    }

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

function listMatch(line) {
  return /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

function isThematicBreak(line) {
  return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function startsNewBlock(line) {
  if (line.trim() === '') return true;
  return Boolean(matchFence(line))
    || isZennContainerStart(line)
    || /^#{1,6}\s+/.test(line)
    || /^\|.+\|\s*$/.test(line)
    || /^>\s?/.test(line)
    || listMatch(line)
    || isThematicBreak(line);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
