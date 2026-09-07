import { runAiRequest } from './aiRequest.js';
import { escapeHtml } from './util.js';

/**
 * 会議中の聞き直しパネルです。
 *
 * 使う場面は2つあります。指摘をまとめて言われて追いつけなくなったときと、
 * 説明してもらったのに分からなかったときです。どちらも欲しいのは議事録ではなく、
 * 「何を言われたか」と「次に何をすればいいか」なので、出すのもその2つだけです。
 *
 * ── 押す前に、読む範囲を出す ─────────────────────────────
 * 「直近」がどこからなのかは、押したあとに分かるのでは遅すぎます。前回の続きなのか、
 * 直近10分なのか、何発言ぶんなのかが分からないまま要約を読むと、その要約が会議の
 * どの部分の話なのかを確かめられません。そこで、範囲だけを計算する窓口
 * （`/api/ai/recap-window`）をAIとは別に用意して、決め方を変えるたびに引き直します。
 * 範囲を決めているのはサーバー側の1か所なので、ここに出る範囲と、実際に読ませる範囲は
 * 必ず同じです。
 *
 * ── 画面の本文ではなく、ファイルを読む ────────────────────
 * 会議中はファイルが数秒ごとに伸びます。画面はブラウザが開いた時点のもので、
 * 「更新」を押すまで増えません。聞き直しはファイルを読むので、画面にまだ出ていない
 * 発言も入ります。取り違えないように、範囲は「いまファイルにあるところまで」として
 * 出し、取り直すボタンも置いてあります。
 *
 * ── 続けて聞く ────────────────────────────────────────
 * 要約を読んで、それでも分からないことは残ります（「その依頼、期限は言われた？」）。
 * そこで、出したあとに同じ範囲へ続けて聞ける欄を下に出します。
 *
 * 範囲の選び方は出しません。続きの問いは、いま画面に出ている要約と同じ範囲への問い
 * だからです。ここで選び直せると、読んだ範囲と答えの根拠がずれます。そのあとの発言
 * まで含めたいときは「直近を聞く」を押し直す、と欄の上に書いてあります。
 *
 * 押し直せば、それまでのやり取りは消えます。範囲が変わった以上、前の範囲への問いと
 * 答えを残しても、どこの話なのかが読めなくなるからです。
 */

/**
 * 発言行の目印。`src/liveCaptions.js` が書く形で、`src/captionRecap.js` が読む形です。
 * ここではリンクを出すかどうかだけを決めるので、話者と時刻を取り出すところまではしません。
 * 3か所が同じ形を見ているので、どれかを変えるときは残りも見てください。
 */
const SPEAKER_LINE = /^\*\*.+?\*\*\s+`\[[^\]]*\]`\s*$/m;

const EMPTY_HTML = '<p class="muted">「直近を聞く」を押すと、いま言われたことの要約と、次にすることが出ます。</p>';
const LOADING_HTML = '<p class="ai-loading">直近の発言を読んでいます…</p>';
const FOLLOW_UP_LOADING_HTML = '<p class="ai-loading">読んだ範囲から答えを探しています…</p>';

/** 指摘の種類。サーバー側の語彙（src/prompts/recap.js）と同じ並びです。 */
const KIND_LABELS = {
  comment: 'コメント',
  request: '依頼',
  question: '質問',
  decision: '決定',
  explanation: '説明'
};

/** 「直近」の決め方。値は `src/captionRecap.js` の `RECAP_SCOPES` と同じです。 */
const SCOPE_LABELS = {
  'since-last': '前回聞いたところから',
  minutes: '直近',
  all: '会議の最初から'
};

export function createCaptionRecapController({
  refs, state, api, toaster, prepareAi, flushComments = async () => true
}) {
  /** 範囲の引き直しは、遅れて返ってきた古い答えで上書きさせません。 */
  let rangeRequest = 0;

  bindEvents();

  /** 文書を開いたとき。前の文書で書いた問いも、その要約も、続きのやり取りも残しません。 */
  function load() {
    refs.recapQuestion.value = '';
    refs.recapFollowUpQuestion.value = '';
    state.recapWindow = null;
    state.recap = null;
    state.recapFollowUps = [];
    applyScope();
    setRunning(false);
    setFollowUpRunning(false);
    refresh();
  }

  /**
   * 本文が入れ替わったとき（開き終わった・保存した）。読む範囲だけを取り直します。
   * 書きかけの問いと、いま出ている要約はそのままにします。
   */
  function refresh() {
    render();
    refreshRange();
  }

  /**
   * この文書で聞き直せるか。発言の行があることと、文字起こし用のファイルであることの両方です。
   * 文字起こしでない文書にリンクを出しても、押せば断られるだけだからです。
   */
  function available() {
    return hasCaptions() && state.transcript === true;
  }

  /**
   * リンクを出すか。聞き直せない文書でも、発言が並んでいるならリンクは出します。
   *
   * 出さないと、文字起こし用のファイルの外に字幕を貼った人には、この機能ごと無いものとして
   * 映ります。出したうえで「このファイルでは聞き直せない」と理由を書けば、直し方
   * （設定にパターンを足すか、文字起こし用のファイルへ移すか）まで画面から辿れます。
   */
  function visible() {
    return hasCaptions();
  }

  function hasCaptions() {
    return state.documentType === 'markdown' && SPEAKER_LINE.test(state.markdown || '');
  }

  /** 聞き直せない理由。文字起こし用のファイルでないときだけ出ます。 */
  function scopeNote() {
    const patterns = state.transcriptFiles || [];
    return patterns.length
      ? `この文書は文字起こし用のファイルではないので、聞き直せません。使えるのは ${patterns.join(' / ')} に当たるファイルです`
        + '（review-markdown config add transcriptFiles \'<パターン>\' で足せます）。'
      : '文字起こしに使えるファイルが設定されていないので、聞き直せません'
        + '（review-markdown config add transcriptFiles \'meet-captions\' で足せます）。';
  }

  /* ---------------------------------------------------------------- *
   * どこまでが「直近」か
   * ---------------------------------------------------------------- */

  async function refreshRange() {
    if (!available() || !state.currentPath) {
      state.recapWindow = null;
      renderRange();
      return;
    }
    const documentPath = state.currentPath;
    const request = (rangeRequest += 1);
    try {
      const { window } = await api.readRecapWindow({
        path: documentPath,
        scope: state.recapScope,
        minutes: state.recapMinutes
      });
      // 引いている間に別の文書へ移ったか、もっと新しい引き直しが始まっていたら捨てます。
      if (state.currentPath !== documentPath || request !== rangeRequest) return;
      state.recapWindow = window;
    } catch (error) {
      if (state.currentPath !== documentPath || request !== rangeRequest) return;
      state.recapWindow = { error: error.message };
    }
    renderRange();
    syncRunState();
  }

  function chooseScope(scope) {
    if (!SCOPE_LABELS[scope] || state.recapScope === scope) return;
    state.recapScope = scope;
    applyScope();
    refreshRange();
  }

  function chooseMinutes(minutes) {
    state.recapMinutes = Number(minutes) || state.recapMinutes;
    // 分を選んだということは、分で切りたいということです。ラジオを選び直させません。
    if (state.recapScope !== 'minutes') chooseScope('minutes');
    else refreshRange();
  }

  /** 画面の選択を、持ち回っている決め方に合わせます。文書を開き直しても選択は残ります。 */
  function applyScope() {
    for (const input of scopeInputs()) input.checked = input.value === state.recapScope;
    refs.recapMinutes.value = String(state.recapMinutes);
  }

  /* ---------------------------------------------------------------- *
   * 聞く
   * ---------------------------------------------------------------- */

  async function recap() {
    const question = refs.recapQuestion.value.trim();
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'recapAbortController',
      onStart() {
        state.recap = { status: 'loading' };
        // 読む範囲が変わるので、前の範囲への問いと答えはここで捨てます。残すと、
        // どこの話への答えなのかが分からないやり取りが上に積まれたままになります。
        state.recapFollowUps = [];
        refs.recapFollowUpQuestion.value = '';
        render();
        revealResults();
      },
      onPrepared: () => setRunning(true),
      run: ({ documentPath, signal }) => api.recapWithAi({
        path: documentPath,
        scope: state.recapScope,
        minutes: state.recapMinutes,
        question
      }, { signal }),
      onResult(result) {
        state.recap = { status: 'ready', ...result.recap };
      },
      // ここだけ onSettled を通りません（頼めていないので後始末する対象がない）。
      // 断られた理由も結果の欄に出るので、見えるところまで持ってくるのはここで行います。
      onUnavailable(error) {
        state.recap = { status: 'error', error };
        render();
        revealResults();
      },
      // 中断は失敗ではないので、何も残さず元の状態へ戻します。
      onAbort: () => { state.recap = null; },
      onError: (error) => { state.recap = { status: 'error', error: error.message }; },
      onSettled() {
        setRunning(false);
        render();
        revealResults();
        // 聞いたぶんだけ「前回の位置」が進むので、次に読む範囲も変わります。
        refreshRange();
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * 続けて聞く
   * ---------------------------------------------------------------- */

  /**
   * 同じ範囲について、もう一度聞きます。送るのは問いだけです。
   *
   * 決め方も分数も送りません。どこを読むかは直前の聞き直しで決まっていて、それを
   * 覚えているのはサーバー側です。ここから範囲を送れるようにすると、画面に出ている
   * 要約と、続きの答えの根拠が食い違う余地ができます。
   */
  async function askFollowUp() {
    const question = refs.recapFollowUpQuestion.value.trim();
    if (!question || state.recap?.status !== 'ready') return;
    // 問いは先に並べます。答えを待っている間も、何を聞いたのかが画面に残ります。
    const asked = { question, status: 'loading' };
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'recapFollowUpAbortController',
      onStart() {
        state.recapFollowUps = [...state.recapFollowUps, asked];
        renderFollowUps();
        revealFollowUp();
      },
      onPrepared: () => setFollowUpRunning(true),
      run: ({ documentPath, signal }) => api.recapFollowUpWithAi({ path: documentPath, question }, { signal }),
      onResult(result) {
        replaceFollowUp(asked, { status: 'ready', ...result.followUp });
        // 聞けたぶんだけ欄を空にします。同じ問いをもう一度送る操作は、ここにはありません。
        refs.recapFollowUpQuestion.value = '';
      },
      // 頼めなかったときは onSettled を通らないので、描き直すのはここです。
      onUnavailable(error) {
        replaceFollowUp(asked, { question, status: 'error', error });
        renderFollowUps();
        revealFollowUp();
      },
      // 中断は失敗ではないので、問いごと引き取ります。書いたものは欄に残したままなので、
      // そのまま押し直せます。
      onAbort() {
        state.recapFollowUps = state.recapFollowUps.filter((entry) => entry !== asked);
      },
      onError(error) {
        replaceFollowUp(asked, { question, status: 'error', error: error.message });
      },
      onSettled() {
        setFollowUpRunning(false);
        renderFollowUps();
        revealFollowUp();
      }
    });
  }

  /** 待っていた問いを、返ってきたものへ置き換えます。並び順は聞いた順のままです。 */
  function replaceFollowUp(asked, resolved) {
    state.recapFollowUps = state.recapFollowUps.map((entry) => (entry === asked ? resolved : entry));
  }

  /**
   * 続きのやり取りを、押した人の目の前へ持ってきます。
   *
   * 持ってくるのは書く欄です。やり取りは古い順に積むので、いちばん新しい問いと答えは
   * いつも書く欄のすぐ上にあります。欄ごと持ってくれば、重ねても新しいほうが見えます。
   */
  function revealFollowUp() {
    refs.recapFollowUpForm.scrollIntoView?.({ block: 'nearest' });
  }

  /**
   * 出したものを、押した人の目の前へ持ってきます。
   *
   * 決め方の選択と問いの欄でパネルの上半分は埋まるので、答えはその下に出ます。押した
   * ままの位置では、変わったのは「停止」が出たことだけで、答えは画面の外にあります。
   * 会議中に押すものなので、出たかどうかを自分でスクロールして確かめさせると、
   * 探している間の発言を聞き逃します。押した直後（待っている表示）と、出そろったとき
   * の2回動かすのは、待っている間に読む場所と、答えが出る場所を同じにするためです。
   */
  function revealResults() {
    refs.recapResults.scrollIntoView?.({ block: 'nearest' });
  }

  /** 要約と行動を、そのまま貼れる文章にして渡します。続けて聞いたぶんも最後に付けます。 */
  async function copy() {
    const recapResult = state.recap;
    if (recapResult?.status !== 'ready') return;
    const answered = state.recapFollowUps.filter((entry) => entry.status === 'ready');
    const text = [
      `【直近の要約】${describeRange(recapResult.range, { done: true })}`,
      recapResult.summary,
      recapResult.answer ? `\n【聞きたかったこと】${recapResult.question}\n${recapResult.answer}` : '',
      recapResult.points.length ? `\n【言われたこと】\n${recapResult.points
        .map((point) => `- ${KIND_LABELS[point.kind] || ''}／${point.speaker}: ${point.point}`).join('\n')}` : '',
      recapResult.actions.length ? `\n【次にすること】\n${recapResult.actions
        .map((action, index) => `${index + 1}. ${action.action}${action.reason ? `（${action.reason}）` : ''}`).join('\n')}` : '',
      answered.length ? `\n【続けて聞いたこと】\n${answered
        .map((entry) => `Q. ${entry.question}\nA. ${entry.answer}`).join('\n\n')}` : ''
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toaster.success('聞き直した内容をコピーしました。');
    } catch {
      toaster.error('コピーできませんでした。画面から選んでコピーしてください。');
    }
  }

  /* ---------------------------------------------------------------- *
   * 描画
   * ---------------------------------------------------------------- */

  function render() {
    renderRange();
    syncRunState();
    refs.recapResults.innerHTML = resultsHtml();
    refs.recapResults.querySelector('[data-recap-action="copy"]')?.addEventListener('click', copy);
    renderFollowUps();
  }

  /**
   * 続きのやり取り。要約が出ているときだけ欄ごと出します。
   * 読んだ範囲が無いうちに問いの欄だけ出しても、押せば断られるだけだからです。
   */
  function renderFollowUps() {
    const open = state.recap?.status === 'ready';
    refs.recapFollowUp.classList.toggle('hidden', !open);
    refs.recapFollowUps.innerHTML = open ? state.recapFollowUps.map(followUpHtml).join('') : '';
    syncFollowUpState();
  }

  function followUpHtml(entry) {
    const asked = `<p class="recap-asked">${escapeHtml(entry.question)}</p>`;
    if (entry.status === 'loading') return `<article class="recap-follow-up-turn">${asked}${FOLLOW_UP_LOADING_HTML}</article>`;
    if (entry.status === 'error') {
      return `<article class="recap-follow-up-turn">${asked}<p class="ai-error">聞けませんでした: ${escapeHtml(entry.error)}</p></article>`;
    }
    return `
      <article class="recap-follow-up-turn">
        ${asked}
        <p>${escapeHtml(entry.answer)}</p>
        ${entry.answered ? '' : '<p class="muted">読んだ範囲には、答えになる発言がありません。</p>'}
        ${(entry.quotes || []).map((quote) => `
          <blockquote class="placement-quote">
            <span class="recap-speaker">${escapeHtml(quote.speaker)}</span>
            ${escapeHtml(quote.quote)}
          </blockquote>`).join('')}
      </article>`;
  }

  function renderRange() {
    const window = state.recapWindow;
    if (hasCaptions() && !available()) {
      refs.recapRange.textContent = scopeNote();
      return;
    }
    if (!available()) {
      refs.recapRange.textContent = 'この文書には文字起こしの発言がありません。';
      return;
    }
    if (!window) {
      refs.recapRange.textContent = '読む範囲を確認しています…';
      return;
    }
    if (window.error) {
      refs.recapRange.textContent = `読む範囲を確認できませんでした: ${window.error}`;
      return;
    }
    refs.recapRange.textContent = window.entries.length === 0
      ? emptyRangeText(window)
      : `いま押すと ${describeRange(rangeOf(window))} を読みます。`;
  }

  function emptyRangeText(window) {
    if (window.reason === 'no-new-entries') return '前回聞いたところから、新しい発言はまだありません。';
    return 'この文書には文字起こしの発言がありません。';
  }

  /**
   * 範囲の言い方。「押す前」と「読んだあと」で同じ言い方にしてあります。
   * 押す前に見た範囲と読んだ範囲が同じ言葉で出るので、途中で発言が増えて範囲が
   * 広がったことにも気づけます。
   */
  function describeRange(range, { done = false } = {}) {
    const scope = range.appliedScope === 'minutes'
      ? `直近${range.minutes}分`
      : SCOPE_LABELS[range.appliedScope] || '直近';
    const span = range.from && range.to ? `${range.from}〜${range.to}` : '';
    const counted = `${scope}の${range.entries}発言${span ? `（${span}）` : ''}`;
    const notes = [
      range.fallback === 'no-mark' ? 'この文書はまだ聞いていないので、前回の続きではありません' : '',
      range.fallback === 'mark-missing' ? '前回聞いた発言が見つからないので、前回の続きではありません' : '',
      range.dropped > 0 ? `長いので古い${range.dropped}発言は${done ? '渡していません' : '渡しません'}` : ''
    ].filter(Boolean);
    return notes.length ? `${counted}［${notes.join('／')}］` : counted;
  }

  function rangeOf(window) {
    return {
      appliedScope: window.appliedScope,
      fallback: window.fallback,
      minutes: window.minutes,
      entries: window.entries.length,
      dropped: window.dropped,
      from: window.from,
      to: window.to
    };
  }

  function resultsHtml() {
    const result = state.recap;
    if (!result) return EMPTY_HTML;
    if (result.status === 'loading') return LOADING_HTML;
    if (result.status === 'error') return `<p class="ai-error">聞き直せませんでした: ${escapeHtml(result.error)}</p>`;

    return [
      `<p class="placement-note">読んだのは ${escapeHtml(describeRange(result.range, { done: true }))} です。</p>`,
      result.summary ? `<p class="review-summary">${escapeHtml(result.summary)}</p>` : '',
      answerHtml(result),
      pointsHtml(result.points || []),
      actionsHtml(result.actions || []),
      '<div class="placement-card-actions"><button type="button" data-recap-action="copy">コピー</button></div>'
    ].filter(Boolean).join('');
  }

  function answerHtml(result) {
    if (!result.answer) return '';
    return `
      <section class="recap-answer">
        <h3>聞きたかったこと</h3>
        <p class="recap-asked">${escapeHtml(result.question)}</p>
        <p>${escapeHtml(result.answer)}</p>
      </section>`;
  }

  function pointsHtml(points) {
    if (points.length === 0) {
      return '<p class="muted">この範囲では、あなたへのコメントや指摘は出ていません。</p>';
    }
    return `
      <section class="recap-section">
        <h3>言われたこと（${points.length}件）</h3>
        ${points.map((point) => `
          <article class="placement-card">
            <div class="placement-card-head">
              <span class="target-badge" data-type="${escapeHtml(point.kind)}">${escapeHtml(KIND_LABELS[point.kind] || point.kind)}</span>
              <span class="recap-speaker">${escapeHtml(point.speaker)}</span>
            </div>
            <p>${escapeHtml(point.point)}</p>
            ${point.quote ? `<blockquote class="placement-quote">${escapeHtml(point.quote)}</blockquote>` : ''}
          </article>`).join('')}
      </section>`;
  }

  function actionsHtml(actions) {
    if (actions.length === 0) {
      return '<p class="muted">この範囲から、あなたがすることは出ていません。</p>';
    }
    return `
      <section class="recap-section recap-actions">
        <h3>次にすること（${actions.length}件）</h3>
        <ol>
          ${actions.map((action) => `
            <li>
              <span class="recap-action-what">${escapeHtml(action.action)}</span>
              ${action.reason ? `<span class="recap-action-why">${escapeHtml(action.reason)}</span>` : ''}
            </li>`).join('')}
        </ol>
      </section>`;
  }

  function setRunning(running) {
    refs.recapQuestion.disabled = running;
    refs.recapRangeRefresh.disabled = running;
    refs.recapStopButton.classList.toggle('hidden', !running);
    for (const input of scopeInputs()) input.disabled = running;
    refs.recapMinutes.disabled = running;
    syncRunState();
  }

  function setFollowUpRunning(running) {
    refs.recapFollowUpQuestion.disabled = running;
    refs.recapFollowUpStopButton.classList.toggle('hidden', !running);
    syncFollowUpState();
  }

  /** 読む発言が1つも無いときは押させません。押しても断られるだけだからです。 */
  function syncRunState() {
    const window = state.recapWindow;
    refs.recapRunButton.disabled = Boolean(state.recapAbortController)
      || !available()
      || Boolean(window?.error)
      || (Array.isArray(window?.entries) && window.entries.length === 0);
  }

  /**
   * 続けて聞けるのは、読んだ範囲があるときだけです。聞き直しを走らせている最中も
   * 押させません。範囲がこれから入れ替わるので、いま出ている範囲への問いになりません。
   */
  function syncFollowUpState() {
    refs.recapFollowUpButton.disabled = Boolean(state.recapFollowUpAbortController)
      || Boolean(state.recapAbortController)
      || state.recap?.status !== 'ready';
  }

  function scopeInputs() {
    return refs.recapScope.querySelectorAll('input[name="recap-scope"]');
  }

  function bindEvents() {
    refs.recapForm.addEventListener('submit', (event) => {
      event.preventDefault();
      recap();
    });
    refs.recapQuestion.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      recap();
    });
    for (const input of scopeInputs()) {
      input.addEventListener('change', () => chooseScope(input.value));
    }
    refs.recapMinutes.addEventListener('change', () => chooseMinutes(refs.recapMinutes.value));
    refs.recapRangeRefresh.addEventListener('click', () => refreshRange());
    refs.recapStopButton.addEventListener('click', () => state.recapAbortController?.abort());
    refs.recapFollowUpForm.addEventListener('submit', (event) => {
      event.preventDefault();
      askFollowUp();
    });
    refs.recapFollowUpQuestion.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      askFollowUp();
    });
    refs.recapFollowUpStopButton.addEventListener('click', () => state.recapFollowUpAbortController?.abort());
  }

  return { load, refresh, render, refreshRange, available, visible };
}
