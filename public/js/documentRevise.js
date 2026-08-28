import { runAiRequest } from './aiRequest.js';
import { statusForComment } from './comments.js';
import { escapeHtml } from './util.js';

/** サーバー側の上限と同じです。超えて書くと実行時に断られます。 */
const MAX_INSTRUCTION_CHARS = 4_000;

const EMPTY_HTML = '<p class="muted">「修正案を作る」を押すと、AIが本文の書き換え案を作ります。1件ずつ本文と見比べて、許可したものだけがファイルへ入ります。</p>';
const LOADING_HTML = '<p class="ai-loading">修正案を作っています…</p>';

const CONFIDENCE_LABELS = {
  high: '確度 高',
  medium: '確度 中',
  low: '確度 低'
};

/** ブロックの種類。画面に出すのは「どこを書き換えるか」の見当を付けるためだけです。 */
const KIND_LABELS = {
  heading: '見出し',
  paragraph: '段落',
  list: 'リスト',
  table: '表',
  code: 'コード',
  mermaid: '図',
  blockquote: '引用',
  container: 'メッセージ',
  'thematic-break': '区切り線'
};

/**
 * 本文の修正パネル。
 *
 * このアプリでAIの書いた文字が原稿へ入る唯一の場所です。それでも入るのは、レビュアーが
 * 1件ずつ本文と見比べて許可したものだけで、押すのは「適用」ではなく「許可する」の
 * 2段階にしてあります。コメントの削除と同じ確認の形にしているのは、どちらも
 * 取り消せない操作だからです（本文の書き換えはファイルへ即書き込みます）。
 *
 * ── 候補を作ってから適用するまでの間 ──────────────────────────
 * 候補はファイル内の位置を持っています。その間に本文が変われば位置は別の場所を指すので、
 * 候補と一緒に受け取った版（documentRevision）を適用のたびに送り、サーバー側で
 * 突き合わせます。違えば断られ、パネルは「作り直してください」に変わります。
 * 1件適用するたびに後ろの候補の位置はずれるので、適用のあとに `appliedEdits` の
 * 増減ぶんだけ残りをずらします。編集モードの `shiftSourceRanges` と同じ考え方です。
 */
export function createDocumentReviseController({
  refs, state, api, toaster, prepareAi, flushComments = async () => true, onApplyEdits, onRevealTarget
}) {
  /** 許可待ちの対象。1件なら候補の番号、まとめてなら 'all'、無ければ null。 */
  let pendingApply = null;
  let applying = false;

  bindEvents();

  /** 文書ごとの候補なので、開き直したら入力も候補も残しません。 */
  function reset() {
    refs.reviseInput.value = '';
    pendingApply = null;
    applying = false;
    setRunning(false);
    render();
  }

  /** コメントの増減で「何件を依頼として渡すか」が変わるので、そのたびに見直します。 */
  function refresh() {
    renderHint();
    syncSubmitState();
  }

  /* ---------------------------------------------------------------- *
   * 修正案を作る
   * ---------------------------------------------------------------- */

  async function propose() {
    const instruction = refs.reviseInput.value.trim();
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      toaster.error(`修正の指示は${MAX_INSTRUCTION_CHARS}文字までです。`);
      return;
    }
    if (!instruction && openComments() === 0) {
      toaster.error('修正の指示を書くか、未解決のレビューコメントを残してから実行してください。');
      return;
    }
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'reviseAbortController',
      onStart() {
        pendingApply = null;
        state.revise = { status: 'loading' };
        render();
      },
      // 入力欄を止めるのはCodexが起動できてからです。起動できなかったときに
      // 止めたままにすると、やり直す手立てが画面から消えます。
      onPrepared: () => setRunning(true),
      run: ({ documentPath, signal }) => api.reviseWithAi({ path: documentPath, instruction }, { signal }),
      onResult(result) {
        state.revise = {
          status: 'ready',
          documentRevision: result.documentRevision || '',
          summary: result.summary || '',
          edits: result.edits || [],
          skipped: result.skipped || [],
          droppedEdits: result.droppedEdits || 0,
          droppedBlocks: result.droppedBlocks || 0,
          requestedComments: result.requestedComments || 0,
          droppedComments: result.droppedComments || 0,
          stale: false
        };
      },
      onUnavailable(error) {
        state.revise = { status: 'error', error };
        render();
      },
      // 中断は失敗ではないので、何も残さず元の空の状態へ戻します。
      onAbort: () => { state.revise = null; },
      onError: (error) => { state.revise = { status: 'error', error: error.message }; },
      onSettled() {
        setRunning(false);
        render();
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * 許可して適用する
   * ---------------------------------------------------------------- */

  function edits() {
    return state.revise?.status === 'ready' ? state.revise.edits : [];
  }

  /** 押しても書き換えません。「この箇所を書き換えますか？」に変わるだけです。 */
  function requestApply(target) {
    if (applying || state.revise?.stale) return;
    pendingApply = target;
    render();
  }

  function cancelApply() {
    pendingApply = null;
    render();
  }

  function applyOne(index) {
    const edit = edits()[index];
    if (edit) apply([edit]);
  }

  function applyAll() {
    if (edits().length > 0) apply([...edits()]);
  }

  /**
   * 許可されたぶんを本文へ書き込みます。書き込みは1回で済ませます。範囲は重ならないので、
   * まとめて渡しても1件ずつ渡しても結果は同じですが、往復を分けるとその間に版が変わります。
   */
  async function apply(chosen) {
    if (applying || !state.revise || state.revise.stale) return;
    // 待っている間に別の文書へ移ると、この一覧はもう画面のものではありません。
    // そのときは書き込みの結果を、いま開いている文書の一覧へ書き戻さずに終わります。
    const proposal = state.revise;
    applying = true;
    pendingApply = null;
    render();

    try {
      const result = await onApplyEdits(chosen, proposal.documentRevision);
      if (state.revise !== proposal) return;
      const remaining = proposal.edits.filter((edit) => !chosen.includes(edit));
      shiftRanges(remaining, result.appliedEdits || []);
      proposal.edits = remaining;
      proposal.documentRevision = result.revision || '';
      toaster.success(chosen.length === 1
        ? '本文の1か所を書き換えました。'
        : `本文の${chosen.length}か所を書き換えました。`);
    } catch (error) {
      if (state.revise !== proposal) return;
      // 409 は「作ったときから本文が変わった」です。残りの候補が指す位置はもう当たらないので、
      // このときだけ候補ごと使えなくします。
      if (error.status === 409) proposal.stale = true;
      toaster.error(`本文を書き換えられませんでした: ${error.message}`);
    } finally {
      applying = false;
      render();
    }
  }

  /**
   * 書き込みで前の方が伸び縮みしたぶん、後ろの候補の位置をずらします。
   * 自分より前で終わっている編集だけが自分を動かします。
   */
  function shiftRanges(remaining, appliedEdits) {
    for (const edit of remaining) {
      const shift = appliedEdits
        .filter((applied) => applied.end <= edit.start)
        .reduce((total, applied) => total + applied.markdown.length - (applied.end - applied.start), 0);
      edit.start += shift;
      edit.end += shift;
    }
  }

  function dismiss(index) {
    if (!edits()[index]) return;
    state.revise.edits.splice(index, 1);
    pendingApply = null;
    render();
  }

  function reveal(index) {
    const edit = edits()[index];
    if (!edit || onRevealTarget(edit.target)) return;
    toaster.error(state.mode === 'edit'
      ? '編集モードでは対象箇所を表示できません。'
      : '本文から対象箇所を見つけられませんでした。');
  }

  /** カードで直した文面が適用されます。AIの下書きそのままではありません。 */
  function editAfter(index, value) {
    const edit = edits()[index];
    if (edit) edit.after = value;
  }

  /* ---------------------------------------------------------------- *
   * 描画
   * ---------------------------------------------------------------- */

  function render() {
    renderHint();
    syncSubmitState();
    refs.reviseResults.innerHTML = resultsHtml();
    refs.reviseResults.querySelectorAll('textarea[data-revise-index]').forEach((textarea) => {
      textarea.addEventListener('input', () => editAfter(Number(textarea.dataset.reviseIndex), textarea.value));
    });
    refs.reviseResults.querySelectorAll('[data-revise-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const actions = { requestApply, cancelApply, applyOne, applyAll, dismiss, reveal };
        const index = button.dataset.index;
        actions[button.dataset.reviseAction]?.(index === 'all' ? 'all' : Number(index));
      });
    });
  }

  function renderHint() {
    if (!refs.reviseContextHint) return;
    const open = openComments();
    refs.reviseContextHint.hidden = false;
    refs.reviseContextHint.textContent = open > 0
      ? `未解決のレビューコメント${open}件を、修正の依頼として渡します。解決済みのコメントは渡しません。`
      : '未解決のレビューコメントはありません。何を直すかを上の欄に書いてください。';
  }

  function openComments() {
    return state.comments.filter((comment) => statusForComment(comment) === 'open').length;
  }

  function resultsHtml() {
    const result = state.revise;
    if (!result) return EMPTY_HTML;
    if (result.status === 'loading') return LOADING_HTML;
    if (result.status === 'error') return `<p class="ai-error">修正案を作れませんでした: ${escapeHtml(result.error)}</p>`;

    const proposals = result.edits || [];
    return [
      result.summary ? `<p class="review-summary">${escapeHtml(result.summary)}</p>` : '',
      result.stale ? '<p class="ai-error">この修正案を作ったときから本文が変わりました。作り直してください。</p>' : '',
      materialHtml(result),
      proposals.length ? summaryHtml(proposals.length, result.stale) : '',
      ...proposals.map(cardHtml),
      proposals.length === 0 && !result.stale
        ? '<p class="muted">適用できる修正案は残っていません。</p>'
        : '',
      result.droppedEdits > 0
        ? `<p class="placement-note">修正案が多いため、${result.droppedEdits}件は表示していません。依頼を分けて実行してください。</p>`
        : '',
      skippedHtml(result.skipped || [])
    ].join('');
  }

  /** 何を材料に作った修正案かを言います。渡っていなかったものは、黙って省きません。 */
  function materialHtml(result) {
    const notes = [
      result.requestedComments > 0 ? `未解決のコメント${result.requestedComments}件を読ませました。` : '',
      result.droppedComments > 0 ? `コメントが多いため、${result.droppedComments}件は渡していません。` : '',
      result.droppedBlocks > 0 ? `本文が長いため、後ろの${result.droppedBlocks}ブロックは渡していません。` : ''
    ].filter(Boolean);
    return notes.length ? `<p class="placement-note">${escapeHtml(notes.join(' '))}</p>` : '';
  }

  function summaryHtml(count, stale) {
    if (pendingApply === 'all') {
      return `
        <div class="placement-summary revise-confirm" role="group" aria-label="まとめて書き換える許可">
          <span>${count}か所を書き換えます。取り消せません。</span>
          <button type="button" data-revise-action="cancelApply" data-index="all">やめる</button>
          <button type="button" class="danger" data-revise-action="applyAll" data-index="all">すべて書き換える</button>
        </div>`;
    }
    return `
      <div class="placement-summary">
        <span>修正案 ${count}件</span>
        <button type="button" data-revise-action="requestApply" data-index="all"${stale || applying ? ' disabled' : ''}>すべて適用</button>
      </div>`;
  }

  function cardHtml(edit, index) {
    const headingPath = (edit.headingPath || []).filter(Boolean).join(' › ');
    return `
      <article class="revise-card" data-index="${index}"${edit.delete ? ' data-delete="true"' : ''}>
        <div class="placement-card-head">
          <span class="target-badge" data-type="${escapeHtml(edit.kind || '')}">${escapeHtml(KIND_LABELS[edit.kind] || edit.kind || 'ブロック')}</span>
          ${edit.delete ? '<span class="revise-delete-badge">削除</span>' : ''}
          <span class="placement-confidence" data-confidence="${escapeHtml(edit.confidence || 'medium')}">${escapeHtml(CONFIDENCE_LABELS[edit.confidence] || CONFIDENCE_LABELS.medium)}</span>
        </div>
        ${headingPath ? `<p class="placement-path">${escapeHtml(headingPath)}</p>` : ''}
        ${edit.reason ? `<p class="placement-reason">${escapeHtml(edit.reason)}</p>` : ''}
        <div class="revise-diff">
          <div class="revise-side" data-side="before">
            <p class="revise-side-label">いまの本文</p>
            <pre class="revise-text">${escapeHtml(edit.before)}</pre>
          </div>
          <div class="revise-side" data-side="after">
            <p class="revise-side-label">${edit.delete ? 'この修正案' : '修正案（ここで直せます）'}</p>
            ${edit.delete
              ? '<p class="revise-removed">この箇所をまるごと削除します。</p>'
              : `<textarea class="revise-text" data-revise-index="${index}" rows="${textRows(edit.after)}">${escapeHtml(edit.after)}</textarea>`}
          </div>
        </div>
        <div class="placement-card-actions">
          ${cardActionsHtml(index)}
        </div>
      </article>`;
  }

  /** 「適用」は一度では効きません。押すとこの行が許可を求める形に変わります。 */
  function cardActionsHtml(index) {
    if (pendingApply === index) {
      return `
        <span class="revise-confirm" role="group" aria-label="この箇所を書き換える許可">この箇所を書き換えますか？ 取り消せません。</span>
        <button type="button" data-revise-action="cancelApply" data-index="${index}">やめる</button>
        <button type="button" class="danger" data-revise-action="applyOne" data-index="${index}">書き換える</button>`;
    }
    const blocked = applying || state.revise?.stale;
    return `
      <button type="button" data-revise-action="reveal" data-index="${index}">対象を表示</button>
      <button type="button" data-revise-action="requestApply" data-index="${index}"${blocked ? ' disabled' : ''}>この修正を適用</button>
      <button type="button" data-revise-action="dismiss" data-index="${index}"${applying ? ' disabled' : ''}>破棄</button>`;
  }

  function skippedHtml(skipped) {
    if (skipped.length === 0) return '';
    return `
      <section class="placement-unplaced">
        <h3>修正案にできなかった依頼</h3>
        <ul>
          ${skipped.map((entry) => `<li><strong>${escapeHtml(entry.request)}</strong>${entry.reason ? ` — ${escapeHtml(entry.reason)}` : ''}</li>`).join('')}
        </ul>
      </section>`;
  }

  /** 修正案がそのまま見える高さ。畳まれていると、許可する前に読めるのは1行目だけです。 */
  function textRows(text) {
    return Math.min(14, Math.max(3, String(text || '').split('\n').length + 1));
  }

  function setRunning(running) {
    refs.reviseInput.disabled = running;
    refs.reviseStopButton.classList.toggle('hidden', !running);
    syncSubmitState();
  }

  function syncSubmitState() {
    refs.reviseSubmitButton.disabled = Boolean(state.reviseAbortController)
      || applying
      || (refs.reviseInput.value.trim() === '' && openComments() === 0);
  }

  function bindEvents() {
    refs.reviseForm.addEventListener('submit', (event) => {
      event.preventDefault();
      propose();
    });
    refs.reviseInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      propose();
    });
    refs.reviseStopButton.addEventListener('click', () => state.reviseAbortController?.abort());
    refs.reviseInput.addEventListener('input', syncSubmitState);
    syncSubmitState();
  }

  return { reset, refresh, render };
}
