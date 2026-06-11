const state = {
  files: [],
  currentPath: null,
  comments: [],
  pendingTarget: null,
  currentSelectionTarget: null
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

window.addEventListener('hashchange', route);
document.querySelector('#back-button').addEventListener('click', () => { window.location.hash = '#/'; });
document.querySelector('#document-comment-button').addEventListener('click', () => openCommentDialog({ type: 'document' }));
document.querySelector('#save-button').addEventListener('click', saveComments);
document.querySelector('#export-button').addEventListener('click', exportReviewMarkdown);
document.querySelector('#cancel-dialog').addEventListener('click', () => dialog.close());
dialog.querySelector('form').addEventListener('submit', submitComment);
selectionToolbar.querySelector('button').addEventListener('click', () => {
  selectionToolbar.classList.add('hidden');
  if (state.currentSelectionTarget) openCommentDialog(state.currentSelectionTarget);
});

document.addEventListener('selectionchange', handleSelectionChange);
route();

async function route() {
  const match = window.location.hash.match(/^#\/review\/(.+)$/);
  if (match) {
    await openFile(decodeURIComponent(match[1]));
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
  fileView.innerHTML = `
    <div class="file-list-header">
      <div>
        <p class="eyebrow">Target directory</p>
        <h2>${escapeHtml(data.rootDir)}</h2>
      </div>
      <span>${data.files.length} files</span>
    </div>
    <ul class="file-list">
      ${data.files.map((file) => `<li><a href="#/review/${encodeURIComponent(file)}">${escapeHtml(file)}</a></li>`).join('') || '<li class="muted">Markdownファイルが見つかりません。</li>'}
    </ul>`;
}

async function openFile(filePath) {
  state.currentPath = filePath;
  fileView.classList.add('hidden');
  reviewView.classList.remove('hidden');
  exportOutput.hidden = true;
  saveStatus.textContent = '';
  documentTitle.textContent = filePath;
  markdownContent.innerHTML = '<p class="muted">Markdownをレンダリング中...</p>';

  const data = await fetchJson(`/api/file?path=${encodeURIComponent(filePath)}`);
  state.comments = data.review.comments || [];
  markdownContent.innerHTML = data.html;
  decorateReviewTargets();
  renderComments();
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
    headings[level - 1] = heading.childNodes[0]?.textContent?.trim() || heading.innerText.trim();
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
  saveStatus.textContent = '未保存のコメントがあります。';
}

function renderComments() {
  commentsList.innerHTML = state.comments.map((comment, index) => `
    <article class="comment-card">
      <div class="comment-meta">
        <strong>${index + 1}. ${labelForType(comment.type)}</strong>
        <span>${escapeHtml(new Date(comment.createdAt || Date.now()).toLocaleString())}</span>
      </div>
      <p class="target-summary">${escapeHtml(describeTarget(comment))}</p>
      <textarea data-comment-index="${index}" rows="4">${escapeHtml(comment.comment || '')}</textarea>
      <div class="comment-actions">
        <button type="button" data-delete-index="${index}">削除</button>
      </div>
    </article>
  `).join('') || '<p class="muted">まだコメントはありません。</p>';

  commentsList.querySelectorAll('textarea[data-comment-index]').forEach((textarea) => {
    textarea.addEventListener('input', () => {
      state.comments[Number(textarea.dataset.commentIndex)].comment = textarea.value;
      saveStatus.textContent = '未保存のコメントがあります。';
    });
  });
  commentsList.querySelectorAll('button[data-delete-index]').forEach((button) => {
    button.addEventListener('click', () => {
      state.comments.splice(Number(button.dataset.deleteIndex), 1);
      renderComments();
      saveStatus.textContent = '未保存のコメントがあります。';
    });
  });
}

async function saveComments() {
  const result = await fetchJson('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.currentPath, comments: state.comments })
  });
  state.comments = result.review.comments;
  renderComments();
  saveStatus.textContent = `保存しました: ${result.reviewFile}`;
}

async function exportReviewMarkdown() {
  await saveComments();
  const response = await fetch(`/api/export?path=${encodeURIComponent(state.currentPath)}`);
  const markdown = await response.text();
  exportOutput.hidden = false;
  exportOutput.value = markdown;
  saveStatus.textContent = 'レビューMarkdownを .review ディレクトリに出力しました。';
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
