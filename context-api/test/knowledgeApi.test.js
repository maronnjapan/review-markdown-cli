import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAskPrompt, citedSourceNumbers, createChatModel } from '../src/answer.js';
import { normalizeKnowledgeRequest } from '../src/search.js';
import { assertOrigin, createContextApi } from '../src/server.js';

/**
 * 判断とページをまとめて扱う口（HTTP、`/ask`、MCP、画面の配信）のテストです。
 *
 * `/search` は今までどおりContextだけを返し（review-markdown CLIが動き続けること）、
 * `sources` を指定したときだけページが混ざることを、まず守ります。
 */

test('/search は sources を省くと判断だけを返し、指定すればページも混ざる', async (t) => {
  const { base } = await startApi(t);
  const W = 'WS1';
  await request(base, 'POST', '/contexts', { workspace_id: W, content: 'トークンの有効期限は15分と決めた', scope: 'workspace', kind: 'decision' });
  await request(base, 'POST', '/pages', { workspace_id: W, title: '認証の設計', content: '# トークン\n\n有効期限は15分にする。' });

  const onlyContexts = await request(base, 'POST', '/search', { query: 'トークンの有効期限', workspace_id: W });
  assert.deepEqual(onlyContexts.body.results.map((result) => result.type), ['context']);
  assert.equal(onlyContexts.body.results[0].content, 'トークンの有効期限は15分と決めた', '今までどおりの形で返る');

  const both = await request(base, 'POST', '/search', { query: 'トークンの有効期限', workspace_id: W, sources: ['context', 'page'] });
  assert.deepEqual(new Set(both.body.results.map((result) => result.type)), new Set(['context', 'page']));
  const page = both.body.results.find((result) => result.type === 'page');
  assert.equal(page.title, '認証の設計');
  assert.equal(page.heading, 'トークン');
  assert.equal(page.snippet, '有効期限は15分にする。');
  assert.equal(page.content, page.snippet, 'Contextと同じ欄で読める');
  assert.deepEqual(page.breadcrumb.map((entry) => entry.title), ['認証の設計']);

  const onlyPages = await request(base, 'POST', '/search', { query: 'トークンの有効期限', workspace_id: W, sources: 'page' });
  assert.deepEqual(onlyPages.body.results.map((result) => result.type), ['page']);

  const other = await request(base, 'POST', '/search', { query: 'トークンの有効期限', workspace_id: 'OTHER', sources: ['page'] });
  assert.deepEqual(other.body.results, [], '別のWorkspaceのページは混ざらない');
  const everywhere = await request(base, 'POST', '/search', { query: 'トークンの有効期限', all_workspaces: true, sources: ['page'] });
  assert.equal(everywhere.body.results.length, 1, 'all_workspaces なら範囲を問わず引ける');

  assert.equal((await request(base, 'POST', '/search', { query: 'x', workspace_id: W, sources: ['file'] })).status, 400);
});

test('検索の受け取り。sources の既定と all_workspaces', () => {
  assert.deepEqual(normalizeKnowledgeRequest({ query: 'q', workspace_id: 'W' }).sources, ['context']);
  assert.deepEqual(normalizeKnowledgeRequest({ query: 'q' }, { defaultSources: ['context', 'page'] }).sources, ['context', 'page']);
  const all = normalizeKnowledgeRequest({ query: 'q', all_workspaces: true, include_global: false });
  assert.equal(all.allWorkspaces, true);
  assert.equal(all.workspaceId, null);
  assert.throws(() => normalizeKnowledgeRequest({ query: 'q', sources: [] }), /1つ以上/);
});

test('Workspaceとページの口が、作る・読む・直す・動かす・消す・取り込む・書き出すで答える', async (t) => {
  const { base } = await startApi(t);

  const created = await request(base, 'POST', '/workspaces', { name: '認証基盤' });
  assert.equal(created.status, 201);
  const W = created.body.workspace.workspace_id;
  assert.equal((await request(base, 'GET', `/workspaces/${W}`)).body.workspace.name, '認証基盤');
  await request(base, 'PATCH', `/workspaces/${W}`, { name: '認証基盤2' });

  const root = await request(base, 'POST', '/pages', { workspace_id: W, title: '設計' });
  assert.equal(root.status, 201);
  const child = await request(base, 'POST', '/pages', { workspace_id: W, parent_id: root.body.page.page_id, title: '認証', content: '本文' });
  const tree = await request(base, 'GET', `/workspaces/${W}/pages`);
  assert.deepEqual(tree.body.results.map((page) => [page.title, page.depth]), [['設計', 0], ['認証', 1]]);

  const read = await request(base, 'GET', `/pages/${child.body.page.page_id}`);
  assert.equal(read.body.page.content, '本文');
  assert.deepEqual(read.body.page.breadcrumb.map((entry) => entry.title), ['設計', '認証']);
  const markdown = await fetch(`${base}/pages/${child.body.page.page_id}?format=markdown`);
  assert.match(markdown.headers.get('content-type'), /text\/markdown/);
  assert.equal(await markdown.text(), '# 認証\n\n本文\n');

  const patched = await request(base, 'PATCH', `/pages/${child.body.page.page_id}`, { title: '認証方式', parent_id: null, position: 0 });
  assert.equal(patched.body.title_changed, true);
  assert.equal(patched.body.moved, true);
  assert.deepEqual((await request(base, 'GET', `/workspaces/${W}/pages`)).body.results.map((page) => page.title), ['認証方式', '設計']);

  const imported = await request(base, 'POST', `/workspaces/${W}/import`, { pages: [{ path: 'docs/a.md', content: '# A\n\nbody' }] });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.created, 2);
  const exported = await request(base, 'GET', `/workspaces/${W}/export`);
  assert.deepEqual(exported.body.pages.map((page) => page.path), ['認証方式', '設計', 'docs', 'docs/A']);

  assert.deepEqual((await request(base, 'DELETE', `/pages/${root.body.page.page_id}`)).body.deleted.length, 1);
  assert.equal((await request(base, 'GET', `/pages/${root.body.page.page_id}`)).status, 404);
  assert.equal((await request(base, 'POST', '/pages', { title: 'x' })).status, 400, 'workspace_id が無い');
  assert.equal((await request(base, 'GET', '/workspaces/none')).status, 404);

  const workspaces = await request(base, 'GET', '/workspaces');
  assert.deepEqual(workspaces.body.results.map((workspace) => [workspace.name, workspace.page_count]), [['認証基盤2', 3]]);
  const removed = await request(base, 'DELETE', `/workspaces/${W}`);
  assert.deepEqual(removed.body, { deleted: true, deleted_pages: 3 });
});

test('判断だけを保存したWorkspaceも、一覧に名前無しで並ぶ', async (t) => {
  const { base } = await startApi(t);
  await request(base, 'POST', '/contexts', { workspace_id: 'FROMCLI', content: 'OIDCを使う', scope: 'workspace' });
  const workspaces = await request(base, 'GET', '/workspaces');
  assert.deepEqual(workspaces.body.results.map((workspace) => [workspace.workspace_id, workspace.registered]), [['FROMCLI', false]]);
  const health = await request(base, 'GET', '/health');
  assert.deepEqual(health.body.counts, { contexts: 1, pages: 0, chunks: 1 });
  assert.equal(health.body.chat, null);
  assert.equal(health.body.ui, true);
});

test('/ask は生成モデルが無ければ資料だけを返し、あれば資料を根拠に答えを流す', async (t) => {
  const withoutModel = await startApi(t);
  await request(withoutModel.base, 'POST', '/pages', { workspace_id: 'W', title: '認証', content: 'OIDCを使う。有効期限は15分。' });
  const sourcesOnly = await request(withoutModel.base, 'POST', '/ask', { question: 'OIDC 有効期限', workspace_id: 'W' });
  assert.equal(sourcesOnly.status, 200);
  assert.equal(sourcesOnly.body.answer, null);
  assert.equal(sourcesOnly.body.reason, 'chat_not_configured');
  assert.equal(sourcesOnly.body.sources.length, 1);
  assert.equal((await request(withoutModel.base, 'POST', '/ask', {})).status, 400, 'question が無い');

  const prompts = [];
  const chatModel = {
    id: 'fake', label: 'Fake model',
    async *generate({ system, prompt }) {
      prompts.push({ system, prompt });
      yield 'OIDCを使い';
      yield 'ます [1]';
    }
  };
  const withModel = await startApi(t, { chatModel });
  await request(withModel.base, 'POST', '/pages', { workspace_id: 'W', title: '認証', content: 'OIDCを使う。有効期限は15分。' });
  const answered = await request(withModel.base, 'POST', '/ask', { question: 'OIDC 有効期限', workspace_id: 'W' });
  assert.equal(answered.body.answer, 'OIDCを使います [1]');
  assert.deepEqual(answered.body.cited, [1]);
  assert.deepEqual(answered.body.model, { id: 'fake', label: 'Fake model' });
  assert.match(prompts[0].prompt, /\[1\] ページ: 認証/, '資料は番号付きで渡す');
  assert.match(prompts[0].system, /資料だけを根拠/);

  const streamed = await fetch(`${withModel.base}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'OIDC 有効期限', workspace_id: 'W', stream: true })
  });
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  const events = parseSse(await streamed.text());
  assert.deepEqual(events.map((event) => event.event), ['sources', 'delta', 'delta', 'done']);
  assert.equal(events[0].data.sources.length, 1);
  assert.equal(events[3].data.answer, 'OIDCを使います [1]');
});

test('回答の文面と、根拠の番号の拾い方', () => {
  const { system, prompt } = buildAskPrompt({
    question: '認証方式は？',
    sources: [
      { type: 'context', kind: 'decision', content: 'OIDCを使う', updated_at: '2026-01-02T00:00:00Z' },
      { type: 'page', title: '認証', breadcrumb: [{ title: '設計' }, { title: '認証' }], heading: 'トークン', snippet: '有効期限は15分', updated_at: '2026-01-03T00:00:00Z' }
    ]
  });
  assert.match(system, /番号で示して/);
  assert.match(prompt, /\[1\] 保存した判断（決定）（2026-01-02）\nOIDCを使う/);
  assert.match(prompt, /\[2\] ページ: 設計 › 認証 › トークン（2026-01-03）\n有効期限は15分/);
  assert.match(prompt, /<question>\n認証方式は？\n<\/question>/);
  assert.deepEqual(citedSourceNumbers('OIDCです[1][2]。[9]は無い', 2), [1, 2]);
  assert.equal(createChatModel({ provider: 'none' }), null);
  assert.throws(() => createChatModel({ provider: 'gemini' }), /使えない CHAT_PROVIDER/);
});

test('生成モデルへは、OllamaはNDJSON、OpenAI互換はSSEで話す', async () => {
  const calls = [];
  const ollama = createChatModel({
    provider: 'ollama',
    model: 'llama3.2',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        body: streamOf(['{"message":{"role":"assistant","content":"こん"},"done":false}\n', '{"message":{"content":"にちは"},"done":false}\n{"done":true}\n'])
      };
    }
  });
  assert.equal(await collect(ollama.generate({ system: 's', prompt: 'p' })), 'こんにちは');
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.messages.map((message) => message.role), ['system', 'user']);

  const openai = createChatModel({
    provider: 'openai',
    apiKey: 'k',
    endpoint: 'http://localhost:9999/v1/',
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return {
        ok: true,
        body: streamOf(['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'])
      };
    }
  });
  assert.equal(await collect(openai.generate({ system: 's', prompt: 'p' })), 'Hello');
  assert.equal(calls[1].url, 'http://localhost:9999/v1/chat/completions');
  assert.equal(calls[1].headers.Authorization, 'Bearer k');

  const noKey = createChatModel({ provider: 'openai' , apiKey: undefined });
  await assert.rejects(() => collect(noKey.generate({ system: 's', prompt: 'p' })), /CHAT_API_KEY/);
  const down = createChatModel({ provider: 'ollama', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => collect(down.generate({ system: 's', prompt: 'p' })), /繋がりませんでした/);
});

test('MCPの口は initialize、tools/list、tools/call に答え、通知には202で答える', async (t) => {
  const { base } = await startApi(t);
  await request(base, 'POST', '/contexts', { workspace_id: 'W', content: 'このプロジェクトではOIDCを利用する', scope: 'workspace', kind: 'decision' });

  const initialized = await request(base, 'POST', '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.protocolVersion, '2025-03-26', '知っている版は、求められた版で答える');
  assert.equal(initialized.body.result.serverInfo.name, 'review-markdown-context-api');
  assert.ok(initialized.body.result.capabilities.tools);

  const notified = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });
  assert.equal(notified.status, 202);
  assert.equal(await notified.text(), '');

  const listed = await request(base, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['search_knowledge', 'read_page', 'list_pages', 'list_workspaces', 'create_page', 'update_page', 'save_context', 'list_contexts']);
  assert.ok(listed.body.result.tools.every((tool) => tool.inputSchema?.type === 'object'));

  const searched = await request(base, 'POST', '/mcp', {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'search_knowledge', arguments: { query: 'このプロジェクトの認証方式', workspace_id: 'W' } }
  });
  assert.equal(searched.body.result.isError, false);
  assert.match(searched.body.result.content[0].text, /\[decision\] \(context_id: ctx_/);
  assert.equal(searched.body.result.structuredContent.results[0].type, 'context');

  const createdPage = await request(base, 'POST', '/mcp', {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'create_page', arguments: { workspace_id: 'W', title: '議事録', content: '決めたこと' } }
  });
  const pageId = createdPage.body.result.structuredContent.page.page_id;
  await request(base, 'POST', '/mcp', {
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'update_page', arguments: { page_id: pageId, append: '追記' } }
  });
  const read = await request(base, 'POST', '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_page', arguments: { page_id: pageId } } });
  assert.match(read.body.result.content[0].text, /決めたこと\n\n追記/);

  const saved = await request(base, 'POST', '/mcp', {
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'save_context', arguments: { content: '常にstrictモード', kind: 'preference' } }
  });
  assert.equal(saved.body.result.structuredContent.context.scope, 'global', 'workspace_id が無ければ global');
  assert.equal(saved.body.result.structuredContent.context.source_type, 'agent');

  const failed = await request(base, 'POST', '/mcp', { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'read_page', arguments: { page_id: 'pg_none' } } });
  assert.equal(failed.body.result.isError, true, '使い方の誤りはツールの結果として返す');
  const unknown = await request(base, 'POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal(unknown.body.error.code, -32601);
  const unknownTool = await request(base, 'POST', '/mcp', { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknownTool.body.error.code, -32602);
  assert.equal((await fetch(`${base}/mcp`)).status, 405, 'サーバから話しかける流れは持たない');
});

test('画面は / と /ui/ の下だけを配り、外へは出ない。APIだけの設定なら配らない', async (t) => {
  const publicDir = await temporaryDir(t);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Knowledge</title>');
  await fs.mkdir(path.join(publicDir, 'js'));
  await fs.writeFile(path.join(publicDir, 'js', 'main.js'), 'export {};');

  const { base } = await startApi(t, { publicDir });
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /Knowledge/);
  const script = await fetch(`${base}/ui/js/main.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const cached = await fetch(`${base}/ui/js/main.js`, { headers: { 'If-None-Match': script.headers.get('etag') } });
  assert.equal(cached.status, 304);
  assert.equal((await fetch(`${base}/ui/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/ui/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/index.js`)).status, 404, '/ui/ の外は配らない');
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);

  const headless = await startApi(t, { ui: false });
  assert.equal((await fetch(headless.base)).status, 404);
  assert.equal((await request(headless.base, 'GET', '/health')).body.ui, false);
});

test('ブラウザから来た要求は、この端末のものだけを通す', () => {
  const requestFrom = (origin, host = '127.0.0.1:8765') => ({ headers: { ...(origin ? { origin } : {}), host } });
  assert.doesNotThrow(() => assertOrigin(requestFrom(undefined)), 'ブラウザ以外（CLI、curl）は Origin を持たない');
  assert.doesNotThrow(() => assertOrigin(requestFrom('http://127.0.0.1:8765')));
  assert.doesNotThrow(() => assertOrigin(requestFrom('http://localhost:3000')), '同じ端末の別のポートは通す');
  assert.doesNotThrow(() => assertOrigin(requestFrom('http://nas.local:8765', 'nas.local:8765')), '自分自身と同じ Host は通す');
  assert.throws(() => assertOrigin(requestFrom('http://evil.example')), (error) => error.statusCode === 403);
  assert.throws(() => assertOrigin(requestFrom('not a url')), (error) => error.statusCode === 403);
});

/* ---------------------------------------------------------------- *
 * 道具
 * ---------------------------------------------------------------- */

async function temporaryDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-markdown-knowledge-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startApi(t, options = {}) {
  // 索引は保存のあとで非同期に作られるので、ディレクトリを消す前に列が空になるのを待ちます。
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-markdown-knowledge-'));
  const api = createContextApi({ dataDir, vectorStore: { kind: 'local' }, ...options });
  await api.ready();
  const server = api.listen(0, { host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await api.pages.close();
    await api.store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { api, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

async function collect(iterator) {
  let text = '';
  for await (const delta of iterator) text += delta;
  return text;
}
