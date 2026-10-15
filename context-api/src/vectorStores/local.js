/**
 * Vector DBの既定です。1ファイルのJSONに索引を持ち、全件と突き合わせて検索します。
 *
 * 個人がローカルで動かすものなので、Contextは多くても数千件です。その規模なら、
 * 別のデータベースを立ち上げてもらうより、ファイル1つで済ませたほうが、使い始めるまでの
 * 手数が少なくなります。数万件を超えたら `--vector-db chroma` へ切り替えられます。
 *
 * 検索は、長さ1に揃えたベクトル同士の内積です（`embedding.js`）。コサイン類似度と同じ
 * 値になり、0から1の範囲で読めます。
 *
 * ここが見るのは索引だけで、Contextの本文の正本は `store.js` が別に持ちます。
 * 仕様5.4の「ContextとVectorを論理的に分ける」はこの分け方のことで、将来ここを
 * PostgreSQL + pgvector へ替えても、正本はそのまま残ります。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 1ファイルの索引の形の版。2: 本文（`text`）も持つようにしました（画面の「索引」で、何を埋め込んだかを見せるため）。 */
const INDEX_VERSION = 2;

export function createLocalVectorStore({ dataDir, fileName = 'vectors.json' } = {}) {
  const filePath = path.join(dataDir, fileName);
  /** Chunk id -> `{ contextId, vector, text, metadata }`。読み込むまでは null です。 */
  let entries = null;
  /** 読み込み中の約束。同時に届いた要求が、同じファイルを二度読まないようにします。 */
  let loading = null;
  let writeQueue = Promise.resolve();

  function load() {
    if (entries) return Promise.resolve(entries);
    loading = loading || readFile().finally(() => { loading = null; });
    return loading;
  }

  async function readFile() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      entries = new Map(Array.isArray(parsed?.entries) ? parsed.entries.map((entry) => [entry.id, entry]) : []);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries = new Map();
    }
    return entries;
  }

  /** 書き込みは1本の列に。失敗した1回で列が詰まらないようにします（`store.js` と同じ形）。 */
  function persist() {
    const queued = writeQueue.then(write, write);
    writeQueue = queued.catch(() => {});
    return queued;
  }

  async function write() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = { version: INDEX_VERSION, entries: [...entries.values()] };
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  }

  return {
    id: 'local',
    label: `ローカルファイル（${filePath}）`,

    /**
     * 使える状態かどうか。ファイルは無くてよく、書ける場所であることだけを見ます。
     * 待ち時間の指定は受け取りますが使いません。相手がいないので、待つことがありません。
     */
    async ready() {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await load();
      return true;
    },

    async upsert(chunks) {
      await load();
      for (const chunk of chunks) {
        entries.set(chunk.id, {
          id: chunk.id,
          contextId: chunk.contextId,
          vector: chunk.vector,
          // 本文の正本は `store.js` と `pages/store.js` が持ちます。ここにも置くのは、
          // 索引を覗いたとき（`list`）に「何を埋め込んだか」をベクトルと並べて見せるためです。
          text: chunk.text ?? null,
          metadata: chunk.metadata || {}
        });
      }
      await persist();
    },

    async deleteByContext(contextId) {
      await load();
      let removed = 0;
      for (const [id, entry] of entries) {
        if (entry.contextId !== contextId) continue;
        entries.delete(id);
        removed += 1;
      }
      if (removed) await persist();
      return removed;
    },

    /**
     * @param {object} query
     * @param {number[]} query.vector 質問のベクトル。
     * @param {number} query.limit 返すChunkの上限。Context単位へまとめるのは呼ぶ側です。
     * @param {string[]} [query.scopeKeys] 検索してよい範囲（`scope.js` の `scopeKeysFor`）。
     *   省略すると絞りません。
     * @param {string[]} [query.sources] 出どころ（`context` / `page`）で絞ります。省略すると絞りません。
     *   出どころの無い古い索引は `context` として扱います（ページを載せる前に作った索引です）。
     */
    async query({ vector, limit = 10, scopeKeys = null, sources = null }) {
      await load();
      const allowed = scopeKeys ? new Set(scopeKeys) : null;
      const allowedSources = sources ? new Set(sources) : null;
      const scored = [];
      for (const entry of entries.values()) {
        if (allowed && !allowed.has(entry.metadata?.scope_key)) continue;
        if (allowedSources && !allowedSources.has(entry.metadata?.source || 'context')) continue;
        scored.push({
          id: entry.id,
          contextId: entry.contextId,
          score: dot(vector, entry.vector),
          metadata: entry.metadata
        });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    /** 索引に入っているChunkの数。画面の設定欄と `/health` が出します。 */
    async count() {
      await load();
      return entries.size;
    },

    /**
     * 索引に入っているChunkを、入れた形のまま読みます（`GET /index/chunks`、画面の「索引」）。
     * `chroma.js` と同じ形で返します。
     *
     * @param {object} [options]
     * @param {number} [options.limit] 返す上限。既定50。
     * @param {number} [options.offset] 読み飛ばす数。既定0。
     * @param {string[]} [options.ids] 指定したChunkだけ（1件を開くとき）。
     * @param {string} [options.contextId] 1件の正本（Contextかページ）のChunkだけ。
     * @param {string[]} [options.sources] 出どころ（`context` / `page`）で絞ります。
     * @param {boolean} [options.vectors] ベクトルも返すか。既定は返しません（1Chunkに数百〜数千の数が付くので、求められたときだけ）。
     * @returns {Promise<{ chunks: Array<{ id: string, contextId: string, text: string|null, metadata: object, vector?: number[] }>, total: number }>}
     *   `total` は切る前の数です。
     */
    async list({ limit = 50, offset = 0, ids = null, contextId = null, sources = null, vectors = false } = {}) {
      await load();
      const wanted = ids ? new Set(ids) : null;
      const allowedSources = sources ? new Set(sources) : null;
      const matched = [];
      for (const entry of entries.values()) {
        if (wanted && !wanted.has(entry.id)) continue;
        if (contextId && entry.contextId !== contextId) continue;
        if (allowedSources && !allowedSources.has(entry.metadata?.source || 'context')) continue;
        matched.push(entry);
      }
      return {
        total: matched.length,
        chunks: matched.slice(offset, offset + limit).map((entry) => ({
          id: entry.id,
          contextId: entry.contextId,
          text: entry.text ?? null,
          metadata: entry.metadata || {},
          ...(vectors ? { vector: entry.vector } : {})
        }))
      };
    },

    async close() {
      await writeQueue;
    }
  };
}

/** 長さ1のベクトル同士なので、内積がそのままコサイン類似度です。 */
function dot(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}
