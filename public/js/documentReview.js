import { createProposalList } from './proposalList.js';
import { escapeHtml } from './util.js';

const MAX_PERSONA_INPUT_CHARS = 2_000;

const EMPTY_HTML = '<p class="muted">レビュースキルを選んで「レビューを実行」を押すと、AIがそのスキルの観点でコメント候補を作ります。</p>';
const LOADING_HTML = '<p class="ai-loading">レビュー中…</p>';

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
 * 誰として読むか（読み手ペルソナ）。ペルソナは走り書きのまま渡し、AIが立場・
 * 前提知識・目的・気にする点へ組み直したものを画面へ出します。何を補ったかも
 * 出すので、レビュアーは組み直しを見てから採用できます。
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
    loadingHtml: LOADING_HTML,
    errorPrefix: 'レビューできませんでした',
    read: (current) => current.review,
    extraHtml: (result) => (result.summary ? `<p class="review-summary">${escapeHtml(result.summary)}</p>` : '')
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

  async function loadSkills() {
    try {
      const result = await api.listReviewSkills();
      state.reviewSkills = result.skills || [];
      if (!state.reviewSkillId) state.reviewSkillId = state.reviewSkills[0]?.id || '';
      renderSkills();
      syncRunState();
    } catch (error) {
      refs.reviewSkillDescription.textContent = `レビュースキルを読み込めませんでした: ${error.message}`;
    }
  }

  function selectSkill(id) {
    state.reviewSkillId = id;
    renderSkillDescription();
    syncRunState();
  }

  /* ---------------------------------------------------------------- *
   * 読み手ペルソナ
   * ---------------------------------------------------------------- */

  async function composePersona() {
    const input = refs.personaInput.value.trim();
    if (!input || state.personaAbortController) return;
    if (input.length > MAX_PERSONA_INPUT_CHARS) {
      toaster.error(`読み手の説明は${MAX_PERSONA_INPUT_CHARS}文字までです。`);
      return;
    }
    if (!(await prepareAi())) {
      toaster.error(state.aiStatus?.error || 'Codexを利用できません');
      return;
    }

    const documentPath = state.currentPath;
    const controller = new AbortController();
    state.personaAbortController = controller;
    state.personaStatus = 'composing';
    renderPersona();
    try {
      // AIは保存済みの読み取りコンテキストを読むので、先に画面の内容を保存します。
      await flushComments();
      const result = await api.composeAiPersona({ path: documentPath, input }, { signal: controller.signal });
      if (state.currentPath !== documentPath) return;
      state.persona = result.persona;
      state.personaStatus = 'ready';
      personaInputTouched = false;
      // 組み直した結果はコメントと同じ自動保存でレビューファイルへ入ります。
      onPersonaChanged();
    } catch (error) {
      if (state.currentPath !== documentPath) return;
      state.personaStatus = 'idle';
      if (error.name !== 'AbortError') toaster.error(`読み手ペルソナを組み立てられませんでした: ${error.message}`);
    } finally {
      if (state.personaAbortController === controller) state.personaAbortController = null;
      renderPersona();
      syncRunState();
    }
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
    refs.personaComposeButton.disabled = composing || refs.personaInput.value.trim() === '';
    refs.personaComposeButton.textContent = state.persona ? 'AIで組み直す' : 'AIで組み立てる';
    refs.personaStopButton.classList.toggle('hidden', !composing);
    refs.personaClearButton.disabled = composing || !state.persona;
    refs.personaState.textContent = state.persona ? '設定済み' : '未設定';
    refs.personaState.dataset.state = state.persona ? 'set' : 'unset';
    refs.personaResult.innerHTML = composing
      ? '<p class="ai-loading">読み手ペルソナを組み立て中…</p>'
      : personaHtml(state.persona);
  }

  /* ---------------------------------------------------------------- *
   * レビューの実行
   * ---------------------------------------------------------------- */

  async function runReview() {
    if (!state.currentPath || state.reviewAbortController) return;
    const skillId = state.reviewSkillId;
    if (!skillId) return;

    state.review = { status: 'loading' };
    proposals.render();
    if (!(await prepareAi())) {
      state.review = { status: 'error', error: state.aiStatus?.error || 'Codexを利用できません' };
      proposals.render();
      return;
    }

    const documentPath = state.currentPath;
    const controller = new AbortController();
    state.reviewAbortController = controller;
    setReviewing(true);
    try {
      // ペルソナと読み取りコンテキストは保存済みのものを読むので、先に保存します。
      await flushComments();
      const result = await api.reviewWithAi({ path: documentPath, skillId }, { signal: controller.signal });
      if (state.currentPath !== documentPath) return;
      state.review = {
        status: 'ready',
        summary: result.summary || '',
        // 採用したコメントには、どのスキルがどう判断した指摘かを残します。
        placements: (result.placements || []).map((placement) => ({
          ...placement,
          source: 'ai-review',
          review: {
            skillId: result.skill?.id || skillId,
            skillName: result.skill?.name || '',
            persona: result.persona?.label || '',
            severity: placement.severity || '',
            reason: placement.reason || ''
          }
        })),
        unplaced: result.unplaced || [],
        unplacedTitle: '箇所に結び付かない指摘',
        droppedPlacements: result.droppedPlacements || 0
      };
    } catch (error) {
      if (state.currentPath !== documentPath) return;
      state.review = error.name === 'AbortError' ? null : { status: 'error', error: error.message };
    } finally {
      if (state.reviewAbortController === controller) state.reviewAbortController = null;
      setReviewing(false);
      proposals.render();
    }
  }

  function setReviewing(reviewing) {
    refs.reviewSkillSelect.disabled = reviewing;
    refs.reviewStopButton.classList.toggle('hidden', !reviewing);
    syncRunState();
  }

  function renderSkills() {
    const skills = state.reviewSkills;
    refs.reviewSkillSelect.innerHTML = skills.length === 0
      ? '<option value="">レビュースキルがありません</option>'
      : skills.map((skill) => (
        `<option value="${escapeHtml(skill.id)}">${escapeHtml(skill.name)}${skill.source === 'builtin' ? '（標準）' : ''}</option>`
      )).join('');
    refs.reviewSkillSelect.value = state.reviewSkillId || '';
    renderSkillDescription();
  }

  function renderSkillDescription() {
    const skill = state.reviewSkills.find((entry) => entry.id === state.reviewSkillId);
    refs.reviewSkillDescription.textContent = skill?.description
      || (state.reviewSkills.length === 0
        ? '.claude/skills/<name>/SKILL.md を置くと、そのスキルもここから選べます。'
        : '');
  }

  function syncRunState() {
    refs.reviewRunButton.disabled = Boolean(state.reviewAbortController)
      || Boolean(state.personaAbortController)
      || !state.reviewSkillId;
  }

  function bindEvents() {
    refs.reviewSkillSelect.addEventListener('change', () => selectSkill(refs.reviewSkillSelect.value));
    refs.personaInput.addEventListener('input', () => {
      personaInputTouched = true;
      renderPersona();
    });
    refs.personaForm.addEventListener('submit', (event) => {
      event.preventDefault();
      composePersona();
    });
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

function personaHtml(persona) {
  if (!persona) {
    return '<p class="muted">読み手を書いて「AIで組み立てる」を押すと、AIが立場・前提知識・目的へ組み直します。</p>';
  }
  const fields = PERSONA_FIELDS.map(([key, label]) => {
    const value = persona[key];
    const text = Array.isArray(value) ? value.join(' / ') : value;
    return text ? `<div class="persona-field"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>` : '';
  }).join('');
  return `
    <article class="persona-card">
      <header>
        <h3>${escapeHtml(persona.label || '読み手')}</h3>
        ${persona.summary ? `<p class="persona-summary">${escapeHtml(persona.summary)}</p>` : ''}
      </header>
      <dl>${fields}</dl>
      ${assumptionsHtml(persona.assumptions)}
    </article>`;
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
