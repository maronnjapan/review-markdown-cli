import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');

test('relative Markdown image paths are served from the target directory', async (t) => {
  const { baseUrl } = await startServer(t, async (root) => {
    await fs.mkdir(path.join(root, 'docs', 'images'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', '画像'), { recursive: true });
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'images', 'plain.png'), pngBytes);
    await fs.writeFile(path.join(root, 'docs', 'images', 'my pic.png'), pngBytes);
    await fs.writeFile(path.join(root, 'docs', '画像', '図1.png'), pngBytes);
    await fs.writeFile(path.join(root, 'assets', 'outside.png'), pngBytes);
    await fs.writeFile(path.join(root, 'docs', 'sample.md'), [
      '![plain](./images/plain.png)',
      '',
      '![space](<images/my pic.png>)',
      '',
      '![japanese](./画像/図1.png)',
      '',
      '![query](images/plain.png?v=1)',
      '',
      '![root relative](/docs/images/plain.png)',
      '',
      '![parent](../assets/outside.png)',
      ''
    ].join('\n'), 'utf8');
  });

  const opened = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent('docs/sample.md')}`).then((response) => response.json());
  const sources = imageSources(opened.html);
  assert.equal(sources.length, 6);

  for (const source of sources) {
    const response = await fetch(`${baseUrl}${source}`);
    assert.equal(response.status, 200, `${source} should be served`);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngBytes);
  }
});

test('remote image sources are left untouched', async (t) => {
  const { baseUrl } = await startServer(t, async (root) => {
    await fs.writeFile(path.join(root, 'sample.md'), '![remote](https://example.com/logo.png)\n', 'utf8');
  });

  const opened = await fetch(`${baseUrl}/api/file?path=sample.md`).then((response) => response.json());

  assert.deepEqual(imageSources(opened.html), ['https://example.com/logo.png']);
});

test('image paths outside the target directory are rejected and missing files report 404', async (t) => {
  const { baseUrl } = await startServer(t, async (root) => {
    await fs.writeFile(path.join(root, 'sample.md'), '# sample\n', 'utf8');
  });

  const escaped = await fetch(`${baseUrl}/api/asset?from=sample.md&src=${encodeURIComponent('../../etc/hosts')}`);
  assert.equal(escaped.status, 400);
  assert.match((await escaped.json()).error, /inside target directory/);

  const missing = await fetch(`${baseUrl}/api/asset?from=sample.md&src=${encodeURIComponent('./images/nope.png')}`);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /Asset not found/);
});

test('the editing preview resolves image sources exactly like the opened document', async (t) => {
  const { baseUrl } = await startServer(t, async (root) => {
    await fs.mkdir(path.join(root, 'docs', '画像'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', '画像', '図1.png'), pngBytes);
    await fs.writeFile(path.join(root, 'docs', 'sample.md'), '![japanese](./画像/図1.png)\n', 'utf8');
  });

  const opened = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent('docs/sample.md')}`)
    .then((response) => response.json());
  const previewed = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'docs/sample.md', markdown: '![japanese](./画像/図1.png)\n' })
  }).then((response) => response.json());

  // 書いている途中に出すものと、読む画面に出るものが違っては、確かめる意味がありません。
  assert.deepEqual(imageSources(previewed.html), imageSources(opened.html));
  assert.equal((await fetch(`${baseUrl}${imageSources(previewed.html)[0]}`)).status, 200);
});

test('the editing preview never writes to the file', async (t) => {
  const { baseUrl, root } = await startServer(t, async (directory) => {
    await fs.writeFile(path.join(directory, 'sample.md'), '# もとの本文\n', 'utf8');
  });

  const response = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'sample.md', markdown: '# 書きかけ\n\n:::message\n途中\n:::\n' })
  });

  assert.equal(response.status, 200);
  assert.match((await response.json()).html, /<aside class="msg message">/);
  assert.equal(await fs.readFile(path.join(root, 'sample.md'), 'utf8'), '# もとの本文\n');
});

async function startServer(t, seed) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-asset-'));
  await seed(root);

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

  return { root, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function imageSources(html) {
  return [...String(html).matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1].replaceAll('&amp;', '&'));
}
