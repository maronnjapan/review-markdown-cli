/**
 * 「資料に聞く」の画面です。質問を意味で引いた資料（ページと判断）を根拠に、回答を流します（`POST /ask`）。
 *
 * 生成のモデルを設定していないサーバでは、資料の一覧だけが出ます。それでも「どのページに書いたか」は
 * 分かるので、RAGの検索の側だけでも使えるようにしてあります。
 */

import { renderMarkdown } from './markdown.js';
import { el, escapeHtml, untitled } from './util.js';

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.api
 * @param {Function} options.toast
 * @param {Function} options.hrefForPage `(pageId, workspaceId)`
 * @param {Function} options.hrefForContext `(contextId, workspaceId)`
 * @param {Function} options.getHealth `/health` の結果（生成モデルの有無を出すため）。
 */
export function createAskView({ root, api, toast, hrefForPage, hrefForContext, getHealth }) {
  let workspaceId = null;
  let controller = null;
  let log = null;

  // 画面の入れ物（`root`）は他の画面と共有なので、この画面のフォームからの送信だけを受けます。
  root.addEventListener('submit', (event) => {
    if (!event.target.matches('.ask-form')) return;
    event.preventDefault();
    const question = root.querySelector('textarea[name="question"]').value.trim();
    if (question) ask(question);
  });
  root.addEventListener('keydown', (event) => {
    if (event.target.matches('textarea[name="question"]') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      event.target.form.requestSubmit();
    }
  });
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-stop]')) controller?.abort();
  });

  function show(nextWorkspaceId, { question = '' } = {}) {
    workspaceId = nextWorkspaceId;
    document.title = '資料に聞く · Knowledge';
    const health = getHealth();
    root.innerHTML = `
      <section class="ask">
        <header class="view-head">
          <h1>資料に聞く</h1>
          <p class="view-lead">保存した判断とページを意味で引き、それだけを根拠に答えます。根拠には [番号] が付き、押すとその資料へ移れます。</p>
          ${health && !health.chat
            ? '<p class="notice">回答を作るモデルが設定されていないので、関係する資料の一覧だけを出します。生成するには <code>CHAT_PROVIDER</code> を設定して立ち上げ直してください（設定の画面に手順があります）。</p>'
            : ''}
        </header>
        <form class="ask-form">
          <textarea name="question" rows="2" placeholder="例: トークンの有効期限はどう決めた？" aria-label="質問"></textarea>
          <div class="ask-form-row">
            <label class="palette-scope"><input type="checkbox" name="all"> すべてのWorkspace</label>
            <button type="submit" class="primary">聞く</button>
          </div>
        </form>
        <div class="ask-log"></div>
      </section>`;
    log = root.querySelector('.ask-log');
    const textarea = root.querySelector('textarea[name="question"]');
    textarea.value = question;
    textarea.focus();
    if (question) ask(question);
  }

  async function ask(question) {
    controller?.abort();
    controller = new AbortController();
    const all = root.querySelector('input[name="all"]').checked;
    const entry = el('article', { class: 'ask-entry' });
    entry.innerHTML = `
      <h2 class="ask-question">${escapeHtml(question)}</h2>
      <div class="ask-answer"><p class="muted ask-wait">資料を探しています…</p></div>
      <div class="ask-sources"></div>`;
    log.prepend(entry);
    const answerBox = entry.querySelector('.ask-answer');
    const sourcesBox = entry.querySelector('.ask-sources');
    let sources = [];
    let answer = '';
    let streaming = false;

    const paintAnswer = (final = false) => {
      if (!answer) return;
      answerBox.innerHTML = final
        ? withCitations(renderMarkdown(answer), sources, entry)
        : `<p class="ask-streaming">${escapeHtml(answer)}<span class="caret"></span></p>`;
    };

    try {
      const done = await api.ask({
        question,
        sources: ['context', 'page'],
        limit: 8,
        ...(all ? { all_workspaces: true } : { workspace_id: workspaceId || undefined })
      }, {
        signal: controller.signal,
        onSources({ sources: found, model }) {
          sources = found;
          sourcesBox.innerHTML = sourcesHtml(sources, entry);
          if (!model) {
            answerBox.innerHTML = sources.length
              ? '<p class="muted">回答を作るモデルが無いので、関係する資料だけを出しました。</p>'
              : '<p class="muted">関係する資料は見つかりませんでした。</p>';
          } else {
            answerBox.innerHTML = '<p class="muted ask-wait">回答を書いています… <button type="button" class="link" data-stop>止める</button></p>';
          }
        },
        onDelta(text) {
          streaming = true;
          answer += text;
          paintAnswer(false);
        },
        onDone(payload) {
          answer = payload.answer ?? answer;
          if (answer) paintAnswer(true);
        }
      });
      if (done === null && !streaming) answerBox.innerHTML = '<p class="muted">止めました。</p>';
      else if (done === null) paintAnswer(true);
    } catch (error) {
      if (answer) paintAnswer(true);
      else answerBox.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
      toast('error', error.message);
    }
  }

  function sourcesHtml(sources, entry) {
    if (!sources.length) return '';
    const id = entry.dataset.id || (entry.dataset.id = String(Date.now()));
    return `<h3 class="ask-sources-label">根拠にした資料</h3><ol class="ask-source-list">${sources.map((source, index) => {
      const number = index + 1;
      if (source.type === 'page') {
        const trail = (source.breadcrumb || []).map((step) => untitled(step.title)).join(' › ');
        const where = [trail || untitled(source.title), source.heading].filter(Boolean).join(' › ');
        return `<li id="src-${id}-${number}" class="ask-source"><span class="ask-source-number">[${number}]</span>`
          + `<a href="${escapeHtml(hrefForPage(source.page_id, source.workspace_id))}"><strong>▤ ${escapeHtml(where)}</strong></a>`
          + `<p>${escapeHtml(source.snippet || '')}</p></li>`;
      }
      const kind = { decision: '決定', preference: '作法', note: '知識' }[source.kind] || '知識';
      return `<li id="src-${id}-${number}" class="ask-source"><span class="ask-source-number">[${number}]</span>`
        + `<a href="${escapeHtml(hrefForContext(source.context_id, source.workspace_id))}"><strong>📌 保存した判断 · ${escapeHtml(kind)}</strong></a>`
        + `<p>${escapeHtml(source.content || '')}</p></li>`;
    }).join('')}</ol>`;
  }

  /** 回答の中の [1] を、資料への内部リンクにします。 */
  function withCitations(html, sources, entry) {
    const id = entry.dataset.id;
    return html.replace(/\[(\d{1,2})\]/g, (match, number) => (
      Number(number) >= 1 && Number(number) <= sources.length
        ? `<a class="citation" href="#src-${id}-${number}" onclick="document.getElementById('src-${id}-${number}')?.scrollIntoView({block:'center'});return false;">[${number}]</a>`
        : match
    ));
  }

  return {
    show,
    hide() {
      controller?.abort();
      root.replaceChildren();
    }
  };
}
