import { escapeHtml } from './util.js';

/** Groups `docs/guide/intro.md` style paths into a nested directory tree. */
export function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ name: parts.at(-1), path: file });
  }
  return root;
}

export function directoryPathsOf(files) {
  const dirs = new Set();
  for (const file of files) {
    const parts = file.split('/').slice(0, -1);
    parts.reduce((prefix, part) => {
      const dirPath = prefix ? `${prefix}/${part}` : part;
      dirs.add(dirPath);
      return dirPath;
    }, '');
  }
  return [...dirs];
}

/** Every directory on the way down to a file, closest ancestor last. */
export function ancestorDirsOf(filePath) {
  const parts = String(filePath || '').split('/').slice(0, -1);
  const dirs = [];
  parts.reduce((prefix, part) => {
    const dirPath = prefix ? `${prefix}/${part}` : part;
    dirs.push(dirPath);
    return dirPath;
  }, '');
  return dirs;
}

/**
 * Directories render closed unless `openDirs` says otherwise: a large book
 * repository should open as a short list of top level folders, not a wall of
 * every draft it contains.
 */
export function renderFileTree(files, { openDirs = new Set() } = {}) {
  if (files.length === 0) return '<p class="muted tree-empty">Markdown / PDFファイルが見つかりません。</p>';
  return renderNode(buildFileTree(files), 0, '', openDirs);
}

function renderNode(node, depth, prefix, openDirs) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  let html = '';

  for (const [name, child] of dirs) {
    const dirPath = prefix ? `${prefix}/${name}` : name;
    html += `
      <details class="tree-dir" data-dir-path="${escapeHtml(dirPath)}"${openDirs.has(dirPath) ? ' open' : ''}>
        <summary class="tree-row" style="--depth:${depth}">
          <span class="tree-chevron" aria-hidden="true"></span>
          <span class="tree-icon tree-icon-dir" aria-hidden="true"></span>
          <span class="tree-label">${escapeHtml(name)}</span>
          <span class="tree-count">${countFiles(child)}</span>
        </summary>
        <div class="tree-children">${renderNode(child, depth + 1, dirPath, openDirs)}</div>
      </details>`;
  }

  for (const file of files) {
    html += fileRowHtml(file, depth);
  }
  return html;
}

/**
 * 1ファイルの行。開くリンクと、そのファイルを操作するボタンを並べます。
 *
 * ボタンはリンクの外に出します。`<a>` の中にボタンは置けないうえ、置けたとしても
 * 「名前を変えるつもりで文書を開く」が起きるからです。行ごと入れ替えて名前を変える欄や
 * 削除の確認に差し替えるので、入れ物（`.tree-file-row`）にファイルのパスを持たせます。
 */
function fileRowHtml(file, depth) {
  return `
      <div class="tree-file-row" style="--depth:${depth}" data-file-path="${escapeHtml(file.path)}">
        ${fileRowContentsHtml(file.path)}
      </div>`;
}

/**
 * 行の中身。名前を変える欄や削除の確認へ差し替えたあと、元へ戻すのにも使うので
 * （`fileListView.js`）、行そのものとは分けてあります。
 */
export function fileRowContentsHtml(filePath) {
  const name = String(filePath || '').split('/').at(-1);
  const pdf = /\.pdf$/i.test(name);
  const escaped = escapeHtml(filePath);
  return `
        <a class="tree-row tree-file${pdf ? ' tree-file-pdf' : ''}" href="#/review/${encodeURIComponent(filePath)}">
          <span class="tree-icon tree-icon-file${pdf ? ' tree-icon-pdf' : ''}" aria-hidden="true"></span>
          <span class="tree-label">${escapeHtml(name)}</span>
        </a>
        <span class="tree-file-actions">
          <button type="button" class="tree-file-action" data-file-action="rename"
            aria-label="${escaped} の名前を変える">名前</button>
          <button type="button" class="tree-file-action tree-file-delete" data-file-action="delete"
            aria-label="${escaped} を削除する">削除</button>
        </span>`;
}

function countFiles(node) {
  return node.files.length + [...node.dirs.values()].reduce((total, child) => total + countFiles(child), 0);
}
