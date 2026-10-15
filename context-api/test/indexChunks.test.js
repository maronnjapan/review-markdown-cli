import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextApi } from '../src/server.js';
import { createLocalVectorStore } from '../src/vectorStores/local.js';

/**
 * 索引に入っているものを、入れた形のまま読む口（`GET /index/chunks`、画面の「索引」）のテストです。
 *
 * ChromaDBは外へ公開していないので、ローカルでもデプロイ先でも直接は覗けません。
 * 代わりにこのサービスの口から、Chunkの本文・Metadata・ベクトルを見られることを確かめます。
 */

test('1ファイルの索引は本文ごと持ち、入れた形のまま読める', async (t) => {
  const dataDir = await temporaryDir(t);
  const store = createLocalVectorStore({ dataDir });
  await store.ready();
  await store.upsert([
    { id: 'c1#0', contextId: 'c1', vector: unit(0), text: 'OIDCを使う', metadata: { source: 'context', scope_key: 'ws:W' } },
    { id: 'c1#1', contextId: 'c1', vector: unit(1), text: '有効期限は15分', metadata: { source: 'context', scope_key: 'ws:W' } },
    { id: 'p1#0', contextId: 'p1', vector: unit(2), text: 'ページの節', metadata: { source: 'page', scope_key: 'ws:W', heading: 'トークン' } }
  ]);

  const all = await store.list();
  assert.equal(all.total, 3);
  assert.deepEqual(all.chunks.map((chunk) => chunk.id), ['c1#0', 'c1#1', 'p1#0']);
  assert.equal(all.chunks[0].text, 'OIDCを使う');
  assert.deepEqual(all.chunks[0].metadata, { source: 'context', scope_key: 'ws:W' });
  assert.equal('vector' in all.chunks[0], false, 'ベクトルは求めたときだけ付く');

  const paged = await store.list({ limit: 2, offset: 1 });
  assert.equal(paged.total, 3, '全体の数は切る前の数');
  assert.deepEqual(paged.chunks.map((chunk) => chunk.id), ['c1#1', 'p1#0']);

  assert.deepEqual((await store.list({ contextId: 'c1' })).chunks.map((chunk) => chunk.id), ['c1#0', 'c1#1']);
  assert.deepEqual((await store.list({ sources: ['page'] })).chunks.map((chunk) => chunk.id), ['p1#0']);
  assert.deepEqual((await store.list({ ids: ['p1#0'], vectors: true })).chunks[0].vector, unit(2));
  await store.close();

  // 読み直しても、本文ごと残っています。
  const reopened = createLocalVectorStore({ dataDir });
  assert.equal((await reopened.list({ ids: ['c1#1'] })).chunks[0].text, '有効期限は15分');
});

test('索引の中身は、本文・Metadata・ベクトルを HTTP で読める', async (t) => {
  const { base, api, close } = await startApi(t);
  t.after(close);
  const { body: created } = await request(base, 'POST', '/contexts', {
    workspace_id: 'W', content: 'このプロジェクトではOIDCを利用する', scope: 'workspace', kind: 'decision'
  });
  const { body: page } = await request(base, 'POST', '/pages', {
    workspace_id: 'W', title: '認証の設計', content: '# トークン\n\n有効期限は15分にする。'
  });
  // ページの索引は保存のあとで作られます。列が空になるのを待ってから読みます。
  await api.pages.idle();

  const { status, body } = await request(base, 'GET', '/index/chunks');
  assert.equal(status, 200);
  assert.equal(body.total, 2);
  assert.equal(body.vector_store.id, 'local');
  const context = body.chunks.find((chunk) => chunk.source === 'context');
  const pageChunk = body.chunks.find((chunk) => chunk.source === 'page');
  assert.equal(context.id, `${created.context_id}#0`);
  assert.equal(context.source_id, created.context_id);
  assert.equal(context.text, 'このプロジェクトではOIDCを利用する', '何を埋め込んだかが本文で見える');
  assert.equal(context.metadata.scope_key, 'ws:W', 'Metadataは入れた形のまま');
  assert.equal(pageChunk.source_id, page.page.page_id);
  assert.equal(pageChunk.metadata.heading, 'トークン');
  assert.ok(pageChunk.text.includes('有効期限は15分'));
  assert.equal('vector' in context, false, '一覧ではベクトルを省く');

  assert.equal((await request(base, 'GET', '/index/chunks?source=page')).body.total, 1);
  assert.equal((await request(base, 'GET', `/index/chunks?id=${created.context_id}`)).body.total, 1);
  assert.equal((await request(base, 'GET', '/index/chunks?source=mail')).status, 400);
  assert.equal((await request(base, 'GET', '/index/chunks?limit=abc')).status, 400);

  const withVectors = await request(base, 'GET', '/index/chunks?vectors=on&limit=1');
  assert.equal(withVectors.body.chunks.length, 1);
  assert.equal(withVectors.body.chunks[0].vector.length, 512, '求めればベクトルも付く');
  assert.equal(withVectors.body.chunks[0].dimensions, 512);

  const one = await request(base, 'GET', `/index/chunks/${encodeURIComponent(context.id)}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.chunk.id, context.id);
  assert.equal(one.body.chunk.vector.length, 512, '1件はベクトルごと返す');
  assert.equal((await request(base, 'GET', '/index/chunks/nothing%230')).status, 404);
});

/* ---------------------------------------------------------------- */

function unit(axis) {
  return Array.from({ length: 8 }, (_, index) => (index === axis ? 1 : 0));
}

async function temporaryDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-chunks-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startApi(t) {
  const dataDir = await temporaryDir(t);
  const api = createContextApi({ dataDir, vectorStore: { kind: 'local' } });
  const server = api.listen(0, { host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    api,
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
