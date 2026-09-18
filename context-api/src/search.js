/**
 * Contextとページをまとめて意味で引く口です（RAGの「検索」の側）。
 *
 * ── `/search` と分けずに、同じ索引を1回引く ──────────────────
 * Context（`store.js`）とページ（`pages/store.js`）は正本が別ですが、索引は同じVector DBです。
 * ここは索引を1回引き、当たったChunkの出どころ（`source`）を見て、どちらの正本から本体を
 * 引くかを決めます。出どころごとに2回引いて混ぜると、件数の配分をこちらで決めることになり、
 * 「判断は3件、ページは2件」のような恣意的な数がAPIの形に残ります。
 *
 * ── 結果はChunkではなく、Contextかページ1件ずつ ───────────────
 * 同じページの複数Chunkが当たったときは、いちばん高いスコアをそのページのスコアにし、
 * そのChunkの本文を抜粋（`snippet`）として返します（`scope.js` の `rankContexts` と同じ考え方）。
 * ページ全体を返さないのは、200,000文字のページが1件当たっただけで、AIに渡す前提が
 * ページ丸ごとになるからです。ページの本文が要るときは `GET /pages/{id}` で引けます。
 *
 * ── 検索の前に、索引の列が空になるのを待つ ──────────────────
 * ページの索引は保存の後で非同期に作られます（`pages/store.js`）。待たずに引くと、
 * 「いま保存した1行」が数百ミリ秒だけ出てこないことになり、それを「保存されていない」と
 * 読む人が出ます。待つのは、列に何かあるときだけです。
 */

import { chunkPage } from './pages/chunking.js';
import { contextApiError } from './model.js';
import { DEFAULT_SEARCH_LIMIT, normalizeSearchRequest, scopeDepthOf, scopeKeysFor } from './scope.js';

/** 出どころ。`context`（保存した判断）と `page`（ページ）。 */
export const KNOWLEDGE_SOURCES = Object.freeze(['context', 'page']);

/** 1件の抜粋の上限。AIへ渡す前提と画面の両方で読める長さです。 */
const MAX_SNIPPET_CHARS = 1200;

/**
 * `/search` と `/ask` の受け取りです。`scope.js` の受け取りに、出どころと「全Workspace」を足したものです。
 *
 * @param {object} body
 * @param {object} [options]
 * @param {string[]} [options.defaultSources] `sources` を省いたときの出どころ。
 *   `/search` はContextだけ（従来どおり）、画面と `/ask` は両方です。
 */
export function normalizeKnowledgeRequest(body = {}, { defaultSources = ['context'] } = {}) {
  const allWorkspaces = body.all_workspaces === true;
  const sources = normalizeSources(body.sources, defaultSources);
  const base = normalizeSearchRequest(allWorkspaces
    // 全Workspaceを引くときは範囲の指定を見ません。`include_global` の決まりにも掛からないようにします。
    ? { ...body, workspace_id: undefined, scope_path: undefined, include_global: true }
    : body);
  return { ...base, sources, allWorkspaces };
}

export function normalizeSources(value, fallback) {
  if (value === undefined || value === null) return [...fallback];
  const list = Array.isArray(value) ? value : [value];
  const sources = [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))];
  if (sources.length === 0) throw contextApiError(`sources を1つ以上指定してください（${KNOWLEDGE_SOURCES.join(' / ')}）`);
  for (const source of sources) {
    if (!KNOWLEDGE_SOURCES.includes(source)) {
      throw contextApiError(`使えない sources です: ${source}（使えるもの: ${KNOWLEDGE_SOURCES.join(', ')}）`);
    }
  }
  return sources;
}

/**
 * @param {object} options
 * @param {object} options.contexts `store.js` が作ったもの。埋め込みと索引もここから借ります（503の札付き）。
 * @param {object} options.pages `pages/store.js` が作ったもの。
 * @param {number} [options.proximityWeight] 近い範囲への加点（`scope.js`）。既定0。
 */
export function createKnowledgeSearch({ contexts, pages, proximityWeight = 0 }) {
  const { embedder, vectorStore } = contexts;

  async function contextResult(contextId, score) {
    const context = await contexts.get(contextId);
    if (!context) return null;
    return {
      type: 'context',
      context_id: context.context_id,
      workspace_id: context.workspace_id,
      content: context.content,
      score,
      scope: context.scope,
      scope_path: context.scope_path,
      kind: context.kind,
      source_type: context.source_type,
      source_path: context.source_path,
      updated_at: context.updated_at
    };
  }

  async function pageResult(pageId, chunkId, score, metadata) {
    const page = await pages.get(pageId);
    if (!page) return null;
    // Chunkの本文は索引に持たず、正本から同じ切り方で作り直します。索引に本文を重ねて持つと、
    // 本文を直したのに古い抜粋が出る、という食い違いの置き場が増えるからです。
    const index = Number(String(chunkId).split('#').pop());
    const chunk = chunkPage(page)[Number.isInteger(index) ? index : 0] || null;
    const snippet = truncate(chunk?.text || '', MAX_SNIPPET_CHARS);
    return {
      type: 'page',
      page_id: page.page_id,
      workspace_id: page.workspace_id,
      title: page.title,
      breadcrumb: page.breadcrumb,
      heading: chunk?.heading ?? metadata.heading ?? '',
      snippet,
      // `content` にも同じ抜粋を入れます。Contextの結果と同じ欄で本文を読む道具（CLIのプロンプト組み立てなど）が、
      // 出どころを見分けずに使えるようにするためです。
      content: snippet,
      score,
      updated_at: page.updated_at
    };
  }

  return {
    /**
     * @param {object} request `normalizeKnowledgeRequest` の結果。
     * @returns {Promise<Array>} スコアの高い順。`type` が `context` か `page` です。
     */
    async search(request) {
      const scopeKeys = request.allWorkspaces ? null : scopeKeysFor({
        workspaceId: request.workspaceId,
        scopePath: request.scopePath,
        includeGlobal: request.includeGlobal
      });
      if (scopeKeys && scopeKeys.length === 0) return [];
      await pages.idle();

      const limit = request.limit || DEFAULT_SEARCH_LIMIT;
      const [vector] = await embedder.embed([request.query]);
      const hits = await vectorStore.query({
        vector,
        limit: limit * 4,
        scopeKeys,
        sources: request.sources
      });

      const best = new Map();
      for (const hit of hits) {
        if (!hit?.contextId) continue;
        const current = best.get(hit.contextId);
        if (!current || hit.score > current.score) {
          best.set(hit.contextId, { score: hit.score, chunkId: hit.id, metadata: hit.metadata || {} });
        }
      }

      const minScore = request.minScore ?? embedder.minScore ?? 0;
      const ranked = [];
      for (const [ownerId, { score, chunkId, metadata }] of best) {
        if (score < minScore) continue;
        const source = metadata.source || 'context';
        const result = source === 'page'
          ? await pageResult(ownerId, chunkId, score, metadata)
          : await contextResult(ownerId, score);
        // 正本から消えているのに索引に残っているものは混ぜません。
        if (!result) continue;
        const depth = Number(metadata.scope_depth ?? (source === 'page' ? 0 : scopeDepthOf(result)));
        ranked.push({ result, rank: score + proximityWeight * depth });
      }
      return ranked
        .sort((a, b) => b.rank - a.rank || ownerIdOf(a.result).localeCompare(ownerIdOf(b.result)))
        .slice(0, limit)
        .map(({ result }) => ({ ...result, score: Number(result.score.toFixed(4)) }));
    }
  };
}

function ownerIdOf(result) {
  return String(result.page_id || result.context_id || '');
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
