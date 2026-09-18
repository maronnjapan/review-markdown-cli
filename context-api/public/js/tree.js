/**
 * サイドバーのページの木です。開閉、選択、ドラッグでの並べ替えと入れ子を受け持ちます。
 *
 * 木の並びはサーバが決めたもの（親の次に子）をそのまま使い、ここでは描くだけです。
 * 動かしたときの新しい親と並び順は、呼ぶ側（`main.js`）が計算してサーバへ送ります。
 */

import { el, escapeHtml, untitled } from './util.js';

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {Function} options.hrefFor ページidからリンク先を作ります。
 * @param {Function} options.isExpanded ページidが開いているかどうか。
 * @param {Function} options.setExpanded 開閉を覚えます。
 * @param {Function} options.onMenu 「⋯」を押したとき `(pageId, anchorElement)`。
 * @param {Function} options.onAddChild 「＋」を押したとき `(pageId)`。
 * @param {Function} options.onMove ドラッグで落としたとき `(draggedId, { targetId, zone })`。
 */
export function createTree({ root, hrefFor, isExpanded, setExpanded, onMenu, onAddChild, onMove }) {
  let pages = [];
  let activeId = null;
  let dragging = null;

  root.classList.add('page-tree');
  root.addEventListener('click', onClick);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', clearDropMarks);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragend', () => {
    dragging = null;
    clearDropMarks();
    root.querySelector('.dragging')?.classList.remove('dragging');
  });

  function childrenOf(parentId) {
    return pages.filter((page) => page.parent_id === parentId);
  }

  function build(parentId) {
    const elements = [];
    for (const page of childrenOf(parentId)) {
      const children = childrenOf(page.page_id);
      const expanded = children.length > 0 && isExpanded(page.page_id);
      elements.push(itemElement(page, children.length > 0, expanded));
      if (expanded) {
        elements.push(el('div', { class: 'tree-children', dataset: { parent: page.page_id } }, ...build(page.page_id)));
      }
    }
    return elements;
  }

  function itemElement(page, hasChildren, expanded) {
    const title = untitled(page.title);
    const item = el('div', {
      class: `tree-item${page.page_id === activeId ? ' active' : ''}`,
      dataset: { id: page.page_id },
      draggable: 'true',
      style: `--depth:${page.depth}`
    });
    item.innerHTML = `
      <button type="button" class="tree-toggle" data-toggle aria-label="${expanded ? 'たたむ' : '開く'}"${hasChildren ? '' : ' data-leaf'}>${hasChildren ? (expanded ? '▾' : '▸') : '·'}</button>
      <a class="tree-link" href="${escapeHtml(hrefFor(page.page_id))}" title="${escapeHtml(title)}"><span class="tree-title">${escapeHtml(title)}</span></a>
      <span class="tree-actions">
        <button type="button" class="tree-icon" data-add title="サブページを追加" aria-label="サブページを追加">＋</button>
        <button type="button" class="tree-icon" data-menu title="操作" aria-label="ページの操作">⋯</button>
      </span>`;
    return item;
  }

  function onClick(event) {
    const item = event.target.closest('.tree-item');
    if (!item) return;
    const pageId = item.dataset.id;
    if (event.target.closest('[data-toggle]')) {
      event.preventDefault();
      if (event.target.closest('[data-leaf]')) return;
      setExpanded(pageId, !isExpanded(pageId));
      render({ pages, activeId });
      return;
    }
    if (event.target.closest('[data-add]')) {
      event.preventDefault();
      onAddChild(pageId);
      return;
    }
    if (event.target.closest('[data-menu]')) {
      event.preventDefault();
      onMenu(pageId, event.target.closest('[data-menu]'));
    }
  }

  /* ---- ドラッグ ---- */

  function onDragStart(event) {
    const item = event.target.closest('.tree-item');
    if (!item) return;
    dragging = item.dataset.id;
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragging);
  }

  function zoneFor(event, item) {
    const rect = item.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    if (ratio < 0.3) return 'before';
    if (ratio > 0.7) return 'after';
    return 'inside';
  }

  function onDragOver(event) {
    const item = event.target.closest('.tree-item');
    if (!dragging || !item || item.dataset.id === dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    item.classList.add(`drop-${zoneFor(event, item)}`);
  }

  function onDrop(event) {
    const item = event.target.closest('.tree-item');
    const draggedId = dragging || event.dataTransfer.getData('text/plain');
    clearDropMarks();
    if (!item || !draggedId || item.dataset.id === draggedId) return;
    event.preventDefault();
    onMove(draggedId, { targetId: item.dataset.id, zone: zoneFor(event, item) });
  }

  function clearDropMarks() {
    for (const marked of root.querySelectorAll('.drop-before, .drop-after, .drop-inside')) {
      marked.classList.remove('drop-before', 'drop-after', 'drop-inside');
    }
  }

  /* ---- 口 ---- */

  function render(next) {
    pages = next.pages || [];
    activeId = next.activeId ?? null;
    root.replaceChildren(...build(null));
    if (pages.length === 0) {
      root.append(el('p', { class: 'tree-empty', text: 'まだページがありません。' }));
    }
  }

  return {
    render,
    setActive(pageId) {
      activeId = pageId;
      for (const item of root.querySelectorAll('.tree-item')) {
        item.classList.toggle('active', item.dataset.id === pageId);
      }
    },
    updateTitle(pageId, title) {
      const page = pages.find((entry) => entry.page_id === pageId);
      if (page) page.title = title;
      const link = root.querySelector(`.tree-item[data-id="${CSS.escape(pageId)}"] .tree-title`);
      if (link) link.textContent = untitled(title);
    }
  };
}
