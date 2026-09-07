import { runAiRequest } from './aiRequest.js';
import { escapeHtml } from './util.js';

const MAX_PERSONA_INPUT_CHARS = 2_000;

const PERSONA_FIELDS = [
  ['background', '立場・経験'],
  ['knowledge', '持っている前提知識'],
  ['gaps', '持っていない知識'],
  ['goals', 'この文書を読む目的'],
  ['concerns', '気にする点・つまずく点']
];

/**
 * 誰がこの文書を読むかを決める欄。
 *
 * 決め方は2通りあります。書いた文章をそのまま渡すか、AIに立場・前提知識・目的・
 * 気にする点へ組み直させるか。組み直した場合は何を補ったかも画面へ出すので、
 * レビュアーは組み直しを見てから採用できます。
 *
 * 決めた読み手は前提の一部として、翻訳・AIチャット・指摘の配置・AIレビューすべてへ渡ります。
 * 保存はコメントと同じ自動保存に相乗りします。
 *
 * ── AIレビューのパネルから切り出してある理由 ──────────────────
 * 読み手はレビューを実行する直前に決めるものなので、決める場所はAIレビューのタブにも
 * 残してあります。同じ操作盤を、読み手だけを開く広い画面（`#/persona/<path>`）へも出す
 * ために、レビューの実行から切り離してあります。どちらで決めても同じ1組の state です。
 */
export function createPersonaController({
  refs, state, api, toaster, prepareAi, flushComments = async () => true,
  onChange, onSettled = () => {}
}) {
  // 書きかけの説明を、保存の往復で消さないための目印です。
  let inputTouched = false;

  bindEvents();

  /** 文書を開いたときの初期化。書きかけは前の文書のものなので捨てます。 */
  function load() {
    inputTouched = false;
    refs.personaInput.value = state.persona?.input || '';
    render();
  }

  /**
   * 保存済みのペルソナを読み込み直したときや、もう一方の画面で決め直されたときに映します。
   *
   * 書き換えるのは、読み手が決まっているときだけです。消したときまで欄を空にすると、
   * 「読み手を消す」を押した人が、そのとき書いていた説明まで失います。文書を開き直したときの
   * 空にするのは `load()` の仕事です。打っている最中の欄には触りません。
   */
  function refresh() {
    if (!inputTouched && state.persona) refs.personaInput.value = state.persona.input || '';
    render();
  }

  /** 書いた文章をそのまま読み手として使います。AIは呼びません。 */
  function useAsWritten() {
    const input = refs.personaInput.value.trim();
    if (!input || state.personaAbortController) return;
    if (input.length > MAX_PERSONA_INPUT_CHARS) {
      toaster.error(`読み手の説明は${MAX_PERSONA_INPUT_CHARS}文字までです。`);
      return;
    }
    state.persona = { source: 'manual', input };
    state.personaStatus = 'ready';
    inputTouched = false;
    // コメントと同じ自動保存でレビューファイルへ入ります。
    onChange();
    onSettled();
  }

  async function compose() {
    const input = refs.personaInput.value.trim();
    if (!input) return;
    if (input.length > MAX_PERSONA_INPUT_CHARS) {
      toaster.error(`読み手の説明は${MAX_PERSONA_INPUT_CHARS}文字までです。`);
      return;
    }
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'personaAbortController',
      // 「組み立て中」はCodexが起動できてから出します。起動できなかったときに
      // 出してしまうと、動いていないものを待っているように見えます。
      onPrepared() {
        state.personaStatus = 'composing';
        onSettled();
      },
      run: ({ documentPath, signal }) => (
        api.composeAiPersona({ path: documentPath, input }, { signal })
      ),
      onResult(result) {
        state.persona = result.persona;
        state.personaStatus = 'ready';
        inputTouched = false;
        // 組み直した結果はコメントと同じ自動保存でレビューファイルへ入ります。
        onChange();
      },
      onUnavailable: (error) => toaster.error(error),
      onAbort: () => { state.personaStatus = 'idle'; },
      onError(error) {
        state.personaStatus = 'idle';
        toaster.error(`読み手ペルソナを組み立てられませんでした: ${error.message}`);
      },
      onSettled
    });
  }

  function clear() {
    if (!state.persona) return;
    state.persona = null;
    state.personaStatus = 'idle';
    onChange();
    onSettled();
  }

  function render() {
    const composing = state.personaStatus === 'composing';
    const empty = refs.personaInput.value.trim() === '';
    refs.personaComposeButton.disabled = composing || empty;
    // source を持たないのは、この機能より前に保存したペルソナです。AIが組んだものとして扱います。
    const composed = state.persona && state.persona.source !== 'manual';
    refs.personaComposeButton.textContent = composed ? 'AIで組み直す' : 'AIで組み立てる';
    refs.personaUseButton.disabled = composing || empty;
    refs.personaStopButton.classList.toggle('hidden', !composing);
    refs.personaClearButton.disabled = composing || !state.persona;
    refs.personaState.textContent = state.persona ? '設定済み' : '未設定';
    refs.personaState.dataset.state = state.persona ? 'set' : 'unset';
    // 読み手が決まっていないレビューは「一般に良い文章か」を見る読みになります。
    // 実行はできるので止めませんが、何が変わるかは実行前に言っておきます。
    // この注意はレビューを実行する場所にしかありません（読み手だけを開く画面には出ません）。
    refs.reviewPersonaHint?.classList.toggle('hidden', Boolean(state.persona));
    refs.personaResult.innerHTML = composing
      ? '<p class="ai-loading">読み手ペルソナを組み立て中…</p>'
      : personaHtml(state.persona);
  }

  function bindEvents() {
    refs.personaInput.addEventListener('input', () => {
      inputTouched = true;
      render();
    });
    refs.personaForm.addEventListener('submit', (event) => {
      event.preventDefault();
      compose();
    });
    refs.personaUseButton.addEventListener('click', useAsWritten);
    refs.personaStopButton.addEventListener('click', () => state.personaAbortController?.abort());
    refs.personaClearButton.addEventListener('click', clear);
  }

  return { load, refresh, render };
}

/** 決まった読み手の見せ方。どの画面も同じ形で出します。 */
export function personaHtml(persona) {
  if (!persona) {
    return '<p class="muted">読み手を書いて「そのまま使う」を押すとその文章のまま、「AIで組み立てる」を押すとAIが立場・前提知識・目的へ組み直して使います。</p>';
  }
  // そのまま使う読み手は、書いた文章がそのまま中身です。項目に振り分けて見せると、
  // 書いていないことまで決まったように見えてしまいます。
  if (persona.source === 'manual') {
    return `
      <article class="persona-card">
        <header>
          <h3>${escapeHtml(persona.label || manualLabel(persona.input))}<span class="persona-source">そのまま使用</span></h3>
        </header>
        <p class="persona-notes">${escapeHtml(persona.input || '')}</p>
      </article>`;
  }
  const fields = PERSONA_FIELDS.map(([key, label]) => {
    const value = persona[key];
    const text = Array.isArray(value) ? value.join(' / ') : value;
    return text ? `<div class="persona-field"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>` : '';
  }).join('');
  return `
    <article class="persona-card">
      <header>
        <h3>${escapeHtml(persona.label || '読み手')}<span class="persona-source">AIが組み立て</span></h3>
        ${persona.summary ? `<p class="persona-summary">${escapeHtml(persona.summary)}</p>` : ''}
      </header>
      <dl>${fields}</dl>
      ${assumptionsHtml(persona.assumptions)}
    </article>`;
}

/** そのまま使う読み手の呼び名。サーバーが保存時に付けるものと同じ作り方です。 */
function manualLabel(input) {
  const label = (String(input || '').split(/\r?\n/).find((line) => line.trim()) || '').trim();
  return label.length > 24 ? `${label.slice(0, 24)}…` : label;
}

/** AIが勝手に足した前提は、直せるように必ず見せます。 */
function assumptionsHtml(assumptions) {
  if (!assumptions?.length) return '';
  return `
    <section class="persona-assumptions">
      <h4>AIが補った前提</h4>
      <ul>${assumptions.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>
      <p class="persona-assumptions-hint">違う場合は、説明へ書き足してもう一度組み直してください。</p>
    </section>`;
}
