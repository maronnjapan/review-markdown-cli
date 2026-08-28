import { runAiRequest } from './aiRequest.js';
import { createProposalList } from './proposalList.js';
import { escapeHtml } from './util.js';

const MAX_PERSONA_INPUT_CHARS = 2_000;
/** サーバー側の上限と同じです。超えて選ぶと実行時に断られます。 */
const MAX_SELECTED_SKILLS = 5;

const EMPTY_HTML = '<p class="muted">レビュースキルを選んで「レビューを実行」を押すと、AIがそのスキルの観点でコメント候補を作ります。</p>';

const PERSONA_FIELDS = [
  ['background', '立場・経験'],
  ['knowledge', '持っている前提知識'],
  ['gaps', '持っていない知識'],
  ['goals', 'この文書を読む目的'],
  ['concerns', '気にする点・つまずく点']
];

/**
 * AIレビューのパネル。
 *
 * レビュアーが決めるのは2つだけです。どの観点で読むか（レビュースキル）と、
 * 誰として読むか（読み手ペルソナ）。
 *
 * スキルは複数選べます。何を見るスキルなのかは、選ぶ前に「詳細」でその場に開けます。
 * 別のエディタで SKILL.md を探しに行かずに済ませるためです。
 *
 * 読み手は2通りの決め方があります。書いた文章をそのまま渡すか、AIに立場・前提知識・
 * 目的・気にする点へ組み直させるか。組み直した場合は何を補ったかも画面へ出すので、
 * レビュアーは組み直しを見てから採用できます。
 *
 * レビューは2周します。指摘を出す1周目と、その指摘をAI自身に反証させる2周目です。
 * どちらを読んでいるかは待ちの表示に出し、2周目で何件落ちたかは結果の先頭に出します。
 * どれだけ絞り込まれた指摘なのかが分からないと、レビュアーは結局全部読み直すからです。
 *
 * レビュー結果は「指摘の配置」と同じコメント候補で、追加するまで保存しません。
 */
export function createDocumentReviewController({
  refs, state, api, toaster, prepareAi, flushComments = async () => true,
  onPersonaChanged, onAddComments, onRevealTarget
}) {
  const proposals = createProposalList({
    container: refs.reviewResults,
    state,
    toaster,
    onAddComments,
    onRevealTarget,
    emptyHtml: EMPTY_HTML,
    loadingHtml,
    errorPrefix: 'レビューできませんでした',
    read: (current) => current.review,
    extraHtml: (result) => [
      result.summary ? `<p class="review-summary">${escapeHtml(result.summary)}</p>` : '',
      verificationHtml(result)
    ].join('')
  });

  // 書きかけの説明を、保存の往復で消さないための目印です。
  let personaInputTouched = false;

  bindEvents();

  /** 文書を開いたときの初期化。スキル一覧は最初の1回だけ取りに行きます。 */
  function load() {
    personaInputTouched = false;
    refs.personaInput.value = state.persona?.input || '';
    state.review = null;
    renderPersona();
    renderSkills();
    proposals.render();
    syncRunState();
    if (state.reviewSkills.length === 0) loadSkills();
  }

  /** 保存済みのペルソナを読み込み直したときに、画面へ映します。 */
  function refresh() {
    if (!personaInputTouched) refs.personaInput.value = state.persona?.input || '';
    renderPersona();
    syncRunState();
  }

  /* ---------------------------------------------------------------- *
   * レビュースキル
   * ---------------------------------------------------------------- */

  async function loadSkills() {
    try {
      const result = await api.listReviewSkills();
      state.reviewSkills = result.skills || [];
      const available = new Set(state.reviewSkills.map((skill) => skill.id));
      state.reviewSkillIds = state.reviewSkillIds.filter((id) => available.has(id));
      if (state.reviewSkillIds.length === 0 && state.reviewSkills[0]) {
        state.reviewSkillIds = [state.reviewSkills[0].id];
      }
      renderSkills();
      syncRunState();
    } catch (error) {
      refs.reviewSkillStatus.textContent = `レビュースキルを読み込めませんでした: ${error.message}`;
    }
  }

  function toggleSkill(id, selected) {
    const chosen = state.reviewSkillIds.filter((entry) => entry !== id);
    if (selected) {
      if (chosen.length >= MAX_SELECTED_SKILLS) {
        toaster.error(`レビュースキルは一度に${MAX_SELECTED_SKILLS}個まで選べます。`);
        renderSkills();
        return;
      }
      // 選んだ順に並べます。プロンプトへも同じ順で載ります。
      chosen.push(id);
    }
    state.reviewSkillIds = chosen;
    renderSkills();
    syncRunState();
  }

  /**
   * スキルの本文をその場で開きます。本文も参照ファイルもプロンプトへ載せるものと同じで、
   * 一度読んだら画面を閉じるまで持っておきます。
   */
  async function toggleSkillDetail(id) {
    if (state.openReviewSkillIds.has(id)) {
      state.openReviewSkillIds.delete(id);
      renderSkills();
      return;
    }
    state.openReviewSkillIds.add(id);
    renderSkills();
    if (state.reviewSkillDetails.has(id)) return;
    try {
      const result = await api.readReviewSkill(id);
      state.reviewSkillDetails.set(id, {
        instructions: result.skill?.instructions || '',
        references: result.skill?.references || []
      });
    } catch (error) {
      state.reviewSkillDetails.set(id, { error: `スキルの内容を読み込めませんでした: ${error.message}` });
    }
    if (state.openReviewSkillIds.has(id)) renderSkills();
  }

  function renderSkills() {
    const skills = state.reviewSkills;
    refs.reviewSkillList.innerHTML = skills.map(skillHtml).join('');
    refs.reviewSkillState.textContent = state.reviewSkillIds.length > 0
      ? `${state.reviewSkillIds.length}個選択中`
      : '未選択';
    refs.reviewSkillState.dataset.state = state.reviewSkillIds.length > 0 ? 'set' : 'unset';
    refs.reviewSkillStatus.textContent = skills.length === 0
      ? '.claude/skills/<name>/SKILL.md を置くと、そのスキルもここから選べます。'
      : '';
  }

  function skillHtml(skill) {
    const selected = state.reviewSkillIds.includes(skill.id);
    const open = state.openReviewSkillIds.has(skill.id);
    const detail = state.reviewSkillDetails.get(skill.id);
    return `
      <div class="review-skill-item" data-selected="${selected}">
        <label class="review-skill-choice">
          <input type="checkbox" data-skill-id="${escapeHtml(skill.id)}"${selected ? ' checked' : ''}>
          <span>${escapeHtml(skill.name)}</span>
          ${skill.source === 'builtin' ? '<span class="review-skill-source">標準</span>' : ''}
        </label>
        ${skill.description ? `<p class="review-skill-description">${escapeHtml(skill.description)}</p>` : ''}
        <div class="review-skill-item-actions">
          <button type="button" data-skill-detail="${escapeHtml(skill.id)}" aria-expanded="${open}">
            ${open ? '詳細を閉じる' : '詳細を見る'}
          </button>
        </div>
        ${open ? skillDetailHtml(detail) : ''}
      </div>`;
  }

  /**
   * 開いたスキルの中身。本文のあとに、そのスキルが名指しした参照ファイルを続けます。
   * ここに出ているものが、そのままレビューのプロンプトへ載ります。
   */
  function skillDetailHtml(detail) {
    if (!detail) return '<pre class="review-skill-detail">読み込み中…</pre>';
    if (detail.error) return `<pre class="review-skill-detail">${escapeHtml(detail.error)}</pre>`;
    return [
      `<pre class="review-skill-detail">${escapeHtml(detail.instructions)}</pre>`,
      ...detail.references.map((reference) => [
        `<p class="review-skill-reference">references/${escapeHtml(reference.name)}`,
        reference.truncated ? '<span>（長いため途中まで渡します）</span>' : '',
        '</p>',
        `<pre class="review-skill-detail">${escapeHtml(reference.text)}</pre>`
      ].join(''))
    ].join('');
  }

  /* ---------------------------------------------------------------- *
   * 読み手ペルソナ
   * ---------------------------------------------------------------- */

  /** 書いた文章をそのまま読み手として使います。AIは呼びません。 */
  function usePersonaAsWritten() {
    const input = refs.personaInput.value.trim();
    if (!input || state.personaAbortController) return;
    if (input.length > MAX_PERSONA_INPUT_CHARS) {
      toaster.error(`読み手の説明は${MAX_PERSONA_INPUT_CHARS}文字までです。`);
      return;
    }
    state.persona = { source: 'manual', input };
    state.personaStatus = 'ready';
    personaInputTouched = false;
    // コメントと同じ自動保存でレビューファイルへ入ります。
    onPersonaChanged();
    renderPersona();
    syncRunState();
  }

  async function composePersona() {
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
        renderPersona();
      },
      run: ({ documentPath, signal }) => (
        api.composeAiPersona({ path: documentPath, input }, { signal })
      ),
      onResult(result) {
        state.persona = result.persona;
        state.personaStatus = 'ready';
        personaInputTouched = false;
        // 組み直した結果はコメントと同じ自動保存でレビューファイルへ入ります。
        onPersonaChanged();
      },
      onUnavailable: (error) => toaster.error(error),
      onAbort: () => { state.personaStatus = 'idle'; },
      onError(error) {
        state.personaStatus = 'idle';
        toaster.error(`読み手ペルソナを組み立てられませんでした: ${error.message}`);
      },
      onSettled() {
        renderPersona();
        syncRunState();
      }
    });
  }

  function clearPersona() {
    if (!state.persona) return;
    state.persona = null;
    state.personaStatus = 'idle';
    onPersonaChanged();
    renderPersona();
    syncRunState();
  }

  function renderPersona() {
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
    refs.reviewPersonaHint.classList.toggle('hidden', Boolean(state.persona));
    refs.personaResult.innerHTML = composing
      ? '<p class="ai-loading">読み手ペルソナを組み立て中…</p>'
      : personaHtml(state.persona);
  }

  /* ---------------------------------------------------------------- *
   * レビューの実行
   * ---------------------------------------------------------------- */

  async function runReview() {
    const skillIds = [...state.reviewSkillIds];
    if (skillIds.length === 0) return;
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'reviewAbortController',
      onStart() {
        state.review = { status: 'loading', phase: 'reading' };
        proposals.render();
      },
      onPrepared: () => setReviewing(true),
      run: ({ documentPath, signal }) => api.reviewWithAi({ path: documentPath, skillIds }, {
        signal,
        onEvent: (event) => {
          if (event.type !== 'phase' || state.currentPath !== documentPath) return;
          state.review = { status: 'loading', phase: event.phase };
          proposals.render();
        }
      }),
      onResult: (result) => { state.review = reviewResult(result); },
      onUnavailable(error) {
        state.review = { status: 'error', error };
        proposals.render();
      },
      // 中断は失敗ではないので、何も残さず元の空の状態へ戻します。
      onAbort: () => { state.review = null; },
      onError: (error) => { state.review = { status: 'error', error: error.message }; },
      onSettled() {
        setReviewing(false);
        proposals.render();
      }
    });
  }

  /** レビュー結果を、コメント候補の一覧が読める形へ整えます。 */
  function reviewResult(result) {
    const skills = result.skills || [];
    return {
      status: 'ready',
      summary: result.summary || '',
      // 2周目まで通ったか、そこで何件落ちたか。残った指摘の重みが変わります。
      verified: result.verified,
      refuted: result.refuted || 0,
      // 採用したコメントには、どのスキルがどう判断した指摘かを残します。
      placements: (result.placements || []).map((placement) => ({
        ...placement,
        source: 'ai-review',
        review: {
          skillId: placement.skill?.id || skills[0]?.id || '',
          skillName: placement.skill?.name || skills[0]?.name || '',
          persona: result.persona?.label || '',
          severity: placement.severity || '',
          reason: placement.reason || ''
        }
      })),
      unplaced: result.unplaced || [],
      unplacedTitle: '箇所に結び付かない指摘',
      droppedPlacements: result.droppedPlacements || 0
    };
  }

  function setReviewing(reviewing) {
    refs.reviewSkillList.querySelectorAll('input[data-skill-id]').forEach((input) => {
      input.disabled = reviewing;
    });
    refs.reviewStopButton.classList.toggle('hidden', !reviewing);
    syncRunState();
  }

  function syncRunState() {
    refs.reviewRunButton.disabled = Boolean(state.reviewAbortController)
      || Boolean(state.personaAbortController)
      || state.reviewSkillIds.length === 0;
  }

  function bindEvents() {
    refs.reviewSkillList.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-skill-id]');
      if (input) toggleSkill(input.dataset.skillId, input.checked);
    });
    refs.reviewSkillList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-skill-detail]');
      if (button) toggleSkillDetail(button.dataset.skillDetail);
    });
    refs.personaInput.addEventListener('input', () => {
      personaInputTouched = true;
      renderPersona();
    });
    refs.personaForm.addEventListener('submit', (event) => {
      event.preventDefault();
      composePersona();
    });
    refs.personaUseButton.addEventListener('click', usePersonaAsWritten);
    refs.personaStopButton.addEventListener('click', () => state.personaAbortController?.abort());
    refs.personaClearButton.addEventListener('click', clearPersona);
    refs.reviewForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runReview();
    });
    refs.reviewStopButton.addEventListener('click', () => state.reviewAbortController?.abort());
  }

  return { load, refresh };
}

/** 2周のうちどちらを読んでいるか。待たされる長さの理由が分かるようにします。 */
function loadingHtml(result) {
  return result.phase === 'verifying'
    ? '<p class="ai-loading">指摘を検証中…（根拠の弱い指摘は取り下げます）</p>'
    : '<p class="ai-loading">レビュー中…</p>';
}

/**
 * AIが自分の指摘を反証した結果。何件落ちたかを出すのは、残った指摘をどれだけ
 * 信じてよいかがそこで変わるからです。検証できなかったときも黙っては済ませません。
 */
function verificationHtml(result) {
  if (result.verified === undefined) return '';
  // 指摘が1件も出なかったレビューには、検証する対象もありませんでした。
  const findings = (result.placements?.length || 0) + (result.unplaced?.length || 0);
  if (findings === 0 && !result.refuted) return '';
  if (!result.verified) {
    return '<p class="review-verification" data-state="skipped">指摘の検証は完了しませんでした。根拠は候補ごとに確かめてください。</p>';
  }
  const message = result.refuted > 0
    ? `AIが自分の指摘を検証し、根拠の弱い${result.refuted}件を取り下げました。`
    : 'AIが自分の指摘を検証し、取り下げた指摘はありませんでした。';
  return `<p class="review-verification" data-state="done">${escapeHtml(message)}</p>`;
}

function personaHtml(persona) {
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
