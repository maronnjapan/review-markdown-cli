/**
 * Context APIの本体です。CLIとは別のプロセスで動きます（仕様3.4）。
 *
 * ── CLIと分けている理由 ────────────────────────────────
 * Contextを扱うのに必要なもの（Vector DB、埋め込み）は、どれも将来差し替わります。
 * CLIの中に置くと、ChromaDBをQdrantへ替えるだけでCLIを直すことになり、原稿を読む
 * ためのアプリが、索引の都合で動かなくなります。HTTPで挟んでおけば、CLIから見えるのは
 * このファイルが決めた口だけです。
 *
 * ── 1つのプロセスに、2つの役 ────────────────────────────
 * このサービスは「知識の核」と「画面」の2つを持ちます。核は、保存した判断（Context）と
 * ページの正本・索引・検索で、HTTPとMCP（`mcp.js`）の口から外部のツールに使わせます。
 * 画面（`public/`。Notion風のアプリ）は、その核の一利用者です。画面が使うのは外部のツールと
 * 同じHTTPの口だけで、画面のためだけの近道は作りません。核を別に配ることになっても、
 * 画面を別の場所へ移すことになっても、片方を直さずに済ませるための分け方です。
 * 同じプロセスから配るのは、使い始めるのに `docker compose up` の1回で済ませるためです。
 *
 * ── ここが実ファイルを読まない理由（仕様3.2） ────────────────
 * このプロセスは、レビュー対象のディレクトリを一度も開きません。読むのも書くのも
 * 自分のデータディレクトリ（と、配るための `public/`）だけです。実ファイルを扱うのはCLIの仕事で、
 * Contextとページを扱うのがこちらの仕事、という切り分けを、コードの届く範囲でも守っています。
 *
 * ── この端末からしか届かないようにする ────────────────────
 * 認証を実装していないからです（仕様1.6）。個人のPCの中だけで完結する前提なので、
 * 同じネットワークの他の端末から見えてはいけません。素で動かすときは `127.0.0.1` に
 * だけBindし、Dockerで動かすときはホストへ公開するポートのほうを縛ります
 * （`config.js` の説明と `docker-compose.yml`）。
 * 画面を持つようになったので、ブラウザから来る要求の `Origin` も見ます（`assertOrigin`）。
 * 悪意のあるサイトを開いたブラウザが、この端末の中のサービスへ書き込みに来るのを防ぐためです。
 * 将来の共有（仕様8章）に備えて、`token` を渡したときだけ `Authorization: Bearer` を
 * 求める形にしてあります。既定は認証なしです。
 */

import http from 'node:http';
import { DEFAULT_PORT } from './config.js';
import { buildAskPrompt, citedSourceNumbers, createChatModel, MAX_ASK_SOURCES } from './answer.js';
import { httpError, readJsonBody, sendError, sendJson, startSse } from './http.js';
import { createEmbedder } from './embedding.js';
import { createMcpHandler } from './mcp.js';
import { contextApiError } from './model.js';
import { createPageStore } from './pages/store.js';
import { KNOWLEDGE_SOURCES, createKnowledgeSearch, normalizeKnowledgeRequest } from './search.js';
import { createContextStore } from './store.js';
import { createUiServer } from './ui.js';
import { createVectorStore } from './vectorStores/index.js';

export const API_VERSION = '0.2.0';

/** 1件のContextを、APIの応答の形にします。保存の形をそのまま外へ出しています。 */
function contextPayload(context) {
  return { ...context };
}

/**
 * @param {object} options
 * @param {string} options.dataDir Contextとページの正本と索引の置き場所。
 * @param {object} [options.embedding] `{ provider, model, endpoint, apiKey }`。
 * @param {object} [options.vectorStore] `{ kind, ... }`。既定はローカルファイル。
 * @param {object} [options.chat] `{ provider, model, endpoint, apiKey }`。回答の生成（`answer.js`）。既定は無し。
 * @param {object} [options.chatModel] 組み立て済みの生成モデル（テスト用）。
 * @param {string} [options.token] 指定すると `Authorization: Bearer <token>` を求めます。
 * @param {boolean} [options.ui] 画面を配るかどうか。既定 true。
 * @param {string} [options.publicDir] 画面のファイルの置き場所（テスト用）。
 * @param {object} [options.store] 組み立て済みのContextStore（テスト用）。
 * @param {object} [options.pages] 組み立て済みのPageStore（テスト用）。
 */
export function createContextApi(options = {}) {
  const embedder = createEmbedder(options.embedding);
  const vectorStore = createVectorStore({ dataDir: options.dataDir, ...options.vectorStore });
  const store = options.store || createContextStore({
    dataDir: options.dataDir,
    embedder,
    vectorStore,
    proximityWeight: options.proximityWeight
  });
  const pages = options.pages || createPageStore({
    dataDir: options.dataDir,
    // 同じ埋め込みと索引を使います。Contextの側が503の札を付けた物を借りるので、失敗の見え方も揃います。
    embedder: store.embedder,
    vectorStore: store.vectorStore
  });
  const search = createKnowledgeSearch({ contexts: store, pages, proximityWeight: options.proximityWeight });
  const chatModel = options.chatModel === undefined ? createChatModel(options.chat) : options.chatModel;
  const ui = options.ui === false ? null : createUiServer({ publicDir: options.publicDir });
  const mcp = createMcpHandler({ search, contexts: store, pages, serverVersion: API_VERSION });
  const token = options.token || null;

  const routes = [
    { method: 'GET', pattern: /^\/health$/, handle: health },
    // 保存した判断（Context）
    { method: 'POST', pattern: /^\/contexts$/, handle: createContext },
    { method: 'GET', pattern: /^\/contexts$/, handle: listContexts },
    { method: 'GET', pattern: /^\/contexts\/([^/]+)$/, handle: getContext },
    { method: 'PATCH', pattern: /^\/contexts\/([^/]+)$/, handle: patchContext },
    { method: 'DELETE', pattern: /^\/contexts\/([^/]+)$/, handle: deleteContext },
    // 検索と、資料を根拠にした回答
    { method: 'POST', pattern: /^\/search$/, handle: searchKnowledge },
    { method: 'POST', pattern: /^\/ask$/, handle: ask },
    // Workspaceとページ
    { method: 'GET', pattern: /^\/workspaces$/, handle: listWorkspaces },
    { method: 'POST', pattern: /^\/workspaces$/, handle: createWorkspace },
    { method: 'GET', pattern: /^\/workspaces\/([^/]+)$/, handle: getWorkspace },
    { method: 'PATCH', pattern: /^\/workspaces\/([^/]+)$/, handle: patchWorkspace },
    { method: 'DELETE', pattern: /^\/workspaces\/([^/]+)$/, handle: deleteWorkspace },
    { method: 'GET', pattern: /^\/workspaces\/([^/]+)\/pages$/, handle: listPages },
    { method: 'GET', pattern: /^\/workspaces\/([^/]+)\/export$/, handle: exportWorkspace },
    { method: 'POST', pattern: /^\/workspaces\/([^/]+)\/import$/, handle: importPages },
    { method: 'POST', pattern: /^\/pages$/, handle: createPage },
    { method: 'GET', pattern: /^\/pages\/([^/]+)$/, handle: getPage },
    { method: 'PATCH', pattern: /^\/pages\/([^/]+)$/, handle: patchPage },
    { method: 'DELETE', pattern: /^\/pages\/([^/]+)$/, handle: deletePage },
    { method: 'POST', pattern: /^\/index\/retry$/, handle: retryIndex },
    // AIエージェント向けの口（`mcp.js`）
    { method: 'POST', pattern: /^\/mcp$/, handle: handleMcp },
    { method: 'GET', pattern: /^\/mcp$/, handle: handleMcp },
    { method: 'DELETE', pattern: /^\/mcp$/, handle: handleMcp }
  ];

  /* ---------------------------------------------------------------- *
   * 稼働確認
   * ---------------------------------------------------------------- */

  async function health({ response }) {
    // 索引まで確かめます。繋がらないまま「ok」と答えると、CLIは使えると思って
    // 保存を試み、保存の時点で初めて失敗します。
    await store.ready();
    const [contextCount, pageCount, chunkCount] = await Promise.all([
      store.count(),
      pages.count(),
      store.vectorStore.count?.().catch(() => null) ?? null
    ]);
    return sendJson(response, {
      status: 'ok',
      version: API_VERSION,
      embedding: { id: store.embedder.id, label: store.embedder.label },
      vector_store: { id: store.vectorStore.id, label: store.vectorStore.label },
      chat: chatModel ? { id: chatModel.id, label: chatModel.label } : null,
      ui: Boolean(ui),
      counts: { contexts: contextCount, pages: pageCount, chunks: chunkCount },
      index: pages.indexSummary()
    });
  }

  /* ---------------------------------------------------------------- *
   * 保存した判断
   * ---------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------- *
   * 検索と回答
   * ---------------------------------------------------------------- */

  /**
   * Semantic Search。`sources` を省くとContextだけを返します（CLIが今までどおり動くように）。
   * `sources: ["context", "page"]` でページも混ざり、`all_workspaces: true` で範囲を問わず引きます。
   */
  async function searchKnowledge({ request, response }) {
    const query = normalizeKnowledgeRequest(await readJsonBody(request), { defaultSources: ['context'] });
    const results = await search.search(query);
    // 該当が無いのはエラーではありません（仕様6.4）。空で返し、どう伝えるかは呼ぶ側が決めます。
    return sendJson(response, { results });
  }

  /**
   * 資料を根拠にした回答（RAG）。資料は `search.js` で引き、文は `answer.js` で作ります。
   * 生成のモデルが無いときも資料は返します。`stream: true` ならSSEで少しずつ返します。
   */
  async function ask({ request, response }) {
    const body = await readJsonBody(request);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw contextApiError('question を指定してください');
    const query = normalizeKnowledgeRequest({
      ...body,
      query: question,
      limit: body.limit ?? MAX_ASK_SOURCES
    }, { defaultSources: [...KNOWLEDGE_SOURCES] });
    const sources = await search.search(query);
    const model = chatModel ? { id: chatModel.id, label: chatModel.label } : null;
    const stream = body.stream === true;

    if (!chatModel) {
      const payload = { question, sources, model: null, answer: null, cited: [], reason: 'chat_not_configured' };
      if (!stream) return sendJson(response, payload);
      const sse = startSse(response);
      sse.send('sources', { sources, model: null });
      sse.send('done', payload);
      return sse.end();
    }

    const { system, prompt } = buildAskPrompt({ question, sources });
    const controller = new AbortController();
    request.once('close', () => controller.abort(new Error('client closed')));

    if (!stream) {
      let answer = '';
      for await (const delta of chatModel.generate({ system, prompt, signal: controller.signal })) answer += delta;
      return sendJson(response, { question, sources, model, answer, cited: citedSourceNumbers(answer, sources.length) });
    }

    const sse = startSse(response);
    sse.send('sources', { sources, model });
    let answer = '';
    try {
      for await (const delta of chatModel.generate({ system, prompt, signal: controller.signal })) {
        answer += delta;
        sse.send('delta', { text: delta });
      }
      sse.send('done', { question, model, answer, cited: citedSourceNumbers(answer, sources.length) });
    } catch (error) {
      // 流し始めたあとはHTTPの状態を変えられないので、出来事として伝えます。
      sse.send('error', { error: error.message });
    }
    return sse.end();
  }

  /* ---------------------------------------------------------------- *
   * Workspaceとページ
   * ---------------------------------------------------------------- */

  async function listWorkspaces({ response }) {
    const workspaces = await pages.listWorkspaces({ extraIds: await store.workspaceIds() });
    return sendJson(response, { results: workspaces });
  }

  async function createWorkspace({ request, response }) {
    const workspace = await pages.createWorkspace(await readJsonBody(request));
    return sendJson(response, { workspace }, 201);
  }

  async function getWorkspace({ response, params }) {
    const workspace = await pages.getWorkspace(params[0]);
    if (!workspace) throw contextApiError(`Workspaceが見つかりません: ${params[0]}`, 404);
    return sendJson(response, { workspace });
  }

  async function patchWorkspace({ request, response, params }) {
    const workspace = await pages.patchWorkspace(params[0], await readJsonBody(request));
    return sendJson(response, { workspace });
  }

  async function deleteWorkspace({ response, params }) {
    return sendJson(response, await pages.removeWorkspace(params[0]));
  }

  async function listPages({ response, params }) {
    return sendJson(response, { results: await pages.tree(params[0]) });
  }

  async function exportWorkspace({ response, params }) {
    return sendJson(response, await pages.exportWorkspace(params[0]));
  }

  async function importPages({ request, response, params }) {
    const body = await readJsonBody(request);
    const result = await pages.importPages(params[0], body.pages);
    return sendJson(response, result, 201);
  }

  async function createPage({ request, response }) {
    const page = await pages.create(await readJsonBody(request));
    return sendJson(response, { page }, 201);
  }

  /** `?format=markdown` で本文だけを `text/markdown` で返します。外部のツールが読むための形です。 */
  async function getPage({ response, params, url }) {
    const page = await pages.get(params[0]);
    if (!page) throw contextApiError(`ページが見つかりません: ${params[0]}`, 404);
    if (url.searchParams.get('format') === 'markdown') {
      const markdown = `# ${page.title || '無題'}\n\n${page.content}`;
      response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return response.end(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    }
    return sendJson(response, { page });
  }

  async function patchPage({ request, response, params }) {
    const { page, contentChanged, titleChanged, moved } = await pages.patch(params[0], await readJsonBody(request));
    return sendJson(response, { page, content_changed: contentChanged, title_changed: titleChanged, moved });
  }

  async function deletePage({ response, params }) {
    return sendJson(response, await pages.remove(params[0]));
  }

  async function retryIndex({ response }) {
    return sendJson(response, await pages.retryFailedIndexes());
  }

  /* ---------------------------------------------------------------- *
   * MCP
   * ---------------------------------------------------------------- */

  async function handleMcp({ request, response }) {
    const body = request.method === 'POST' ? await readJsonBody(request) : null;
    const { status, headers = {}, payload } = await mcp.handle({ method: request.method, body });
    if (payload === null) {
      response.writeHead(status, headers);
      return response.end();
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    return response.end(JSON.stringify(payload));
  }

  /* ---------------------------------------------------------------- *
   * 振り分け
   * ---------------------------------------------------------------- */

  async function handleRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    assertOrigin(request);
    const route = routes.find((candidate) => (
      candidate.method === request.method && candidate.pattern.test(url.pathname)
    ));
    if (!route) {
      // 画面のファイルは、APIの道に無いものだけを受け持ちます。画面を配らない設定なら404です。
      if (ui && ui.handles(url.pathname)) return ui.serve(url.pathname, request, response);
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
    pages,
    search,
    chatModel,
    mcp,
    handleRequest,

    /**
     * 両方の正本を使える状態にします。埋め込みや索引の形が変わっていれば作り直します。
     * @param {object} [options] Vector DBへそのまま渡します（起動時の待ち時間など）。
     */
    async ready(options = {}) {
      const contexts = await store.ready(options);
      const reindexedPages = await pages.ready(options);
      return { reindexed: contexts.reindexed + reindexedPages.reindexed, contexts: contexts.reindexed, pages: reindexedPages.reindexed };
    },

    /**
     * @param {number} [port]
     * @param {object} [options]
     * @param {string} [options.host] Bindするアドレス。既定は `127.0.0.1` です。
     *   コンテナの中だけ `0.0.0.0` にします（理由は `config.js` の説明）。
     */
    listen(port = DEFAULT_PORT, { host = '127.0.0.1' } = {}, callback) {
      const server = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => sendError(response, error));
      });
      server.once('close', () => {
        pages.close?.();
        store.close?.();
      });
      return server.listen(port, host, callback);
    }
  };
}

/** ブラウザ以外から来る要求に `Origin` はありません。あるときだけ、この端末のものかを見ます。 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * ブラウザから来た要求の出どころを確かめます。
 *
 * 画面を持つサービスは、同じ端末で開いた他のサイトからも `fetch` で叩けます（DNS rebindingや
 * 悪意のあるページ）。`Origin` が、このサービス自身（`Host` と同じ）か、この端末（localhost）で
 * なければ断ります。MCPの仕様も、ローカルで動くサーバにこの確認を求めています。
 */
export function assertOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || origin === 'null') return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw httpError('Forbidden origin', 403);
  }
  if (parsed.host === String(request.headers.host || '')) return;
  if (LOCAL_HOSTNAMES.has(parsed.hostname)) return;
  throw httpError('Forbidden origin', 403);
}
