import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyBlockEdits } from '../src/editorMarkdown.js';
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

test('renderMarkdown uses Zenn Markdown extensions', async () => {
  const html = await renderMarkdown(':::message\nZenn message\n:::\n');

  assert.match(html, /<aside class="msg message">/);
  assert.match(html, /class="msg-symbol"/);
  assert.match(html, /Zenn message/);
});

test('applyBlockEdits changes only selected source ranges', () => {
  const markdown = '# Title\r\n\r\nOriginal paragraph.\r\n\r\n* untouched item\r\n';
  const blocks = parseMarkdownBlocks(markdown);
  const paragraph = blocks[1];
  const result = applyBlockEdits(markdown, [{
    blockId: paragraph.id,
    start: paragraph.start,
    end: paragraph.end,
    markdown: 'Updated *paragraph*.'
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
    markdown: '',
    delete: true
  }]);

  assert.equal(result.markdown, 'First paragraph.\n\nLast paragraph.\n');
  assert.equal(result.appliedEdits[0].delete, true);
});

test('applyBlockEdits refuses a range that no longer holds what the editor saw', () => {
  const markdown = '# Title\n\n書きかけの段落。\n';
  const edit = { blockId: 'document', start: 9, end: 16, before: '書きかけの段落', markdown: '直した段落' };

  assert.equal(applyBlockEdits(markdown, [edit]).markdown, '# Title\n\n直した段落。\n');

  // 別のエディタで1行足されると、同じ位置が別の中身を指します。当てれば壊れます。
  const shifted = '追記。\n\n# Title\n\n書きかけの段落。\n';
  assert.throws(() => applyBlockEdits(shifted, [edit]), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /書き換わりました/);
    return true;
  });
});

test('applyBlockEdits only takes Markdown', () => {
  assert.throws(
    () => applyBlockEdits('本文\n', [{ blockId: 'document', start: 0, end: 2, html: '<p>本文</p>' }]),
    /markdown is required/
  );
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
        markdown: 'New text.'
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
