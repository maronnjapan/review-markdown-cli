/**
 * Contextの正本と、その索引（Vector）の面倒を一緒に見るところです。
 *
 * ── 正本と索引を分けている理由（仕様5.4） ────────────────────
 * Contextの本文とMetadataは、このモジュールが持つJSONファイルが正本です。Vector DBへ
 * 入るのは、それを引くための索引だけです。同じものを2か所に置いているように見えますが、
 * 役割が違います。正本は「ユーザーが残した判断」で、索引は「それを引くための数字」です。
 * 埋め込みを変えれば索引は作り直せますが、正本は作り直せません。将来ここを
 * PostgreSQLへ移しても、索引の側だけを差し替えられるようにしてあります。
 *
 * ── 埋め込みが変わったら索引を作り直す ─────────────────────
 * 索引には、どの埋め込みで作ったかを記録します。違う埋め込みで作った数字同士を
 * 比べても意味が無いので、起動時に食い違いを見つけたら黙って作り直します。
 * 作り直せるのは、正本が別にあるからです。
 *
 * ── 本文を書き換えたら索引も作り直す（仕様6.3） ─────────────
 * 更新で本文が変わったときは、古いChunkとVectorを捨ててから入れ直します。残したまま
 * 足すと、「以前の決定」と「変えたあとの決定」の両方が検索に当たります。訂正したのに
 * 古い判断を前提に答え続けるのは、訂正できていないのと同じです。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkContent } from './chunking.js';
import { applyContextPatch, buildContext, contextApiError } from './model.js';
import { DEFAULT_SEARCH_LIMIT, rankContexts, scopeDepthOf, scopeKeyFor, scopeKeysFor } from './scope.js';

const STORE_VERSION = 1;
const STORE_FILE = 'contexts.json';

/**
 * @param {object} options
 * @param {string} options.dataDir Contextの正本と索引を置くディレクトリ。
 * @param {object} options.embedder `embedding.js` が作ったもの。
 * @param {object} options.vectorStore `vectorStores/` が作ったもの。
 * @param {number} [options.proximityWeight] 近い範囲への加点（`scope.js`。既定0）。
 */
export function createContextStore({ dataDir, embedder: rawEmbedder, vectorStore: rawVectorStore, proximityWeight = 0 }) {
  const filePath = path.join(dataDir, STORE_FILE);
  // 索引と埋め込みの失敗は、どちらも「いまContextを扱えない」ことです。呼ぶ側が
  // 500（こちらの不具合）と区別できるよう、ここで 503 の札を付けておきます。
  // CLIは接続不能と503を同じ「Context API利用不可」として扱います（仕様6.5、7.4）。
  const vectorStore = unavailableAs503(rawVectorStore, 'Vector DB');
  const embedder = unavailableAs503(rawEmbedder, '埋め込み');
  /** context_id -> Context。読み込むまでは null です。 */
  let contexts = null;
  /** 索引を作った埋め込みのid。正本のファイルに一緒に入れます。 */
  let indexedWith = null;
  let writeQueue = Promise.resolve();

  async function load() {
    if (contexts) return contexts;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      contexts = new Map((parsed?.contexts || []).map((context) => [context.context_id, context]));
      indexedWith = typeof parsed?.embedding === 'string' ? parsed.embedding : null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      contexts = new Map();
      indexedWith = null;
    }
    return contexts;
  }

  function persist() {
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const payload = {
        version: STORE_VERSION,
        embedding: indexedWith,
        contexts: [...contexts.values()]
      };
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, filePath);
    });
    return writeQueue;
  }

  /** Context 1件を索引へ入れ直します。古いChunkは必ず先に捨てます。 */
  async function reindex(context) {
    await vectorStore.deleteByContext(context.context_id);
    const chunks = chunkContent(context.content);
    if (chunks.length === 0) return;
    const vectors = await embedder.embed(chunks);
    await vectorStore.upsert(chunks.map((text, index) => ({
      id: `${context.context_id}#${index}`,
      contextId: context.context_id,
      vector: vectors[index],
      text,
      metadata: {
        scope_key: scopeKeyFor(context),
        // 並び順には使いませんが、将来「近い範囲を優先する」を入れるときの材料です
        // （`scope.js` 冒頭の【要確認5】への回答）。
        scope_depth: scopeDepthOf(context),
        scope: context.scope,
        kind: context.kind,
        updated_at: context.updated_at
      }
    })));
  }

  return {
    embedder,
    vectorStore,

    /**
     * 使える状態にします。Vector DBへ繋がらなければここで投げ、呼ぶ側が 503 にします。
     * 埋め込みが前回と違っていれば、索引を作り直してから返ります。
     */
    async ready() {
      await vectorStore.ready();
      await load();
      if (indexedWith === embedder.id) return { reindexed: 0 };
      let reindexed = 0;
      for (const context of contexts.values()) {
        await reindex(context);
        reindexed += 1;
      }
      indexedWith = embedder.id;
      await persist();
      return { reindexed };
    },

    async create(input) {
      await load();
      const context = buildContext(input);
      contexts.set(context.context_id, context);
      await reindex(context);
      await persist();
      return context;
    },

    async get(contextId) {
      await load();
      return contexts.get(contextId) || null;
    },

    async patch(contextId, changes) {
      await load();
      const stored = contexts.get(contextId);
      if (!stored) throw contextApiError(`Contextが見つかりません: ${contextId}`, 404);
      const { context, contentChanged } = applyContextPatch(stored, changes);
      contexts.set(contextId, context);
      // 範囲や種類だけを変えたときも索引へ入れ直します。Metadataが古いままだと、
      // 範囲を絞ったつもりのContextが、絞る前の範囲で検索に当たり続けます。
      await reindex(context);
      await persist();
      return { context, contentChanged };
    },

    async remove(contextId) {
      await load();
      if (!contexts.has(contextId)) throw contextApiError(`Contextが見つかりません: ${contextId}`, 404);
      contexts.delete(contextId);
      await vectorStore.deleteByContext(contextId);
      await persist();
      return true;
    },

    /**
     * Semantic Search。検索してよい範囲は `scope.js` が決め、ここは索引を引いて
     * Context単位へまとめるだけです。
     */
    async search(request) {
      await load();
      const scopeKeys = scopeKeysFor({
        workspaceId: request.workspaceId,
        scopePath: request.scopePath,
        includeGlobal: request.includeGlobal
      });
      if (scopeKeys.length === 0) return [];
      const [vector] = await embedder.embed([request.query]);
      const hits = await vectorStore.query({
        vector,
        // Chunk単位で引いてからContext単位へまとめるので、要求された件数より多めに引きます。
        // 同じContextの複数Chunkが上位を占めると、まとめたあとに件数が足りなくなるためです。
        limit: (request.limit || DEFAULT_SEARCH_LIMIT) * 4,
        scopeKeys
      });
      return rankContexts(hits, {
        load: (id) => contexts.get(id) || null,
        limit: request.limit,
        minScore: request.minScore ?? embedder.minScore ?? 0,
        proximityWeight
      });
    },

    /**
     * 保存済みのContextを新しい順に並べます。仕様6.1の一覧には無い口ですが、
     * 訂正（仕様1.3の4つ目）には「何を保存したか」を見る場所が要ります。根拠提示から
     * たどれるのは、その回答に使われた1件だけだからです。
     */
    async list({ workspaceId = null, includeGlobal = true, limit = 100 } = {}) {
      await load();
      return [...contexts.values()]
        .filter((context) => (
          (workspaceId && context.workspace_id === workspaceId)
          || (includeGlobal && context.scope === 'global')
          || (!workspaceId && !context.workspace_id)
        ))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, limit);
    },

    async close() {
      await writeQueue;
      await vectorStore.close?.();
    }
  };
}

/**
 * 外の相手（Vector DB、埋め込み）の失敗に 503 を付けます。
 *
 * 付いていない失敗は 500 として出ます。区別するのは、CLIの振る舞いが変わるからです。
 * 503 なら「いまContextが使えない」とユーザーへ伝えてローカルファイルの機能は続け、
 * 500 ならこちらの不具合なので、そのまま出します（仕様7.4）。
 */
function unavailableAs503(target, label) {
  return new Proxy(target, {
    get(source, property) {
      const value = source[property];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        try {
          return await value.apply(source, args);
        } catch (error) {
          if (error?.statusCode) throw error;
          throw contextApiError(`${label}を利用できません: ${error.message}`, 503);
        }
      };
    }
  });
}
