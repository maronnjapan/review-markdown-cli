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
    const pdf = /\.pdf$/i.test(file.name);
    html += `
      <a class="tree-row tree-file${pdf ? ' tree-file-pdf' : ''}" style="--depth:${depth}" href="#/review/${encodeURIComponent(file.path)}">
        <span class="tree-icon tree-icon-file${pdf ? ' tree-icon-pdf' : ''}" aria-hidden="true"></span>
        <span class="tree-label">${escapeHtml(file.name)}</span>
      </a>`;
  }
  return html;
}

function countFiles(node) {
  return node.files.length + [...node.dirs.values()].reduce((total, child) => total + countFiles(child), 0);
}
