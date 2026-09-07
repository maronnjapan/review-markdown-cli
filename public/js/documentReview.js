import { runAiRequest } from './aiRequest.js';
import { missingBriefFields } from './documentBrief.js';
import { createProposalList } from './proposalList.js';
import { escapeHtml } from './util.js';

/** サーバー側の上限と同じです。超えて選ぶと実行時に断られます。 */
const MAX_SELECTED_SKILLS = 5;

const EMPTY_HTML = '<p class="muted">レビュースキルを選んで「レビューを実行」を押すと、AIがそのスキルの観点でコメント候補を作ります。</p>';

/**
 * AIレビューのパネル。
 *
 * レビュアーが決めるのは2つだけです。どの観点で読むか（レビュースキル）と、
 * 誰として読むか（読み手ペルソナ）。
 *
 * スキルは複数選べます。何を見るスキルなのかは、選ぶ前に「詳細」でその場に開けます。
 * 別のエディタで SKILL.md を探しに行かずに済ませるためです。
 *
 * 読み手を決める欄そのものは `persona.js` にあります。読み手だけを開く画面
 * （`#/persona/<path>`）にも同じ欄があり、どちらで決めても同じ1組の state です。
 * ここに欄を残してあるのは、読み手がレビューを実行する直前に決まるものだからです。
 *
 * レビューは2周します。指摘を出す1周目と、その指摘をAI自身に反証させる2周目です。
 * どちらを読んでいるかは待ちの表示に出し、2周目で何件落ちたかは結果の先頭に出します。
 * どれだけ絞り込まれた指摘なのかが分からないと、レビュアーは結局全部読み直すからです。
 *
 * レビュー結果は「指摘の配置」と同じコメント候補で、追加するまで保存しません。
 *
 * ── 資料の管理者の関門 ─────────────────────────────────
 * 目的・ストーリー・期待値が揃っていない文書では、実行を1度止めます。3点はレビューの
 * 判断基準そのもので、無いままのレビューは「一般に良い文章か」を見る読みにしかなりません。
 * 止め続けはしません。押し直せば実行します。関門は「決めないまま進んでいることに
 * 気づかせる」ためのもので、レビュアーの判断より上に置くものではないからです。
 */
export function createDocumentReviewController({
  refs, state, api, toaster, prepareAi, flushComments = async () => true,
  onAddComments, onRevealTarget
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

  // 管理者の関門で1度止めたかどうか。止めるのは文書ごとに1回だけです。
  let briefWarned = false;

  bindEvents();

  /** 文書を開いたときの初期化。スキル一覧は最初の1回だけ取りに行きます。 */
  function load() {
    briefWarned = false;
    state.review = null;
    renderSkills();
    proposals.render();
    syncRunState();
    if (state.reviewSkills.length === 0) loadSkills();
  }

  /** 読み手や3点が決まり直したときに、実行できるかどうかを見直します。 */
  function refresh() {
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

  async function editSkill(existing = null) {
    const window = refs.reviewPanel.ownerDocument.defaultView;
    let detail = existing ? state.reviewSkillDetails.get(existing.id) : null;
    if (existing && !detail) detail = (await api.readReviewSkill(existing.id)).skill;
    const id = window.prompt('スキルID（英数字・ハイフン）', existing?.id || 'my-skill');
    if (!id) return;
    const name = window.prompt('スキル名', existing?.name || '');
    if (!name) return;
    const description = window.prompt('説明', existing?.description || '') ?? '';
    const instructions = window.prompt('AIへの手順（Markdown）', detail?.instructions || '');
    if (!instructions) return;
    try {
      await api.saveReviewSkill({ id, name, description, instructions });
      state.reviewSkills = [];
      state.reviewSkillDetails.delete(id);
      await loadSkills();
      toaster.success('スキルを保存しました。');
    } catch (error) { toaster.error(`スキルを保存できませんでした: ${error.message}`); }
  }

  async function deleteSelectedSkill() {
    const skill = state.reviewSkills.find((entry) => entry.id === state.reviewSkillIds[0]);
    const window = refs.reviewPanel.ownerDocument.defaultView;
    if (!skill || !window.confirm(`「${skill.name}」を削除しますか？`)) return;
    try {
      await api.deleteReviewSkill(skill.id);
      state.reviewSkillIds = state.reviewSkillIds.filter((id) => id !== skill.id);
      state.reviewSkills = [];
      await loadSkills();
      toaster.info('スキルを削除しました。');
    } catch (error) { toaster.error(`スキルを削除できませんでした: ${error.message}`); }
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
   * レビューの実行
   * ---------------------------------------------------------------- */

  async function runReview() {
    const skillIds = [...state.reviewSkillIds];
    if (skillIds.length === 0) return;
    // 管理者が3点を求めている間は、1度目の実行を止めます。押し直せば実行します。
    const missing = state.features.manager ? missingBriefFields(state.brief) : [];
    if (missing.length > 0 && !briefWarned) {
      briefWarned = true;
      syncRunState();
      toaster.info(`資料の管理者が${fieldNames(missing)}を求めています。`
        + '「管理者」の画面で決めるか、もう一度押すとこのまま実行します。');
      return;
    }
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
      || state.documentType === 'pdf'
      || state.reviewSkillIds.length === 0;
    // 何が足りないかは、押す前に見えている必要があります。押してから初めて止められると、
    // 待たされたうえに引き返させられたようにしか見えません。
    const missing = state.features.manager ? missingBriefFields(state.brief) : [];
    // 揃った時点で関門は閉じ直します。あとで3点を消したのなら、それはもう一度
    // 気づくべき変化で、一度通したことを理由に黙って通すものではありません。
    if (missing.length === 0) briefWarned = false;
    refs.reviewBriefHint.hidden = missing.length === 0;
    refs.reviewBriefHint.textContent = missing.length === 0 ? '' : briefHint(missing);
    refs.reviewRunButton.textContent = missing.length > 0 && briefWarned
      ? 'それでも実行する'
      : 'レビューを実行';
  }

  function briefHint(missing) {
    return briefWarned
      ? `${fieldNames(missing)}は決まっていないままです。このまま実行すると、その3点を基準にしない読みになります。`
      : `資料の管理者が${fieldNames(missing)}を求めています。「管理者」の画面で決めてから実行してください。`;
  }

  function bindEvents() {
    refs.reviewSkillAdd.addEventListener('click', () => editSkill());
    refs.reviewSkillEdit.addEventListener('click', () => {
      const skill = state.reviewSkills.find((entry) => entry.id === state.reviewSkillIds[0]);
      if (skill) editSkill(skill);
    });
    refs.reviewSkillDelete.addEventListener('click', deleteSelectedSkill);
    refs.reviewSkillList.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-skill-id]');
      if (input) toggleSkill(input.dataset.skillId, input.checked);
    });
    refs.reviewSkillList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-skill-detail]');
      if (button) toggleSkillDetail(button.dataset.skillDetail);
    });
    refs.reviewForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runReview();
    });
    refs.reviewStopButton.addEventListener('click', () => state.reviewAbortController?.abort());
  }

  return { load, refresh };
}

function fieldNames(missing) {
  return missing.map(({ label }) => label).join('・');
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
