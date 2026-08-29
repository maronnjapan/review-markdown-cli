import { ancestorDirsOf, directoryPathsOf, renderFileTree } from './fileTree.js';
import { escapeHtml } from './util.js';

const STORAGE_PREFIX = 'review-markdown:open-dirs:';

/**
 * The file list. Directories start collapsed, so the first thing a reviewer
 * sees is the shape of the project rather than every file in it. Which folders
 * they opened is remembered for the session, and the folders leading to the
 * file they just reviewed are reopened for them.
 */
export function createFileListView({ refs, state, api }) {
  const storage = sessionStorageOf(refs.fileView);
  let pendingReveal = null;

  async function show() {
    refs.reviewView.classList.add('hidden');
    refs.fileView.classList.remove('hidden');
    refs.fileView.innerHTML = '<p class="muted">Markdown / PDFファイルを読み込み中...</p>';

    try {
      const data = await api.listFiles();
      state.rootDir = data.rootDir;
      state.files = data.files;
      state.filters = data.filters || { include: [], exclude: [] };
      state.openDirs = loadOpenDirs(data.rootDir);
      if (pendingReveal) {
        ancestorDirsOf(pendingReveal).forEach((dir) => state.openDirs.add(dir));
        pendingReveal = null;
        saveOpenDirs();
      }
      refs.fileView.innerHTML = viewHtml(data, state.openDirs);
      bindTreeEvents();
    } catch (error) {
      refs.fileView.innerHTML = `<p class="load-error">ファイル一覧を読み込めませんでした: ${escapeHtml(error.message)}</p>`;
    }
  }

  /** Asks the next render to keep the trail to this file open. */
  function revealPath(filePath) {
    if (filePath) pendingReveal = filePath;
  }

  function bindTreeEvents() {
    refs.fileView.querySelectorAll('details.tree-dir').forEach((details) => {
      details.addEventListener('toggle', () => {
        if (details.open) state.openDirs.add(details.dataset.dirPath);
        else state.openDirs.delete(details.dataset.dirPath);
        saveOpenDirs();
      });
    });

    refs.fileView.querySelectorAll('[data-tree-action]').forEach((button) => {
      button.addEventListener('click', () => setAllOpen(button.dataset.treeAction === 'expand'));
    });
  }

  function setAllOpen(open) {
    state.openDirs = open ? new Set(directoryPathsOf(state.files)) : new Set();
    refs.fileView.querySelectorAll('details.tree-dir').forEach((details) => { details.open = open; });
    saveOpenDirs();
  }

  function loadOpenDirs(rootDir) {
    try {
      const stored = storage?.getItem(STORAGE_PREFIX + rootDir);
      return new Set(stored ? JSON.parse(stored) : []);
    } catch {
      return new Set();
    }
  }

  function saveOpenDirs() {
    try {
      storage?.setItem(STORAGE_PREFIX + state.rootDir, JSON.stringify([...state.openDirs]));
    } catch {
      // Private browsing or a full quota: remembering folders is optional.
    }
  }

  return { show, revealPath };
}

function viewHtml(data, openDirs) {
  return `
    <div class="file-list-header">
      <div>
        <p class="eyebrow">Target directory</p>
        <h2>${escapeHtml(data.rootDir)}</h2>
        ${filtersHtml(data.filters)}
      </div>
      <div class="file-list-actions">
        <span class="file-count">${data.files.length} files</span>
        <button type="button" data-tree-action="expand">すべて展開</button>
        <button type="button" data-tree-action="collapse">すべて閉じる</button>
      </div>
    </div>
    <div class="file-tree">${renderFileTree(data.files, { openDirs })}</div>`;
}

function filtersHtml(filters) {
  const chips = [
    ...(filters?.include || []).map((pattern) => ({ label: 'include', pattern })),
    ...(filters?.exclude || []).map((pattern) => ({ label: 'exclude', pattern }))
  ];
  if (chips.length === 0) return '';
  return `<p class="filter-chips">${chips.map(({ label, pattern }) => (
    `<span class="filter-chip filter-chip-${label}">${label}: ${escapeHtml(pattern)}</span>`
  )).join('')}</p>`;
}

function sessionStorageOf(element) {
  try {
    return element?.ownerDocument?.defaultView?.sessionStorage || null;
  } catch {
    return null;
  }
}
