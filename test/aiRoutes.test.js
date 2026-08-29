import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

test('the manager and translation routes are unavailable by default', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-disabled-features-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async translate() { throw new Error('disabled translation must not run'); },
    async composeDocumentBrief() { throw new Error('disabled manager must not run'); },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'disabled-token' });
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
  const opened = await fetch(`${baseUrl}/api/file?path=guide.md`).then((response) => response.json());
  assert.deepEqual(opened.features, { manager: false, translation: false });

  const headers = { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'disabled-token' };
  for (const [endpoint, body] of [
    ['/api/ai/translate', { path: 'guide.md', target: { type: 'paragraph', selectedText: 'Run.' } }],
    ['/api/ai/brief', { path: 'guide.md', input: '運用手順' }]
  ]) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    assert.equal(response.status, 404, `${endpoint} は明示的に有効化するまで使えない`);
  }

  const briefSave = await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', brief: { purpose: 'x', story: 'y', expectation: 'z' } })
  });
  assert.equal(briefSave.status, 404, '無効時は直接APIから管理者の前提も保存できない');
});

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
  const { app } = createServer(root, { aiService, aiToken: 'test-launch-token', translation: true });
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
  assert.equal(
    applyAttempt.status,
    404,
    'no AI endpoint writes to the document: an approved revision goes through /api/file like any other save'
  );
});

test('a saved chat is corrected through the same guarded endpoint', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-conversation-edit-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');
  const edits = [];
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async updateConversation(id, payload) {
      edits.push([id, payload]);
      return { id, title: payload.title, messages: payload.messages, codexThreadId: null };
    },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'edit-token' });
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
  const body = JSON.stringify({
    id: 'conversation-1',
    title: 'run の訳語',
    messages: [{ id: 'user-1', content: 'この文脈の run はどう訳す？' }]
  });

  const unauthorized = await fetch(`${baseUrl}/api/ai/conversation`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  assert.equal(unauthorized.status, 403, '記録の書き換えも、ほかのAI操作と同じ関門を通す');

  const response = await fetch(`${baseUrl}/api/ai/conversation`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'edit-token' },
    body
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).conversation.title, 'run の訳語');
  assert.deepEqual(edits, [['conversation-1', {
    title: 'run の訳語',
    messages: [{ id: 'user-1', content: 'この文脈の run はどう訳す？' }]
  }]], '題名と残すやり取りだけが、そのまま渡る');
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

test('the manager endpoint streams a draft, and the three settled points save with the review', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-brief-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const calls = [];
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async composeDocumentBrief(documentPath, input, { onDelta }) {
      calls.push(['brief', documentPath, input]);
      onDelta('{"purpose":');
      return {
        brief: { purpose: '当番が一人で再起動できるようになる。', story: '', expectation: '' },
        // 埋まらなかった項目は、埋めずに問いとして返します。
        questions: ['止めてよい条件は誰が決めますか。', '読んだ人に何を判断してほしいですか。'],
        assumptions: []
      };
    },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'brief-token', manager: true });
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
  const withToken = { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'brief-token' };

  const unauthorized = await fetch(`${baseUrl}/api/ai/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', input: 'x' })
  });
  assert.equal(unauthorized.status, 403);

  const events = await fetch(`${baseUrl}/api/ai/brief`, {
    method: 'POST',
    headers: withToken,
    body: JSON.stringify({ path: 'guide.md', input: '運用チームから当番向けの手順を頼まれた。' })
  }).then(async (response) => (await response.text()).trim().split('\n').map(JSON.parse));
  assert.deepEqual(events.map(({ type }) => type), ['started', 'delta', 'result']);
  assert.equal(events.at(-1).brief.purpose, '当番が一人で再起動できるようになる。');
  assert.deepEqual(events.at(-1).questions.length, 2);
  assert.deepEqual(calls, [['brief', 'guide.md', '運用チームから当番向けの手順を頼まれた。']]);

  // 組み立てただけでは何も残りません。保存の要求で初めてファイルへ入ります。
  assert.equal((await fetch(`${baseUrl}/api/file?path=guide.md`).then((r) => r.json())).review.brief, null);

  const brief = {
    purpose: '当番が一人で再起動できるようになる。',
    story: '止めてよい条件 → 止める手順 → 戻ったことの確かめ方。',
    expectation: '再起動についての問い合わせが来なくなる。'
  };
  const saved = await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', brief })
  }).then((response) => response.json());
  assert.equal(saved.review.brief.story, brief.story);

  const opened = await fetch(`${baseUrl}/api/file?path=guide.md`).then((response) => response.json());
  assert.equal(opened.review.brief.purpose, brief.purpose, '開き直しても3点は残る');

  // null は「3つを消す」です。コメントだけを送る保存（undefined）と区別します。
  await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', comments: [] })
  });
  assert.equal((await fetch(`${baseUrl}/api/file?path=guide.md`).then((r) => r.json())).review.brief.purpose, brief.purpose);
  const cleared = await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', brief: null })
  }).then((response) => response.json());
  assert.equal(cleared.review.brief, undefined);

  const outsideRoot = await fetch(`${baseUrl}/api/ai/brief`, {
    method: 'POST',
    headers: withToken,
    body: JSON.stringify({ path: '../secret.md', input: 'x' })
  });
  assert.equal(outsideRoot.status, 400, 'レビュー対象ディレクトリの外は読ませない');
});

test('the review endpoints list skills, read one, rebuild a persona, and stream proposals', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-review-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const calls = [];
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async listReviewSkills() {
      calls.push(['skills']);
      return [{ id: 'reader-fit-review', name: '読み手適合レビュー', description: '読み手に届くかを見る。', source: 'builtin' }];
    },
    async readReviewSkill(skillId) {
      calls.push(['skill', skillId]);
      return { id: skillId, name: '読み手適合レビュー', source: 'builtin', instructions: '# 読み手適合レビュー\n\n読めるかを見る。' };
    },
    async composePersona(documentPath, input) {
      calls.push(['persona', documentPath, input]);
      return { label: '運用当番の新人', goals: ['手順どおり作業する'], input };
    },
    async reviewDocument(documentPath, { skillIds }, { onDelta }) {
      calls.push(['review', documentPath, skillIds]);
      onDelta('{"summary":');
      return {
        skills: skillIds.map((id) => ({ id, name: '読み手適合レビュー', source: 'builtin' })),
        summary: 'この読み手には前提が足りません。',
        placements: [{
          comment: '実行前の確認を書いてください',
          reason: '対象の段落です',
          severity: 'must',
          confidence: 'high',
          target: { type: 'paragraph', selectedText: 'Run the program.', headingPath: ['Guide'] }
        }],
        unplaced: [],
        droppedPlacements: 0
      };
    },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'review-token' });
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
  const withToken = { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'review-token' };

  for (const [url, options] of [
    ['/api/ai/review-skills', {}],
    ['/api/ai/review-skill?id=reader-fit-review', {}],
    ['/api/ai/persona', { method: 'POST', body: JSON.stringify({ path: 'guide.md', input: 'x' }) }],
    ['/api/ai/review', { method: 'POST', body: JSON.stringify({ path: 'guide.md', skillIds: ['reader-fit-review'] }) }]
  ]) {
    const response = await fetch(`${baseUrl}${url}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    assert.equal(response.status, 403, `${url} はトークンなしでは答えない`);
  }

  const skills = await fetch(`${baseUrl}/api/ai/review-skills`, { headers: withToken }).then((r) => r.json());
  assert.deepEqual(skills.skills.map(({ id }) => id), ['reader-fit-review']);

  // 選ぶ前に、そのスキルが何を見るのかを画面で読めます。
  const skill = await fetch(`${baseUrl}/api/ai/review-skill?id=reader-fit-review`, { headers: withToken })
    .then((r) => r.json());
  assert.match(skill.skill.instructions, /読めるかを見る。/);

  const personaEvents = await fetch(`${baseUrl}/api/ai/persona`, {
    method: 'POST',
    headers: withToken,
    body: JSON.stringify({ path: 'guide.md', input: '異動したての運用担当' })
  }).then(async (response) => (await response.text()).trim().split('\n').map(JSON.parse));
  assert.deepEqual(personaEvents.map(({ type }) => type), ['started', 'result']);
  assert.equal(personaEvents.at(-1).persona.label, '運用当番の新人');

  const reviewEvents = await fetch(`${baseUrl}/api/ai/review`, {
    method: 'POST',
    headers: withToken,
    body: JSON.stringify({ path: 'guide.md', skillIds: ['reader-fit-review', 'ops-review'] })
  }).then(async (response) => (await response.text()).trim().split('\n').map(JSON.parse));
  assert.deepEqual(reviewEvents.map(({ type }) => type), ['started', 'delta', 'result']);
  assert.equal(reviewEvents.at(-1).summary, 'この読み手には前提が足りません。');
  assert.equal(reviewEvents.at(-1).placements[0].severity, 'must');

  // 組み直したペルソナは、レビューではなく保存の要求で初めてファイルへ入ります。
  const saved = await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'guide.md', persona: personaEvents.at(-1).persona })
  }).then((response) => response.json());
  assert.equal(saved.review.persona.label, '運用当番の新人');

  const opened = await fetch(`${baseUrl}/api/file?path=guide.md`).then((response) => response.json());
  assert.equal(opened.review.persona.label, '運用当番の新人', '開き直しても読み手は残る');
  assert.deepEqual(calls, [
    ['skills'],
    ['skill', 'reader-fit-review'],
    ['persona', 'guide.md', '異動したての運用担当'],
    ['review', 'guide.md', ['reader-fit-review', 'ops-review']]
  ], 'スキルは選んだ分だけまとめて渡す');

  const outsideRoot = await fetch(`${baseUrl}/api/ai/review`, {
    method: 'POST',
    headers: withToken,
    body: JSON.stringify({ path: '../secret.md', skillIds: ['reader-fit-review'] })
  });
  assert.equal(outsideRoot.status, 400, 'レビュー対象ディレクトリの外は読ませない');
});

test('path を書き忘れたAI要求は、ストリームを開く前に400で断る', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-routes-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async translate() { throw new Error('対象が決まる前に呼んではいけない'); },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'test-launch-token', translation: true });
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

  const response = await fetch(`${baseUrl}/api/ai/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'test-launch-token' },
    body: JSON.stringify({ target: { selectedText: 'run' } })
  });

  // 200 でストリームを開いてから中身をエラーにすると、呼ぶ側は「使い方の誤り」と
  // 「AIの失敗」を区別できません。
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /path is required/);
});
