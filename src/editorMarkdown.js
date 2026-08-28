import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export function htmlBlockToMarkdown(html) {
  const turndown = createTurndownService();
  const markdown = turndown.turndown(String(html || '')).trim();
  return compactZennParagraphBreaks(markdown);
}

/**
 * Zenn renders a single newline in prose as a visible line break. Turndown, on
 * the other hand, separates sibling paragraphs with a blank line. Keep the
 * compact Zenn form for ordinary text, while retaining blank lines wherever
 * they delimit a Markdown block whose meaning could otherwise change.
 */
export function compactZennParagraphBreaks(markdown) {
  const source = String(markdown);
  if (!/\n[\t ]*\n/.test(source)) return source;

  const chunks = source.split(/\n[\t ]*\n+/);
  if (chunks.length < 2) return source;

  let compacted = chunks[0];
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1];
    const current = chunks[index];
    const separator = isWhitespaceSensitiveBlock(previous) || isWhitespaceSensitiveBlock(current)
      ? '\n\n'
      : '\n';
    compacted += `${separator}${current}`;
  }
  return compacted;
}

function isWhitespaceSensitiveBlock(markdown) {
  const lines = String(markdown).split('\n');
  const firstLine = lines[0] || '';
  const lastLine = lines.at(-1) || '';
  return /^\s{0,3}>/.test(firstLine)
    || /^\s*(?:[-+*]|\d+[.)])\s+/.test(firstLine)
    || /^\s{0,3}(?:`{3,}|~{3,})/.test(firstLine)
    || /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(lastLine)
    || /^\s{0,3}:::(?:message|details)(?:\s|$)/.test(firstLine)
    || /^\s{0,3}:::\s*$/.test(lastLine)
    || /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(firstLine)
    || /^\s{4}\S/.test(firstLine)
    || /^\s{0,3}\[[^\]]+\]:\s*/.test(firstLine)
    || /^\s{0,3}<[A-Za-z!/]/.test(firstLine)
    || /^\s{0,3}<\/[A-Za-z][^>]*>\s*$/.test(lastLine)
    || isMarkdownTable(markdown);
}

function isMarkdownTable(markdown) {
  const [header = '', delimiter = ''] = String(markdown).split('\n', 2);
  return header.includes('|')
    && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(delimiter);
}

export function applyBlockEdits(markdown, edits) {
  const source = String(markdown);
  const normalizedEdits = (Array.isArray(edits) ? edits : []).map((edit, index) => {
    const start = Number(edit.start);
    const end = Number(edit.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) {
      throw Object.assign(new Error(`Invalid source range for edit ${index + 1}`), { statusCode: 400 });
    }
    if (typeof edit.html !== 'string' && typeof edit.markdown !== 'string') {
      throw Object.assign(new Error(`html or markdown is required for edit ${index + 1}`), { statusCode: 400 });
    }
    return {
      blockId: String(edit.blockId || `edit-${index}`),
      start,
      end,
      markdown: edit.delete === true ? '' : replacementFor(edit),
      ...(edit.delete === true ? { delete: true } : {})
    };
  });

  const sourceOrdered = [...normalizedEdits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sourceOrdered.length; index += 1) {
    if (sourceOrdered[index].start < sourceOrdered[index - 1].end) {
      throw Object.assign(new Error('Edited source ranges must not overlap'), { statusCode: 400 });
    }
  }

  const ascending = expandDeletionRanges(source, sourceOrdered);
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index].start < ascending[index - 1].end) {
      throw Object.assign(new Error('Expanded deletion ranges must not overlap'), { statusCode: 400 });
    }
  }

  let updated = source;
  for (const edit of [...ascending].reverse()) {
    updated = `${updated.slice(0, edit.start)}${edit.markdown}${updated.slice(edit.end)}`;
  }

  return { markdown: updated, appliedEdits: ascending };
}

/**
 * その範囲を置き換える原文。
 *
 * 編集モードは画面のHTMLを送ってくるのでMarkdownへ戻します。AIの修正案（`documentEdits.js`）は
 * もともとMarkdownなので、そのまま使います。HTMLへ通して戻すと、頼んでいない書き換え
 * （引用符の種類、改行の畳み方、コードの言語指定）が本文に混ざるからです。
 */
function replacementFor(edit) {
  return typeof edit.markdown === 'string' ? edit.markdown : htmlBlockToMarkdown(edit.html);
}

function expandDeletionRanges(source, edits) {
  const expanded = [];
  for (const originalEdit of edits) {
    const edit = { ...originalEdit };
    if (!edit.delete) {
      expanded.push(edit);
      continue;
    }

    const followingSeparator = source.slice(edit.end).match(/^(?:\r\n|\n)[\t ]*(?:\r\n|\n)/);
    if (followingSeparator) {
      edit.end += followingSeparator[0].length;
      expanded.push(edit);
      continue;
    }

    const trailingWhitespace = source.slice(edit.end).match(/^(?:(?:\r\n|\n)[\t ]*)?$/);
    if (trailingWhitespace) {
      edit.end = source.length;
      const precedingSeparator = source.slice(0, edit.start).match(/(?:\r\n|\n)[\t ]*(?:\r\n|\n)$/);
      if (precedingSeparator) {
        const expandedStart = edit.start - precedingSeparator[0].length;
        const overlapsPreviousDeletion = expanded.some((previous) => (
          previous.delete && previous.end > expandedStart
        ));
        if (!overlapsPreviousDeletion) edit.start = expandedStart;
      }
    }
    expanded.push(edit);
  }
  return expanded;
}

function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**'
  });
  turndown.use(gfm);
  turndown.remove(['script', 'style', 'button']);

  turndown.addRule('mermaidBlock', {
    filter(node) {
      return node.nodeName === 'DIV' && node.classList.contains('mermaid');
    },
    replacement(_content, node) {
      return `\n\n\`\`\`mermaid\n${node.textContent.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    }
  });

  turndown.addRule('fencedCodeWithLanguage', {
    filter: 'pre',
    replacement(_content, node) {
      const code = node.querySelector('code');
      const languageClass = String(code?.getAttribute('class') || '')
        .split(/\s+/)
        .find((name) => name.startsWith('language-'));
      const language = languageClass ? languageClass.slice('language-'.length) : '';
      const value = (code || node).textContent.replace(/\n+$/, '');
      return `\n\n\`\`\`${language}\n${value}\n\`\`\`\n\n`;
    }
  });

  /**
   * The review UI rewrites link destinations so they can be navigated locally.
   * Write the author's original spelling back, and drop the renderer's own
   * heading anchors so editing a heading does not leave `[](#...)` behind.
   */
  turndown.addRule('markdownSourceLink', {
    filter(node) {
      return node.nodeName === 'A' && Boolean(node.getAttribute('href'));
    },
    replacement(content, node) {
      if (node.classList.contains('header-anchor-link')) return '';
      const text = content.trim();
      if (!text) return '';
      const href = node.getAttribute('data-markdown-href') || node.getAttribute('href') || '';
      if (!href) return text;
      const title = node.getAttribute('data-link-error') ? '' : node.getAttribute('title');
      return `[${text}](${href}${title ? ` "${title}"` : ''})`;
    }
  });

  turndown.addRule('markdownSourceImage', {
    filter: 'img',
    replacement(_content, node) {
      const alt = String(node.getAttribute('alt') || '').replaceAll(']', '\\]');
      const source = node.getAttribute('data-markdown-src') || node.getAttribute('src') || '';
      return source ? `![${alt}](${source})` : '';
    }
  });

  return turndown;
}
