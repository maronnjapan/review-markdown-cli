const PANES = {
  comments: { panel: 'commentsPanel', tab: 'commentsTabButton' },
  manager: { panel: 'managerPanel', tab: 'managerTabButton' },
  ai: { panel: 'aiPanel', tab: 'aiTabButton' },
  placement: { panel: 'placementPanel', tab: 'placementTabButton' },
  review: { panel: 'reviewPanel', tab: 'reviewTabButton' },
  revise: { panel: 'revisePanel', tab: 'reviseTabButton' }
};

/**
 * The tabs of the right-hand pane. Controllers switch panes through this rather
 * than each toggling the others' elements.
 */
export function createSidePanes({ refs, state }) {
  function show(name) {
    const requested = PANES[name];
    state.sidePane = requested && !refs[requested.tab].classList.contains('hidden') ? name : 'comments';
    for (const [pane, { panel, tab }] of Object.entries(PANES)) {
      const active = pane === state.sidePane;
      refs[panel].classList.toggle('hidden', !active);
      refs[tab].classList.toggle('active', active);
      refs[tab].setAttribute('aria-selected', String(active));
    }
  }

  function bind() {
    for (const [pane, { tab }] of Object.entries(PANES)) {
      refs[tab].addEventListener('click', () => show(pane));
    }
  }

  return { show, bind };
}
