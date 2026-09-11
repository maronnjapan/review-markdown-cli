import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalEmbedder } from '../src/embedding.js';
import { normalizeSearchRequest } from '../src/scope.js';
import { createContextStore } from '../src/store.js';
import { createChromaVectorStore } from '../src/vectorStores/chroma.js';

/**
 * 既定の索引（ChromaDB）へ、こちらが何を送り、返ってきたものをどう読むかのテストです。
 *
 * 本物のChromaDBは立てません。立てると、テストを走らせるのにDockerが要ることになります。
 * 代わりに、ChromaのHTTPの口と同じ形で答える相手を置いて、送っているものを読みます。
 * 「Chromaが本当にそう答えるか」はChroma側の約束で、こちらが守るべきなのは
 * 「その約束どおりに送り、返事を正しく読む」ことだからです。
 */

test('ChromaDBへは、コレクションを作ってから索引を入れる', async (t) => {
  const { chroma, endpoint } = await startFakeChroma(t, { version: 'v2' });
  const store = createChromaVectorStore({ endpoint, collection: 'contexts' });
  await store.ready();

  const [created] = chroma.requests.filter(({ pathname }) => pathname.endsWith('/collections'));
  assert.match(created.pathname, /^\/api\/v2\/tenants\/default_tenant\/databases\/default_database\/collections$/);
  assert.equal(created.body.get_or_create, true, '起動のたびに作り直さない');
  // 既定の測り方はL2です。長さ1に揃えたベクトルでも目盛りが違うので、`1 - distance` が
  // 類似度になりません。コサインを名指ししていることを見ます。
  assert.deepEqual(created.body.metadata, { 'hnsw:space': 'cosine' });
});

test('古いChromaDB（v1）にも、心拍を見てから合わせる', async (t) => {
  const { chroma, endpoint } = await startFakeChroma(t, { version: 'v1' });
  const store = createChromaVectorStore({ endpoint, collection: 'contexts' });
  await store.ready();

  assert.ok(
    chroma.requests.some(({ pathname }) => pathname === '/api/v1/collections'),
    'v2で答えない相手にはv1で話す'
  );
});

test('立ち上がりが遅くても、待ってから繋ぐ', async (t) => {
  const { chroma, endpoint } = await startFakeChroma(t, { version: 'v2', unreadyFirst: 2 });
  const waits = [];
  const store = createChromaVectorStore({ endpoint, collection: 'contexts' });

  await store.ready({ waitSeconds: 10, onWait: (line) => waits.push(line) });
  assert.ok(chroma.heartbeats >= 3, '繋がるまで聞き直す');
  assert.equal(waits.length, 1, '待っていることは1回だけ言う（毎秒言わない）');
});

test('待っても繋がらなければ、諦めて理由を返す', async (t) => {
  const { endpoint } = await startFakeChroma(t, { version: 'none' });
  const store = createChromaVectorStore({ endpoint, collection: 'contexts' });
  await assert.rejects(() => store.ready({ waitSeconds: 0 }), /ChromaDBに接続できませんでした/);
});

test('Contextの保存・検索・訂正・削除が、ChromaDB越しに通る', async (t) => {
  const { chroma, endpoint } = await startFakeChroma(t, { version: 'v2' });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chroma-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createContextStore({
    dataDir,
    embedder: createLocalEmbedder(),
    vectorStore: createChromaVectorStore({ endpoint, collection: 'contexts' })
  });
  await store.ready();

  const created = await store.create({
    workspace_id: 'W', content: 'このプロジェクトではOIDCを利用する', scope: 'path', scope_path: 'src/auth', kind: 'decision'
  });

  const upsert = chroma.requests.findLast(({ pathname }) => pathname.endsWith('/upsert'));
  assert.deepEqual(upsert.body.ids, [`${created.context_id}#0`]);
  assert.equal(upsert.body.embeddings[0].length, 512, '埋め込みはこちらで作って渡す');
  assert.deepEqual(upsert.body.metadatas[0], {
    scope_key: 'path:W:src/auth',
    scope_depth: 2,
    scope: 'path',
    kind: 'decision',
    updated_at: created.updated_at,
    context_id: created.context_id
  });

  const results = await store.search(normalizeSearchRequest({
    query: 'このプロジェクトの認証方式', workspace_id: 'W', scope_path: 'src/auth/oauth'
  }));
  const query = chroma.requests.findLast(({ pathname }) => pathname.endsWith('/query'));
  // 絞り込みは1本の文字列で渡します。どのVector DBにもある「どれかに一致」で済むためです。
  assert.deepEqual(query.body.where, {
    scope_key: { $in: ['path:W:src/auth/oauth', 'path:W:src/auth', 'path:W:src', 'ws:W', 'global'] }
  });
  assert.deepEqual(results.map(({ context }) => context.content), ['このプロジェクトではOIDCを利用する']);
  assert.ok(results[0].score > 0 && results[0].score <= 1, 'コサイン距離を「大きいほど近い」へ直して読む');

  // 訂正すると、古いChunkを消してから入れ直します。残すと、訂正前の判断も引けてしまいます。
  await store.patch(created.context_id, { content: '認証方式をSAMLへ変更した' });
  const deletes = chroma.requests.filter(({ pathname }) => pathname.endsWith('/delete'));
  assert.deepEqual(deletes.at(-1).body.where, { context_id: created.context_id });
  assert.equal(chroma.collection.size, 1, '入れ直したぶんだけが残る');

  await store.remove(created.context_id);
  assert.equal(chroma.collection.size, 0);
  await store.close();
});

/* ---------------------------------------------------------------- *
 * ChromaDBの代わり
 * ---------------------------------------------------------------- */

/**
 * @param {object} options
 * @param {'v2'|'v1'|'none'} options.version どの版の心拍に答えるか。`none` は何にも答えません。
 * @param {number} [options.unreadyFirst] 最初の何回かは心拍を落とす（立ち上がりの遅さ）。
 */
async function startFakeChroma(t, { version, unreadyFirst = 0 }) {
  const chroma = { requests: [], heartbeats: 0, collection: new Map() };
  const root = version === 'v2'
    ? '/api/v2/tenants/default_tenant/databases/default_database'
    : '/api/v1';

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await readBody(request);
    chroma.requests.push({ method: request.method, pathname: url.pathname, body });

    const reply = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (url.pathname.endsWith('/heartbeat')) {
      chroma.heartbeats += 1;
      const supported = version !== 'none' && url.pathname === `/api/${version}/heartbeat`;
      if (!supported) return reply(404, { error: 'not found' });
      if (chroma.heartbeats <= unreadyFirst) return reply(503, { error: 'starting' });
      return reply(200, { 'nanosecond heartbeat': 1 });
    }
    if (url.pathname === `${root}/collections` && request.method === 'POST') {
      return reply(200, { id: 'collection-1', name: body.name });
    }
    if (url.pathname === `${root}/collections/collection-1/upsert`) {
      body.ids.forEach((id, index) => chroma.collection.set(id, {
        vector: body.embeddings[index],
        metadata: body.metadatas[index]
      }));
      return reply(200, {});
    }
    if (url.pathname === `${root}/collections/collection-1/delete`) {
      for (const [id, entry] of chroma.collection) {
        if (entry.metadata.context_id === body.where.context_id) chroma.collection.delete(id);
      }
      return reply(200, {});
    }
    if (url.pathname === `${root}/collections/collection-1/query`) {
      const allowed = new Set(body.where?.scope_key?.$in || []);
      const [vector] = body.query_embeddings;
      const hits = [...chroma.collection.entries()]
        .filter(([, entry]) => allowed.size === 0 || allowed.has(entry.metadata.scope_key))
        // 本物と同じく、コサイン距離（小さいほど近い）で返します。
        .map(([id, entry]) => [id, entry, 1 - dot(vector, entry.vector)])
        .sort((a, b) => a[2] - b[2])
        .slice(0, body.n_results);
      return reply(200, {
        ids: [hits.map(([id]) => id)],
        metadatas: [hits.map(([, entry]) => entry.metadata)],
        distances: [hits.map(([, , distance]) => distance)]
      });
    }
    return reply(404, { error: 'not found' });
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { chroma, endpoint: `http://127.0.0.1:${server.address().port}` };
}

function dot(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
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
