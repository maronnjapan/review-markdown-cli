import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import { MAX_EDIT_BLOCK_CHARS, MAX_EDIT_MARKDOWN_CHARS } from '../src/aiLimits.js';
import { buildEditProposals, documentRevision, extractEditableBlocks } from '../src/documentEdits.js';
import { createServer } from '../src/server.js';
import { writeReview } from '../src/reviewStore.js';

const DOCUMENT = [
  '# 運用手順',
  '',
  'この手順は当番が読みます。',
  '',
  '## 再起動',
  '',
  'サービスを止めてから起動します。',
  '',
  '- 古い注記',
  '- もう一つの注記'
].join('\n');

test('editable blocks carry the source range and the heading they sit under', () => {
  const { blocks, dropped } = extractEditableBlocks(DOCUMENT);

  assert.equal(dropped, 0);
  assert.deepEqual(blocks.map(({ kind, headingPath }) => ({ kind, headingPath })), [
    { kind: 'heading', headingPath: ['運用手順'] },
    { kind: 'paragraph', headingPath: ['運用手順'] },
    { kind: 'heading', headingPath: ['運用手順', '再起動'] },
    { kind: 'paragraph', headingPath: ['運用手順', '再起動'] },
    { kind: 'list', headingPath: ['運用手順', '再起動'] }
  ]);
  // 範囲は原文をそのまま切り出せるものです。ここがずれると、別の場所が書き換わります。
  for (const block of blocks) {
    assert.equal(DOCUMENT.slice(block.start, block.end), block.markdown);
  }
});

test('a proposal keeps what it can and says why it dropped the rest', async () => {
  const { blocks } = extractEditableBlocks(DOCUMENT);
  const result = await buildEditProposals(blocks, {
    summary: '確認を足しました。',
    edits: [
      // 後ろのブロックを先に返されても、適用の順に並べ直します。
      { blockIndex: 4, markdown: '', reason: '古い注記を消します。', confidence: 'medium' },
      { blockIndex: 3, markdown: '止める前に、接続中の利用者がいないことを確かめます。', reason: '確認を足しました。', confidence: 'high' },
      { blockIndex: 3, markdown: '二度目の書き換え。', reason: '同じ箇所への2件目。', confidence: 'low' },
      { blockIndex: 1, markdown: 'この手順は当番が読みます。', reason: '変えていません。', confidence: 'low' },
      { blockIndex: 99, markdown: 'どこ？', reason: '存在しない箇所。', confidence: 'low' },
      { blockIndex: 0, markdown: 'あ'.repeat(MAX_EDIT_MARKDOWN_CHARS + 1), reason: '長すぎる書き換え。', confidence: 'low' }
    ],
    skipped: [{ request: '図を足す', reason: '図の内容が分かりません' }]
  });

  assert.deepEqual(result.edits.map(({ blockIndex, after, delete: remove }) => ({ blockIndex, after, remove })), [
    { blockIndex: 3, after: '止める前に、接続中の利用者がいないことを確かめます。', remove: false },
    { blockIndex: 4, after: '', remove: true }
  ]);
  assert.equal(result.edits[0].before, 'サービスを止めてから起動します。');
  // 表示のための対象は、Markdownの記法ではなく画面に出る文字列です。
  assert.equal(result.edits[1].target.selectedText, '古い注記 もう一つの注記');
  assert.deepEqual(result.skipped.map(({ reason }) => reason), [
    '図の内容が分かりません',
    '同じ箇所に複数の修正案が出たため、最初の1件だけを残しました',
    '書き換える箇所を特定できませんでした',
    `修正案が長すぎます（1件${MAX_EDIT_MARKDOWN_CHARS}文字まで）`
  ]);
  // 原文と同じものは変更ではないので、候補にも「できなかった依頼」にも出しません。
  assert.equal(result.edits.some(({ blockIndex }) => blockIndex === 1), false);
  assert.equal(result.skipped.some(({ request }) => request === '変えていません。'), false);
});

test('a block the model only saw part of is never rewritten', async () => {
  const long = `# 見出し\n\n${'あ'.repeat(MAX_EDIT_BLOCK_CHARS + 10)}`;
  const { blocks } = extractEditableBlocks(long);
  const result = await buildEditProposals(blocks, {
    summary: '',
    edits: [{ blockIndex: 1, markdown: '短くしました。', reason: '長い段落を縮めます。', confidence: 'high' }],
    skipped: []
  });

  assert.deepEqual(result.edits, []);
  assert.match(result.skipped[0].reason, /途中までしか渡していません/);
});

test('a revision needs either an instruction or an open comment, and only open comments travel', async (t) => {
  const { root, store } = await testRoot(t);
  const prompts = [];
  const codex = fakeCodex(prompts);
  const service = new AiService(root, { store, client: codex });

  await assert.rejects(
    () => service.proposeEdits('guide.md', '   '),
    /修正の指示を書くか、未解決のレビューコメント/
  );

  await writeReview(root, 'guide.md', [
    { type: 'paragraph', status: 'open', targetText: 'サービスを止めてから起動します。', comment: '確認を足してください' },
    { type: 'paragraph', status: 'resolved', targetText: 'この手順は当番が読みます。', comment: '直しました' }
  ]);
  const proposal = await service.proposeEdits('guide.md', '');

  assert.equal(proposal.requestedComments, 1, '未解決のコメントだけが依頼になる');
  assert.match(prompts.at(-1), /確認を足してください/);
  assert.equal(prompts.at(-1).includes('直しました'), false, '解決済みのコメントは渡さない');
  assert.match(prompts.at(-1), /<document_blocks>/);
  assert.equal(proposal.documentRevision, documentRevision(DOCUMENT));
});

test('the revision endpoint streams proposals and writes nothing itself', async (t) => {
  const { root } = await testRoot(t);
  const calls = [];
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async proposeEdits(documentPath, instruction, { onDelta }) {
      calls.push([documentPath, instruction]);
      onDelta('{"edits":');
      return { documentRevision: 'abc', summary: '', edits: [], skipped: [], droppedEdits: 0 };
    },
    close() {}
  };
  const { baseUrl } = await startServer(t, root, { aiService, aiToken: 'revise-token' });

  const unauthorized = await fetch(`${baseUrl}/api/ai/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', instruction: '短くして' })
  });
  assert.equal(unauthorized.status, 403);

  const proposed = await fetch(`${baseUrl}/api/ai/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'revise-token' },
    body: JSON.stringify({ path: 'guide.md', instruction: '短くして' })
  });
  const events = (await proposed.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(({ type }) => type), ['started', 'delta', 'result']);
  assert.equal(events.at(-1).documentRevision, 'abc');
  assert.deepEqual(calls, [['guide.md', '短くして']]);

  assert.equal(await fs.readFile(path.join(root, 'guide.md'), 'utf8'), DOCUMENT, '修正案を作るだけでは本文は変わらない');
  assert.deepEqual(await fs.readdir(root), ['guide.md'], 'レビューファイルも作らない');
});

test('an approved revision is written verbatim, and one made against older text is refused', async (t) => {
  const { root } = await testRoot(t);
  const { baseUrl } = await startServer(t, root, {
    aiService: { async status() { return { available: false }; }, close() {} },
    aiToken: 'apply-token'
  });
  const filePath = path.join(root, 'guide.md');
  await writeReview(root, 'guide.md', [{ type: 'document', comment: '全体的に長い' }]);

  const { blocks } = extractEditableBlocks(DOCUMENT);
  const saveFile = (payload) => fetch(`${baseUrl}/api/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const stale = await saveFile({
    path: 'guide.md',
    baseRevision: 'a'.repeat(64),
    edits: [{ blockId: blocks[3].blockId, start: blocks[3].start, end: blocks[3].end, markdown: '別の文。' }]
  });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /修正案を作り直してください/);
  assert.equal(await fs.readFile(filePath, 'utf8'), DOCUMENT, '断った保存は本文へ触らない');

  const applied = await saveFile({
    path: 'guide.md',
    baseRevision: documentRevision(DOCUMENT),
    edits: [{
      blockId: blocks[3].blockId,
      start: blocks[3].start,
      end: blocks[3].end,
      // 記法をそのまま残せるかを見ます。HTMLへ通して戻すと `**` や引用の形が変わります。
      markdown: '**止める前**に、[手順](./check.md)で確認します。'
    }]
  });
  assert.equal(applied.status, 200);
  const result = await applied.json();
  assert.match(result.markdown, /\*\*止める前\*\*に、\[手順\]\(\.\/check\.md\)で確認します。/);
  assert.equal(result.revision, documentRevision(result.markdown));
  assert.equal(await fs.readFile(filePath, 'utf8'), result.markdown);
  // 修正案の保存はコメントを送りません。保存済みのコメントを消さないことが条件です。
  assert.deepEqual(result.review.comments.map(({ comment }) => comment), ['全体的に長い']);
});

async function testRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-document-edits-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-document-edits-data-'));
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));
  return { root, store: new AiStore(root, { dataDir }) };
}

async function startServer(t, root, options) {
  const { app } = createServer(root, options);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** 送られたプロンプトを集めるだけのCodex。修正案は返さないので、答えの形だけ合わせます。 */
function fakeCodex(prompts) {
  let nextThread = 1;
  return {
    model: 'fast-test-model',
    effort: 'low',
    async start() {},
    async createThread() { return `thread-${nextThread++}`; },
    async resumeThread(id) { return id; },
    async deleteThread() {},
    async runTurn({ prompt }) {
      prompts.push(prompt);
      return { text: JSON.stringify({ summary: '', edits: [], skipped: [] }) };
    },
    async close() {}
  };
}
