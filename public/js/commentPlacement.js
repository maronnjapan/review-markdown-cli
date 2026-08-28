import { runAiRequest } from './aiRequest.js';
import { createProposalList } from './proposalList.js';

const EMPTY_HTML = '<p class="muted">指摘コメントを貼り付けて「対象箇所を探す」を押すと、AIが対象箇所ごとのコメント候補を作ります。</p>';
const LOADING_HTML = '<p class="ai-loading">対象箇所を探しています…</p>';

/**
 * "Here is my review note, put it where it belongs." The AI only proposes:
 * nothing reaches the review file until the reviewer adds a proposal, so a
 * mislocated note costs one click to drop rather than an edit to undo.
 */
export function createCommentPlacementController({
  refs, state, api, toaster, prepareAi, flushComments = async () => true, onAddComments, onRevealTarget
}) {
  const proposals = createProposalList({
    container: refs.placementResults,
    state,
    toaster,
    onAddComments,
    onRevealTarget,
    emptyHtml: EMPTY_HTML,
    loadingHtml: LOADING_HTML,
    errorPrefix: '対象箇所を特定できませんでした',
    read: (current) => current.placement
  });

  bindEvents();

  /** Notes written about one document must not follow the reviewer to the next. */
  function reset() {
    refs.placementInput.value = '';
    setSearching(false);
    proposals.render();
  }

  async function findTargets() {
    const notes = refs.placementInput.value.trim();
    if (!notes) return;
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'placementAbortController',
      onStart() {
        state.placement = { status: 'loading' };
        proposals.render();
      },
      // 入力欄を止めるのはCodexが起動できてからです。起動できなかったときに
      // 止めたままにすると、やり直す手立てが画面から消えます。
      onPrepared: () => setSearching(true),
      run: ({ documentPath, signal }) => (
        api.placeAiComments({ path: documentPath, notes }, { signal })
      ),
      onResult(result) {
        state.placement = {
          status: 'ready',
          placements: result.placements || [],
          unplaced: result.unplaced || [],
          droppedPlacements: result.droppedPlacements || 0
        };
      },
      onUnavailable(error) {
        state.placement = { status: 'error', error };
        proposals.render();
      },
      // 中断は失敗ではないので、何も残さず元の空の状態へ戻します。
      onAbort: () => { state.placement = null; },
      onError: (error) => { state.placement = { status: 'error', error: error.message }; },
      onSettled() {
        setSearching(false);
        proposals.render();
      }
    });
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
