/**
 * 「いまどこを開いているか」から、検索してよいContextの範囲を決めます。
 *
 * ── 祖先をここで展開する理由 ────────────────────────────
 * `src/auth/oauth/token.ts` を開いている人には、`src/auth/oauth` に保存した決定も、
 * `src/auth` に保存した決定も、Workspace全体の決定も効きます。この展開をCLI側でやると、
 * 「どこまで遡るか」という決まりがCLIとContext APIの2か所に分かれて持たれます。
 * 片方だけ直したときに、保存したのに出てこないContextができるので、決めるのはここだけです。
 * CLIが送るのは、いま開いているファイルのディレクトリ1つです（仕様5.3）。
 *
 * ── scope_key という1本の文字列にしている理由 ───────────────
 * 範囲は `scope` と `workspace_id` と `scope_path` の3つで決まりますが、Vector DBへは
 * 1つの文字列として入れます。どのVector DBにも「この値のどれかに一致するもの」という
 * 絞り込みはありますが、3つの欄をまたいだ条件の書き方は製品ごとに違うからです。
 * 1本にしておけば、ChromaDBでもローカルのファイルでも同じ絞り込みで済みます。
 *
 * ── 並び順は類似度だけ（仕様5.3の【要確認5】への回答） ──────────
 * MVPは類似度の高い順に返します。「近いディレクトリのContextを優先する」加点は、
 * どれくらい効かせるのが妥当かを使ってみないと決められないので、入れていません。
 * 代わりに、あとから入れられる材料（`scope_depth`）はVector DBのMetadataへ入れてあり、
 * `rankContexts` は重みを受け取る形にしてあります。既定の重みは0です。
 */

import { contextApiError, normalizeRelativePath } from './model.js';

/** `/search` の `limit` の既定（仕様6.4の【要確認6】への回答）。 */
export const DEFAULT_SEARCH_LIMIT = 5;

/** `limit` の上限。これ以上を前提として渡しても、AIが読むのは前のほうだけです。 */
export const MAX_SEARCH_LIMIT = 20;

/** どのWorkspaceでも効くContextの範囲キー。 */
const GLOBAL_KEY = 'global';

/**
 * Context 1件の範囲キー。保存時にVector DBのMetadataへ入れます。
 */
export function scopeKeyFor({ scope, workspace_id: workspaceId, scope_path: scopePath }) {
  if (scope === 'global') return GLOBAL_KEY;
  if (scope === 'workspace') return `ws:${workspaceId}`;
  return `path:${workspaceId}:${scopePath}`;
}

/**
 * 範囲の細かさ。大きいほど「いま開いている場所に近い」範囲です。
 * MVPでは並び順に使いませんが、将来の加点はこの値から計算できます。
 */
export function scopeDepthOf({ scope, scope_path: scopePath }) {
  if (scope === 'global') return -1;
  if (scope === 'workspace') return 0;
  return String(scopePath || '').split('/').filter(Boolean).length;
}

/**
 * 検索してよい範囲キーの一覧です。開いている場所から祖先へ遡って並べます。
 *
 * @param {object} params
 * @param {string} [params.workspaceId] 開いているWorkspace。無ければ `global` だけになります。
 * @param {string} [params.scopePath] 開いているファイルのディレクトリ（Workspace Rootからの相対）。
 * @param {boolean} [params.includeGlobal] 個人の共通知識も混ぜるか。
 */
export function scopeKeysFor({ workspaceId, scopePath, includeGlobal = true }) {
  const keys = [];
  if (workspaceId) {
    for (const ancestor of ancestorPaths(scopePath)) {
      keys.push(`path:${workspaceId}:${ancestor}`);
    }
    keys.push(`ws:${workspaceId}`);
  }
  if (includeGlobal) keys.push(GLOBAL_KEY);
  return keys;
}

/**
 * `src/auth/oauth` から `src/auth/oauth`, `src/auth`, `src` を作ります。近い順です。
 * 空のときは何も返しません（Workspace全体のContextだけが対象になります）。
 */
export function ancestorPaths(scopePath) {
  const raw = String(scopePath || '').trim();
  if (!raw) return [];
  const segments = normalizeRelativePath(raw, 'scope_path').split('/');
  const paths = [];
  for (let length = segments.length; length > 0; length -= 1) {
    paths.push(segments.slice(0, length).join('/'));
  }
  return paths;
}

/**
 * `POST /search` の受け取りです。使えない値は 400 で断ります。
 */
export function normalizeSearchRequest(body = {}) {
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) throw contextApiError('query を指定してください');
  const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id.trim() : '';
  const scopePath = typeof body.scope_path === 'string' ? body.scope_path.trim() : '';
  const includeGlobal = body.include_global === undefined ? true : body.include_global === true;
  if (!workspaceId && !includeGlobal) {
    throw contextApiError('workspace_id を指定しないときは include_global を true にしてください');
  }
  return {
    query,
    workspaceId: workspaceId || null,
    // 開いているのがWorkspace Rootそのものなら、ディレクトリの指定はありません。
    scopePath: scopePath ? normalizeRelativePath(scopePath, 'scope_path') : null,
    includeGlobal,
    limit: normalizeLimit(body.limit),
    minScore: normalizeMinScore(body.min_score)
  };
}

/**
 * ChunkのヒットをContext 1件ずつへまとめます（仕様5.4）。
 *
 * 同じContextの複数Chunkが当たったときは、いちばん高いスコアをそのContextのスコアに
 * します。合計にすると、長く書いたContextほど上に来ることになり、内容ではなく
 * 分量で順位が決まってしまいます。
 *
 * @param {Array} hits Vector DBが返したChunkのヒット。
 * @param {object} options
 * @param {Function} options.load contextId からContext本体を引く関数。
 * @param {number} [options.proximityWeight] 近い範囲への加点の重み。既定0（このモジュール冒頭）。
 */
export async function rankContexts(hits, { load, limit = DEFAULT_SEARCH_LIMIT, minScore = 0, proximityWeight = 0 } = {}) {
  const best = new Map();
  for (const hit of hits) {
    if (!hit?.contextId) continue;
    const current = best.get(hit.contextId);
    if (!current || hit.score > current.score) {
      best.set(hit.contextId, { score: hit.score, metadata: hit.metadata || {} });
    }
  }

  const results = [];
  for (const [contextId, { score, metadata }] of best) {
    if (score < minScore) continue;
    const context = await load(contextId);
    // 正本から消えているのに索引に残っているChunkは、結果に混ぜません。
    // 消したはずの判断が回答に出てくるのは、訂正できていないのと同じです。
    if (!context) continue;
    const depth = Number(metadata.scope_depth ?? scopeDepthOf(context));
    results.push({ context, score, rank: score + proximityWeight * depth });
  }
  return results
    .sort((a, b) => b.rank - a.rank || String(a.context.context_id).localeCompare(String(b.context.context_id)))
    .slice(0, limit)
    .map(({ context, score }) => ({ context, score }));
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SEARCH_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw contextApiError(`limit は1から${MAX_SEARCH_LIMIT}の整数で指定してください: ${value}`);
  }
  return limit;
}

/**
 * これ未満のスコアは返しません。送られてこなければ、埋め込みが決めた既定を使います
 * （`server.js`。埋め込みごとにスコアの出方が違うためです）。
 */
function normalizeMinScore(value) {
  if (value === undefined || value === null || value === '') return null;
  const minScore = Number(value);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw contextApiError(`min_score は0から1の数で指定してください: ${value}`);
  }
  return minScore;
}
