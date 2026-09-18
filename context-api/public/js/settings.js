/**
 * 設定の画面です。サーバの状態、Workspaceの名前とid、Markdownの取り込みと書き出し、
 * 外部のツール（review-markdown CLI、MCP）から繋ぐための手順を1か所に置きます。
 */

import { download, escapeHtml } from './util.js';

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.api
 * @param {Function} options.toast
 * @param {Function} options.getWorkspace 今のWorkspace（無ければ null）。
 * @param {Function} options.getToken
 * @param {Function} options.setToken
 * @param {Function} options.onWorkspaceChanged 名前を変えた・消したあとに呼びます。
 * @param {Function} options.onImported 取り込んだあとに呼びます。
 */
export function createSettingsView({ root, api, toast, getWorkspace, getToken, setToken, onWorkspaceChanged, onImported }) {
  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);

  async function show() {
    document.title = '設定 · Knowledge';
    const workspace = getWorkspace();
    const origin = window.location.origin;
    root.innerHTML = `
      <section class="settings">
        <header class="view-head"><h1>設定</h1></header>

        <section class="settings-block">
          <h2>サーバ</h2>
          <dl class="settings-facts" data-health><dt>状態</dt><dd>確認しています…</dd></dl>
          <p class="muted">索引に失敗したページがあるときは、埋め込みのサービスを立ち上げ直してから作り直せます。</p>
          <button type="button" data-retry-index>失敗した索引を作り直す</button>
        </section>

        <section class="settings-block">
          <h2>Workspace</h2>
          ${workspace ? `
            <form data-rename class="settings-form">
              <label class="field"><span>名前</span><input name="name" type="text" value="${escapeHtml(workspace.name || '')}" maxlength="80"></label>
              <button type="submit" class="primary">名前を保存</button>
            </form>
            <p class="settings-id">id: <code data-copy="${escapeHtml(workspace.workspace_id)}" title="押すとコピー">${escapeHtml(workspace.workspace_id)}</code></p>
            <p class="muted">リポジトリを review-markdown で開くときは、このidを <code>.review/workspace.json</code> に <code>{"workspace_id": "…"}</code> と書くと、そのリポジトリのAIがこのWorkspaceのページと判断を引きます。</p>
            <div class="settings-row">
              <button type="button" data-export>Markdownの束として書き出す（JSON）</button>
              <label class="file-button">Markdownを取り込む<input type="file" multiple accept=".md,.markdown,.txt" data-import hidden></label>
              <label class="file-button">フォルダごと取り込む<input type="file" webkitdirectory multiple data-import hidden></label>
              <button type="button" class="danger" data-delete-workspace>このWorkspaceを削除</button>
            </div>`
          : '<p class="muted">Workspaceを選ぶと、名前の変更や取り込みができます。</p>'}
        </section>

        <section class="settings-block">
          <h2>外部のツールから使う</h2>
          <p>この画面が使っているHTTPの口を、そのまま外のツールにも開いています。</p>
          <h3>Claude Code / Codex などのAIエージェント（MCP）</h3>
          <pre><code>claude mcp add --transport http knowledge ${escapeHtml(origin)}/mcp</code></pre>
          <p class="muted">エージェントは <code>search_knowledge</code> で判断とページを引き、確認の取れた決定を <code>save_context</code> で残し、長いメモを <code>create_page</code> で書けます。</p>
          <h3>review-markdown CLI</h3>
          <pre><code>review-markdown config set contextEndpoint ${escapeHtml(origin)} --global
review-markdown context status</code></pre>
          <h3>HTTP</h3>
          <pre><code>curl -X POST ${escapeHtml(origin)}/search -H 'Content-Type: application/json' \\
  -d '{"query":"認証方式","workspace_id":"${escapeHtml(workspace?.workspace_id || '…')}","sources":["context","page"]}'</code></pre>
        </section>

        <section class="settings-block">
          <h2>アクセストークン</h2>
          <p class="muted">サーバに <code>CONTEXT_API_TOKEN</code> を設定したときだけ要ります。このブラウザにだけ保存します。</p>
          <form data-token class="settings-form">
            <label class="field"><span>トークン</span><input name="token" type="password" value="${escapeHtml(getToken() || '')}" autocomplete="off"></label>
            <button type="submit">保存</button>
          </form>
        </section>
      </section>`;
    await paintHealth();
  }

  async function paintHealth() {
    const facts = root.querySelector('[data-health]');
    if (!facts) return;
    try {
      const health = await api.health();
      facts.innerHTML = [
        ['状態', `稼働中（v${escapeHtml(health.version || '')}）`],
        ['埋め込み', escapeHtml(health.embedding?.label || '')],
        ['索引', escapeHtml(health.vector_store?.label || '')],
        ['回答の生成', health.chat ? escapeHtml(health.chat.label) : '未設定（CHAT_PROVIDER を設定すると「資料に聞く」で回答を作れます）'],
        ['件数', `判断 ${health.counts?.contexts ?? 0}件 · ページ ${health.counts?.pages ?? 0}件 · 索引 ${health.counts?.chunks ?? '?'}件`],
        ['索引の状態', `作成中 ${health.index?.pending ?? 0}件 · 失敗 ${health.index?.failed ?? 0}件`]
      ].map(([term, detail]) => `<dt>${term}</dt><dd>${detail}</dd>`).join('');
    } catch (error) {
      facts.innerHTML = `<dt>状態</dt><dd class="error">${escapeHtml(error.message)}</dd>`;
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    const form = event.target;
    if (form.matches('[data-rename]')) {
      const workspace = getWorkspace();
      try {
        await api.patchWorkspace(workspace.workspace_id, { name: form.name.value });
        toast('success', '名前を変えました。');
        onWorkspaceChanged();
      } catch (error) {
        toast('error', error.message);
      }
    } else if (form.matches('[data-token]')) {
      setToken(form.token.value.trim());
      toast('success', 'トークンを保存しました。');
      await paintHealth();
    }
  }

  async function onClick(event) {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        toast('success', 'コピーしました。');
      } catch {
        toast('error', 'コピーできませんでした。');
      }
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    const workspace = getWorkspace();
    if (button.hasAttribute('data-retry-index')) {
      try {
        const result = await api.retryIndex();
        toast('success', `${result.retried}件を作り直しました（失敗 ${result.failed}件）。`);
        await paintHealth();
      } catch (error) {
        toast('error', error.message);
      }
    } else if (button.hasAttribute('data-export') && workspace) {
      try {
        const exported = await api.exportWorkspace(workspace.workspace_id);
        download(`${workspace.name || workspace.workspace_id}.json`, JSON.stringify(exported, null, 2));
      } catch (error) {
        toast('error', error.message);
      }
    } else if (button.hasAttribute('data-delete-workspace') && workspace) {
      if (!window.confirm(`Workspace「${workspace.name}」と、その中のページをすべて削除しますか？ 保存した判断は残ります。`)) return;
      try {
        await api.deleteWorkspace(workspace.workspace_id);
        toast('success', '削除しました。');
        onWorkspaceChanged({ deleted: workspace.workspace_id });
      } catch (error) {
        toast('error', error.message);
      }
    }
  }

  async function onChange(event) {
    const input = event.target.closest('input[data-import]');
    if (!input || !input.files?.length) return;
    const workspace = getWorkspace();
    if (!workspace) return;
    const files = [...input.files].filter((file) => /\.(md|markdown|txt)$/i.test(file.name));
    if (files.length === 0) return toast('error', 'Markdown（.md）のファイルがありません。');
    try {
      const pages = await Promise.all(files.map(async (file) => ({
        path: file.webkitRelativePath || file.name,
        content: await file.text()
      })));
      const result = await api.importPages(workspace.workspace_id, pages);
      toast('success', `${result.created}件のページを取り込みました。`);
      onImported();
    } catch (error) {
      toast('error', `取り込めませんでした: ${error.message}`);
    } finally {
      input.value = '';
    }
    return undefined;
  }

  return {
    show,
    hide() {
      root.replaceChildren();
    }
  };
}

