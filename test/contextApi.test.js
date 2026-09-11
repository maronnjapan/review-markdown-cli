import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chunkContent } from '../src/context/chunking.js';
import { parseContextArgs } from '../src/context/command.js';
import { createLocalEmbedder, hashEmbedding } from '../src/context/embedding.js';
import { applyContextPatch, buildContext } from '../src/context/model.js';
import { ancestorPaths, normalizeSearchRequest, scopeKeysFor } from '../src/context/scope.js';
import { createContextApi } from '../src/context/server.js';
import { createContextStore } from '../src/context/store.js';
import { createLocalVectorStore } from '../src/context/vectorStores/local.js';

/**
 * Context API（保存した判断を預かるサービス）のテストです。
 *
 * ここで守っているのは、仕様10章の受け入れケースのうち、CLIを通さずに確かめられる分です。
 * 保存したものが引けること（ケース1）、訂正が次の検索に効くこと（ケース5）、範囲の外では
 * 使われないこと（ケース6）、該当が無いときは空で返すこと（ケース7）。
 */

test('保存した判断は、保存したときの語でなくても引ける', async (t) => {
  const store = await seedStore(t);
  await store.create({ workspace_id: 'W', content: 'このプロジェクトではOIDCを利用する', scope: 'workspace', kind: 'decision' });

  const results = await store.search(normalizeSearchRequest({
    query: 'このプロジェクトの認証方式って何？',
    workspace_id: 'W'
  }));

  assert.equal(results.length, 1);
  assert.equal(results[0].context.content, 'このプロジェクトではOIDCを利用する');
  assert.ok(results[0].score > 0, '類似度が付く');
});

test('関係の無い判断は、同じWorkspaceに保存されていても返さない', async (t) => {
  const store = await seedStore(t);
  await store.create({ workspace_id: 'W', content: '請求書は月末締めで出す', scope: 'workspace' });

  // 該当なしはエラーではなく空です（仕様6.4）。ケース7で、AIに「見つからなかった」と
  // 言わせるための入り口がここです。
  assert.deepEqual(
    await store.search(normalizeSearchRequest({ query: 'このプロジェクトの認証方式って何？', workspace_id: 'W' })),
    []
  );
});

test('訂正すると、次の検索からは直したあとの判断だけが返る', async (t) => {
  const store = await seedStore(t);
  const created = await store.create({
    workspace_id: 'W', content: 'このプロジェクトではOIDCを利用する', scope: 'workspace', kind: 'decision'
  });

  const { contentChanged } = await store.patch(created.context_id, { content: '認証方式をOIDCからSAMLへ変更した' });
  assert.equal(contentChanged, true, '本文が変わったら、索引を作り直す必要があると伝える');

  const results = await store.search(normalizeSearchRequest({ query: 'このプロジェクトの認証方式', workspace_id: 'W' }));
  assert.deepEqual(results.map(({ context }) => context.content), ['認証方式をOIDCからSAMLへ変更した']);
  assert.equal(
    results.filter(({ context }) => context.content.includes('OIDCを利用する')).length,
    0,
    '古い本文は索引からも消えている'
  );
});

test('削除した判断は、索引に残っていても結果に混ぜない', async (t) => {
  const dataDir = await temporaryDir(t);
  const vectorStore = createLocalVectorStore({ dataDir });
  const store = createContextStore({ dataDir, embedder: createLocalEmbedder(), vectorStore });
  await store.ready();
  const created = await store.create({ workspace_id: 'W', content: 'Refresh TokenをAgentへ渡さない', scope: 'workspace' });

  // 正本だけが消えて索引が残る事故（別プロセスが落ちたなど）を作ります。
  await store.remove(created.context_id);
  await vectorStore.upsert([{
    id: `${created.context_id}#0`,
    contextId: created.context_id,
    vector: hashEmbedding('Refresh TokenをAgentへ渡さない'),
    text: 'Refresh TokenをAgentへ渡さない',
    metadata: { scope_key: 'ws:W', scope_depth: 0 }
  }]);

  assert.deepEqual(
    await store.search(normalizeSearchRequest({ query: 'Refresh Token の扱い', workspace_id: 'W' })),
    [],
    '消した判断が回答の前提に戻ってこない'
  );
});

test('Path Scopeは、開いているファイルの祖先ディレクトリまで効く', async (t) => {
  const store = await seedStore(t);
  await store.create({
    workspace_id: 'W', content: 'Refresh TokenをAgentへ渡さない', scope: 'path', scope_path: 'src/auth', kind: 'decision'
  });

  const inScope = await store.search(normalizeSearchRequest({
    query: 'Refresh Token の扱い', workspace_id: 'W', scope_path: 'src/auth/oauth'
  }));
  assert.deepEqual(inScope.map(({ context }) => context.content), ['Refresh TokenをAgentへ渡さない']);

  const outOfScope = await store.search(normalizeSearchRequest({
    query: 'Refresh Token の扱い', workspace_id: 'W', scope_path: 'src/billing'
  }));
  assert.deepEqual(outOfScope, [], '別のディレクトリを開いているあいだは使わない');
});

test('祖先の展開はContext APIが行うので、CLIは開いているディレクトリだけを送る', () => {
  assert.deepEqual(ancestorPaths('src/auth/oauth'), ['src/auth/oauth', 'src/auth', 'src']);
  assert.deepEqual(
    scopeKeysFor({ workspaceId: 'W', scopePath: 'src/auth/oauth' }),
    ['path:W:src/auth/oauth', 'path:W:src/auth', 'path:W:src', 'ws:W', 'global']
  );
  // 個人の共通知識を混ぜないと言われたときは、Workspaceのぶんだけになります。
  assert.deepEqual(scopeKeysFor({ workspaceId: 'W', includeGlobal: false }), ['ws:W']);
});

test('個人の共通知識は、Workspaceを問わず引ける', async (t) => {
  const store = await seedStore(t);
  await store.create({ content: '常にTypeScriptのstrictモードで書く', scope: 'global', kind: 'preference' });

  const found = await store.search(normalizeSearchRequest({ query: 'TypeScript strictモードで書く', workspace_id: 'OTHER' }));
  assert.deepEqual(found.map(({ context }) => context.content), ['常にTypeScriptのstrictモードで書く']);

  const excluded = await store.search(normalizeSearchRequest({
    query: 'TypeScript strictモードで書く', workspace_id: 'OTHER', include_global: false
  }));
  assert.deepEqual(excluded, [], 'include_global を外せば混ざらない');
});

test('長い判断は切って索引にするが、返すのはContext 1件', async (t) => {
  const store = await seedStore(t);
  const content = [
    '認証まわりの決定をまとめる。',
    'ログインはOIDCで行う。',
    ...Array.from({ length: 20 }, (_, index) => `この決まりごと${index}は認証とは関係がなく、索引を切るためだけに置いてある。`),
    '有効期限は15分にする。'
  ].join('\n\n');
  await store.create({ workspace_id: 'W', content, scope: 'workspace' });

  assert.ok(chunkContent(content).length > 1, '索引の上では複数のChunkになる');
  const results = await store.search(normalizeSearchRequest({ query: '有効期限は15分にする', workspace_id: 'W' }));
  assert.equal(results.length, 1, '同じ判断が何度も並ばない');
  assert.equal(results[0].context.content, content, '返すのは切る前の本文');
});

test('範囲の食い違いと欠けた必須項目は、保存させない', () => {
  const fails = (input, expected) => assert.throws(() => buildContext(input), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, expected);
    return true;
  });

  fails({ workspace_id: 'W', content: 'x', scope: 'path' }, /scope_path が必要/);
  fails({ workspace_id: 'W', content: 'x', scope: 'workspace', scope_path: 'src' }, /scope_path は指定できません/);
  fails({ content: 'x', scope: 'workspace' }, /workspace_id が必要/);
  fails({ workspace_id: 'W', content: 'x', scope: 'global' }, /workspace_id は指定できません/);
  fails({ workspace_id: 'W', content: '   ', scope: 'workspace' }, /content を指定してください/);
  fails({ workspace_id: 'W', content: 'x', scope: 'team' }, /使えない scope/);
  // 絶対パスは、別のPCで同じWorkspaceを開いたときに一致しません（仕様5.2）。
  fails({ workspace_id: 'W', content: 'x', scope: 'path', scope_path: '/etc/passwd' }, /相対パスで指定/);
  fails({ workspace_id: 'W', content: 'x', scope: 'path', scope_path: 'C:\\project\\src' }, /相対パスで指定/);
  fails({ workspace_id: 'W', content: 'x', scope: 'path', scope_path: '../other' }, /\.\. は使えません/);
});

test('範囲だけを変える更新も、変えたあとの組み合わせで見直す', () => {
  const stored = buildContext({ workspace_id: 'W', content: 'x', scope: 'path', scope_path: 'src/auth' });

  // 範囲をWorkspace全体へ変えたとき、ディレクトリは自動で落ちます。残すと、絞ったつもりの
  // 判断が全体に効いていることになります。
  const { context } = applyContextPatch(stored, { scope: 'workspace', scope_path: null });
  assert.equal(context.scope_path, null);
  assert.throws(() => applyContextPatch(stored, { scope: 'workspace' }), /scope_path は指定できません/);
  assert.throws(() => applyContextPatch(stored, { workspace_id: 'OTHER' }), /workspace_id は更新できません/);
});

test('埋め込みを取り替えたら、保存済みの判断の索引を作り直す', async (t) => {
  const dataDir = await temporaryDir(t);
  const first = createContextStore({
    dataDir, embedder: createLocalEmbedder({ dimensions: 64 }), vectorStore: createLocalVectorStore({ dataDir })
  });
  await first.ready();
  await first.create({ workspace_id: 'W', content: 'このプロジェクトではOIDCを利用する', scope: 'workspace' });
  await first.close();

  // 次元の違う埋め込みで開き直します。作り直さないと、意味の違う数字同士を比べることに
  // なり、保存した判断が引けなくなります。
  const second = createContextStore({
    dataDir, embedder: createLocalEmbedder({ dimensions: 512 }), vectorStore: createLocalVectorStore({ dataDir })
  });
  assert.deepEqual(await second.ready(), { reindexed: 1 });
  const results = await second.search(normalizeSearchRequest({ query: 'このプロジェクトの認証方式', workspace_id: 'W' }));
  assert.equal(results.length, 1);
  await second.close();
});

test('HTTPの口は、仕様6.1の6本で答える', async (t) => {
  const { base, close } = await startApi(t);
  t.after(close);

  const health = await request(base, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const created = await request(base, 'POST', '/contexts', {
    workspace_id: 'W', content: 'このプロジェクトではOIDCを利用する', scope: 'workspace', kind: 'decision'
  });
  assert.equal(created.status, 201);
  assert.match(created.body.context_id, /^ctx_/);

  const read = await request(base, 'GET', `/contexts/${created.body.context_id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.context.kind, 'decision');

  const searched = await request(base, 'POST', '/search', { query: 'このプロジェクトの認証方式', workspace_id: 'W' });
  assert.equal(searched.status, 200);
  assert.equal(searched.body.results[0].context_id, created.body.context_id);
  assert.equal(searched.body.results[0].scope, 'workspace');

  const patched = await request(base, 'PATCH', `/contexts/${created.body.context_id}`, { content: 'SAMLへ変更した' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.context.content, 'SAMLへ変更した');

  const deleted = await request(base, 'DELETE', `/contexts/${created.body.context_id}`);
  assert.equal(deleted.status, 200);
  assert.equal((await request(base, 'GET', `/contexts/${created.body.context_id}`)).status, 404);
});

test('使い方の誤りは400、居ないものは404、預け先の不調は503', async (t) => {
  const { base, close } = await startApi(t);
  t.after(close);

  assert.equal((await request(base, 'POST', '/contexts', { content: 'x', scope: 'path' })).status, 400);
  assert.equal((await request(base, 'POST', '/search', { workspace_id: 'W' })).status, 400, 'queryが無い');
  assert.equal((await request(base, 'GET', '/contexts/ctx_none')).status, 404);
  assert.equal((await request(base, 'PATCH', '/contexts/ctx_none', { content: 'x' })).status, 404);
  assert.equal((await request(base, 'GET', '/nope')).status, 404);

  // Vector DBへ繋がらないときは 503 です。CLIは接続不能と同じ「利用不可」として扱います。
  const broken = await startApi(t, {
    vectorStore: {
      id: 'broken',
      label: 'broken',
      async ready() { throw new Error('connect ECONNREFUSED 127.0.0.1:8000'); },
      async upsert() {}, async deleteByContext() {}, async query() { return []; }, async close() {}
    }
  });
  t.after(broken.close);
  const health = await request(broken.base, 'GET', '/health');
  assert.equal(health.status, 503);
  assert.match(health.body.error, /Vector DB/);
});

test('トークンを設定したときだけ、Authorization を求める', async (t) => {
  const { base, close } = await startApi(t, { token: 'secret' });
  t.after(close);

  assert.equal((await request(base, 'GET', '/health')).status, 401);
  const authorized = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer secret' } });
  assert.equal(authorized.status, 200);
});

test('起動の指定は、知らない値を受け取らない', () => {
  assert.deepEqual(parseContextArgs(['start', '--port=9000']).port, 9000);
  assert.equal(parseContextArgs(['start', '--vector-db', 'chroma']).vectorStore.kind, 'chroma');
  assert.equal(parseContextArgs(['start', '--embedding', 'ollama']).embedding.provider, 'ollama');
  assert.equal(parseContextArgs([]).help, true, 'コマンドを書かなければヘルプ');
  assert.throws(() => parseContextArgs(['start', '--vector-db', 'qdrant']), /unknown vector db/);
  assert.throws(() => parseContextArgs(['start', '--embedding', 'gemini']), /unknown embedding/);
  assert.throws(() => parseContextArgs(['restart']), /unknown context command/);
});

/* ---------------------------------------------------------------- *
 * 道具
 * ---------------------------------------------------------------- */

async function temporaryDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-markdown-context-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedStore(t) {
  const dataDir = await temporaryDir(t);
  const store = createContextStore({
    dataDir,
    embedder: createLocalEmbedder(),
    vectorStore: createLocalVectorStore({ dataDir })
  });
  await store.ready();
  t.after(() => store.close());
  return store;
}

async function startApi(t, { vectorStore, ...options } = {}) {
  const dataDir = await temporaryDir(t);
  const api = createContextApi({
    dataDir,
    ...options,
    ...(vectorStore
      ? { store: createContextStore({ dataDir, embedder: createLocalEmbedder(), vectorStore }) }
      : {})
  });
  const server = api.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
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
