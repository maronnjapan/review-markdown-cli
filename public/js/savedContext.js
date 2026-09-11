import { escapeHtml, truncate } from './util.js';

/**
 * 保存した判断（Context）の画面です。
 *
 * ── ここが「訂正の起点」です ────────────────────────────
 * 保存した判断は、消すまで残り、次の会話の前提になります。だから、残したものを
 * 一覧で見られて、その場で直せて、消せる場所が要ります。根拠提示（AIの回答の下に出る
 * 「使った判断」）からもここへ来られますが、そちらでたどれるのは、その回答に使われた
 * 1件だけです。古くなった判断は、使われなくなってから気づくことのほうが多いので、
 * 全部を並べる場所を別に持ちます。
 *
 * ── 範囲を選ばせる理由 ─────────────────────────────
 * 「このプロジェクトではOIDCを使う」はWorkspace全体の話で、「Refresh Tokenを
 * Agentへ渡さない」は認証まわりのディレクトリの話、「常にstrictモードで書く」は
 * どのプロジェクトでも効く自分の作法です。全部をWorkspace全体にすると、課金の実装を
 * 読んでいるときにも認証の決定が前提として混ざります。
 *
 * ── 保存の前に必ず本人が見る ───────────────────────────
 * 相談の答えから残すときも、いったんこの欄へ文面が入ります。AIが書いたものを
 * そのまま前提にすると、間違ったまま残ったものが次の回答を歪め続けます（仕様7.5）。
 *
 * ── Context APIが止まっていても、画面は出します ─────────────
 * 欄ごと消すと、この機能があることも、いま使えないことも画面から分かりません。
 * 使えない理由と、起動するための1行を出して、押せない状態で置いておきます（仕様7.4）。
 */

/** 範囲の選択肢。`value` はContext APIが受け取る `scope` そのものです。 */
const SCOPES = [
  { value: 'workspace', label: 'このWorkspace全体' },
  { value: 'path', label: 'このファイルのディレクトリ以下' },
  { value: 'global', label: 'どのWorkspaceでも（個人の共通知識）' }
];

/** 種類。読み方の指示なので、画面でも説明を添えます（`src/context/model.js`）。 */
const KINDS = [
  { value: 'decision', label: '決定', hint: 'このプロジェクトで決まったこと' },
  { value: 'preference', label: '作法', hint: 'いつもこうしている、という自分の決め事' },
  { value: 'note', label: '知識', hint: 'その他、覚えておきたいこと' }
];

const KIND_LABELS = Object.fromEntries(KINDS.map(({ value, label }) => [value, label]));

const SOURCE_LABELS = {
  manual: '自分で保存',
  comment: 'コメントから',
  agent: 'AIの提案を承認'
};

export function createSavedContextController({ refs, state, api, toaster }) {
  bindEvents();

  /** 画面を開いたときと、保存や訂正のあと。一覧は毎回引き直します。 */
  async function load() {
    renderForm();
    setStatus('loading', '保存した判断を読み込んでいます…');
    try {
      const { status, contexts } = await api.listSavedContexts();
      state.savedContextStatus = status;
      state.savedContexts = contexts || [];
      render();
      setStatus(status.available ? 'idle' : 'error', status.available ? '' : unavailableMessage(status));
    } catch (error) {
      state.savedContextStatus = { configured: true, available: false, error: error.message };
      state.savedContexts = [];
      render();
      setStatus('error', `保存した判断を読み込めませんでした: ${error.message}`);
    }
  }

  /** 相談の答えなどを、保存の下書きとして欄へ入れます。保存はしません。 */
  function draft(content) {
    refs.savedContextInput.value = String(content || '').trim();
    refs.savedContextInput.focus();
    setStatus('idle', '内容を確かめてから「保存する」を押してください。');
  }

  async function save() {
    const content = refs.savedContextInput.value.trim();
    if (!content) return setStatus('error', '残す内容を書いてください。');
    setStatus('saving', '保存しています…');
    try {
      await api.saveContext({
        content,
        scope: refs.savedContextScope.value,
        kind: refs.savedContextKind.value,
        // 保存の起点。画面から書いたものは、ユーザー自身が決めたものとして残します。
        // 相談の答えから移したものは、AIの提案をユーザーが承認したものとして残します。
        sourceType: state.savedContextDraftSource || 'manual',
        path: state.currentPath || undefined,
        sourcePath: state.currentPath || undefined
      });
      refs.savedContextInput.value = '';
      state.savedContextDraftSource = null;
      await load();
      setStatus('saved', '保存しました。次の質問から前提になります。');
    } catch (error) {
      setStatus('error', `保存できませんでした: ${error.message}`);
    }
  }

  /** 訂正です。本文が変われば、Context API側で索引も作り直されます（仕様6.3）。 */
  async function update(contextId, content) {
    setStatus('saving', '保存しています…');
    try {
      await api.updateSavedContext({ contextId, content });
      await load();
      setStatus('saved', '直しました。次の質問からは、直したあとの内容が前提になります。');
    } catch (error) {
      setStatus('error', `直せませんでした: ${error.message}`);
    }
  }

  async function remove(contextId) {
    const view = refs.savedContextList.ownerDocument.defaultView;
    if (!view.confirm('この判断を削除しますか？ 以後の回答では前提になりません。')) return;
    try {
      await api.deleteSavedContext(contextId);
      await load();
      setStatus('saved', '削除しました。');
    } catch (error) {
      setStatus('error', `削除できませんでした: ${error.message}`);
    }
  }

  /** 画面からの検索。AIを通さずに、保存した判断だけを引き直せる道です。 */
  async function search() {
    const query = refs.savedContextSearch.value.trim();
    if (!query) {
      state.savedContextResults = null;
      render();
      return;
    }
    setStatus('loading', '探しています…');
    try {
      const { results } = await api.searchSavedContexts({ query, path: state.currentPath || undefined });
      state.savedContextResults = { query, results };
      render();
      setStatus('idle', results.length ? '' : 'この語に関係する判断は保存されていません。');
    } catch (error) {
      setStatus('error', `探せませんでした: ${error.message}`);
    }
  }

  function renderForm() {
    refs.savedContextScope.innerHTML = SCOPES.map(({ value, label }) => (
      `<option value="${value}">${escapeHtml(label)}</option>`
    )).join('');
    refs.savedContextKind.innerHTML = KINDS.map(({ value, label, hint }) => (
      `<option value="${value}">${escapeHtml(`${label}（${hint}）`)}</option>`
    )).join('');
  }

  function render() {
    const available = state.savedContextStatus?.available === true;
    refs.savedContextForm.classList.toggle('hidden', !available);
    refs.savedContextSearchForm.classList.toggle('hidden', !available);
    refs.savedContextEndpoint.textContent = available
      ? `預け先: ${state.savedContextStatus.endpoint}（${state.savedContextStatus.embedding?.label || '埋め込み不明'}）`
      : '';
    refs.savedContextEndpoint.hidden = !available;

    const listed = state.savedContextResults?.results || state.savedContexts || [];
    refs.savedContextListLabel.textContent = state.savedContextResults
      ? `「${truncate(state.savedContextResults.query, 24)}」に近い判断 ${listed.length}件`
      : `保存した判断 ${listed.length}件`;
    refs.savedContextList.innerHTML = listed.length
      ? listed.map((context) => contextHtml(context)).join('')
      : `<p class="muted">${available
        ? 'まだ保存した判断はありません。次の会話でも前提にしたい決定を残せます。'
        : ''}</p>`;
  }

  function setStatus(status, message) {
    refs.savedContextStatus.dataset.state = status;
    refs.savedContextStatus.textContent = message ?? '';
  }

  function unavailableMessage(status) {
    if (!status.configured) {
      return '保存した判断の預け先（contextEndpoint）が設定されていません。'
        + 'review-markdown context start で起動し、review-markdown config set contextEndpoint <URL> --global で設定してください。';
    }
    return `${status.endpoint} へ接続できません（${status.error || '理由不明'}）。`
      + ' review-markdown context start で起動してください。ファイルの閲覧・編集・コメントはそのまま使えます。';
  }

  function bindEvents() {
    refs.savedContextForm.addEventListener('submit', (event) => {
      event.preventDefault();
      save();
    });
    refs.savedContextSearchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      search();
    });
    refs.savedContextSearchClear.addEventListener('click', () => {
      refs.savedContextSearch.value = '';
      state.savedContextResults = null;
      render();
      setStatus('idle', '');
    });
    refs.savedContextList.addEventListener('click', (event) => {
      const card = event.target.closest('[data-context-id]');
      if (!card) return;
      const contextId = card.dataset.contextId;
      if (event.target.closest('[data-context-delete]')) return remove(contextId);
      if (event.target.closest('[data-context-edit]')) return startEdit(card);
      if (event.target.closest('[data-context-cancel]')) return render();
      if (event.target.closest('[data-context-save]')) {
        const body = card.querySelector('[data-context-body]');
        return update(contextId, body.value.trim());
      }
    });
  }

  /** 直す欄は、押した1件だけをその場で差し替えます。 */
  function startEdit(card) {
    const content = card.querySelector('.saved-context-content')?.textContent || '';
    card.querySelector('.saved-context-body').innerHTML = [
      `<textarea class="saved-context-edit" data-context-body rows="4">${escapeHtml(content)}</textarea>`,
      '<div class="saved-context-actions">',
      '<button type="button" data-context-save>保存する</button>',
      '<button type="button" data-context-cancel>やめる</button>',
      '</div>'
    ].join('');
    card.querySelector('[data-context-body]')?.focus();
  }

  return { load, draft, render, setStatus };
}

/** 保存した判断1件。範囲と種類を必ず添えるのは、どこで効くかが本文から読めないからです。 */
function contextHtml(context) {
  const score = typeof context.score === 'number' ? `<span class="saved-context-score">近さ ${context.score.toFixed(2)}</span>` : '';
  return `
    <article class="saved-context-card" data-context-id="${escapeHtml(context.context_id)}">
      <header class="saved-context-meta">
        <span class="saved-context-kind" data-kind="${escapeHtml(context.kind || 'note')}">${escapeHtml(KIND_LABELS[context.kind] || '知識')}</span>
        <span class="saved-context-scope">${escapeHtml(scopeLabel(context))}</span>
        ${score}
        <span class="saved-context-source">${escapeHtml(SOURCE_LABELS[context.source_type] || '')}</span>
        <span class="saved-context-updated">${escapeHtml(String(context.updated_at || '').slice(0, 10))}</span>
      </header>
      <div class="saved-context-body">
        <p class="saved-context-content">${escapeHtml(context.content || '')}</p>
        <div class="saved-context-actions">
          <button type="button" data-context-edit>直す</button>
          <button type="button" data-context-delete>削除</button>
        </div>
      </div>
    </article>`;
}

export function scopeLabel(context) {
  if (context.scope === 'global') return 'どのWorkspaceでも';
  if (context.scope === 'path') return `${context.scope_path || context.scopePath} 以下`;
  return 'このWorkspace全体';
}

export { KIND_LABELS };
