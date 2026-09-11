/**
 * Context APIの本体です。CLIとは別のプロセスで動きます（仕様3.4）。
 *
 * ── CLIと分けている理由 ────────────────────────────────
 * Contextを扱うのに必要なもの（Vector DB、埋め込み）は、どれも将来差し替わります。
 * CLIの中に置くと、ChromaDBをQdrantへ替えるだけでCLIを直すことになり、原稿を読む
 * ためのアプリが、索引の都合で動かなくなります。HTTPで挟んでおけば、CLIから見えるのは
 * このファイルが決めた6本の口だけです。
 *
 * ── ここが実ファイルを読まない理由（仕様3.2） ────────────────
 * このプロセスは、レビュー対象のディレクトリを一度も開きません。読むのも書くのも
 * 自分のデータディレクトリだけです。実ファイルを扱うのはCLIの仕事で、Contextを扱うのが
 * こちらの仕事、という切り分けを、コードの届く範囲でも守っています。
 *
 * ── 127.0.0.1 にだけBindする理由 ─────────────────────────
 * 認証を実装していないからです（仕様1.6）。個人のPCの中だけで完結する前提なので、
 * 同じネットワークの他の端末から見えてはいけません。`0.0.0.0` でListenしません。
 * 将来の共有（仕様8章）に備えて、`token` を渡したときだけ `Authorization: Bearer` を
 * 求める形にしてあります。既定は認証なしです。
 */

import http from 'node:http';
import { httpError, readJsonBody, sendError, sendJson } from '../http.js';
import { createEmbedder } from './embedding.js';
import { contextApiError } from './model.js';
import { normalizeSearchRequest } from './scope.js';
import { createContextStore } from './store.js';
import { createVectorStore } from './vectorStores/index.js';

/** Context APIの既定のポート。CLI設定の `contextEndpoint` の既定と揃えます。 */
export const DEFAULT_CONTEXT_PORT = 8765;

/** 1件のContextを、APIの応答の形にします。保存の形をそのまま外へ出しています。 */
function contextPayload(context) {
  return { ...context };
}

/**
 * @param {object} options
 * @param {string} options.dataDir Contextの正本と索引の置き場所。
 * @param {object} [options.embedding] `{ provider, model, endpoint, apiKey }`。
 * @param {object} [options.vectorStore] `{ kind, ... }`。既定はローカルファイル。
 * @param {string} [options.token] 指定すると `Authorization: Bearer <token>` を求めます。
 * @param {object} [options.store] 組み立て済みのContextStore（テスト用）。
 */
export function createContextApi(options = {}) {
  const store = options.store || createContextStore({
    dataDir: options.dataDir,
    embedder: createEmbedder(options.embedding),
    vectorStore: createVectorStore({ dataDir: options.dataDir, ...options.vectorStore }),
    proximityWeight: options.proximityWeight
  });
  const token = options.token || null;

  const routes = [
    { method: 'GET', pattern: /^\/health$/, handle: health },
    { method: 'POST', pattern: /^\/contexts$/, handle: createContext },
    { method: 'GET', pattern: /^\/contexts$/, handle: listContexts },
    { method: 'GET', pattern: /^\/contexts\/([^/]+)$/, handle: getContext },
    { method: 'PATCH', pattern: /^\/contexts\/([^/]+)$/, handle: patchContext },
    { method: 'DELETE', pattern: /^\/contexts\/([^/]+)$/, handle: deleteContext },
    { method: 'POST', pattern: /^\/search$/, handle: search }
  ];

  async function health({ response }) {
    // 索引まで確かめます。繋がらないまま「ok」と答えると、CLIは使えると思って
    // 保存を試み、保存の時点で初めて失敗します。
    await store.ready();
    return sendJson(response, {
      status: 'ok',
      embedding: { id: store.embedder.id, label: store.embedder.label },
      vector_store: { id: store.vectorStore.id, label: store.vectorStore.label }
    });
  }

  async function createContext({ request, response }) {
    const context = await store.create(await readJsonBody(request));
    return sendJson(response, { context_id: context.context_id, created_at: context.created_at }, 201);
  }

  async function getContext({ response, params }) {
    const context = await store.get(params[0]);
    if (!context) throw contextApiError(`Contextが見つかりません: ${params[0]}`, 404);
    return sendJson(response, { context: contextPayload(context) });
  }

  /**
   * 保存済みの一覧です。仕様6.1の表には無い口ですが、訂正（仕様1.3の4つ目）には
   * 「何を保存したか」を見る場所が要ります。根拠提示からたどれるのは、その回答に
   * 使われた1件だけだからです。
   */
  async function listContexts({ response, url }) {
    const workspaceId = url.searchParams.get('workspace_id');
    const contexts = await store.list({
      workspaceId: workspaceId || null,
      includeGlobal: url.searchParams.get('include_global') !== 'false',
      limit: Number(url.searchParams.get('limit')) || undefined
    });
    return sendJson(response, { results: contexts.map(contextPayload) });
  }

  async function patchContext({ request, response, params }) {
    const { context } = await store.patch(params[0], await readJsonBody(request));
    return sendJson(response, { context: contextPayload(context) });
  }

  async function deleteContext({ response, params }) {
    await store.remove(params[0]);
    return sendJson(response, { deleted: true });
  }

  async function search({ request, response }) {
    const query = normalizeSearchRequest(await readJsonBody(request));
    const results = await store.search(query);
    // 該当が無いのはエラーではありません（仕様6.4）。空で返し、どう伝えるかはCLIが決めます。
    return sendJson(response, {
      results: results.map(({ context, score }) => ({
        context_id: context.context_id,
        content: context.content,
        score: Number(score.toFixed(4)),
        scope: context.scope,
        scope_path: context.scope_path,
        kind: context.kind,
        source_type: context.source_type,
        source_path: context.source_path,
        updated_at: context.updated_at
      }))
    });
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const route = routes.find((candidate) => (
      candidate.method === request.method && candidate.pattern.test(url.pathname)
    ));
    if (!route) {
      // 道はあるがメソッドが違うときは、405で「口はある」と伝えます。
      const known = routes.some((candidate) => candidate.pattern.test(url.pathname));
      throw httpError(known ? 'Method not allowed' : 'Not found', known ? 405 : 404);
    }
    assertAuthorized(request);
    const params = url.pathname.match(route.pattern).slice(1).map(decodeURIComponent);
    return route.handle({ request, response, url, params });
  }

  function assertAuthorized(request) {
    if (!token) return;
    const header = String(request.headers.authorization || '');
    if (header !== `Bearer ${token}`) throw httpError('Unauthorized', 401);
  }

  return {
    store,
    handleRequest,
    /** @param {number} port @param {Function} [callback] */
    listen(port = DEFAULT_CONTEXT_PORT, callback) {
      const server = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => sendError(response, error));
      });
      server.once('close', () => store.close?.());
      // ここを `0.0.0.0` にしないこと（このモジュール冒頭の説明）。
      return server.listen(port, '127.0.0.1', callback);
    }
  };
}
