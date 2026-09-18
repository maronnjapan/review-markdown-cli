/**
 * ⌘K で開く検索です。ページと保存した判断を、意味で引きます（`POST /search`）。
 *
 * 結果の先頭には「この語について資料に聞く」を、末尾には「この題名でページを作る」を置きます。
 * 探して無ければ書く、が1つの入力欄で済むようにするためです。
 */

import { debounce, el, escapeHtml, untitled } from './util.js';

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.api
 * @param {Function} options.getWorkspaceId
 * @param {Function} options.onOpenPage `(pageId)`
 * @param {Function} options.onOpenContexts `(contextId)`
 * @param {Function} options.onAsk `(question)`
 * @param {Function} options.onCreatePage `(title)`
 * @param {Function} options.onError `(message)`
 */
export function createPalette({ root, api, getWorkspaceId, onOpenPage, onOpenContexts, onAsk, onCreatePage, onError }) {
  let open = false;
  let entries = [];
  let active = 0;
  let requestSeq = 0;

  root.className = 'palette hidden';
  root.innerHTML = `
    <div class="palette-backdrop" data-close></div>
    <div class="palette-box" role="dialog" aria-modal="true" aria-label="検索">
      <div class="palette-input-row">
        <span class="palette-glyph">⌕</span>
        <input class="palette-input" type="search" placeholder="ページと判断を意味で探す" autocomplete="off" aria-label="検索語">
        <label class="palette-scope"><input type="checkbox" class="palette-all"> すべてのWorkspace</label>
      </div>
      <div class="palette-results" role="listbox"></div>
      <div class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> 選ぶ <kbd>Enter</kbd> 開く <kbd>Esc</kbd> 閉じる</div>
    </div>`;
  const input = root.querySelector('.palette-input');
  const allBox = root.querySelector('.palette-all');
  const results = root.querySelector('.palette-results');

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) close();
    const item = event.target.closest('[data-entry]');
    if (item) choose(Number(item.dataset.entry));
  });
  input.addEventListener('input', () => search());
  allBox.addEventListener('change', () => search.flush() || search());
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!entries.length) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  const search = debounce(async () => {
    const query = input.value.trim();
    const seq = ++requestSeq;
    if (!query) {
      entries = [];
      paint();
      return;
    }
    const base = [{ kind: 'ask', label: `「${query}」について資料に聞く`, hint: '保存した判断とページを根拠に答えます' }];
    try {
      const found = await api.search({
        query,
        sources: ['context', 'page'],
        limit: 10,
        ...(allBox.checked ? { all_workspaces: true } : { workspace_id: getWorkspaceId() || undefined })
      });
      if (seq !== requestSeq) return;
      entries = [
        ...base,
        ...found.map((result) => ({ kind: result.type, result })),
        { kind: 'create', label: `「${query}」というページを作る`, hint: '今のWorkspaceに新しいページを作ります', title: query }
      ];
    } catch (error) {
      if (seq !== requestSeq) return;
      onError(error.message);
      entries = base;
    }
    active = entries.length > 1 ? 1 : 0;
    paint();
  }, 160);

  function paint() {
    if (!entries.length) {
      results.innerHTML = input.value.trim()
        ? '<p class="palette-empty">探しています…</p>'
        : '<p class="palette-empty">ページの題名や本文、保存した判断の言葉を入れてください。言い換えでも引けます。</p>';
      return;
    }
    results.innerHTML = entries.map((entry, index) => entryHtml(entry, index, index === active)).join('');
    results.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function entryHtml(entry, index, isActive) {
    const classes = `palette-entry${isActive ? ' active' : ''}`;
    if (entry.kind === 'ask' || entry.kind === 'create') {
      return `<button type="button" class="${classes} palette-action" data-entry="${index}" role="option" aria-selected="${isActive}">`
        + `<span class="palette-icon">${entry.kind === 'ask' ? '✦' : '＋'}</span>`
        + `<span class="palette-text"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.hint)}</small></span></button>`;
    }
    const { result } = entry;
    if (entry.kind === 'page') {
      const trail = (result.breadcrumb || []).slice(0, -1).map((step) => untitled(step.title)).join(' › ');
      const where = [trail, result.heading].filter(Boolean).join(' › ');
      return `<button type="button" class="${classes}" data-entry="${index}" role="option" aria-selected="${isActive}">`
        + '<span class="palette-icon">▤</span>'
        + `<span class="palette-text"><strong>${escapeHtml(untitled(result.title))}</strong>`
        + `${where ? `<span class="palette-where">${escapeHtml(where)}</span>` : ''}`
        + `<small>${escapeHtml(result.snippet || '')}</small></span>`
        + `<span class="palette-score">${result.score.toFixed(2)}</span></button>`;
    }
    const kind = { decision: '決定', preference: '作法', note: '知識' }[result.kind] || '知識';
    return `<button type="button" class="${classes}" data-entry="${index}" role="option" aria-selected="${isActive}">`
      + '<span class="palette-icon">📌</span>'
      + `<span class="palette-text"><strong>保存した判断 · ${escapeHtml(kind)}</strong><small>${escapeHtml(result.content)}</small></span>`
      + `<span class="palette-score">${result.score.toFixed(2)}</span></button>`;
  }

  function choose(index) {
    const entry = entries[index];
    if (!entry) return;
    const query = input.value.trim();
    close();
    if (entry.kind === 'ask') onAsk(query);
    else if (entry.kind === 'create') onCreatePage(entry.title);
    else if (entry.kind === 'page') onOpenPage(entry.result.page_id, entry.result.workspace_id);
    else onOpenContexts(entry.result.context_id, entry.result.workspace_id);
  }

  function show(initialQuery = '') {
    open = true;
    root.classList.remove('hidden');
    input.value = initialQuery;
    entries = [];
    active = 0;
    paint();
    input.focus();
    input.select();
    if (initialQuery) search();
  }

  function close() {
    if (!open) return;
    open = false;
    requestSeq += 1;
    search.cancel();
    root.classList.add('hidden');
  }

  return {
    open: show,
    close,
    isOpen: () => open,
    toggle: (initialQuery) => (open ? close() : show(initialQuery))
  };
}
