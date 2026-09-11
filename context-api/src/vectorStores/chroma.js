/**
 * ChromaDBを索引に使うときの口です。既定の索引はこちらです。
 *
 * `docker compose up` を打つと、このサービスと一緒にChromaDBが立ち上がり、
 * `CHROMA_URL` で繋がります。Dockerを使わずに試すときは `VECTOR_DB=local` で、
 * 1ファイルの索引（`local.js`）へ切り替えられます。
 *
 * ── npmのクライアントを使わない理由 ──────────────────────
 * ChromaはHTTPで話せるので、`fetch` だけで足ります。依存を足すと、Chromaを使わない人
 * （＝既定の人すべて）にもインストールの時間がかかります。
 *
 * ── v2とv1の両方を見る理由 ────────────────────────────
 * Chromaは 0.6 でAPIのパスが `/api/v1` から `/api/v2/tenants/.../databases/...` へ
 * 変わりました。どちらが動いているかは繋いでみないと分からないので、心拍で確かめてから
 * 使う側を決めます。ここで吸収しておけば、CLIはもちろん、Context APIの他の部分も
 * Chromaの版を知らずに済みます。
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000';
const DEFAULT_COLLECTION = 'review_markdown_contexts';
const DEFAULT_TENANT = 'default_tenant';
const DEFAULT_DATABASE = 'default_database';
const REQUEST_TIMEOUT_MS = 15_000;

export function createChromaVectorStore({
  endpoint = DEFAULT_ENDPOINT,
  collection = DEFAULT_COLLECTION,
  tenant = DEFAULT_TENANT,
  database = DEFAULT_DATABASE,
  fetchImpl = fetch
} = {}) {
  const base = String(endpoint).replace(/\/+$/, '');
  /** 繋いでから決まるもの（APIの版とコレクションid）。`ready()` が1回だけ埋めます。 */
  let connection = null;

  async function request(pathname, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`ChromaDBへの要求が失敗しました（HTTP ${response.status}）: ${pathname} ${detail}`.trim());
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /** 動いている版のAPIの根。心拍が返ったほうを使います。 */
  async function detectRoot() {
    for (const candidate of [`/api/v2/tenants/${tenant}/databases/${database}`, '/api/v1']) {
      const heartbeat = candidate.startsWith('/api/v2') ? '/api/v2/heartbeat' : '/api/v1/heartbeat';
      try {
        await request(heartbeat);
        return candidate;
      } catch {
        // 次の版を試します。どちらも駄目なら、呼んだ側が 503 として扱います。
      }
    }
    throw new Error(`ChromaDBに接続できませんでした: ${base}`);
  }

  async function connect() {
    if (connection) return connection;
    const root = await detectRoot();
    // 同じ名前で作り直しても既存を返します（get_or_create）。起動のたびに作り直しません。
    const created = await request(`${root}/collections`, {
      method: 'POST',
      body: {
        name: collection,
        get_or_create: true,
        // 距離の測り方をコサインにします。既定はL2で、長さ1に揃えたベクトル
        // （`embedding.js`）でもL2距離はコサイン類似度と目盛りが違うので、
        // `1 - distance` がスコアになりません。0から1で読める値に揃えるためです。
        // 既にあるコレクションは作ったときの測り方のままなので、途中で変えるときは
        // コレクション名（CHROMA_COLLECTION）を変えて作り直してください。
        metadata: { 'hnsw:space': 'cosine' }
      }
    });
    connection = { root, collectionId: created.id || created.collection_id || collection };
    return connection;
  }

  return {
    id: 'chroma',
    label: `ChromaDB（${base} / ${collection}）`,

    /**
     * 繋がるまで待ちます。
     *
     * Docker Composeでは、このサービスとChromaDBがほぼ同時に立ち上がります。
     * `depends_on` の healthcheck で順番は付けていますが、それでも一瞬先に来ることが
     * あるので、ここでも待ちます。待たずに諦めると、コンテナが起動直後に1回落ちて、
     * 再起動で偶然うまくいく、という直しにくい形になります。
     *
     * @param {object} [options]
     * @param {number} [options.waitSeconds] 何秒まで待つか。0なら1回だけ試します。
     * @param {Function} [options.onWait] 待っていることを伝える先（起動ログ）。
     */
    async ready({ waitSeconds = 0, onWait = () => {} } = {}) {
      const deadline = Date.now() + waitSeconds * 1000;
      let notified = false;
      while (true) {
        try {
          await connect();
          return true;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          if (!notified) {
            onWait(`ChromaDBを待っています（${base}、最大${waitSeconds}秒）`);
            notified = true;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    },

    async upsert(chunks) {
      if (chunks.length === 0) return;
      const { root, collectionId } = await connect();
      await request(`${root}/collections/${collectionId}/upsert`, {
        method: 'POST',
        body: {
          ids: chunks.map((chunk) => chunk.id),
          embeddings: chunks.map((chunk) => chunk.vector),
          // 本文の正本は `store.js` が持ちます。ここへ入れるのは、Chromaの画面から
          // 索引を覗いたときに、何のベクトルか分かるようにするためです。
          documents: chunks.map((chunk) => chunk.text || ''),
          metadatas: chunks.map((chunk) => ({ ...chunk.metadata, context_id: chunk.contextId }))
        }
      });
    },

    async deleteByContext(contextId) {
      const { root, collectionId } = await connect();
      await request(`${root}/collections/${collectionId}/delete`, {
        method: 'POST',
        body: { where: { context_id: contextId } }
      });
      // Chromaは消した件数を返しません。呼ぶ側は件数を使わないので0で揃えます。
      return 0;
    },

    async query({ vector, limit = 10, scopeKeys = null }) {
      const { root, collectionId } = await connect();
      const body = {
        query_embeddings: [vector],
        n_results: limit,
        include: ['metadatas', 'distances'],
        ...(scopeKeys ? { where: { scope_key: { $in: scopeKeys } } } : {})
      };
      const result = await request(`${root}/collections/${collectionId}/query`, { method: 'POST', body });
      const ids = result.ids?.[0] || [];
      const metadatas = result.metadatas?.[0] || [];
      const distances = result.distances?.[0] || [];
      return ids.map((id, index) => ({
        id,
        contextId: metadatas[index]?.context_id,
        // コサイン距離で返るので（`connect` で測り方を指定しています）、他のVector DBと
        // 同じ「大きいほど近い」へ揃えます。
        score: 1 - Number(distances[index] ?? 1),
        metadata: metadatas[index] || {}
      }));
    },

    async close() {}
  };
}
