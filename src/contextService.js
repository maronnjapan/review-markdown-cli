/**
 * CLIから見たContext APIです。
 *
 * ── CLIが知っているのはこの1本だけ（仕様7.2） ───────────────
 * この先にVector DBがあるのか、埋め込みがどれなのか、索引がChromaDBなのかファイルなのかを、
 * CLIは知りません。知らないままにしておくと、Context API側を作り替えてもCLIは動きます。
 * 逆に、ここでVector DBを直に触ると、索引を替えるたびに原稿を読むアプリを直すことに
 * なります（仕様3.2が禁じているのはその状態です）。
 *
 * ── 繋がらないことは失敗ではなく状態（仕様7.4） ──────────────
 * Context APIは別プロセスなので、立ち上がっていないことがあります。そのときCLIごと
 * 止めるのは行き過ぎです。ファイルを読む・直す・コメントを書く・一般的な質問をする、は
 * Contextと関係なくできます。だからここは「使えない」という状態を返し、使えないことを
 * ユーザーへ伝える役はAIサービスと画面が持ちます。
 *
 * 接続不能（Connection refused、タイムアウト）と 503 は、同じ「Context API利用不可」
 * として扱います（仕様6.5）。CLIから見れば、どちらも「いまContextを使えない」であり、
 * ユーザーが次にすることも同じ（Context APIを起動する）だからです。
 *
 * ── workspace_id を呼ぶ側に書かせない（仕様7.1） ────────────
 * `workspace_id` と、いま開いているファイルから決まる `scope_path` は、ここが補います。
 * AI Agentに書かせると、モデルが別のWorkspaceのidを書いた瞬間に、他のプロジェクトの
 * 判断が混ざります。
 */

import { ensureWorkspaceId, readWorkspaceId, scopePathFor } from './workspace.js';

/** Context APIを待つ時間。越えたら「使えない」として扱います。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 検索で渡す既定の件数。Context API側の既定と揃えます（`src/context/scope.js`）。 */
export const DEFAULT_CONTEXT_LIMIT = 5;

/** 画面とAIへ出す、使えないときの言い方。どこから出ても同じ文にします。 */
export const CONTEXT_UNAVAILABLE_MESSAGE = 'Context API を利用できません（review-markdown context start で起動してください）';

export function contextUnavailableError(detail = '') {
  return Object.assign(new Error(detail ? `${CONTEXT_UNAVAILABLE_MESSAGE}: ${detail}` : CONTEXT_UNAVAILABLE_MESSAGE), {
    unavailable: true
  });
}

/** 設定されていないときに返す、何もできないContextService。 */
export function createDisabledContextService() {
  return {
    enabled: false,
    endpoint: null,
    async status() {
      return { configured: false, available: false, endpoint: null };
    },
    async workspaceId() {
      return null;
    },
    async saveContext() {
      throw contextUnavailableError('contextEndpoint が設定されていません');
    },
    async searchContext() {
      throw contextUnavailableError('contextEndpoint が設定されていません');
    },
    async listContexts() {
      throw contextUnavailableError('contextEndpoint が設定されていません');
    },
    async getContext() {
      throw contextUnavailableError('contextEndpoint が設定されていません');
    },
    async updateContext() {
      throw contextUnavailableError('contextEndpoint が設定されていません');
    },
    async deleteContext() {
      throw contextUnavailableError('contextEndpoint が設定されていません');
    }
  };
}

/**
 * @param {object} options
 * @param {string} options.rootDir Workspace Root（CLIを起動したディレクトリ）。
 * @param {string} [options.endpoint] `contextEndpoint`。無ければ何もできないServiceを返します。
 * @param {string} [options.token] 将来の `Authorization: Bearer`（仕様3.4、8.1）。
 * @param {Function} [options.fetchImpl] テスト用の差し替え口。
 */
export function createContextService({ rootDir, endpoint, token, fetchImpl = fetch } = {}) {
  if (!endpoint) return createDisabledContextService();
  const base = String(endpoint).replace(/\/+$/, '');

  async function request(pathname, { method = 'GET', body, ensureWorkspace = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      // 接続不能もタイムアウトも、ここで同じ「使えない」へ寄せます。
      throw contextUnavailableError(error.message);
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 503) throw contextUnavailableError(payload.error || 'Vector DB');
    if (!response.ok) {
      // 使い方の誤り（400）とContextの不在（404）は、こちらの落ち度として素直に出します。
      throw Object.assign(new Error(payload.error || `Context API がエラーを返しました（HTTP ${response.status}）`), {
        statusCode: response.status
      });
    }
    return payload;
  }

  /** Workspace idは、Contextを使うときに初めて作ります（`src/workspace.js`）。 */
  async function workspaceIdFor({ create = true } = {}) {
    if (!create) return readWorkspaceId(rootDir);
    const { workspaceId } = await ensureWorkspaceId(rootDir);
    return workspaceId;
  }

  return {
    enabled: true,
    endpoint: base,

    /**
     * 使えるかどうか。画面の表示にも、AIがContext検索を諦めるかの判断にも使います。
     * 使えないことは投げずに返します。ここで投げると、呼ぶ側すべてが握りつぶす
     * try/catch を持つことになります。
     */
    async status() {
      try {
        const health = await request('/health');
        return {
          configured: true,
          available: true,
          endpoint: base,
          embedding: health.embedding || null,
          vectorStore: health.vector_store || null
        };
      } catch (error) {
        return { configured: true, available: false, endpoint: base, error: error.message };
      }
    },

    workspaceId: workspaceIdFor,

    /**
     * Contextを1件保存します（仕様6.2）。
     *
     * @param {string} content 残す判断や知識。
     * @param {object} [options]
     * @param {string} [options.scope] `workspace` / `path` / `global`。既定は `workspace`。
     * @param {string} [options.scopePath] `scope = path` のときの対象ディレクトリ。
     * @param {string} [options.documentPath] いま開いている文書。`scopePath` を省いたときの補完に使います。
     * @param {string} [options.kind] `decision` / `preference` / `note`。
     * @param {string} [options.sourceType] `manual` / `comment` / `agent`（仕様7.5）。
     * @param {string} [options.sourcePath] 根拠になったファイル。
     */
    async saveContext(content, options = {}) {
      const scope = options.scope || 'workspace';
      const scopePath = scope === 'path'
        ? (options.scopePath || scopePathFor(options.documentPath))
        : null;
      if (scope === 'path' && !scopePath) {
        throw Object.assign(new Error('このファイルはWorkspace直下にあるので、ディレクトリを範囲にできません'), { statusCode: 400 });
      }
      const body = {
        content,
        scope,
        ...(scope === 'global' ? {} : { workspace_id: await workspaceIdFor() }),
        ...(scopePath ? { scope_path: scopePath } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.sourceType ? { source_type: options.sourceType } : {}),
        ...(options.sourcePath ? { source_path: options.sourcePath } : {})
      };
      return request('/contexts', { method: 'POST', body });
    },

    /**
     * Semantic Search（仕様6.4）。祖先ディレクトリの展開はContext APIが行うので、
     * ここが渡すのは、いま開いているファイルのディレクトリ1つだけです。
     */
    async searchContext(query, options = {}) {
      const workspaceId = await workspaceIdFor({ create: false });
      const scopePath = options.scopePath === undefined
        ? scopePathFor(options.documentPath)
        : options.scopePath;
      const body = {
        query,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...(scopePath ? { scope_path: scopePath } : {}),
        include_global: options.includeGlobal !== false,
        limit: options.limit || DEFAULT_CONTEXT_LIMIT
      };
      const payload = await request('/search', { method: 'POST', body });
      return payload.results || [];
    },

    /** 保存済みの一覧。訂正の起点になる画面が使います（仕様1.3の4つ目）。 */
    async listContexts({ limit } = {}) {
      const workspaceId = await workspaceIdFor({ create: false });
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspace_id', workspaceId);
      if (limit) params.set('limit', String(limit));
      const query = params.toString();
      const payload = await request(`/contexts${query ? `?${query}` : ''}`);
      return payload.results || [];
    },

    async getContext(contextId) {
      return (await request(`/contexts/${encodeURIComponent(contextId)}`)).context;
    },

    async updateContext(contextId, changes) {
      const body = {
        ...(changes.content === undefined ? {} : { content: changes.content }),
        ...(changes.scope === undefined ? {} : { scope: changes.scope }),
        ...(changes.scopePath === undefined ? {} : { scope_path: changes.scopePath }),
        ...(changes.kind === undefined ? {} : { kind: changes.kind })
      };
      return (await request(`/contexts/${encodeURIComponent(contextId)}`, { method: 'PATCH', body })).context;
    },

    async deleteContext(contextId) {
      await request(`/contexts/${encodeURIComponent(contextId)}`, { method: 'DELETE' });
      return true;
    }
  };
}
