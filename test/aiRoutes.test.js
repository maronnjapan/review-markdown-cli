import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

test('AI routes require a per-launch token and stream read-only results', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-routes-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const calls = [];
  const aiService = {
    async status() { return { available: true, provider: 'codex', model: 'fast-test-model', effort: 'low' }; },
    async listConversations(documentPath) { calls.push(['list', documentPath]); return []; },
    async translate(documentPath, target, { onDelta }) {
      calls.push(['translate', documentPath, target]);
      onDelta('{"translation":');
      return { kind: 'passage', result: { translation: 'プログラムを実行する。', notes: [] } };
    },
    async createConversation() { throw new Error('not used'); },
    async sendMessage() { throw new Error('not used'); },
    async deleteConversation() {},
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'test-launch-token' });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const statusResponse = await fetch(`${baseUrl}/api/ai/status`);
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await statusResponse.json(), {
    token: 'test-launch-token',
    available: true,
    provider: 'codex',
    model: 'fast-test-model',
    effort: 'low'
  });

  const unauthorized = await fetch(`${baseUrl}/api/ai/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', target: { type: 'paragraph', selectedText: 'Run the program.' } })
  });
  assert.equal(unauthorized.status, 403);

  const translated = await fetch(`${baseUrl}/api/ai/translate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Review-Markdown-Token': 'test-launch-token'
    },
    body: JSON.stringify({ path: 'guide.md', target: { type: 'paragraph', selectedText: 'Run the program.' } })
  });
  assert.equal(translated.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const events = (await translated.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(({ type }) => type), ['started', 'delta', 'result']);
  assert.equal(events.at(-1).translation.result.translation, 'プログラムを実行する。');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['translate', 'guide.md']);

  const conversations = await fetch(`${baseUrl}/api/ai/conversations?path=guide.md`, {
    headers: { 'X-Review-Markdown-Token': 'test-launch-token' }
  });
  assert.equal(conversations.status, 200);
  assert.deepEqual(await conversations.json(), { conversations: [] });

  const crossOrigin = await fetch(`${baseUrl}/api/ai/status`, { headers: { Origin: 'http://example.test' } });
  assert.equal(crossOrigin.status, 403);

  const applyAttempt = await fetch(`${baseUrl}/api/ai/apply`, {
    method: 'POST',
    headers: { 'X-Review-Markdown-Token': 'test-launch-token' }
  });
  assert.equal(applyAttempt.status, 404, 'there is no endpoint that applies AI output to the document');
});

test('comment placement streams proposals and never writes them itself', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-place-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const calls = [];
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async placeComments(documentPath, notes, { onDelta }) {
      calls.push([documentPath, notes]);
      onDelta('{"placements":');
      return {
        placements: [{
          comment: '手順を具体的に',
          reason: '対象の段落です',
          confidence: 'high',
          target: { type: 'paragraph', selectedText: 'Run the program.', targetText: 'Run the program.', headingPath: ['Guide'] }
        }],
        unplaced: [],
        droppedPlacements: 0
      };
    },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'place-token' });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/api/ai/place-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', notes: '手順を具体的に' })
  });
  assert.equal(unauthorized.status, 403);

  const placed = await fetch(`${baseUrl}/api/ai/place-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'place-token' },
    body: JSON.stringify({ path: 'guide.md', notes: '手順を具体的に' })
  });
  const events = (await placed.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(({ type }) => type), ['started', 'delta', 'result']);
  assert.equal(events.at(-1).placements[0].target.selectedText, 'Run the program.');
  assert.deepEqual(calls, [['guide.md', '手順を具体的に']]);

  const outsideRoot = await fetch(`${baseUrl}/api/ai/place-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'place-token' },
    body: JSON.stringify({ path: '../secret.md', notes: '手順を具体的に' })
  });
  assert.equal(outsideRoot.status, 400, 'レビュー対象ディレクトリの外は配置対象にできない');

  assert.deepEqual(await fs.readdir(root), ['guide.md'], '配置だけでは何も保存しない');
});

test('the reading context travels with the review, and a context only save keeps the comments', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-context-routes-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const { app } = createServer(root, {
    aiContext: 'このディレクトリは入門書の原稿。',
    aiService: { async status() { return { available: false }; }, close() {} },
    aiToken: 'test-launch-token'
  });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const saveReview = (payload) => fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then((response) => response.json());

  await saveReview({
    path: 'guide.md',
    comments: [{ type: 'document', comment: '結論を先に' }],
    aiContext: '第3章。読者は初学者。'
  });
  // The page beacon on the way out carries the context alone.
  const kept = await saveReview({ path: 'guide.md', aiContext: '第3章。読者は当番の担当者。' });
  assert.equal(kept.review.comments.length, 1, 'コメントを送らない保存では消さない');
  assert.equal(kept.review.aiContext, '第3章。読者は当番の担当者。');

  const opened = await fetch(`${baseUrl}/api/file?path=guide.md`).then((response) => response.json());
  assert.equal(opened.review.aiContext, '第3章。読者は当番の担当者。');
  assert.equal(opened.projectAiContext, 'このディレクトリは入門書の原稿。', '設定ファイル側の前提も画面へ返す');

  const exported = await fetch(`${baseUrl}/api/export?path=guide.md`).then((response) => response.text());
  assert.match(exported, /## 読み取りコンテキスト\n\n第3章。読者は当番の担当者。/);
});
