import { ancestorDirsOf, directoryPathsOf, fileRowContentsHtml, renderFileTree } from './fileTree.js';
import { escapeHtml } from './util.js';

const STORAGE_PREFIX = 'review-markdown:open-dirs:';

/**
 * The file list. Directories start collapsed, so the first thing a reviewer
 * sees is the shape of the project rather than every file in it. Which folders
 * they opened is remembered for the session, and the folders leading to the
 * file they just reviewed are reopened for them.
 *
 * ファイルを作る・名前を変える・消すのもこの画面です。原稿の置き場所を直したいときに
 * 端末へ戻らせないためで、どの操作も一覧を出したまま、その行の中で終わります。
 * 名前を変える欄も削除の確認も、別の画面やダイアログではなく行そのものを差し替えます。
 */
export function createFileListView({ refs, state, api, toaster = null }) {
  const storage = sessionStorageOf(refs.fileView);
  let pendingReveal = null;
  // 送っている間は次の操作を受けません。二度押しで同じファイルを2回消しにいくと、
  // 2回目は「見つかりません」で失敗し、消えたのが自分の操作かどうかが分からなくなります。
  let working = false;

  // ファイルの操作は行ごと差し替えるので、行に付けずに一覧で受けます。差し替えた欄の
  // ボタンにも、付け直さずにそのまま届きます。描き直しのたびに付け足さないよう、
  // 中身ではなく入れ物へ1度だけ付けます。
  refs.fileView.addEventListener('click', onFileActionClick);
  refs.fileView.addEventListener('submit', onFileFormSubmit);

  async function show() {
    refs.reviewView.classList.add('hidden');
    refs.fileView.classList.remove('hidden');
    refs.fileView.innerHTML = '<p class="muted">Markdown / PDFファイルを読み込み中...</p>';

    try {
      const data = await api.listFiles();
      state.openDirs = loadOpenDirs(data.rootDir);
      render(data, pendingReveal);
      pendingReveal = null;
    } catch (error) {
      refs.fileView.innerHTML = `<p class="load-error">ファイル一覧を読み込めませんでした: ${escapeHtml(error.message)}</p>`;
    }
  }

  /** Asks the next render to keep the trail to this file open. */
  function revealPath(filePath) {
    if (filePath) pendingReveal = filePath;
  }

  /**
   * 一覧を描き直します。`reveal` を渡すと、そのファイルまでのディレクトリを開きます。
   * 作った直後・名前を変えた直後のファイルが、閉じたフォルダの中に隠れないためです。
   */
  function render(data, reveal = null) {
    state.rootDir = data.rootDir;
    state.files = data.files;
    state.filters = data.filters || { include: [], exclude: [] };
    if (reveal) {
      ancestorDirsOf(reveal).forEach((dir) => state.openDirs.add(dir));
      saveOpenDirs();
    }
    refs.fileView.innerHTML = viewHtml(data, state.openDirs);
    bindTreeEvents();
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

  function onFileActionClick(event) {
    const button = event.target.closest('[data-file-action]');
    if (!button) return;
    const row = button.closest('[data-file-path]');
    const filePath = row?.dataset.filePath || '';
    const actions = {
      new: () => openCreateForm(),
      rename: () => replaceRow(row, renameFormHtml(filePath)),
      delete: () => replaceRow(row, deleteConfirmHtml(filePath)),
      'delete-confirm': () => deleteFile(filePath),
      cancel: () => closeForms()
    };
    const action = actions[button.dataset.fileAction];
    if (!action) return;
    event.preventDefault();
    action();
  }

  function onFileFormSubmit(event) {
    const form = event.target.closest('[data-file-form]');
    if (!form) return;
    event.preventDefault();
    const value = form.querySelector('input[name="path"]')?.value || '';
    if (form.dataset.fileForm === 'create') return createFile(value);
    return renameFile(form.closest('[data-file-path]')?.dataset.filePath || '', value);
  }

  function openCreateForm() {
    const form = refs.fileView.querySelector('[data-file-form="create"]');
    if (!form) return;
    // 開いている欄は畳みます。名前を変える欄と作る欄が並んでいると、どちらに書いているのかを
    // 見失います。
    closeForms();
    form.classList.remove('hidden');
    const input = form.querySelector('input[name="path"]');
    input.focus();
  }

  /** 行の中身を、名前を変える欄や削除の確認へ差し替えます。 */
  function replaceRow(row, html) {
    if (!row) return;
    closeForms();
    row.innerHTML = html;
    const input = row.querySelector('input[name="path"]');
    if (input) {
      input.focus();
      // 拡張子とディレクトリはそのまま使うことが多いので、選ぶのはファイル名の部分だけです。
      input.setSelectionRange(...nameRange(input.value));
    } else {
      row.querySelector('button')?.focus();
    }
  }

  /** 開いたままの欄を畳みます。一覧のどこかで別の操作を始めたときにも呼びます。 */
  function closeForms() {
    refs.fileView.querySelector('[data-file-form="create"]')?.classList.add('hidden');
    refs.fileView.querySelectorAll('.tree-file-row').forEach((row) => {
      if (row.querySelector('[data-file-form="rename"], [data-file-action="delete-confirm"]')) {
        row.innerHTML = fileRowContentsHtml(row.dataset.filePath);
      }
    });
  }

  function createFile(requestedPath) {
    const trimmed = requestedPath.trim();
    if (!trimmed) return;
    return runFileAction(
      () => api.createFile({ path: trimmed }),
      (result) => `${result.path} を作りました`
    );
  }

  function renameFile(filePath, requestedPath) {
    const trimmed = requestedPath.trim();
    if (!filePath || !trimmed || trimmed === filePath) return closeForms();
    return runFileAction(
      () => api.renameFile({ path: filePath, to: trimmed }),
      (result) => `${result.from} を ${result.path} にしました`
    );
  }

  function deleteFile(filePath) {
    if (!filePath) return;
    return runFileAction(
      () => api.deleteFile({ path: filePath }),
      (result) => (result.data?.length
        ? `${result.path} と、そのレビューデータ${result.data.length}件を削除しました`
        : `${result.path} を削除しました`)
    );
  }

  /**
   * 変えたあとの一覧は、返ってきたものをそのまま描きます。取り直しに行かないのは、
   * 行き違いで古い一覧が返ると、消したはずのファイルが残って見えるからです。
   *
   * 失敗したときは描き直しません。書いた名前を残したまま断りだけを出せば、打ち直さずに
   * 直せます。
   */
  async function runFileAction(send, message) {
    if (working) return;
    working = true;
    try {
      const result = await send();
      render(result, result.path);
      toaster?.success(message(result));
    } catch (error) {
      toaster?.error(error.message);
    } finally {
      working = false;
    }
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
        <button type="button" data-file-action="new">新規作成</button>
        <button type="button" data-tree-action="expand">すべて展開</button>
        <button type="button" data-tree-action="collapse">すべて閉じる</button>
      </div>
    </div>
    ${createFormHtml()}
    <div class="file-tree">${renderFileTree(data.files, { openDirs })}</div>`;
}

function createFormHtml() {
  return `
    <form class="file-new-form hidden" data-file-form="create">
      <label class="file-new-label" for="new-file-path">新しいファイルのパス</label>
      <input id="new-file-path" name="path" type="text" autocomplete="off" spellcheck="false"
        placeholder="docs/新しいメモ.md">
      <button type="submit">作成</button>
      <button type="button" data-file-action="cancel">やめる</button>
      <p class="file-form-hint">対象ディレクトリからのパスです。拡張子を省くと <code>.md</code> を付け、途中のディレクトリは作ります。</p>
    </form>`;
}

/**
 * 名前を変える欄。パスをそのまま出すので、書き換えれば別のディレクトリへ移せます。
 * ファイル名だけの欄にすると、移すためだけに端末へ戻ることになります。
 */
function renameFormHtml(filePath) {
  return `
    <form class="tree-file-form" data-file-form="rename">
      <input name="path" type="text" autocomplete="off" spellcheck="false"
        aria-label="${escapeHtml(filePath)} の新しいパス" value="${escapeHtml(filePath)}">
      <button type="submit">変更</button>
      <button type="button" data-file-action="cancel">やめる</button>
      <p class="file-form-hint">パスごと書き換えると、別のディレクトリへ移します。コメントも一緒に移ります。</p>
    </form>`;
}

/**
 * 削除の確認。押し間違いで原稿が消えないよう、コメントの削除と同じ2段階にしています。
 * 本文もレビューデータも取り消せないので、何が消えるかまで書きます。
 */
function deleteConfirmHtml(filePath) {
  return `
    <div class="tree-file-confirm" role="group" aria-label="${escapeHtml(filePath)} の削除">
      <span class="tree-file-confirm-text">${escapeHtml(filePath)} と、そのコメント・メモ・タスクを削除します。取り消せません。</span>
      <button type="button" class="tree-file-delete" data-file-action="delete-confirm">削除する</button>
      <button type="button" data-file-action="cancel">やめる</button>
    </div>`;
}

/** ディレクトリと拡張子を除いた、ファイル名の部分。名前を変える欄で最初に選ぶ範囲です。 */
function nameRange(value) {
  const start = value.lastIndexOf('/') + 1;
  const dot = value.lastIndexOf('.');
  return [start, dot > start ? dot : value.length];
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
