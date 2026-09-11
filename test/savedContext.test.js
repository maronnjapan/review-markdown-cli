import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import { normalizeConfigValue } from '../src/config.js';
import { createServer } from '../src/server.js';
import { citedContextIds, evidenceFrom, normalizeContextPlan } from '../src/contextRouting.js';
import { createContextService, createDisabledContextService } from '../src/contextService.js';
import { createWorkspaceId, ensureWorkspaceId, readWorkspaceId, scopePathFor } from '../src/workspace.js';

/**
 * 保存した判断を、CLIの側から使うところのテストです。
 *
 * 仕様10章の受け入れケースのうち、CLIを通すものをここで守ります。
 * 保存したものが再起動後の回答に出ること（ケース1）、ローカルファイルはContextが無くても
 * 読めること（ケース2）、預け先が止まっていても止まらないこと（ケース4）、
 * 該当が無いときに一般論で埋めないこと（ケース7）、根拠が出ること（ケース8）。
 */

test('Workspace idは、Contextを使うときに初めて作る', async (t) => {
  const root = await temporaryDir(t);

  // 原稿を開いただけのディレクトリには書きません（仕様4.2の【要確認3】への回答）。
  assert.equal(await readWorkspaceId(root), null);
  assert.equal(await exists(path.join(root, '.review', 'workspace.json')), false);

  const first = await ensureWorkspaceId(root);
  assert.equal(first.created, true);
  assert.match(first.workspaceId, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULIDの26文字');

  const second = await ensureWorkspaceId(root);
  assert.equal(second.created, false);
  assert.equal(second.workspaceId, first.workspaceId, '開き直しても同じWorkspaceとして扱う');
});

test('Workspace idは作った順に並ぶので、パスが変わっても同じものとして扱える', () => {
  const earlier = createWorkspaceId(1_700_000_000_000);
  const later = createWorkspaceId(1_700_000_001_000);
  assert.ok(earlier < later, '先頭が時刻なので、文字列の比較で作った順になる');
  assert.notEqual(createWorkspaceId(1_700_000_000_000), createWorkspaceId(1_700_000_000_000), '同じ時刻でも衝突しない');
});

test('検索範囲に渡すのは、開いているファイルのディレクトリ1つだけ', () => {
  assert.equal(scopePathFor('src/auth/oauth/token.ts'), 'src/auth/oauth');
  assert.equal(scopePathFor('README.md'), null, 'Workspace直下にはディレクトリの範囲が無い');
  assert.equal(scopePathFor(''), null);
});

test('預け先を設定していなければ、Contextの操作だけが断られる', async () => {
  const service = createDisabledContextService();
  assert.equal(service.enabled, false);
  assert.deepEqual(await service.status(), { configured: false, available: false, endpoint: null });
  await assert.rejects(() => service.searchContext('認証'), (error) => {
    assert.equal(error.unavailable, true, 'CLIは接続不能と同じ扱いにできる');
    return true;
  });
});

test('接続できないことと503は、同じ「利用不可」として扱う', async (t) => {
  const root = await temporaryDir(t);
  const refused = createContextService({
    rootDir: root,
    endpoint: 'http://127.0.0.1:9',
    fetchImpl: async () => { throw new Error('fetch failed'); }
  });
  const unavailable = createContextService({
    rootDir: root,
    endpoint: 'http://127.0.0.1:8765',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Vector DBを利用できません' }), { status: 503 })
  });

  for (const service of [refused, unavailable]) {
    assert.equal((await service.status()).available, false);
    await assert.rejects(() => service.searchContext('認証'), (error) => {
      assert.equal(error.unavailable, true);
      // 画面へ出るときも 503 のままにします。500 だとこのアプリの不具合に見え、
      // 直す先（Context APIを起動する）が分かりません。
      assert.equal(error.statusCode, 503);
      return true;
    });
  }

  // 使い方の誤りは、こちらの落ち度として素直に出します（握りつぶすと直せません）。
  const badRequest = createContextService({
    rootDir: root,
    endpoint: 'http://127.0.0.1:8765',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'scope_path が必要です' }), { status: 400 })
  });
  await assert.rejects(() => badRequest.searchContext('認証'), (error) => {
    assert.equal(error.unavailable, undefined);
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test('workspace_id と scope_path は、呼ぶ側ではなくServiceが補う', async (t) => {
  const root = await temporaryDir(t);
  const sent = [];
  const service = createContextService({
    rootDir: root,
    endpoint: 'http://127.0.0.1:8765',
    fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ context_id: 'ctx_1', results: [] }), { status: 200 });
    }
  });

  await service.saveContext('Refresh TokenをAgentへ渡さない', {
    scope: 'path',
    documentPath: 'src/auth/oauth/token.md',
    kind: 'decision'
  });
  const workspaceId = await readWorkspaceId(root);
  assert.equal(sent[0].body.workspace_id, workspaceId, '保存のときにWorkspace idを作る');
  assert.equal(sent[0].body.scope_path, 'src/auth/oauth', '開いているファイルのディレクトリになる');

  await service.searchContext('Refresh Token', { documentPath: 'src/auth/oauth/token.md' });
  assert.equal(sent[1].body.scope_path, 'src/auth/oauth');
  assert.equal(sent[1].body.include_global, true);
  assert.equal(sent[1].body.limit, 5, '既定は5件（仕様6.4の【要確認6】への回答）');

  // Workspace直下のファイルには、ディレクトリの範囲がありません。
  await assert.rejects(
    () => service.saveContext('x', { scope: 'path', documentPath: 'README.md' }),
    /Workspace直下/
  );
});

test('預け先のURLは、原稿のリポジトリからは受け取らない', () => {
  assert.equal(normalizeConfigValue('contextEndpoint', 'http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');
  assert.throws(() => normalizeConfigValue('contextEndpoint', 'ftp://example.com'), /http または https/);
  assert.throws(() => normalizeConfigValue('contextEndpoint', 'http://example.com/collect'), /パスやクエリ/);
});

test('回答が名指しした判断だけを、根拠として出す', () => {
  const contexts = [
    { context_id: 'ctx_1', content: 'OIDCを利用する', scope: 'workspace', kind: 'decision' },
    { context_id: 'ctx_2', content: '請求は月末締め', scope: 'workspace', kind: 'note' }
  ];

  assert.deepEqual(citedContextIds('認証はOIDCです[ctx_1]。', contexts), ['ctx_1']);
  // モデルが作ったidは捨てます。存在しない根拠が根拠として表示されるからです。
  assert.deepEqual(citedContextIds('根拠は[ctx_99]です。', contexts), []);

  const evidence = evidenceFrom(contexts, '認証はOIDCです[ctx_1]。');
  assert.deepEqual(evidence.map(({ contextId, cited }) => [contextId, cited]), [['ctx_1', true], ['ctx_2', false]]);
});

test('検索語の無い計画は、検索しないほうへ倒す', () => {
  assert.deepEqual(normalizeContextPlan({ needsContext: true, query: '認証方式', reason: '過去の決定' }), {
    needsContext: true, query: '認証方式', reason: '過去の決定'
  });
  assert.equal(normalizeContextPlan({ needsContext: true, query: '   ' }).needsContext, false);
  assert.equal(normalizeContextPlan({ needsContext: false, query: '認証' }).needsContext, false);
  assert.equal(normalizeContextPlan(null).needsContext, false);
});

test('保存した判断は、CLIを立ち上げ直しても回答に出て、根拠も付く', async (t) => {
  const { service, root, store, endpoint, prompts } = await startChat(t);
  await service.saveContext('このプロジェクトではOIDCを利用する', { scope: 'workspace', kind: 'decision' });

  // 立ち上げ直しは、同じディレクトリに対して AiService を作り直すのと同じです。
  const restarted = new AiService(root, {
    store,
    client: fakeClient(prompts),
    contextService: createContextService({ rootDir: root, endpoint })
  });
  const conversation = await restarted.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  const { message } = await restarted.sendMessage(conversation.id, 'このプロジェクトの認証方式って何？');

  assert.match(message.content, /OIDC/);
  assert.equal(message.context.status, 'used');
  assert.equal(message.context.evidence.length, 1);
  assert.equal(message.context.evidence[0].cited, true, 'どの判断を根拠にしたかが記録に残る');
  assert.equal(message.context.evidence[0].content, 'このプロジェクトではOIDCを利用する');
  assert.match(prompts.at(-1), /<saved_contexts>/);
});

test('要らないと判断した質問では、保存した判断を引かない', async (t) => {
  const { service, prompts } = await startChat(t, { needsContext: false });
  await service.saveContext('このプロジェクトではOIDCを利用する', { scope: 'workspace', kind: 'decision' });

  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  const { message } = await service.sendMessage(conversation.id, 'JWTって何？');

  assert.equal(message.context.status, 'skipped');
  assert.equal(message.context.evidence, undefined);
  // 引かなかったときの文面は、この機能が無かった頃と変わりません。
  assert.doesNotMatch(prompts.at(-1), /saved_contexts/);
});

test('保存した判断が無いときは、無かったと言わせる文面になる', async (t) => {
  const { service, prompts } = await startChat(t);
  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  const { message } = await service.sendMessage(conversation.id, 'このプロジェクトの認証方式って何？');

  assert.equal(message.context.status, 'used');
  assert.equal(message.context.evidence, undefined, '根拠は1件も無い');
  assert.match(prompts.at(-1), /<saved_contexts count="0">/);
  assert.match(prompts.at(-1), /never present it as a decision this project already made/);
});

test('預け先が止まっていても会話は続き、引けなかったことを回答へ添える', async (t) => {
  const { service, closeApi, prompts } = await startChat(t);
  await service.saveContext('このプロジェクトではOIDCを利用する', { scope: 'workspace', kind: 'decision' });
  await closeApi();

  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  const { message } = await service.sendMessage(conversation.id, 'このプロジェクトの認証方式って何？');

  assert.equal(message.context.status, 'unavailable');
  assert.match(message.context.error, /Context API を利用できません/);
  assert.match(prompts.at(-1), /<saved_contexts status="unavailable">/);
  assert.ok(message.content, '相談そのものは止まらない');
});

test('訂正すると、次の質問からは直したあとの判断が回答に出る', async (t) => {
  const { service } = await startChat(t);
  const created = await service.saveContext('このプロジェクトではOIDCを利用する', { scope: 'workspace', kind: 'decision' });
  await service.updateContext(created.context_id, { content: '認証方式をOIDCからSAMLへ変更した' });

  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  const { message } = await service.sendMessage(conversation.id, 'このプロジェクトの認証方式って何？');

  assert.deepEqual(message.context.evidence.map(({ content }) => content), ['認証方式をOIDCからSAMLへ変更した']);
  assert.doesNotMatch(message.content, /OIDCを利用する/, '古い決定は前提として渡っていない');

  await service.deleteContext(created.context_id);
  assert.deepEqual(await service.listContexts(), [], '消せば一覧からも消える');
});

/* ---------------------------------------------------------------- *
 * 道具
 * ---------------------------------------------------------------- */

async function temporaryDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-markdown-saved-context-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 預け先の代わりです。仕様6章の口だけを、その場で覚える形で実装しています。
 *
 * 本物（`context-api/`）を呼ばないのは、CLIが預け先の中身を知らないことを、テストでも
 * 守るためです。CLIが当てにしてよいのはHTTPの約束だけで、索引がChromaDBかどうかも、
 * 埋め込みが何かも関係ありません。ここが本物を読み込んでいると、あちらを作り替えた
 * だけでこちらが落ち、「CLIは預け先の中身を知らない」が嘘になります。
 * 約束そのものが守られているかは `context-api/test/` が見ています。
 */
async function startStubContextApi() {
  const contexts = new Map();
  let nextId = 0;

  const handle = async (request) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await readBody(request);
    const id = url.pathname.startsWith('/contexts/') ? decodeURIComponent(url.pathname.slice('/contexts/'.length)) : null;

    if (url.pathname === '/health') return [200, { status: 'ok', embedding: { id: 'stub' }, vector_store: { id: 'stub' } }];
    if (url.pathname === '/contexts' && request.method === 'POST') {
      if (!body.content) return [400, { error: 'content を指定してください' }];
      const now = new Date().toISOString();
      const context = {
        context_id: `ctx_stub_${nextId += 1}`,
        workspace_id: body.workspace_id ?? null,
        content: body.content,
        scope: body.scope || 'workspace',
        scope_path: body.scope_path ?? null,
        kind: body.kind || 'note',
        source_type: body.source_type || 'manual',
        source_path: body.source_path ?? null,
        created_at: now,
        updated_at: now
      };
      contexts.set(context.context_id, context);
      return [201, { context_id: context.context_id, created_at: now }];
    }
    if (url.pathname === '/contexts' && request.method === 'GET') {
      return [200, { results: [...contexts.values()] }];
    }
    if (id && request.method === 'GET') {
      return contexts.has(id) ? [200, { context: contexts.get(id) }] : [404, { error: '見つかりません' }];
    }
    if (id && request.method === 'PATCH') {
      if (!contexts.has(id)) return [404, { error: '見つかりません' }];
      const updated = { ...contexts.get(id), ...body, updated_at: new Date().toISOString() };
      contexts.set(id, updated);
      return [200, { context: updated }];
    }
    if (id && request.method === 'DELETE') {
      return contexts.delete(id) ? [200, { deleted: true }] : [404, { error: '見つかりません' }];
    }
    if (url.pathname === '/search' && request.method === 'POST') {
      if (!body.query) return [400, { error: 'query を指定してください' }];
      const allowed = scopeKeys(body);
      const results = [...contexts.values()]
        .filter((context) => allowed.has(scopeKeyOf(context)))
        .map((context) => ({ ...context, score: overlap(body.query, context.content) }))
        .filter((context) => context.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, body.limit || 5);
      return [200, { results }];
    }
    return [404, { error: 'Not found' }];
  };

  const server = http.createServer((request, response) => {
    handle(request).then(([status, payload]) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    server,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    closeApi: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 範囲キー。本物と同じ決まりです（`context-api/src/scope.js`）。 */
function scopeKeyOf(context) {
  if (context.scope === 'global') return 'global';
  if (context.scope === 'workspace') return `ws:${context.workspace_id}`;
  return `path:${context.workspace_id}:${context.scope_path}`;
}

/** 開いている場所から、祖先ディレクトリまで。展開の決まりも本物と同じです。 */
function scopeKeys({ workspace_id: workspaceId, scope_path: scopePath, include_global: includeGlobal = true }) {
  const keys = new Set();
  if (workspaceId) {
    const segments = String(scopePath || '').split('/').filter(Boolean);
    for (let length = segments.length; length > 0; length -= 1) {
      keys.add(`path:${workspaceId}:${segments.slice(0, length).join('/')}`);
    }
    keys.add(`ws:${workspaceId}`);
  }
  if (includeGlobal) keys.add('global');
  return keys;
}

/** 近さの代わり。語がいくつ重なったかだけを数えます。 */
function overlap(query, content) {
  const words = String(query).split(/[\s、。]+/).filter((word) => word.length > 1);
  const hits = words.filter((word) => content.includes(word)).length;
  return words.length ? hits / words.length : 0;
}

/** 預け先の代わりを立て、そこへ繋いだ AiService を作ります。AIも差し替えます。 */
async function startChat(t, { needsContext = true } = {}) {
  const root = await temporaryDir(t);
  const dataDir = await temporaryDir(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# 手順\n\n本文です。\n', 'utf8');

  const { server, endpoint, closeApi } = await startStubContextApi();
  t.after(() => (server.listening ? closeApi() : null));

  const prompts = [];
  const store = new AiStore(root, { dataDir });
  const service = new AiService(root, {
    store,
    client: fakeClient(prompts, needsContext),
    contextService: createContextService({ rootDir: root, endpoint })
  });
  return { service, root, store, dataDir, endpoint, prompts, closeApi };
}

/**
 * 差し替えたAIです。Context検索の要否にはJSONで答え、相談には渡された判断を
 * 名指しして答えます。文面がそのまま返るので、何が渡ったかをテストから読めます。
 */
function fakeClient(prompts, needsContext = true) {
  return {
    provider: 'fake',
    async start() {},
    async createThread() { return `thread-${prompts.length}`; },
    async resumeThread() {},
    async deleteThread() {},
    async close() {},
    async runTurn({ prompt }) {
      prompts.push(prompt);
      if (prompt.includes('Decide whether answering the question needs')) {
        return {
          text: JSON.stringify({
            needsContext,
            query: needsContext ? '認証方式 OIDC SAML ログイン' : '',
            reason: needsContext ? '過去の決定を聞いている' : '一般知識で答えられる'
          })
        };
      }
      const quoted = [...prompt.matchAll(/<context id="(ctx_[^"]+)"[^>]*>\n([^\n]+)/g)];
      if (quoted.length === 0) return { text: '保存済みの決定は見つかりませんでした。' };
      return { text: `${quoted[0][2]}と決めています[${quoted[0][1]}]。` };
    }
  };
}

/* ---------------------------------------------------------------- *
 * 画面からの窓口（`src/routes.js`）
 * ---------------------------------------------------------------- */

test('画面の窓口は、預け先が止まっていても「使えない」を返して開ける', async (t) => {
  const root = await temporaryDir(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# 手順\n\n本文です。\n', 'utf8');
  const calls = [];
  const contextService = {
    enabled: true,
    async status() { return { configured: true, available: false, endpoint: 'http://127.0.0.1:8765', error: 'fetch failed' }; },
    async listContexts() { throw new Error('呼ばれてはいけません'); },
    async saveContext(content, options) { calls.push(['save', content, options]); return { context_id: 'ctx_1' }; },
    async searchContext(query, options) { calls.push(['search', query, options]); return []; },
    async updateContext(id, changes) { calls.push(['update', id, changes]); return { context_id: id }; },
    async deleteContext(id) { calls.push(['delete', id]); return true; }
  };
  const { baseUrl, headers } = await startReviewServer(t, root, { contextService });

  // 一覧は、繋がらなくても 200 で返します。欄ごと消すと、この機能があることも、
  // いま使えないことも画面から分かりません（仕様7.4）。
  const listed = await fetch(`${baseUrl}/api/saved-contexts`, { headers }).then((response) => response.json());
  assert.equal(listed.status.available, false);
  assert.deepEqual(listed.contexts, []);

  const saved = await fetch(`${baseUrl}/api/saved-context`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: 'OIDCを使う', scope: 'path', path: 'guide.md', kind: 'decision', sourceType: 'agent' })
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(calls[0], ['save', 'OIDCを使う', {
    scope: 'path', scopePath: undefined, documentPath: 'guide.md', kind: 'decision', sourceType: 'agent', sourcePath: undefined
  }]);

  await fetch(`${baseUrl}/api/saved-context`, {
    method: 'PATCH', headers, body: JSON.stringify({ contextId: 'ctx_1', content: 'SAMLへ変えた' })
  });
  assert.deepEqual(calls[1], ['update', 'ctx_1', { content: 'SAMLへ変えた', scope: undefined, scopePath: undefined, kind: undefined }]);

  await fetch(`${baseUrl}/api/saved-context`, {
    method: 'DELETE', headers, body: JSON.stringify({ contextId: 'ctx_1' })
  });
  assert.deepEqual(calls[2], ['delete', 'ctx_1']);
});

test('保存の起点にできるのは、レビュー対象の中のファイルだけ', async (t) => {
  const root = await temporaryDir(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# 手順\n', 'utf8');
  const contextService = {
    enabled: true,
    async status() { return { configured: true, available: true, endpoint: 'http://127.0.0.1:8765' }; },
    async saveContext() { return { context_id: 'ctx_1' }; }
  };
  const { baseUrl, headers } = await startReviewServer(t, root, { contextService });

  const escaped = await fetch(`${baseUrl}/api/saved-context`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: 'x', scope: 'workspace', path: '../outside.md' })
  });
  assert.equal(escaped.status, 400, 'レビュー対象の外を指すパスは受け取らない');
});

test('Contextの窓口も、起動ごとのトークンを求める', async (t) => {
  const root = await temporaryDir(t);
  const { baseUrl } = await startReviewServer(t, root, {});
  const response = await fetch(`${baseUrl}/api/saved-contexts`);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /token/i);
});

async function startReviewServer(t, root, options) {
  const { app } = createServer(root, {
    aiToken: 'saved-context-token',
    aiService: { async status() { return { available: true, provider: 'codex' }; }, close() {} },
    ...options
  });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    headers: { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'saved-context-token' }
  };
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}
