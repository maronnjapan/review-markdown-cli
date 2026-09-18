/**
 * AI Agentが、質問ごとに `search_context` を使うかどうかを決めるところです（仕様2.1、7.1）。
 *
 * ── 全部の質問で検索しない ──────────────────────────────
 * 「JWTって何？」に保存済みの判断は要りません。そこへ検索を挟むと、たまたま語の
 * 似ているContextが前提として混ざり、一般的な答えのはずのものが、このプロジェクト固有の
 * 話に歪みます。逆に「JWTの有効期限、前にどう決めた？」で検索しなければ、AIは
 * 覚えていない一般論を答えます。どちらになるかは語では決まらないので、モデルに決めさせます。
 *
 * ── 検索語をモデルに書かせる理由 ──────────────────────────
 * 質問文そのままでは引けないことがあります。「このプロジェクトの認証方式って何？」と
 * 保存してある「OIDCを利用する」には、共通する語がほとんどありません。保存したときに
 * 使ったであろう語（OIDC、OAuth、SAML、ログイン）を足した検索語を書かせると、
 * このあたりの取りこぼしが減ります。
 *
 * ── 使ったContextを拾う ────────────────────────────────
 * 回答の中の `[ctx_xxx]` を拾って、どのContextを根拠にしたかを画面へ返します（仕様7.3）。
 * モデルが書き忘れることもあるので、渡したContextは全部返し、そのうち名指しされたものに
 * 印を付けます。「渡したが使わなかった」と「使ったのに書き忘れた」を画面で見分けられる
 * ようにするためです。
 */

/**
 * 回答の中に書かれたContextとページのid。`[ctx_...]` と `ctx_...` の両方を拾います。
 * ページ（`pg_...`）も同じ形で名指しさせます（`prompts/savedContexts.js`）。
 */
const CITATION_PATTERN = /(?:ctx|pg)_[A-Za-z0-9_-]+/g;

/** モデルが決めた計画。答えが壊れていても、検索しない側へ倒します。 */
export function normalizeContextPlan(answer) {
  const needsContext = answer?.needsContext === true;
  const query = typeof answer?.query === 'string' ? answer.query.trim() : '';
  return {
    // 検索すると答えたのに検索語が空なら、検索しません。空の検索語で引くと、
    // 質問と関係のないContextが類似度順に並ぶだけです。
    needsContext: needsContext && Boolean(query),
    query,
    reason: typeof answer?.reason === 'string' ? answer.reason.trim() : ''
  };
}

/**
 * 回答が名指ししたContextのidです。渡していないidは捨てます。
 * モデルが作ったidをそのまま画面へ出すと、存在しない根拠が根拠として表示されます。
 */
export function citedContextIds(text, contexts = []) {
  const provided = new Set(contexts.map(knowledgeId));
  const cited = new Set();
  for (const match of String(text || '').matchAll(CITATION_PATTERN)) {
    if (provided.has(match[0])) cited.add(match[0]);
  }
  return [...cited];
}

/**
 * 検索結果1件のid。Contextは `ctx_...`、ページは `pg_...` です。
 * Context APIの検索は、`sources` にページを含めるとページも混ぜて返します（`type: 'page'`）。
 */
export function knowledgeId(result) {
  return result.type === 'page' ? result.page_id : result.context_id;
}

/**
 * 画面へ返す根拠です。渡したContextとページすべてに、使われたかどうかの印を付けます。
 *
 * @param {Array} contexts `search_context` が返したもの（Contextとページ）。
 * @param {string} answerText モデルの回答。
 * @returns {Array} `{ type, contextId, content, score, scope, scopePath, kind, updatedAt, cited }`。
 *   ページには `pageId`、`title`、`heading`、`workspaceId` も付きます。`contextId` には
 *   どちらでもidが入ります（画面が名指しに使う欄を1つにするためです）。
 */
export function evidenceFrom(contexts = [], answerText = '') {
  const cited = new Set(citedContextIds(answerText, contexts));
  return contexts.map((context) => (context.type === 'page'
    ? {
      type: 'page',
      contextId: context.page_id,
      pageId: context.page_id,
      workspaceId: context.workspace_id || null,
      title: context.title || '',
      heading: context.heading || '',
      content: context.snippet ?? context.content ?? '',
      score: context.score,
      scope: 'workspace',
      scopePath: null,
      kind: 'page',
      updatedAt: context.updated_at || null,
      cited: cited.has(context.page_id)
    }
    : {
      type: 'context',
      contextId: context.context_id,
      content: context.content,
      score: context.score,
      scope: context.scope,
      scopePath: context.scope_path || null,
      kind: context.kind || 'note',
      updatedAt: context.updated_at || null,
      cited: cited.has(context.context_id)
    }));
}

/**
 * 会話へ残す、今回のContextの使われ方です。
 *
 * `status` は3つ。`used`（検索して渡した）、`unavailable`（Context APIが使えなかった）、
 * `skipped`（この質問には要らないとモデルが判断した）。画面はこれを見て、
 * 根拠を出すか、使えなかったことを出すか、何も出さないかを決めます。
 */
export function contextUsage({ status, query = '', reason = '', evidence = [], error = '' }) {
  return {
    status,
    ...(query ? { query } : {}),
    ...(reason ? { reason } : {}),
    ...(error ? { error } : {}),
    ...(evidence.length ? { evidence } : {})
  };
}
