/**
 * 保存した判断（Context）の画面です。review-markdown CLIが「保存した判断」として引くものと同じ物を、
 * ここでも残せて、直せて、消せます。
 */

import { escapeHtml, relativeTime } from './util.js';

const KINDS = [
  { value: 'decision', label: '決定', hint: 'このプロジェクトで決まったこと' },
  { value: 'preference', label: '作法', hint: 'いつもこうしている、という自分の決め事' },
  { value: 'note', label: '知識', hint: 'その他、覚えておきたいこと' }
];
const KIND_LABELS = Object.fromEntries(KINDS.map(({ value, label }) => [value, label]));
const SOURCE_LABELS = { manual: '自分で保存', comment: 'コメントから', agent: 'AIの提案を承認' };

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.api
 * @param {Function} options.toast `(kind, message)`
 */
export function createContextsView({ root, api, toast }) {
  let workspaceId = null;
  let contexts = [];
  let searched = null;
  let editingId = null;
  let highlightId = null;

  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);

  async function show(nextWorkspaceId, { highlight = null } = {}) {
    workspaceId = nextWorkspaceId;
    highlightId = highlight;
    searched = null;
    editingId = null;
    document.title = '保存した判断 · Knowledge';
    paintShell();
    await load();
  }

  async function load() {
    try {
      contexts = await api.listContexts(workspaceId);
      paintList();
    } catch (error) {
      toast('error', `保存した判断を読み込めませんでした: ${error.message}`);
    }
  }

  function paintShell() {
    root.innerHTML = `
      <section class="contexts">
        <header class="view-head">
          <h1>保存した判断</h1>
          <p class="view-lead">次の会話でも前提にしたい決定や作法を1件ずつ残します。このWorkspaceの判断と、どのWorkspaceでも効く個人の作法が並びます。review-markdown CLI のAIも、MCPで繋いだエージェントも、ここにある判断を質問に応じて引きます。</p>
        </header>
        <form class="context-form" data-create>
          <textarea name="content" rows="3" placeholder="例: このプロジェクトではOIDCを利用する" aria-label="残す内容" maxlength="8000"></textarea>
          <div class="context-form-row">
            <label class="field"><span>効く範囲</span>
              <select name="scope">
                <option value="workspace">このWorkspace全体</option>
                <option value="path">Workspaceの中のディレクトリ以下</option>
                <option value="global">どのWorkspaceでも（個人の共通知識）</option>
              </select></label>
            <label class="field context-path hidden"><span>ディレクトリ</span><input name="scope_path" type="text" placeholder="src/auth"></label>
            <label class="field"><span>種類</span>
              <select name="kind">${KINDS.map((kind) => `<option value="${kind.value}">${kind.label}（${kind.hint}）</option>`).join('')}</select></label>
            <button type="submit" class="primary">保存する</button>
          </div>
        </form>
        <form class="context-search" data-search>
          <input name="query" type="search" placeholder="保存した判断を意味で探す（例: 認証）" aria-label="保存した判断を探す">
          <button type="submit">探す</button>
          <button type="button" data-clear>すべて表示</button>
        </form>
        <h2 class="context-list-label"></h2>
        <div class="context-list"></div>
      </section>`;
    root.querySelector('select[name="scope"]').addEventListener('change', (event) => {
      root.querySelector('.context-path').classList.toggle('hidden', event.target.value !== 'path');
    });
    if (!workspaceId) {
      root.querySelector('select[name="scope"]').value = 'global';
      root.querySelector('select[name="scope"]').disabled = true;
    }
  }

  function paintList() {
    const listed = searched ? searched.results : contexts;
    root.querySelector('.context-list-label').textContent = searched
      ? `「${searched.query}」に近い判断 ${listed.length}件`
      : `保存した判断 ${listed.length}件`;
    const list = root.querySelector('.context-list');
    list.innerHTML = listed.length
      ? listed.map(cardHtml).join('')
      : '<p class="muted">まだ保存した判断はありません。次の会話でも前提にしたい決定を残せます。</p>';
    if (highlightId) {
      list.querySelector(`[data-context-id="${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: 'center' });
      highlightId = null;
    }
  }

  function cardHtml(context) {
    const editing = editingId === context.context_id;
    const score = typeof context.score === 'number' ? `<span class="chip chip-score">近さ ${context.score.toFixed(2)}</span>` : '';
    return `
      <article class="context-card${editing ? ' editing' : ''}${highlightId === context.context_id ? ' highlight' : ''}" data-context-id="${escapeHtml(context.context_id)}">
        <header class="context-meta">
          <span class="chip chip-kind" data-kind="${escapeHtml(context.kind || 'note')}">${escapeHtml(KIND_LABELS[context.kind] || '知識')}</span>
          <span class="chip">${escapeHtml(scopeLabel(context))}</span>
          ${score}
          <span class="muted">${escapeHtml(SOURCE_LABELS[context.source_type] || '')}</span>
          <span class="muted">${escapeHtml(relativeTime(context.updated_at))}</span>
        </header>
        ${editing
          ? `<form class="context-edit" data-edit="${escapeHtml(context.context_id)}">
               <textarea name="content" rows="4" maxlength="8000">${escapeHtml(context.content || '')}</textarea>
               <div class="context-actions"><button type="submit" class="primary">保存する</button><button type="button" data-cancel>やめる</button></div>
             </form>`
          : `<p class="context-content">${escapeHtml(context.content || '')}</p>
             <div class="context-actions">
               <button type="button" data-edit-start="${escapeHtml(context.context_id)}">直す</button>
               <button type="button" class="danger" data-delete="${escapeHtml(context.context_id)}">削除</button>
             </div>`}
      </article>`;
  }

  async function onSubmit(event) {
    event.preventDefault();
    const form = event.target;
    if (form.matches('[data-create]')) return create(form);
    if (form.matches('[data-search]')) return search(form.query.value.trim());
    if (form.matches('[data-edit]')) return update(form.dataset.edit, form.content.value.trim());
    return undefined;
  }

  async function create(form) {
    const content = form.content.value.trim();
    if (!content) return toast('error', '残す内容を書いてください。');
    const scope = form.scope.value;
    try {
      await api.createContext({
        content,
        scope,
        kind: form.kind.value,
        source_type: 'manual',
        ...(scope === 'global' ? {} : { workspace_id: workspaceId }),
        ...(scope === 'path' ? { scope_path: form.scope_path.value.trim() } : {})
      });
      form.content.value = '';
      searched = null;
      await load();
      toast('success', '保存しました。次の検索から引けます。');
    } catch (error) {
      toast('error', `保存できませんでした: ${error.message}`);
    }
    return undefined;
  }

  async function search(query) {
    if (!query) {
      searched = null;
      paintList();
      return;
    }
    try {
      const results = await api.search({
        query,
        sources: ['context'],
        limit: 20,
        ...(workspaceId ? { workspace_id: workspaceId } : {})
      });
      searched = { query, results };
      paintList();
    } catch (error) {
      toast('error', `探せませんでした: ${error.message}`);
    }
  }

  async function update(contextId, content) {
    if (!content) return toast('error', '内容を書いてください。');
    try {
      await api.patchContext(contextId, { content });
      editingId = null;
      searched = null;
      await load();
      toast('success', '直しました。次の検索からは直したあとの内容が前提になります。');
    } catch (error) {
      toast('error', `直せませんでした: ${error.message}`);
    }
    return undefined;
  }

  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-clear')) {
      root.querySelector('input[name="query"]').value = '';
      searched = null;
      paintList();
    } else if (button.dataset.editStart) {
      editingId = button.dataset.editStart;
      paintList();
      root.querySelector('.context-edit textarea')?.focus();
    } else if (button.hasAttribute('data-cancel')) {
      editingId = null;
      paintList();
    } else if (button.dataset.delete) {
      if (!window.confirm('この判断を削除しますか？ 以後の回答では前提になりません。')) return;
      try {
        await api.deleteContext(button.dataset.delete);
        searched = null;
        await load();
        toast('success', '削除しました。');
      } catch (error) {
        toast('error', `削除できませんでした: ${error.message}`);
      }
    }
  }

  return {
    show,
    hide() {
      root.replaceChildren();
    }
  };
}

export function scopeLabel(context) {
  if (context.scope === 'global') return 'どのWorkspaceでも';
  if (context.scope === 'path') return `${context.scope_path} 以下`;
  return 'このWorkspace全体';
}

