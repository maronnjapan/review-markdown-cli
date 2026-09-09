import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiStore } from '../src/aiStore.js';
import { createServer } from '../src/server.js';

test('POST /api/file/create makes a Markdown file and hands back the new list', async (t) => {
  const { root, baseUrl } = await startServer(t, async (root) => {
    await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');
  });

  const created = await postJson(`${baseUrl}/api/file/create`, { path: 'docs/notes' });
  assert.equal(created.status, 200);
  const body = await created.json();

  // 拡張子を書かずに送っても Markdown になり、途中のディレクトリは作られます。
  assert.equal(body.path, 'docs/notes.md');
  assert.deepEqual(body.files, ['docs/notes.md', 'guide.md']);
  assert.equal(await fs.readFile(path.join(root, 'docs', 'notes.md'), 'utf8'), '# notes\n');

  const duplicate = await postJson(`${baseUrl}/api/file/create`, { path: 'docs/notes.md' });
  assert.equal(duplicate.status, 409);
  assert.match((await duplicate.json()).error, /すでにあります/);

  // 一覧に出ないファイルは作れません。ここが緩むと、パスを送るだけで
  // 対象ディレクトリのどこにでも書ける窓口になります。
  const script = await postJson(`${baseUrl}/api/file/create`, { path: 'tool.js' });
  assert.equal(script.status, 400);
  assert.match((await script.json()).error, /Markdown \/ PDF/);
});

test('POST /api/file/rename moves the file with the review data saved beside it', async (t) => {
  const { root, baseUrl } = await startServer(t, async (root) => {
    await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\n本文。\n', 'utf8');
  });

  const saved = await postJson(`${baseUrl}/api/review`, {
    path: 'guide.md',
    comments: [{ id: 'comment-1', type: 'document', comment: '通しで読む' }],
    aiContext: '入門書の1章'
  });
  assert.equal(saved.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/export?path=guide.md`)).status, 200);
  await fs.writeFile(
    path.join(root, '.review', 'guide.md.tasks.json'),
    `${JSON.stringify({ targetFile: 'guide.md', watch: true, tasks: [] }, null, 2)}\n`,
    'utf8'
  );

  const renamed = await postJson(`${baseUrl}/api/file/rename`, { path: 'guide.md', to: 'docs/入門.md' });
  assert.equal(renamed.status, 200);
  const body = await renamed.json();
  assert.equal(body.path, 'docs/入門.md');
  assert.equal(body.from, 'guide.md');
  assert.deepEqual(body.files, ['docs/入門.md']);

  assert.equal(await exists(path.join(root, 'guide.md')), false);
  assert.equal(await fs.readFile(path.join(root, 'docs', '入門.md'), 'utf8'), '# Guide\n\n本文。\n');

  // コメント・出力・タスクは、どれも「どの文書のものか」を自分の中に持っています。
  // 動かすだけでは前の名前を指し続けるので、中身も書き換わっていることまで見ます。
  const review = JSON.parse(await fs.readFile(path.join(root, '.review', 'docs', '入門.md.review.json'), 'utf8'));
  assert.equal(review.targetFile, 'docs/入門.md');
  assert.equal(review.comments[0].comment, '通しで読む');
  assert.equal(review.aiContext, '入門書の1章');
  const exported = await fs.readFile(path.join(root, '.review', 'docs', '入門.md.review.md'), 'utf8');
  assert.match(exported, /^# Review for docs\/入門\.md$/m);
  const tasks = JSON.parse(await fs.readFile(path.join(root, '.review', 'docs', '入門.md.tasks.json'), 'utf8'));
  assert.deepEqual({ targetFile: tasks.targetFile, watch: tasks.watch }, { targetFile: 'docs/入門.md', watch: true });
  assert.equal(await exists(path.join(root, '.review', 'guide.md.review.json')), false);
  assert.equal(await exists(path.join(root, '.review', 'guide.md.tasks.json')), false);

  // 名前を変えたあとに開いても、コメントはその文書のものとして読めます。
  const opened = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent('docs/入門.md')}`)
    .then((response) => response.json());
  assert.equal(opened.review.comments.length, 1);
  assert.equal(opened.reviewFile, '.review/docs/入門.md.review.json');
});

test('POST /api/file/rename refuses a name that would take the file out of the review', async (t) => {
  const { baseUrl } = await startServer(t, async (root) => {
    await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');
    await fs.writeFile(path.join(root, 'other.md'), '# Other\n', 'utf8');
  }, { exclude: ['drafts/**'] });

  const cases = [
    [{ path: 'guide.md', to: '../escaped.md' }, 400, /stay inside target directory/],
    [{ path: 'guide.md', to: 'drafts/guide.md' }, 400, /include \/ exclude/],
    [{ path: 'guide.md', to: 'guide.pdf' }, 400, /MarkdownとPDF/],
    [{ path: 'guide.md', to: 'guide.md' }, 400, /名前が変わっていません/],
    [{ path: 'guide.md', to: 'other.md' }, 409, /すでにあります/],
    [{ path: 'missing.md', to: 'found.md' }, 404, /見つかりません/]
  ];
  for (const [payload, status, message] of cases) {
    const response = await postJson(`${baseUrl}/api/file/rename`, payload);
    assert.equal(response.status, status, `${payload.path} -> ${payload.to}`);
    assert.match((await response.json()).error, message);
  }
});

test('POST /api/file/delete removes the file together with its review data', async (t) => {
  const { root, baseUrl } = await startServer(t, async (root) => {
    await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');
    await fs.writeFile(path.join(root, 'keep.md'), '# Keep\n', 'utf8');
  });

  await postJson(`${baseUrl}/api/review`, {
    path: 'guide.md',
    comments: [{ id: 'comment-1', type: 'document', comment: '消える' }]
  });
  await fetch(`${baseUrl}/api/export?path=guide.md`);

  const deleted = await postJson(`${baseUrl}/api/file/delete`, { path: 'guide.md' });
  assert.equal(deleted.status, 200);
  const body = await deleted.json();
  assert.deepEqual(body.files, ['keep.md']);
  assert.deepEqual(body.data.sort(), ['.review/guide.md.review.json', '.review/guide.md.review.md']);

  assert.equal(await exists(path.join(root, 'guide.md')), false);
  assert.equal(await exists(path.join(root, '.review', 'guide.md.review.json')), false);
  assert.equal(await exists(path.join(root, '.review', 'guide.md.review.md')), false);
  assert.equal(await exists(path.join(root, 'keep.md')), true);

  const missing = await postJson(`${baseUrl}/api/file/delete`, { path: 'guide.md' });
  assert.equal(missing.status, 404);
  // レビュー対象の外は、消す手前で断ります。
  const outside = await postJson(`${baseUrl}/api/file/delete`, { path: '../guide.md' });
  assert.equal(outside.status, 400);
});

test('renaming a document takes the saved AI chats and the recap mark with it', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-files-data-'));
  const { baseUrl, root } = await startServer(t, async (root) => {
    await fs.writeFile(path.join(root, 'meeting.md'), '# Meeting\n', 'utf8');
  }, {}, { aiDataDir: dataDir });

  const store = new AiStore(root, { dataDir });
  await store.saveConversation({
    id: 'conversation-1',
    documentPath: 'meeting.md',
    title: '相談',
    messages: [],
    updatedAt: new Date().toISOString()
  });
  await store.saveRecapMark('meeting.md', { index: 3, fingerprint: 'caption-3' });

  const renamed = await postJson(`${baseUrl}/api/file/rename`, { path: 'meeting.md', to: 'notes/meeting.md' });
  assert.equal(renamed.status, 200);

  const moved = new AiStore(root, { dataDir });
  assert.deepEqual((await moved.listConversations('notes/meeting.md')).map(({ id }) => id), ['conversation-1']);
  assert.deepEqual(await moved.listConversations('meeting.md'), []);
  assert.deepEqual(await moved.getRecapMark('notes/meeting.md'), { index: 3, fingerprint: 'caption-3' });
  assert.equal(await moved.getRecapMark('meeting.md'), null);
});

async function startServer(t, seed, filters = {}, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-files-'));
  await seed(root);

  const { app } = createServer(root, {
    ...filters,
    // 端末側の保存先を分けます。渡さないと、テストが本物の記録を書き換えます。
    aiDataDir: options.aiDataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'review-files-data-')),
    ...options
  });
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

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
