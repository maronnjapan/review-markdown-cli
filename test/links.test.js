import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { htmlBlockToMarkdown } from '../src/editorMarkdown.js';
import { isTextDocumentPath, resolveDocumentLink } from '../src/links.js';
import { renderMarkdown } from '../src/markdown.js';
import { createServer } from '../src/server.js';

test('relative links below the review root resolve to an in-app route', () => {
  const from = (href, isInScope) => resolveDocumentLink(href, { relativeFile: 'docs/guide/intro.md', isInScope });

  assert.deepEqual(from('./advanced.md'), {
    state: 'internal',
    href: '#/review/docs%2Fguide%2Fadvanced.md',
    path: 'docs/guide/advanced.md',
    hash: ''
  });
  assert.equal(from('../plan.md').path, 'docs/plan.md');
  assert.equal(from('/README.md').path, 'README.md');
  assert.equal(from('./advanced.md#section').href, '#/review/docs%2Fguide%2Fadvanced.md#section');
});

test('links above the review root are reported as errors instead of being followed', () => {
  const resolved = resolveDocumentLink('../../../etc/passwd', { relativeFile: 'docs/guide/intro.md' });

  assert.equal(resolved.state, 'outside');
  assert.equal(resolved.href, '../../../etc/passwd');
  assert.match(resolved.message, /レビュー対象ディレクトリの外/);
});

test('links hidden by --include / --exclude are reported as out of scope', () => {
  const resolved = resolveDocumentLink('../drafts/wip.md', {
    relativeFile: 'docs/intro.md',
    isInScope: (target) => !target.startsWith('drafts/')
  });

  assert.equal(resolved.state, 'filtered');
  assert.equal(resolved.path, 'drafts/wip.md');
  assert.match(resolved.message, /レビュー対象から外れています/);
});

test('external URLs, mail addresses and in-page anchors are left alone', () => {
  const context = { relativeFile: 'docs/intro.md' };

  assert.equal(resolveDocumentLink('https://example.com', context), null);
  assert.equal(resolveDocumentLink('//example.com/a.md', context), null);
  assert.equal(resolveDocumentLink('mailto:someone@example.com', context), null);
  assert.equal(resolveDocumentLink('#section', context), null);
  assert.equal(resolveDocumentLink('   ', context), null);
});

test('non-Markdown targets inside the root are served as files', () => {
  const resolved = resolveDocumentLink('./files/spec.pdf?v=2', { relativeFile: 'docs/intro.md' });

  assert.equal(resolved.state, 'asset');
  assert.equal(resolved.path, 'docs/files/spec.pdf');
  assert.equal(resolved.href, '/api/asset?from=docs%2Fintro.md&src=.%2Ffiles%2Fspec.pdf%3Fv%3D2');
});

test('rendered links carry the verdict, and editing writes the original path back', async () => {
  const options = {
    resolveLink: (href) => resolveDocumentLink(href, { relativeFile: 'docs/intro.md' })
  };
  const markdown = [
    '## 見出しA',
    '',
    '[隣](./neighbour.md) と [外](../../outside.md) と [外部](https://example.com)',
    '',
    '[日本語](./図表/一覧.md#まとめ)'
  ].join('\n');

  const html = await renderMarkdown(markdown, options);
  assert.match(html, /href="#\/review\/docs%2Fneighbour\.md" data-link-state="internal"/);
  assert.match(html, /data-link-state="outside"[^>]*class="md-link-unavailable"/);
  assert.match(html, /href="https:\/\/example\.com" target="_blank"/);
  assert.match(html, /data-link-path="docs\/図表\/一覧\.md"/);

  const editable = await renderMarkdown(markdown, { ...options, editableBlocks: true });
  const blocks = [...editable.matchAll(/<div class="markdown-block"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((match) => htmlBlockToMarkdown(match[1]));

  // Round-tripping must not leave the review UI's own URLs (or the renderer's
  // heading anchors) behind in the author's Markdown.
  assert.deepEqual(blocks, [
    '## 見出しA',
    '[隣](./neighbour.md) と [外](../../outside.md) と [外部](https://example.com)',
    '[日本語](./図表/一覧.md#まとめ)'
  ]);
});

test('a link to another Markdown file survives a save through the server', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-links-'));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'intro.md'), '続きは[次章](./next.md)を参照。\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'next.md'), '# Next\n', 'utf8');

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

  const opened = await fetch(`${baseUrl}/api/file?path=docs/intro.md`).then((response) => response.json());
  assert.match(opened.html, /href="#\/review\/docs%2Fnext\.md"/);

  const editableBlock = opened.editableHtml.match(/<div class="markdown-block"[^>]*>([\s\S]*?)<\/div>/)[1];
  await fetch(`${baseUrl}/api/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'docs/intro.md',
      edits: [{ blockId: 'block-0', start: 0, end: opened.markdown.trimEnd().length, html: editableBlock }],
      comments: []
    })
  });

  assert.equal(await fs.readFile(path.join(root, 'docs', 'intro.md'), 'utf8'), '続きは[次章](./next.md)を参照。\n');
});

test('Markdown and plain-text files have a text body; PDFs and images do not', () => {
  for (const textFile of ['README.md', 'docs/guide.markdown', 'notes/memo.TXT', 'data/rows.csv']) {
    assert.equal(isTextDocumentPath(textFile), true, textFile);
  }
  for (const binaryFile of ['spec.pdf', 'images/diagram.png', 'archive.zip', 'LICENSE']) {
    assert.equal(isTextDocumentPath(binaryFile), false, binaryFile);
  }
});

test('the server tells the client which opened files have a text body', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-text-body-'));
  await fs.writeFile(path.join(root, 'note.md'), '# メモ\n', 'utf8');
  await fs.writeFile(path.join(root, 'memo.txt'), 'ただのテキスト\n', 'utf8');
  await fs.writeFile(path.join(root, 'spec.pdf'), '%PDF-1.7\n', 'utf8');

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
  const open = (file) => fetch(`${baseUrl}/api/file?path=${file}`).then((response) => response.json());

  assert.equal((await open('note.md')).textBody, true);
  assert.equal((await open('memo.txt')).textBody, true);
  assert.equal((await open('spec.pdf')).textBody, false);
});
