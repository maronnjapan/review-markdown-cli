const PANES = {
  outline: { panel: 'outlinePanel', tab: 'outlineTabButton' },
  comments: { panel: 'commentsPanel', tab: 'commentsTabButton' },
  memos: { panel: 'memosPanel', tab: 'memosTabButton' },
  ai: { panel: 'aiPanel', tab: 'aiTabButton' }
};

/**
 * The tabs of the right-hand pane. Controllers switch panes through this rather
 * than each toggling the others' elements.
 *
 * ここに残すのは、本文の位置に紐づくものだけです（目次・コメント・メモ・その場の相談）。
 * 腰を据えて読み書きするものは、細長い欄へ押し込まず、それぞれの画面へ出します
 * （`toolPages.js`）。
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
      refs[tab].tabIndex = active ? 0 : -1;
    }
  }

  function bind() {
    for (const [pane, { tab }] of Object.entries(PANES)) {
      refs[tab].addEventListener('click', () => show(pane));
    }
    refs.sidePane.querySelector('.side-pane-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = Object.values(PANES)
        .map(({ tab }) => refs[tab])
        .filter((tab) => !tab.classList.contains('hidden'));
      const currentIndex = Math.max(0, tabs.indexOf(event.target));
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      tabs[nextIndex].click();
      tabs[nextIndex].focus();
    });
  }

  return { show, bind };
}
