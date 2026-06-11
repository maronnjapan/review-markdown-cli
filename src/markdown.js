const inlineCodePlaceholders = [];

export function renderMarkdown(markdown) {
  const lines = String(markdown).replaceAll('\r\n', '\n').split('\n');
  const html = [];
  let index = 0;
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines = [];
  let listType = null;
  let blockquote = [];
  let paragraph = [];
  let table = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };
  const flushBlockquote = () => {
    if (blockquote.length === 0) return;
    html.push(`<blockquote>${renderMarkdown(blockquote.join('\n'))}</blockquote>`);
    blockquote = [];
  };
  const flushTable = () => {
    if (table.length === 0) return;
    const rows = table.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
    const hasSeparator = rows.length > 1 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
    if (!hasSeparator) {
      paragraph.push(...table);
      table = [];
      return;
    }
    const headers = rows[0];
    const bodyRows = rows.slice(2);
    html.push('<table><thead><tr>');
    headers.forEach((header) => html.push(`<th>${renderInline(header)}</th>`));
    html.push('</tr></thead><tbody>');
    bodyRows.forEach((row) => {
      html.push('<tr>');
      row.forEach((cell) => html.push(`<td>${renderInline(cell)}</td>`));
      html.push('</tr>');
    });
    html.push('</tbody></table>');
    table = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushBlockquote();
    flushTable();
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^```\s*([\w-]+)?\s*$/);
    if (fence) {
      if (inCodeBlock) {
        html.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLanguage = '';
        codeLines = [];
      } else {
        flushAll();
        inCodeBlock = true;
        codeLanguage = fence[1] || '';
      }
      index += 1;
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      index += 1;
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\|.+\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushBlockquote();
      table.push(line);
      index += 1;
      continue;
    }
    flushTable();

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blockquote.push(quote[1]);
      index += 1;
      continue;
    }
    flushBlockquote();

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const desiredType = unordered ? 'ul' : 'ol';
      if (listType !== desiredType) {
        flushList();
        listType = desiredType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      index += 1;
      continue;
    }
    flushList();

    paragraph.push(line.trim());
    index += 1;
  }

  if (inCodeBlock) {
    html.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushAll();
  return html.join('\n');
}

function renderInline(text) {
  inlineCodePlaceholders.length = 0;
  let output = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code) => {
    const token = `@@CODE${inlineCodePlaceholders.length}@@`;
    inlineCodePlaceholders.push(`<code>${code}</code>`);
    return token;
  });
  output = output
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
  inlineCodePlaceholders.forEach((code, placeholderIndex) => {
    output = output.replace(`@@CODE${placeholderIndex}@@`, code);
  });
  return output;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
