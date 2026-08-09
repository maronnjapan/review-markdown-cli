const state = {
  files: [],
  currentPath: null,
  comments: [],
  pendingTarget: null,
  currentSelectionTarget: null,
  commentsDirty: false,
  commentsVersion: 0,
  commentSaveTimer: null,
  commentSavePromise: null,
  commentSaveQueued: false,
  commentSaveFailed: false,
  mode: 'comment',
  rawHtml: '',
  editableHtml: '',
  markdown: '',
  dirtyBlocks: new Set(),
  blockVersions: new Map(),
  saveTimer: null,
  savePromise: null,
  saveFailed: false,
  editorCommentBlocks: new Map()
};

const fileView = document.querySelector('#file-view');
const reviewView = document.querySelector('#review-view');
const markdownContent = document.querySelector('#markdown-content');
const documentTitle = document.querySelector('#document-title');
const commentsList = document.querySelector('#comments-list');
const saveStatus = document.querySelector('#save-status');
const selectionToolbar = document.querySelector('#selection-toolbar');
const dialog = document.querySelector('#comment-dialog');
const dialogTitle = document.querySelector('#dialog-title');
const dialogTarget = document.querySelector('#dialog-target');
const commentInput = document.querySelector('#comment-input');
const exportOutput = document.querySelector('#export-output');
const commentModeButton = document.querySelector('#comment-mode-button');
const editModeButton = document.querySelector('#edit-mode-button');
const editorToolbar = document.querySelector('#editor-toolbar');
const editorSaveRow = document.querySelector('#editor-save-row');
const editorSaveStatus = document.querySelector('#editor-save-status');
const retrySaveButton = document.querySelector('#retry-save-button');
const blockFormat = document.querySelector('#block-format');

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', handleBeforeUnload);
window.addEventListener('pagehide', beaconComments);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') beaconComments();
});
document.querySelector('#back-button').addEventListener('click', navigateBack);
document.querySelector('.header-link').addEventListener('click', (event) => {
  if (!hasUnsavedDocumentChanges()) return;
  event.preventDefault();
  navigateBack();
});
document.querySelector('#document-comment-button').addEventListener('click', () => openCommentDialog({ type: 'document' }));
document.querySelector('#save-button').addEventListener('click', saveComments);
document.querySelector('#export-button').addEventListener('click', exportReviewMarkdown);
commentModeButton.addEventListener('click', () => setMode('comment'));
editModeButton.addEventListener('click', () => setMode('edit'));
retrySaveButton.addEventListener('click', () => saveDocumentEdits());
blockFormat.addEventListener('change', () => applyBlockFormat(blockFormat.value));
editorToolbar.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault();
});
editorToolbar.addEventListener('click', handleEditorToolbarClick);
document.querySelector('#cancel-dialog').addEventListener('click', () => dialog.close());
dialog.querySelector('form').addEventListener('submit', submitComment);
selectionToolbar.querySelector('button').addEventListener('click', () => {
  selectionToolbar.classList.add('hidden');
  if (state.currentSelectionTarget) openCommentDialog(state.currentSelectionTarget);
});

document.addEventListener('selectionchange', handleSelectionChange);
document.addEventListener('keydown', handleModeShortcut);
route();

async function route() {
  const match = window.location.hash.match(/^#\/review\/(.+)$/);
  const nextPath = match ? decodeURIComponent(match[1]) : null;
  if (state.mode === 'edit' && state.currentPath && nextPath !== state.currentPath && hasUnsavedDocumentChanges()) {
    const saved = await flushDocumentSaves();
    if (!saved && !window.confirm('本文を保存できていません。編集内容を破棄して移動しますか？')) {
      window.location.hash = `#/review/${encodeURIComponent(state.currentPath)}`;
      return;
    }
  }
  if (state.mode === 'comment' && state.currentPath && nextPath !== state.currentPath && state.commentsDirty) {
    const saved = await flushCommentSaves();
    if (!saved && !window.confirm('コメントを保存できていません。破棄して移動しますか？')) {
      window.location.hash = `#/review/${encodeURIComponent(state.currentPath)}`;
      return;
    }
    state.commentsDirty = false;
  }
  if (match) {
    await openFile(nextPath);
  } else {
    await showFileList();
  }
}

async function showFileList() {
  reviewView.classList.add('hidden');
  fileView.classList.remove('hidden');
  fileView.innerHTML = '<p class="muted">Markdownファイルを読み込み中...</p>';
  const data = await fetchJson('/api/files');
  state.files = data.files;
  const tree = buildFileTree(data.files);
  fileView.innerHTML = `
    <div class="file-list-header">
      <div>
        <p class="eyebrow">Target directory</p>
        <h2>${escapeHtml(data.rootDir)}</h2>
      </div>
      <span>${data.files.length} files</span>
    </div>
    <div class="file-tree">
      ${data.files.length ? renderTree(tree, 0) : '<p class="muted tree-empty">Markdownファイルが見つかりません。</p>'}
    </div>`;
}

function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ name: parts[parts.length - 1], path: file });
  }
  return root;
}

function renderTree(node, depth) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  let html = '';
  for (const [name, child] of dirs) {
    html += `
      <details class="tree-dir" open>
        <summary class="tree-row" style="--depth:${depth}">
          <span class="tree-chevron" aria-hidden="true"></span>
          <span class="tree-icon tree-icon-dir" aria-hidden="true"></span>
          <span class="tree-label">${escapeHtml(name)}</span>
        </summary>
        <div class="tree-children">${renderTree(child, depth + 1)}</div>
      </details>`;
  }
  for (const file of files) {
    html += `
      <a class="tree-row tree-file" style="--depth:${depth}" href="#/review/${encodeURIComponent(file.path)}">
        <span class="tree-icon tree-icon-file" aria-hidden="true"></span>
        <span class="tree-label">${escapeHtml(file.name)}</span>
      </a>`;
  }
  return html;
}

async function openFile(filePath) {
  clearTimeout(state.saveTimer);
  clearTimeout(state.commentSaveTimer);
  state.saveTimer = null;
  state.commentSaveTimer = null;
  state.mode = 'comment';
  state.dirtyBlocks.clear();
  state.blockVersions.clear();
  state.saveFailed = false;
  state.commentsDirty = false;
  state.commentSaveFailed = false;
  state.commentSaveQueued = false;
  state.commentsVersion += 1;
  state.editorCommentBlocks.clear();
  state.currentPath = filePath;
  fileView.classList.add('hidden');
  reviewView.classList.remove('hidden');
  exportOutput.hidden = true;
  setCommentSaveStatus('idle', 'コメントは自動保存されます。');
  documentTitle.textContent = filePath;
  markdownContent.innerHTML = '<p class="muted">Markdownをレンダリング中...</p>';

  const data = await fetchJson(`/api/file?path=${encodeURIComponent(filePath)}`);
  state.comments = data.review.comments || [];
  state.markdown = data.markdown;
  state.rawHtml = data.html;
  state.editableHtml = data.editableHtml;
  renderCommentMode();
  updateModeControls();
}

async function enhanceContent() {
  const diagrams = markdownContent.querySelectorAll('div.mermaid');
  if (diagrams.length === 0 || state.mode !== 'comment') return;
  try {
    const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/+esm');
    if (state.mode !== 'comment') return;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    await mermaid.run({ nodes: diagrams });
  } catch (error) {
    console.warn('Mermaid render skipped', error);
  }
}

function renderCommentMode() {
  markdownContent.classList.remove('editing');
  markdownContent.innerHTML = state.rawHtml;
  decorateReviewTargets();
  renderComments();
  enhanceContent();
}

function renderEditMode() {
  selectionToolbar.classList.add('hidden');
  markdownContent.innerHTML = state.editableHtml;
  markdownContent.classList.add('editing');
  prepareEditableSpecialBlocks();
  prepareEditorCommentAnchors();

  markdownContent.querySelectorAll('.markdown-block').forEach(bindEditableBlock);
  ensureEditablePlaceholder();
  renderComments();
}

function bindEditableBlock(block) {
  block.contentEditable = 'true';
  block.spellcheck = true;
  block.addEventListener('input', handleEditorInput);
  block.addEventListener('paste', handleEditorPaste);
  block.addEventListener('dblclick', handleEditableMedia);
}

function ensureEditablePlaceholder() {
  if (markdownContent.querySelector('.markdown-block')) return;
  const block = document.createElement('div');
  block.className = 'markdown-block new-block';
  block.dataset.blockId = `block-new-${Date.now()}`;
  block.dataset.blockKind = 'paragraph';
  block.dataset.sourceStart = String(state.markdown.length);
  block.dataset.sourceEnd = String(state.markdown.length);
  block.innerHTML = '<p><br></p>';
  markdownContent.append(block);
  bindEditableBlock(block);
}

function prepareEditableSpecialBlocks() {
  markdownContent.querySelectorAll('.markdown-block[data-block-kind="code"], .markdown-block[data-block-kind="mermaid"]').forEach((block) => {
    const start = Number(block.dataset.sourceStart);
    const end = Number(block.dataset.sourceEnd);
    const source = state.markdown.slice(start, end);
    const fence = source.match(/^(`{3,}|~{3,})\s*([^\r\n]*)\r?\n/);
    if (!fence) return;
    const closingFence = new RegExp(`\\r?\\n${fence[1][0]}{${fence[1].length},}\\s*$`);
    const codeSource = source.slice(fence[0].length).replace(closingFence, '');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const info = fence[2].trim();
    if (info) code.className = `language-${info}`;
    code.textContent = codeSource;
    pre.append(code);
    block.replaceChildren(pre);
  });
}

async function setMode(nextMode) {
  if (nextMode === state.mode || !state.currentPath) return;
  if (nextMode === 'comment') {
    const saved = await flushDocumentSaves();
    if (!saved) return;
    state.mode = 'comment';
    renderCommentMode();
  } else {
    if (!(await flushCommentSaves())) return;
    state.mode = 'edit';
    renderEditMode();
  }
  updateModeControls();
}

function updateModeControls() {
  const editing = state.mode === 'edit';
  commentModeButton.classList.toggle('active', !editing);
  editModeButton.classList.toggle('active', editing);
  commentModeButton.setAttribute('aria-pressed', String(!editing));
  editModeButton.setAttribute('aria-pressed', String(editing));
  editorToolbar.classList.toggle('hidden', !editing);
  editorSaveRow.classList.toggle('hidden', !editing);
  document.querySelector('#document-comment-button').disabled = editing;
  reviewView.classList.toggle('editing-mode', editing);
  if (!editing) setEditorSaveStatus('saved', '保存済み');
}

function handleModeShortcut(event) {
  if (
    event.repeat
    || event.altKey
    || !event.shiftKey
    || (!event.ctrlKey && !event.metaKey)
    || event.key.toLowerCase() !== 'e'
    || !state.currentPath
  ) return;
  if (dialog.open) return;
  event.preventDefault();
  setMode(state.mode === 'edit' ? 'comment' : 'edit');
}

function prepareEditorCommentAnchors() {
  state.editorCommentBlocks.clear();
  state.comments.forEach((comment) => {
    if (!comment.id) comment.id = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    delete comment.targetDetached;
  });

  for (const comment of state.comments) {
    if (comment.type !== 'paragraph' && comment.type !== 'section') continue;
    const selector = comment.type === 'section' ? 'h1, h2, h3, h4, h5, h6' : 'p, li, blockquote, pre';
    const target = [...markdownContent.querySelectorAll(selector)].find((element) => {
      const text = normalizeText(getEditorTargetText(element));
      return text && text === normalizeText(getCommentTargetText(comment));
    });
    if (target) {
      appendDataId(target, 'blockCommentIds', comment.id);
      const blockId = target.closest('.markdown-block')?.dataset.blockId;
      if (blockId) state.editorCommentBlocks.set(comment.id, blockId);
    } else {
      comment.targetDetached = true;
    }
  }

  const selectionGroups = new Map();
  state.comments.filter((comment) => comment.type === 'text-selection').forEach((comment) => {
    const key = [
      normalizeText(getCommentTargetText(comment)),
      normalizeText(comment.contextBefore || ''),
      normalizeText(comment.contextAfter || '')
    ].join('\n---\n');
    if (!selectionGroups.has(key)) selectionGroups.set(key, []);
    selectionGroups.get(key).push(comment);
  });

  for (const comments of selectionGroups.values()) {
    const reference = comments[0];
    const match = findTextRange(getCommentTargetText(reference), reference.contextBefore, reference.contextAfter);
    if (!match) {
      comments.forEach((comment) => { comment.targetDetached = true; });
      continue;
    }
    try {
      const range = document.createRange();
      range.setStart(match.startNode, match.startOffset);
      range.setEnd(match.endNode, match.endOffset);
      const anchor = document.createElement('span');
      anchor.className = 'editor-comment-anchor';
      anchor.dataset.commentIds = comments.map((comment) => comment.id).join(' ');
      anchor.append(range.extractContents());
      range.insertNode(anchor);
      const blockId = anchor.closest('.markdown-block')?.dataset.blockId;
      comments.forEach((comment) => {
        if (blockId) state.editorCommentBlocks.set(comment.id, blockId);
        else comment.targetDetached = true;
      });
    } catch {
      comments.forEach((comment) => { comment.targetDetached = true; });
    }
  }
}

function appendDataId(element, dataName, id) {
  const ids = new Set(String(element.dataset[dataName] || '').split(/\s+/).filter(Boolean));
  ids.add(id);
  element.dataset[dataName] = [...ids].join(' ');
}

function handleEditorInput(event) {
  const block = event.currentTarget.closest('.markdown-block');
  if (!block) return;
  if (!event.isComposing) applyMarkdownShortcuts(block);
  const pendingDeletion = isEmptyParagraphBlock(block);
  block.dataset.pendingDeletion = String(pendingDeletion);
  block.classList.toggle('pending-deletion', pendingDeletion);
  const blockId = block.dataset.blockId;
  state.dirtyBlocks.add(blockId);
  state.blockVersions.set(blockId, (state.blockVersions.get(blockId) || 0) + 1);
  block.classList.add('dirty');
  syncCommentsFromEditor(block);
  renderComments();
  scheduleDocumentSave();
}

function isEmptyParagraphBlock(block) {
  if (block.dataset.blockKind !== 'paragraph') return false;
  if (block.querySelector('img, table, hr, video, audio, iframe')) return false;
  return block.textContent.replaceAll('\u00a0', ' ').trim() === '';
}

function applyMarkdownShortcuts(block) {
  applyBlockMarkdownShortcut(block);
  applyInlineMarkdownShortcuts(block);
}

function applyBlockMarkdownShortcut(block) {
  if (block.children.length !== 1) return false;
  const root = block.firstElementChild;
  if (!root?.matches('p, div') || root.querySelector('.editor-comment-anchor')) return false;

  const source = root.textContent || '';
  let match;
  let container;
  let contentTarget;
  let prefixLength;
  let kind;

  if ((match = source.match(/^(#{1,6})\s(.*)$/s))) {
    container = document.createElement(`h${match[1].length}`);
    contentTarget = container;
    prefixLength = match[1].length + 1;
    kind = 'heading';
  } else if ((match = source.match(/^>\s(.*)$/s))) {
    container = document.createElement('blockquote');
    contentTarget = document.createElement('p');
    container.append(contentTarget);
    prefixLength = 2;
    kind = 'blockquote';
  } else if ((match = source.match(/^[-*+]\s(.*)$/s))) {
    container = document.createElement('ul');
    contentTarget = document.createElement('li');
    container.append(contentTarget);
    prefixLength = 2;
    kind = 'list';
  } else if ((match = source.match(/^\d+\.\s(.*)$/s))) {
    container = document.createElement('ol');
    contentTarget = document.createElement('li');
    container.append(contentTarget);
    prefixLength = source.indexOf(' ') + 1;
    kind = 'list';
  } else if ((match = source.match(/^```([\w-]*)\s$/))) {
    container = document.createElement('pre');
    contentTarget = document.createElement('code');
    if (match[1]) contentTarget.className = `language-${match[1]}`;
    container.append(contentTarget);
    prefixLength = source.length;
    match[2] = '';
    kind = match[1].toLowerCase() === 'mermaid' ? 'mermaid' : 'code';
  } else {
    return false;
  }

  const caretOffset = getCaretTextOffset(root);
  contentTarget.textContent = match[2] || '';
  if (!contentTarget.textContent) contentTarget.append(document.createElement('br'));
  if (root.dataset.blockCommentIds) {
    contentTarget.dataset.blockCommentIds = root.dataset.blockCommentIds;
  }
  root.replaceWith(container);
  block.dataset.blockKind = kind;
  if (caretOffset !== null) {
    setCaretTextOffset(contentTarget, Math.max(0, caretOffset - prefixLength));
  }
  return true;
}

function applyInlineMarkdownShortcuts(block) {
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !/[*_`[\]]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  nodes.forEach(replaceInlineMarkdownInTextNode);
}

function replaceInlineMarkdownInTextNode(textNode) {
  const source = textNode.nodeValue;
  const pattern = /!\[([^\]\n]*)\]\(([^)\n]+)\)|\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) return;

  const selection = window.getSelection();
  const caretOffset = selection?.isCollapsed && selection.anchorNode === textNode
    ? selection.anchorOffset
    : null;
  const fragment = document.createDocumentFragment();
  let sourceOffset = 0;
  let caretTarget = null;

  matches.forEach((match) => {
    if (match.index > sourceOffset) {
      fragment.append(document.createTextNode(source.slice(sourceOffset, match.index)));
    }
    const formatted = createInlineMarkdownElement(match);
    fragment.append(formatted);
    if (caretOffset !== null && caretOffset >= match.index && caretOffset <= match.index + match[0].length) {
      caretTarget = formatted;
    }
    sourceOffset = match.index + match[0].length;
  });
  if (sourceOffset < source.length) {
    fragment.append(document.createTextNode(source.slice(sourceOffset)));
  }

  textNode.replaceWith(fragment);
  if (caretTarget) placeCaretAfter(caretTarget);
}

function createInlineMarkdownElement(match) {
  if (match[1] !== undefined) {
    const image = document.createElement('img');
    image.alt = match[1];
    image.dataset.markdownSrc = match[2].trim();
    image.src = resolveEditableImageSource(match[2].trim());
    return image;
  }
  if (match[3] !== undefined) {
    const link = document.createElement('a');
    link.textContent = match[3];
    link.href = match[4].trim();
    link.target = '_blank';
    link.rel = 'noreferrer';
    return link;
  }

  const element = document.createElement(
    match[5] !== undefined || match[6] !== undefined
      ? 'strong'
      : match[7] !== undefined
        ? 'code'
        : 'em'
  );
  element.textContent = match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9];
  return element;
}

function getCaretTextOffset(element) {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

function setCaretTextOffset(element, requestedOffset) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = requestedOffset;
  let node = walker.nextNode();
  while (node) {
    if (remaining <= node.nodeValue.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= node.nodeValue.length;
    node = walker.nextNode();
  }
  placeCaretAfter(element.lastChild || element);
}

function placeCaretAfter(node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function handleEditorPaste(event) {
  event.preventDefault();
  const text = event.clipboardData?.getData('text/plain') || '';
  document.execCommand('insertText', false, text);
}

function handleEditableMedia(event) {
  const image = event.target.closest('img');
  const link = event.target.closest('a');
  if (!image && !link) return;
  event.preventDefault();
  if (link) {
    const href = window.prompt('リンク先URL', link.getAttribute('href') || '');
    if (href === null) return;
    link.setAttribute('href', href.trim());
    link.closest('.markdown-block')?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return;
  }
  const currentSource = image.dataset.markdownSrc || image.getAttribute('src') || '';
  const source = window.prompt('画像のパスまたはURL', currentSource);
  if (source === null) return;
  const alt = window.prompt('画像の代替テキスト', image.getAttribute('alt') || '');
  if (alt === null) return;
  image.dataset.markdownSrc = source.trim();
  image.setAttribute('src', resolveEditableImageSource(source.trim()));
  image.setAttribute('alt', alt);
  image.closest('.markdown-block')?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function resolveEditableImageSource(source) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source)) return source;
  return `/api/asset?from=${encodeURIComponent(state.currentPath)}&src=${encodeURIComponent(source)}`;
}

function handleEditorToolbarClick(event) {
  const button = event.target.closest('button');
  if (!button || state.mode !== 'edit') return;
  const command = button.dataset.editorCommand;
  if (command) {
    document.execCommand(command, false);
    markSelectedBlockDirty();
    return;
  }
  const action = button.dataset.editorAction;
  if (action === 'link') {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const href = window.prompt('リンク先URL', 'https://');
    if (href) document.execCommand('createLink', false, href);
  } else if (action === 'inline-code') {
    wrapSelectionWithElement('code');
  } else if (action === 'blockquote') {
    document.execCommand('formatBlock', false, 'blockquote');
  } else if (action === 'code-block') {
    document.execCommand('formatBlock', false, 'pre');
  }
  markSelectedBlockDirty();
}

function applyBlockFormat(tagName) {
  if (state.mode !== 'edit') return;
  document.execCommand('formatBlock', false, tagName);
  markSelectedBlockDirty();
}

function wrapSelectionWithElement(tagName) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const element = document.createElement(tagName);
  try {
    range.surroundContents(element);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(element);
    selection.addRange(nextRange);
  } catch {
    const text = selection.toString();
    document.execCommand('insertHTML', false, `<${tagName}>${escapeHtml(text)}</${tagName}>`);
  }
}

function markSelectedBlockDirty() {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const block = element?.closest?.('.markdown-block');
  if (block) block.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'formatSetBlockTextDirection' }));
}

function syncCommentsFromEditor(block) {
  block.querySelectorAll('[data-block-comment-ids]').forEach((target) => {
    const text = getEditorTargetText(target).trim();
    for (const id of target.dataset.blockCommentIds.split(/\s+/).filter(Boolean)) {
      const comment = state.comments.find((item) => item.id === id);
      if (!comment || !text) continue;
      comment.selectedText = text;
      comment.targetText = text;
      comment.headingPath = collectHeadingPath(target);
      if (comment.type === 'section') comment.heading = text;
      delete comment.targetDetached;
    }
  });

  block.querySelectorAll('.editor-comment-anchor[data-comment-ids]').forEach((anchor) => {
    const selectedText = anchor.textContent.trim();
    for (const id of anchor.dataset.commentIds.split(/\s+/).filter(Boolean)) {
      const comment = state.comments.find((item) => item.id === id);
      if (!comment) continue;
      if (!selectedText) {
        comment.targetDetached = true;
        continue;
      }
      const context = contextAroundNode(anchor);
      comment.selectedText = selectedText;
      comment.contextBefore = context.before;
      comment.contextAfter = context.after;
      comment.headingPath = collectHeadingPath(anchor);
      delete comment.targetDetached;
    }
  });

  for (const comment of state.comments) {
    if (state.editorCommentBlocks.get(comment.id) !== block.dataset.blockId) continue;
    const selector = `[data-block-comment-ids~="${cssEscape(comment.id)}"], .editor-comment-anchor[data-comment-ids~="${cssEscape(comment.id)}"]`;
    if (!block.querySelector(selector)) comment.targetDetached = true;
  }
}

function contextAroundNode(node) {
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(markdownContent);
  beforeRange.setEndBefore(node);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(markdownContent);
  afterRange.setStartAfter(node);
  return {
    before: beforeRange.toString().slice(-120).trim(),
    after: afterRange.toString().slice(0, 120).trim()
  };
}

function getEditorTargetText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.inline-comment-button').forEach((button) => button.remove());
  return clone.textContent || '';
}

function scheduleDocumentSave() {
  clearTimeout(state.saveTimer);
  setEditorSaveStatus('dirty', '未保存の変更があります');
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    saveDocumentEdits();
  }, 800);
}

async function saveDocumentEdits() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (state.savePromise) return state.savePromise;

  const snapshots = [...state.dirtyBlocks].map((blockId) => {
    const block = [...markdownContent.querySelectorAll('.markdown-block')]
      .find((element) => element.dataset.blockId === blockId);
    if (!block) return null;
    return {
      block,
      blockId,
      start: Number(block.dataset.sourceStart),
      end: Number(block.dataset.sourceEnd),
      html: cleanEditorBlockHtml(block),
      delete: block.dataset.pendingDeletion === 'true',
      version: state.blockVersions.get(blockId) || 0
    };
  }).filter(Boolean);

  if (snapshots.length === 0) {
    state.saveFailed = false;
    setEditorSaveStatus('saved', '保存済み');
    return true;
  }

  snapshots.filter((snapshot) => snapshot.delete).forEach(({ block }) => {
    block.contentEditable = 'false';
    block.setAttribute('aria-busy', 'true');
  });
  setEditorSaveStatus('saving', '保存中…');
  state.savePromise = (async () => {
    try {
      const result = await fetchJson('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: state.currentPath,
          edits: snapshots.map(({ blockId, start, end, html, delete: deleteBlock }) => ({
            blockId,
            start,
            end,
            html,
            delete: deleteBlock
          })),
          comments: state.comments
        })
      });
      updateEditorSourceRanges(result.appliedEdits || []);
      state.markdown = result.markdown;
      state.rawHtml = result.html;
      state.editableHtml = result.editableHtml;
      state.comments = result.review.comments || state.comments;
      state.commentsDirty = false;
      snapshots.forEach(({ block, blockId, version, delete: deleteBlock }) => {
        if ((state.blockVersions.get(blockId) || 0) !== version) return;
        state.dirtyBlocks.delete(blockId);
        if (deleteBlock) {
          block.remove();
        } else {
          block.classList.remove('dirty');
          block.classList.remove('pending-deletion');
          delete block.dataset.pendingDeletion;
        }
      });
      if (state.mode === 'edit') ensureEditablePlaceholder();
      state.saveFailed = false;
      renderComments();
      if (state.dirtyBlocks.size > 0) {
        scheduleDocumentSave();
      } else {
        setEditorSaveStatus('saved', '保存済み');
      }
      return true;
    } catch (error) {
      snapshots.filter((snapshot) => snapshot.delete).forEach(({ block }) => {
        if (!block.isConnected) return;
        block.contentEditable = 'true';
        block.removeAttribute('aria-busy');
      });
      state.saveFailed = true;
      setEditorSaveStatus('error', `保存できませんでした: ${error.message}`);
      return false;
    } finally {
      state.savePromise = null;
    }
  })();
  return state.savePromise;
}

function cleanEditorBlockHtml(block) {
  if (block.dataset.pendingDeletion === 'true') return '';
  const clone = block.cloneNode(true);
  clone.querySelectorAll('.editor-comment-anchor, .comment-highlight-text').forEach((anchor) => {
    anchor.replaceWith(...anchor.childNodes);
  });
  clone.querySelectorAll('.inline-comment-button').forEach((button) => button.remove());
  clone.querySelectorAll('[data-block-comment-ids]').forEach((element) => {
    element.removeAttribute('data-block-comment-ids');
  });
  clone.querySelectorAll('.comment-highlight-target').forEach((element) => {
    element.classList.remove('comment-highlight-target');
  });
  clone.querySelectorAll('[contenteditable]').forEach((element) => element.removeAttribute('contenteditable'));
  return clone.innerHTML;
}

function updateEditorSourceRanges(appliedEdits) {
  const edits = [...appliedEdits].sort((a, b) => a.start - b.start);
  markdownContent.querySelectorAll('.markdown-block').forEach((block) => {
    const oldStart = Number(block.dataset.sourceStart);
    const oldEnd = Number(block.dataset.sourceEnd);
    const ownEdit = edits.find((edit) => edit.blockId === block.dataset.blockId);
    const shift = edits
      .filter((edit) => edit.blockId !== block.dataset.blockId && edit.end <= oldStart)
      .reduce((total, edit) => total + edit.markdown.length - (edit.end - edit.start), 0);
    const nextStart = oldStart + shift;
    block.dataset.sourceStart = String(nextStart);
    block.dataset.sourceEnd = String(ownEdit ? nextStart + ownEdit.markdown.length : oldEnd + shift);
  });
}

async function flushDocumentSaves() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  while (state.savePromise || state.dirtyBlocks.size > 0) {
    const saved = state.savePromise ? await state.savePromise : await saveDocumentEdits();
    if (!saved) return false;
  }
  return true;
}

function setEditorSaveStatus(status, message) {
  editorSaveRow.dataset.state = status;
  editorSaveStatus.textContent = message;
  retrySaveButton.classList.toggle('hidden', status !== 'error');
}

function hasUnsavedDocumentChanges() {
  return state.dirtyBlocks.size > 0
    || Boolean(state.savePromise)
    || state.saveFailed
    || state.commentsDirty
    || Boolean(state.commentSavePromise);
}

function handleBeforeUnload(event) {
  if (!hasUnsavedDocumentChanges()) return;
  event.preventDefault();
  event.returnValue = '';
}

async function navigateBack() {
  if (state.mode === 'comment' && state.commentsDirty) {
    if (!(await flushCommentSaves())
      && !window.confirm('コメントを保存できていません。破棄してファイル一覧へ戻りますか？')) return;
    state.commentsDirty = false;
  }
  if (state.mode === 'edit' && !(await flushDocumentSaves())) {
    if (!window.confirm('本文を保存できていません。編集内容を破棄してファイル一覧へ戻りますか？')) return;
  }
  state.mode = 'comment';
  state.dirtyBlocks.clear();
  state.saveFailed = false;
  window.location.hash = '#/';
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function decorateReviewTargets() {
  markdownContent.querySelectorAll('p, li, blockquote, pre').forEach((element) => {
    wrapTarget(element, 'paragraph', '段落にコメント');
  });
  markdownContent.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((element) => {
    wrapTarget(element, 'section', '見出し配下にコメント');
  });
}

function wrapTarget(element, type, label) {
  element.classList.add('review-target');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inline-comment-button';
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCommentDialog({
      type,
      selectedText: element.innerText.trim(),
      targetText: element.innerText.trim(),
      heading: type === 'section' ? element.innerText.trim() : undefined,
      headingPath: collectHeadingPath(element)
    });
  });
  element.append(button);
}

function handleSelectionChange() {
  if (state.mode !== 'comment') {
    state.currentSelectionTarget = null;
    selectionToolbar.classList.add('hidden');
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !markdownContent.contains(selection.anchorNode)) {
    state.currentSelectionTarget = null;
    selectionToolbar.classList.add('hidden');
    return;
  }
  state.currentSelectionTarget = buildSelectionTarget();
  if (!state.currentSelectionTarget) {
    selectionToolbar.classList.add('hidden');
    return;
  }
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  selectionToolbar.style.left = `${rect.left + window.scrollX}px`;
  selectionToolbar.style.top = `${rect.bottom + window.scrollY + 8}px`;
  selectionToolbar.classList.remove('hidden');
}

function buildSelectionTarget() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const selectedText = selection.toString().trim();
  if (!selectedText) return null;
  const container = selection.anchorNode.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : selection.anchorNode;
  const fullText = markdownContent.innerText;
  const index = fullText.indexOf(selectedText);
  return {
    type: 'text-selection',
    selectedText,
    contextBefore: index > -1 ? fullText.slice(Math.max(0, index - 120), index).trim() : '',
    contextAfter: index > -1 ? fullText.slice(index + selectedText.length, index + selectedText.length + 120).trim() : '',
    headingPath: collectHeadingPath(container)
  };
}

function collectHeadingPath(element) {
  const headings = [];
  const allHeadings = [...markdownContent.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  const elementTop = element.getBoundingClientRect().top + window.scrollY;
  for (const heading of allHeadings) {
    const headingTop = heading.getBoundingClientRect().top + window.scrollY;
    if (headingTop > elementTop) break;
    const level = Number(heading.tagName.slice(1));
    headings[level - 1] = heading.textContent?.trim() || heading.innerText?.trim() || '';
    headings.length = level;
  }
  return headings.filter(Boolean);
}

function openCommentDialog(target) {
  state.pendingTarget = target;
  dialogTitle.textContent = target.type === 'document' ? '文書全体へのコメント' : 'コメント追加';
  dialogTarget.textContent = describeTarget(target);
  commentInput.value = '';
  dialog.showModal();
  commentInput.focus();
}

function submitComment(event) {
  event.preventDefault();
  const comment = commentInput.value.trim();
  if (!comment || !state.pendingTarget) return;
  state.comments.push({
    id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...state.pendingTarget,
    comment,
    createdAt: new Date().toISOString()
  });
  dialog.close();
  state.pendingTarget = null;
  renderComments();
  markCommentsDirty();
}

function renderComments() {
  commentsList.innerHTML = state.comments.map((comment, index) => `
    <article class="comment-card${comment.targetDetached ? ' detached' : ''}">
      <div class="comment-meta">
        <strong>${index + 1}. ${labelForType(comment.type)}</strong>
        <span>${escapeHtml(new Date(comment.createdAt || Date.now()).toLocaleString())}</span>
      </div>
      <p class="target-summary">${escapeHtml(describeTarget(comment))}</p>
      ${comment.targetDetached ? '<span class="detached-label">編集後の対象を特定できません</span>' : ''}
      <textarea data-comment-index="${index}" rows="4"${state.mode === 'edit' ? ' disabled' : ''}>${escapeHtml(comment.comment || '')}</textarea>
      <div class="comment-actions">
        <button type="button" data-repeat-index="${index}"${state.mode === 'edit' ? ' disabled' : ''}>同じ対象に追加</button>
        <button type="button" data-delete-index="${index}"${state.mode === 'edit' ? ' disabled' : ''}>削除</button>
      </div>
    </article>
  `).join('') || '<p class="muted">まだコメントはありません。</p>';

  commentsList.querySelectorAll('textarea[data-comment-index]').forEach((textarea) => {
    textarea.addEventListener('input', () => {
      state.comments[Number(textarea.dataset.commentIndex)].comment = textarea.value;
      markCommentsDirty();
    });
  });
  commentsList.querySelectorAll('button[data-repeat-index]').forEach((button) => {
    button.addEventListener('click', () => {
      openCommentDialog(copyCommentTarget(state.comments[Number(button.dataset.repeatIndex)]));
    });
  });
  commentsList.querySelectorAll('button[data-delete-index]').forEach((button) => {
    button.addEventListener('click', () => {
      state.comments.splice(Number(button.dataset.deleteIndex), 1);
      renderComments();
      markCommentsDirty();
    });
  });
  if (state.mode === 'comment') renderCommentHighlights();
}

function renderCommentHighlights() {
  clearCommentHighlights();
  highlightBlockTargets();
  highlightTextSelections();
}

function clearCommentHighlights() {
  markdownContent.querySelectorAll('.comment-highlight-text').forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    mark.remove();
    parent?.normalize();
  });
  markdownContent.querySelectorAll('.comment-highlight-target').forEach((element) => {
    element.classList.remove('comment-highlight-target');
    element.removeAttribute('data-comment-count');
  });
}

function highlightBlockTargets() {
  markdownContent.querySelectorAll('.review-target').forEach((element) => {
    const elementText = normalizeText(getReviewTargetText(element));
    if (!elementText) return;
    const matches = state.comments.filter((comment) => blockCommentMatchesElement(comment, element, elementText));
    if (matches.length === 0) return;
    element.classList.add('comment-highlight-target');
    element.dataset.commentCount = String(matches.length);
  });
}

function blockCommentMatchesElement(comment, element, elementText) {
  if (comment.type === 'paragraph') {
    return normalizeText(getCommentTargetText(comment)) === elementText;
  }
  if (comment.type === 'section' && /^H[1-6]$/.test(element.tagName)) {
    return normalizeText(getCommentTargetText(comment)) === elementText;
  }
  return false;
}

function highlightTextSelections() {
  const seen = new Set();
  state.comments.forEach((comment) => {
    const selectedText = getCommentTargetText(comment);
    if (comment.type !== 'text-selection' || !selectedText) return;
    const key = [
      normalizeText(selectedText),
      normalizeText(comment.contextBefore || ''),
      normalizeText(comment.contextAfter || '')
    ].join('\n---\n');
    if (seen.has(key)) return;
    seen.add(key);
    markTextSelection(comment);
  });
}

function markTextSelection(comment) {
  const match = findTextRange(getCommentTargetText(comment), comment.contextBefore, comment.contextAfter);
  if (!match) return;

  const range = document.createRange();
  range.setStart(match.startNode, match.startOffset);
  range.setEnd(match.endNode, match.endOffset);

  const mark = document.createElement('mark');
  mark.className = 'comment-highlight-text';
  mark.tabIndex = 0;
  mark.title = 'この対象にコメントを追加';
  mark.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCommentDialog(copyCommentTarget(comment));
  });
  mark.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openCommentDialog(copyCommentTarget(comment));
  });

  mark.append(range.extractContents());
  range.insertNode(mark);
}

function findTextRange(selectedText, contextBefore = '', contextAfter = '') {
  const nodes = collectContentTextNodes();
  const fullText = nodes.map(({ node }) => node.nodeValue).join('');
  const match = findBestTextMatch(fullText, selectedText, contextBefore, contextAfter);
  if (!match) return null;
  const start = locateTextOffset(nodes, match.start);
  const end = locateTextOffset(nodes, match.end, true);
  if (!start || !end) return null;
  return {
    startNode: start.node,
    startOffset: start.offset,
    endNode: end.node,
    endOffset: end.offset
  };
}

function collectContentTextNodes() {
  const nodes = [];
  const walker = document.createTreeWalker(markdownContent, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('button, script, style')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push({ node, length: node.nodeValue.length });
    node = walker.nextNode();
  }
  return nodes;
}

function findBestTextMatch(fullText, selectedText, contextBefore, contextAfter) {
  const exactIndex = findBestTextIndex(fullText, selectedText, contextBefore, contextAfter);
  if (exactIndex > -1) return { start: exactIndex, end: exactIndex + selectedText.length };

  const normalized = buildNormalizedTextIndex(fullText);
  const normalizedSelectedText = normalizeText(selectedText);
  if (!normalizedSelectedText) return null;
  const normalizedIndex = findBestTextIndex(normalized.text, normalizedSelectedText, contextBefore, contextAfter);
  if (normalizedIndex < 0) return null;
  const normalizedEndIndex = normalizedIndex + normalizedSelectedText.length - 1;
  return {
    start: normalized.starts[normalizedIndex],
    end: normalized.ends[normalizedEndIndex]
  };
}

function findBestTextIndex(fullText, selectedText, contextBefore, contextAfter) {
  let index = fullText.indexOf(selectedText);
  let bestIndex = index;
  let bestScore = -1;
  while (index !== -1) {
    const before = fullText.slice(Math.max(0, index - 200), index);
    const after = fullText.slice(index + selectedText.length, index + selectedText.length + 200);
    const score = scoreContextMatch(before, after, contextBefore, contextAfter);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
    index = fullText.indexOf(selectedText, index + selectedText.length);
  }
  return bestIndex;
}

function buildNormalizedTextIndex(text) {
  let normalized = '';
  const starts = [];
  const ends = [];
  let index = 0;

  while (index < text.length) {
    if (/\s/.test(text[index])) {
      const start = index;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      if (normalized && !normalized.endsWith(' ')) {
        normalized += ' ';
        starts.push(start);
        ends.push(index);
      }
      continue;
    }

    normalized += text[index];
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }

  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    starts.pop();
    ends.pop();
  }

  return { text: normalized, starts, ends };
}

function scoreContextMatch(before, after, contextBefore, contextAfter) {
  let score = 0;
  const beforeText = normalizeText(before);
  const afterText = normalizeText(after);
  const expectedBefore = normalizeText(contextBefore).slice(-60);
  const expectedAfter = normalizeText(contextAfter).slice(0, 60);
  if (expectedBefore && beforeText.endsWith(expectedBefore)) score += 2;
  else if (expectedBefore && beforeText.includes(expectedBefore)) score += 1;
  if (expectedAfter && afterText.startsWith(expectedAfter)) score += 2;
  else if (expectedAfter && afterText.includes(expectedAfter)) score += 1;
  return score;
}

function locateTextOffset(nodes, offset, preferPrevious = false) {
  let current = 0;
  for (const { node, length } of nodes) {
    const nodeEnd = current + length;
    if (offset < nodeEnd || (preferPrevious && offset === nodeEnd)) {
      return { node, offset: offset - current };
    }
    current = nodeEnd;
  }
  const last = nodes.at(-1);
  return last && offset === current ? { node: last.node, offset: last.length } : null;
}

function getReviewTargetText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.inline-comment-button').forEach((button) => button.remove());
  return clone.textContent.trim();
}

function getCommentTargetText(comment) {
  return comment.selectedText || comment.targetText || comment.heading || '';
}

function copyCommentTarget(comment) {
  const target = { ...comment };
  delete target.id;
  delete target.comment;
  delete target.createdAt;
  return target;
}

function markCommentsDirty() {
  state.commentsDirty = true;
  // Every edit invalidates in-flight saves: their response must not overwrite newer text.
  state.commentsVersion += 1;
  scheduleCommentSave();
}

function scheduleCommentSave() {
  if (state.mode === 'edit' || !state.currentPath) return;
  clearTimeout(state.commentSaveTimer);
  setCommentSaveStatus('dirty', '自動保存待ち…');
  state.commentSaveTimer = setTimeout(() => {
    state.commentSaveTimer = null;
    saveComments();
  }, 800);
}

/**
 * Saves whatever `state.comments` holds right now. Concurrent calls collapse into
 * the in-flight request, and edits made while it is running trigger one more round
 * so the file always ends up matching the pane.
 */
async function saveComments() {
  clearTimeout(state.commentSaveTimer);
  state.commentSaveTimer = null;
  if (state.mode === 'edit' || !state.currentPath) return true;
  if (state.commentSavePromise) {
    state.commentSaveQueued = true;
    return state.commentSavePromise;
  }

  state.commentSavePromise = (async () => {
    try {
      let saved = true;
      do {
        state.commentSaveQueued = false;
        saved = await pushComments();
      } while (saved && state.commentSaveQueued);
      return saved;
    } finally {
      state.commentSavePromise = null;
    }
  })();
  return state.commentSavePromise;
}

async function pushComments() {
  const version = state.commentsVersion;
  const path = state.currentPath;
  setCommentSaveStatus('saving', '保存中…');
  try {
    const result = await fetchJson('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, comments: state.comments })
    });
    state.commentSaveFailed = false;
    if (state.commentsVersion !== version || state.currentPath !== path) return true;
    adoptSavedCommentIds(result.review.comments);
    state.commentsDirty = false;
    // Re-rendering here would replace the textarea the reviewer is typing in, so don't.
    setCommentSaveStatus('saved', `自動保存しました ${new Date().toLocaleTimeString()}: ${result.reviewFile}`);
    return true;
  } catch (error) {
    state.commentSaveFailed = true;
    setCommentSaveStatus('error', `保存できませんでした: ${error.message}`);
    return false;
  }
}

function adoptSavedCommentIds(savedComments) {
  (savedComments || []).forEach((saved, index) => {
    const comment = state.comments[index];
    if (!comment) return;
    if (!comment.id) comment.id = saved.id;
    if (!comment.createdAt) comment.createdAt = saved.createdAt;
  });
}

async function flushCommentSaves() {
  clearTimeout(state.commentSaveTimer);
  state.commentSaveTimer = null;
  while (state.commentSavePromise || state.commentsDirty) {
    const saved = state.commentSavePromise ? await state.commentSavePromise : await saveComments();
    if (!saved) return false;
  }
  return true;
}

function setCommentSaveStatus(status, message) {
  saveStatus.dataset.state = status;
  saveStatus.textContent = message;
}

/**
 * A reload or tab close can beat the debounce timer, so hand the browser one last
 * copy on the way out. Beacons outlive the page; a normal fetch would be cancelled.
 */
function beaconComments() {
  if (state.mode !== 'comment' || !state.currentPath || !state.commentsDirty) return;
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  const payload = JSON.stringify({ path: state.currentPath, comments: state.comments });
  navigator.sendBeacon('/api/review', new Blob([payload], { type: 'application/json' }));
}

async function exportReviewMarkdown() {
  if (state.mode === 'edit' && !(await flushDocumentSaves())) return;
  if (!(await flushCommentSaves())) return;
  const response = await fetch(`/api/export?path=${encodeURIComponent(state.currentPath)}`);
  const markdown = await response.text();
  exportOutput.hidden = false;
  exportOutput.value = markdown;
  setCommentSaveStatus('saved', 'レビューMarkdownを .review ディレクトリに出力しました。');
}

function describeTarget(target) {
  if (target.type === 'document') return '文書全体';
  if (target.type === 'section') return `見出し: ${target.heading || target.targetText || ''}`;
  if (target.type === 'paragraph') return `段落: ${truncate(target.selectedText || target.targetText || '')}`;
  if (target.type === 'text-selection') return `選択範囲: ${truncate(target.selectedText || '')}`;
  return target.type || 'コメント';
}

function labelForType(type) {
  return ({ document: '文書全体', 'text-selection': '範囲選択', paragraph: '段落', section: 'セクション' })[type] || type;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.json()).error || response.statusText);
  return response.json();
}

function truncate(text, length = 90) {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
