import { commentTargetText, labelForType } from './comments.js';
import { escapeHtml } from './util.js';

const CONFIDENCE_LABELS = {
  high: '確度 高',
  medium: '確度 中',
  low: '確度 低'
};

/**
 * "Here is my review note, put it where it belongs." The AI only proposes:
 * nothing reaches the review file until the reviewer adds a proposal, so a
 * mislocated note costs one click to drop rather than an edit to undo.
 */
export function createCommentPlacementController({
  refs, state, api, toaster, prepareAi, flushComments = async () => true, onAddComments, onRevealTarget
}) {
  bindEvents();

  /** Notes written about one document must not follow the reviewer to the next. */
  function reset() {
    refs.placementInput.value = '';
    setSearching(false);
    render();
  }

  async function findTargets() {
    const notes = refs.placementInput.value.trim();
    if (!notes || state.placementAbortController) return;
    if (!state.currentPath) return;

    state.placement = { status: 'loading' };
    render();
    if (!(await prepareAi())) {
      state.placement = { status: 'error', error: state.aiStatus?.error || 'Codexを利用できません' };
      render();
      return;
    }

    const documentPath = state.currentPath;
    const controller = new AbortController();
    state.placementAbortController = controller;
    setSearching(true);
    try {
      // The AI reads the saved reading context, so save what is on screen first.
      await flushComments();
      const result = await api.placeAiComments({ path: documentPath, notes }, { signal: controller.signal });
      if (state.currentPath !== documentPath) return;
      state.placement = {
        status: 'ready',
        placements: result.placements || [],
        unplaced: result.unplaced || [],
        droppedPlacements: result.droppedPlacements || 0
      };
    } catch (error) {
      if (state.currentPath !== documentPath) return;
      state.placement = error.name === 'AbortError'
        ? null
        : { status: 'error', error: error.message };
    } finally {
      if (state.placementAbortController === controller) state.placementAbortController = null;
      setSearching(false);
      render();
    }
  }

  function addPlacement(index) {
    const placement = currentPlacements()[index];
    if (!placement) return;
    state.placement.placements.splice(index, 1);
    onAddComments([commentEntry(placement)]);
    render();
  }

  function addAllPlacements() {
    const placements = currentPlacements();
    if (placements.length === 0) return;
    state.placement.placements = [];
    onAddComments(placements.map(commentEntry));
    render();
  }

  function dismissPlacement(index) {
    if (!currentPlacements()[index]) return;
    state.placement.placements.splice(index, 1);
    render();
  }

  function revealPlacement(index) {
    const placement = currentPlacements()[index];
    if (!placement || onRevealTarget(placement.target)) return;
    toaster.error(state.mode === 'edit'
      ? '編集モードでは対象箇所を表示できません。'
      : '本文から対象箇所を見つけられませんでした。');
  }

  /** The reviewer's edits in the card are what gets saved, not the AI's draft. */
  function editPlacement(index, value) {
    const placement = currentPlacements()[index];
    if (placement) placement.comment = value;
  }

  function commentEntry(placement) {
    return {
      // `source` marks the comment as AI-placed once it is saved in the review file.
      target: { ...placement.target, source: 'ai' },
      comment: placement.comment
    };
  }

  function currentPlacements() {
    return state.placement?.placements || [];
  }

  function setSearching(searching) {
    refs.placementInput.disabled = searching;
    refs.placementStopButton.classList.toggle('hidden', !searching);
    syncSubmitState();
  }

  function syncSubmitState() {
    refs.placementSubmitButton.disabled = Boolean(state.placementAbortController)
      || refs.placementInput.value.trim() === '';
  }

  function render() {
    const actions = {
      add: addPlacement,
      addAll: addAllPlacements,
      dismiss: dismissPlacement,
      reveal: revealPlacement
    };
    refs.placementResults.innerHTML = resultsHtml(state.placement);
    refs.placementResults.querySelectorAll('textarea[data-placement-index]').forEach((textarea) => {
      textarea.addEventListener('input', () => editPlacement(Number(textarea.dataset.placementIndex), textarea.value));
    });
    refs.placementResults.querySelectorAll('[data-placement-action]').forEach((button) => {
      button.addEventListener('click', () => actions[button.dataset.placementAction]?.(Number(button.dataset.index)));
    });
  }

  function bindEvents() {
    refs.placementForm.addEventListener('submit', (event) => {
      event.preventDefault();
      findTargets();
    });
    refs.placementInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      findTargets();
    });
    refs.placementStopButton.addEventListener('click', () => state.placementAbortController?.abort());
    refs.placementInput.addEventListener('input', syncSubmitState);
    syncSubmitState();
  }

  return { reset };
}

function resultsHtml(placement) {
  if (!placement) return '<p class="muted">指摘コメントを貼り付けて「対象箇所を探す」を押すと、AIが対象箇所ごとのコメント候補を作ります。</p>';
  if (placement.status === 'loading') return '<p class="ai-loading">対象箇所を探しています…</p>';
  if (placement.status === 'error') {
    return `<p class="ai-error">対象箇所を特定できませんでした: ${escapeHtml(placement.error)}</p>`;
  }

  const placements = placement.placements || [];
  const unplaced = placement.unplaced || [];
  if (placements.length === 0 && unplaced.length === 0) {
    return '<p class="muted">追加できる候補は残っていません。</p>';
  }
  return [
    placements.length ? summaryHtml(placements.length) : '',
    ...placements.map(cardHtml),
    placement.droppedPlacements > 0
      ? `<p class="placement-note">候補が多いため、${placement.droppedPlacements}件は表示していません。指摘を分けて実行してください。</p>`
      : '',
    unplacedHtml(unplaced)
  ].join('');
}

function summaryHtml(count) {
  return `
    <div class="placement-summary">
      <span>コメント候補 ${count}件</span>
      <button type="button" data-placement-action="addAll">すべて追加</button>
    </div>`;
}

function cardHtml(placement, index) {
  const target = placement.target || {};
  const headingPath = (target.headingPath || []).filter(Boolean).join(' › ');
  return `
    <article class="placement-card" data-index="${index}">
      <div class="placement-card-head">
        <span class="target-badge" data-type="${escapeHtml(target.type || '')}">${escapeHtml(labelForType(target.type))}</span>
        <span class="placement-confidence" data-confidence="${escapeHtml(placement.confidence || 'medium')}">${escapeHtml(CONFIDENCE_LABELS[placement.confidence] || CONFIDENCE_LABELS.medium)}</span>
      </div>
      ${headingPath ? `<p class="placement-path">${escapeHtml(headingPath)}</p>` : ''}
      <blockquote class="placement-quote">${escapeHtml(commentTargetText(target))}</blockquote>
      ${placement.reason ? `<p class="placement-reason">${escapeHtml(placement.reason)}</p>` : ''}
      <textarea data-placement-index="${index}" rows="3">${escapeHtml(placement.comment || '')}</textarea>
      <div class="placement-card-actions">
        <button type="button" data-placement-action="reveal" data-index="${index}">対象を表示</button>
        <button type="button" data-placement-action="add" data-index="${index}">コメントを追加</button>
        <button type="button" data-placement-action="dismiss" data-index="${index}">破棄</button>
      </div>
    </article>`;
}

function unplacedHtml(unplaced) {
  if (unplaced.length === 0) return '';
  return `
    <section class="placement-unplaced">
      <h3>対象箇所を特定できなかった指摘</h3>
      <ul>
        ${unplaced.map((entry) => `<li><strong>${escapeHtml(entry.note)}</strong>${entry.reason ? ` — ${escapeHtml(entry.reason)}` : ''}</li>`).join('')}
      </ul>
    </section>`;
}
