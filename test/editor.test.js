import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyBlockEdits,
  compactZennParagraphBreaks,
  htmlBlockToMarkdown
} from '../src/editorMarkdown.js';
import { parseMarkdownBlocks, renderMarkdown } from '../src/markdown.js';
import { createServer } from '../src/server.js';

test('parseMarkdownBlocks exposes exact source ranges without normalizing untouched content', () => {
  const markdown = '# Title\r\n\r\nParagraph.\r\n\r\n- one\r\n- two\r\n';
  const blocks = parseMarkdownBlocks(markdown);

  assert.deepEqual(blocks.map(({ kind, source }) => ({ kind, source })), [
    { kind: 'heading', source: '# Title' },
    { kind: 'paragraph', source: 'Paragraph.' },
    { kind: 'list', source: '- one\r\n- two' }
  ]);
  assert.equal(markdown.slice(blocks[1].start, blocks[1].end), 'Paragraph.');
});

test('renderMarkdown can wrap editable blocks with source metadata', async () => {
  const html = await renderMarkdown('# Title\n\nBody\n', { editableBlocks: true });

  assert.match(html, /class="markdown-block"/);
  assert.match(html, /data-block-kind="heading"/);
  assert.match(html, /data-source-start="9" data-source-end="13"><p[^>]*>Body<\/p>/);
});

test('renderMarkdown uses Zenn Markdown extensions', async () => {
  const html = await renderMarkdown(':::message\nZenn message\n:::\n');

  assert.match(html, /<aside class="msg message">/);
  assert.match(html, /class="msg-symbol"/);
  assert.match(html, /Zenn message/);
});

test('htmlBlockToMarkdown supports the editor formatting vocabulary', () => {
  const markdown = htmlBlockToMarkdown(`
    <h2>Hello <strong>world</strong></h2>
    <blockquote><p>Quoted</p></blockquote>
    <ul><li>one</li><li>two</li></ul>
    <p><a href="https://example.com">link</a> <img alt="sample" src="/resolved" data-markdown-src="./sample.png"></p>
    <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>
    <pre><code class="language-mermaid">graph TD
A--&gt;B</code></pre>
  `);

  assert.match(markdown, /## Hello \*\*world\*\*/);
  assert.match(markdown, /> Quoted/);
  assert.match(markdown, /one[\s\S]*two/);
  assert.match(markdown, /\[link\]\(https:\/\/example\.com\)/);
  assert.match(markdown, /!\[sample\]\(\.\/sample\.png\)/);
  assert.match(markdown, /\| A \|[\s\S]*\| B \|/);
  assert.match(markdown, /```mermaid\ngraph TD\nA-->B\n```/);
});

test('htmlBlockToMarkdown uses compact Zenn line breaks between ordinary paragraphs', () => {
  const markdown = htmlBlockToMarkdown('<p>一行目</p><p>二行目</p><h2>見出し</h2><p>本文</p>');

  assert.equal(markdown, '一行目\n二行目\n## 見出し\n本文');
});

test('compactZennParagraphBreaks keeps blank lines around syntax-sensitive blocks', async () => {
  const markdown = compactZennParagraphBreaks([
    '導入',
    '',
    '> 引用',
    '',
    '引用後の本文',
    '',
    '- 項目',
    '',
    'リスト後の本文',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    'コード後の本文'
  ].join('\n'));

  assert.equal(markdown, [
    '導入',
    '',
    '> 引用',
    '',
    '引用後の本文',
    '',
    '- 項目',
    '',
    'リスト後の本文',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    'コード後の本文'
  ].join('\n'));

  const html = await renderMarkdown(markdown);
  assert.match(html, /<blockquote[\s\S]*引用[\s\S]*<\/blockquote>\s*<p[^>]*>引用後の本文<\/p>/);
  assert.match(html, /<\/ul>\s*<p[^>]*>リスト後の本文<\/p>/);
});

test('compactZennParagraphBreaks keeps blank lines inside and after fenced blocks', () => {
  const markdown = [
    '```js',
    'function answer() {',
    '',
    '  return 42;',
    '}',
    '```',
    '',
    'コード後の本文',
    '',
    ':::message',
    '一段落目',
    '',
    '二段落目',
    ':::',
    '',
    'メッセージ後の本文'
  ].join('\n');

  assert.equal(compactZennParagraphBreaks(markdown), markdown);
});

test('applyBlockEdits changes only selected source ranges', () => {
  const markdown = '# Title\r\n\r\nOriginal paragraph.\r\n\r\n* untouched item\r\n';
  const blocks = parseMarkdownBlocks(markdown);
  const paragraph = blocks[1];
  const result = applyBlockEdits(markdown, [{
    blockId: paragraph.id,
    start: paragraph.start,
    end: paragraph.end,
    html: '<p>Updated <em>paragraph</em>.</p>'
  }]);

  assert.equal(result.markdown, '# Title\r\n\r\nUpdated *paragraph*.\r\n\r\n* untouched item\r\n');
  assert.deepEqual(result.appliedEdits[0], {
    blockId: paragraph.id,
    start: paragraph.start,
    end: paragraph.end,
    markdown: 'Updated *paragraph*.'
  });
});

test('applyBlockEdits deletes an empty block together with its Markdown separator', () => {
  const markdown = 'First paragraph.\n\nDelete this paragraph.\n\nLast paragraph.\n';
  const paragraph = parseMarkdownBlocks(markdown)[1];
  const result = applyBlockEdits(markdown, [{
    blockId: paragraph.id,
    start: paragraph.start,
    end: paragraph.end,
    html: '',
    delete: true
  }]);

  assert.equal(result.markdown, 'First paragraph.\n\nLast paragraph.\n');
  assert.equal(result.appliedEdits[0].delete, true);
});

test('POST /api/file updates Markdown and comment targets together', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-editor-'));
  const filePath = path.join(root, 'example.md');
  await fs.writeFile(filePath, '# Title\n\nOld text.\n', 'utf8');

  const { app } = createServer(root);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const cssResponse = await fetch(`${baseUrl}/zenn-content.css`);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get('content-type'), /^text\/css/);
  assert.match(await cssResponse.text(), /\.znc/);

  const opened = await fetch(`${baseUrl}/api/file?path=example.md`).then((response) => response.json());
  const paragraph = parseMarkdownBlocks(opened.markdown)[1];
  const response = await fetch(`${baseUrl}/api/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'example.md',
      edits: [{
        blockId: paragraph.id,
        start: paragraph.start,
        end: paragraph.end,
        html: '<p>New text.</p>'
      }],
      comments: [{
        id: 'comment-1',
        type: 'paragraph',
        targetText: 'New text.',
        comment: 'Updated target'
      }]
    })
  });
  const saved = await response.json();

  assert.equal(response.status, 200);
  assert.equal(await fs.readFile(filePath, 'utf8'), '# Title\n\nNew text.\n');
  assert.equal(saved.review.comments[0].targetText, 'New text.');
  assert.match(saved.html, /class="code-line"/);
  assert.match(saved.editableHtml, /data-source-start=/);
  const review = JSON.parse(await fs.readFile(path.join(root, '.review', 'example.md.review.json'), 'utf8'));
  assert.equal(review.comments[0].comment, 'Updated target');
});

test('POST /api/file rejects non-Markdown targets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-editor-'));
  await fs.writeFile(path.join(root, 'notes.txt'), 'text', 'utf8');
  const { app } = createServer(root);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'notes.txt', edits: [], comments: [] })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Only Markdown files/);
});
