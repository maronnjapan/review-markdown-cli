import { runAiRequest } from './aiRequest.js';
import { escapeHtml } from './util.js';

/** サーバー側の上限と同じです（src/aiLimits.js）。超えて送ると保存時に断られます。 */
const MAX_BRIEF_FIELD_CHARS = 600;
const MAX_BRIEF_INPUT_CHARS = 2_000;

/**
 * 管理者が求める3点。`src/documentBrief.js` の `BRIEF_FIELDS` と同じ並び・同じidです。
 * ビルドを持たない構成では `src/` を `public/` から import できないので、
 * `contextNotes.js` と同じ理由でここへもう一組置いています。
 *
 * `label` は、埋まっていない項目をレビュアーへ名指しで言うために使います。欄そのものの
 * 見出しと説明は index.html にあります。書いてあることはプロンプトの説明
 * （`src/prompts/readingContext.js` の BRIEF_LEGEND と `src/prompts/manager.js`）と
 * 揃えてあります。レビュアーが「目的」に書いたつもりのものと、AIが「目的」として
 * 読むものがずれると、指摘の当たり方が変わる理由が分からなくなるからです。
 */
const FIELDS = [
  { id: 'purpose', ref: 'briefPurpose', label: '目的' },
  { id: 'story', ref: 'briefStory', label: 'ストーリー' },
  { id: 'expectation', ref: 'briefExpectation', label: '期待値' }
];

const STATUS_MESSAGES = {
  idle: '',
  dirty: '自動保存待ち…',
  saving: '保存中…',
  saved: '保存しました。次のAI操作から反映します。'
};

/**
 * 資料の管理者のパネル。
 *
 * 資料を作り始める前に、目的・ストーリー・期待値の3つを決めさせる役です。決まった3点は
 * 前提として、翻訳・AIチャット・指摘の配置・AIレビューすべてへ渡します。3つが揃うまで
 * AIレビューは1度止まります（関門そのものは `documentReview.js` にあります）。
 *
 * 決め方は2通りです。3つの欄へ直接書くか、「決まっていること」を走り書きで渡して管理者に
 * 組み立てさせるか。組み立てさせた場合、管理者は書いていない項目を埋めません。代わりに
 * 「それを決めるにはこれを答えてほしい」という問いを返します。埋めさせないのがこの役の
 * 要点です。それらしい目的で欄が埋まると、レビュアーは決まったと思ったまま書き始めます。
 */
export function createDocumentBriefController({ refs, state, api, toaster, prepareAi, flushComments, onChange }) {
  // 書きかけの3点を、保存の往復や走り書きの組み立てで消さないための目印です。
  let touched = false;

  bindEvents();

  /** 文書を開いたときの初期化。走り書きと問いは前の文書のものなので捨てます。 */
  function load() {
    touched = false;
    refs.briefInput.value = '';
    state.briefDraft = null;
    state.briefStatus = 'idle';
    fillFields();
    render();
    setStatus(state.briefDirty ? 'dirty' : 'idle');
  }

  /** 保存済みの3点を読み込み直したときに、画面へ映します。 */
  function refresh() {
    if (!touched) fillFields();
    render();
  }

  function setStatus(status, message) {
    refs.briefStatus.dataset.state = status;
    refs.briefStatus.textContent = message ?? STATUS_MESSAGES[status] ?? '';
  }

  /* ---------------------------------------------------------------- *
   * 3点を決める
   * ---------------------------------------------------------------- */

  /**
   * 画面の3欄を、保存する形へまとめます。1つも書かれていなければ null で、
   * これが「管理者は未設定」です。
   */
  function collect() {
    const brief = Object.fromEntries(FIELDS.map(({ id, ref }) => [id, refs[ref].value.trim()]));
    if (!FIELDS.some(({ id }) => brief[id])) return null;
    return { ...brief, updatedAt: new Date().toISOString() };
  }

  function fillFields() {
    for (const { id, ref } of FIELDS) refs[ref].value = state.brief?.[id] || '';
  }

  /**
   * もう一方の画面で書き換えられた3点を、こちらの欄へ映します。
   * 3点は「AIレビュー」タブとコンテキスト画面の2か所から書けるので、
   * 片方で決めた内容が残っていない側から上書きされないように揃えます。
   */
  function sync() {
    const { activeElement } = refs.briefPurpose.ownerDocument;
    if (FIELDS.some(({ ref }) => refs[ref] === activeElement)) return;
    fillFields();
    render();
  }

  function handleInput() {
    touched = true;
    const tooLong = FIELDS.find(({ ref }) => refs[ref].value.trim().length > MAX_BRIEF_FIELD_CHARS);
    if (tooLong) {
      // 保存で断られるより先に言います。断られてから消すのでは、書いた分が宙に浮きます。
      setStatus('error', `「${tooLong.label}」は${MAX_BRIEF_FIELD_CHARS}文字までです。`);
      render();
      return;
    }
    state.brief = collect();
    render();
    onChange();
  }

  function clearBrief() {
    // 保存できる形になっていない書きかけ（上限に当たった欄）も、ここで消せます。
    // state.brief だけを見ると、書いてあるのに消せない欄が残ります。
    if (!state.brief && !FIELDS.some(({ ref }) => refs[ref].value.trim())) return;
    state.brief = null;
    touched = true;
    fillFields();
    render();
    onChange();
    toaster.info('目的・ストーリー・期待値を消しました。');
  }

  /* ---------------------------------------------------------------- *
   * 管理者に組み立てさせる
   * ---------------------------------------------------------------- */

  async function composeBrief() {
    const input = refs.briefInput.value.trim();
    if (!input) return;
    if (input.length > MAX_BRIEF_INPUT_CHARS) {
      toaster.error(`決まっていることは${MAX_BRIEF_INPUT_CHARS}文字までです。`);
      return;
    }
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'briefAbortController',
      // 「組み立て中」はCodexが起動できてから出します。起動できなかったときに出すと、
      // 動いていないものを待っているように見えます。
      onPrepared() {
        state.briefStatus = 'composing';
        render();
      },
      run: ({ documentPath, signal }) => api.composeAiBrief({ path: documentPath, input }, { signal }),
      onResult: adoptDraft,
      onUnavailable(error) {
        state.briefDraft = { error };
        render();
      },
      onError(error) {
        state.briefDraft = { error: error.message };
      },
      onSettled() {
        state.briefStatus = 'idle';
        render();
      }
    });
  }

  /**
   * 管理者が組み立てた3点を欄へ入れます。
   *
   * 埋められなかった欄は、レビュアーが書いたものを消しません。空で上書きすると、
   * 聞き直すたびに自分で書いた分が消えることになります。管理者が返した問いと、
   * 走り書きから補った点は、欄ではなく下の結果へ出します。答えるのはレビュアーで、
   * ここで欄を埋めてしまうと答えたことになるからです。
   */
  function adoptDraft(draft) {
    state.briefDraft = { questions: draft.questions || [], assumptions: draft.assumptions || [] };
    let filled = 0;
    for (const { id, ref } of FIELDS) {
      const value = draft.brief?.[id] || '';
      if (!value) continue;
      refs[ref].value = value;
      filled += 1;
    }
    if (filled === 0) return;
    touched = true;
    state.brief = collect();
    onChange();
  }

  /* ---------------------------------------------------------------- *
   * 表示
   * ---------------------------------------------------------------- */

  function render() {
    const composing = state.briefStatus === 'composing';
    const filled = FIELDS.filter(({ ref }) => refs[ref].value.trim()).length;
    const settled = filled === FIELDS.length;
    refs.briefState.textContent = settled ? '揃いました' : `${filled} / ${FIELDS.length}`;
    refs.briefState.dataset.state = settled ? 'set' : (filled === 0 ? 'unset' : 'partial');
    // タブは既定でコメントを開くので、押されるまで管理者は画面に出ません。
    // 決まっていない数をラベルへ出して、押される前から求めていることを見せます。
    refs.managerTabCount.hidden = settled;
    refs.managerTabCount.textContent = settled ? '' : `${filled} / ${FIELDS.length}`;
    refs.briefComposeButton.disabled = composing || refs.briefInput.value.trim() === '';
    refs.briefStopButton.classList.toggle('hidden', !composing);
    refs.briefClearButton.disabled = composing || filled === 0;
    for (const { ref } of FIELDS) refs[ref].disabled = composing;
    refs.briefResult.innerHTML = composing
      ? '<p class="ai-loading">管理者が目的・ストーリー・期待値を組み立て中…</p>'
      : draftHtml(state.briefDraft);
  }

  function bindEvents() {
    for (const { ref } of FIELDS) refs[ref].addEventListener('input', handleInput);
    refs.briefInput.addEventListener('input', render);
    refs.briefComposeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      composeBrief();
    });
    refs.briefStopButton.addEventListener('click', () => state.briefAbortController?.abort());
    refs.briefClearButton.addEventListener('click', clearBrief);
  }

  return { load, refresh, render, setStatus, sync };
}

/**
 * その資料が、もう書かれているかどうか。見出しと前書き（front matter）だけの骨組みは
 * 「まだ書かれていない」とみなします。
 *
 * 管理者が書き始める手前で止めるのは、これから作る資料だけです。すでに書かれたものを
 * 直しに来た人や、読みに来ただけの人まで編集の手前で止めると、この道具はレビューの
 * 道具でなくなります。
 */
export function hasWrittenBody(markdown) {
  const body = String(markdown || '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  return body.split(/\r?\n/).some((line) => {
    const text = line.trim();
    return text !== '' && !/^#{1,6}\s/.test(text);
  });
}

/** まだ決まっていない項目。関門（documentReview.js）と表示の両方がここを見ます。 */
export function missingBriefFields(brief) {
  return FIELDS.filter(({ id }) => !brief?.[id]).map(({ id, label }) => ({ id, label }));
}

function draftHtml(draft) {
  if (!draft) {
    return '<p class="muted">決まっていることを書いて「管理者に聞く」を押すと、管理者が3つの欄へ組み直し、決まっていない分は問いとして返します。</p>';
  }
  if (draft.error) return `<p class="ai-error">管理者に聞けませんでした: ${escapeHtml(draft.error)}</p>`;
  const parts = [];
  if (draft.questions?.length) {
    parts.push(`
      <section class="brief-questions">
        <h4>管理者からの問い</h4>
        <ol>${draft.questions.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ol>
        <p class="brief-questions-hint">答えを「決まっていること」へ書き足してもう一度聞くか、欄へ直接書いてください。</p>
      </section>`);
  }
  if (draft.assumptions?.length) {
    // 走り書きが言い切っていないのに書いた分は、必ず見せます。違えば直せるようにするためです。
    parts.push(`
      <section class="brief-assumptions">
        <h4>管理者が補ったところ</h4>
        <ul>${draft.assumptions.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>
      </section>`);
  }
  if (parts.length === 0) {
    return '<p class="brief-settled">管理者からの問いはありません。3つとも決まっているものとして扱います。</p>';
  }
  return parts.join('');
}
