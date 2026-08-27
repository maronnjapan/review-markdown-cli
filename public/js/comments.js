import { createId, escapeHtml, truncate } from './util.js';

const TYPE_LABELS = {
  document: '文書全体',
  section: 'セクション',
  paragraph: '段落',
  'text-selection': '範囲選択'
};

const TYPE_HINTS = {
  document: 'この文書全体に対する指摘として保存します。',
  section: 'この見出しと、その配下の本文に対する指摘として保存します。',
  paragraph: 'この段落に対する指摘として保存します。',
  'text-selection': '選択した文字列に対する指摘として保存します。'
};

const STATUS_LABELS = {
  open: '未解決',
  resolved: '解決済み'
};

export function labelForType(type) {
  return TYPE_LABELS[type] || type || 'コメント';
}

export function commentTargetText(comment) {
  return comment.selectedText || comment.targetText || comment.heading || '';
}

export function describeTarget(target) {
  if (target.type === 'document') return '文書全体';
  if (target.type === 'section') return `見出し: ${target.heading || target.targetText || ''}`;
  if (target.type === 'paragraph') return `段落: ${truncate(commentTargetText(target))}`;
  if (target.type === 'text-selection') return `選択範囲: ${truncate(commentTargetText(target))}`;
  return labelForType(target.type);
}

export function statusForComment(comment) {
  return comment?.status === 'resolved' ? 'resolved' : 'open';
}

/** A fresh comment aimed at the same place as an existing one. */
export function copyCommentTarget(comment) {
  const target = { ...comment };
  delete target.id;
  delete target.comment;
  delete target.createdAt;
  delete target.status;
  delete target.targetDetached;
  // The reviewer is writing this one, whoever placed the comment it reuses.
  delete target.source;
  return target;
}

export function newComment(target, text) {
  return {
    id: createId(),
    ...target,
    comment: text,
    status: 'open',
    createdAt: new Date().toISOString()
  };
}

/**
 * The "what am I about to comment on?" dialog. It shows the target verbatim
 * rather than a truncated one-liner, because picking the wrong paragraph is the
 * mistake that is hardest to notice after the fact.
 */
export function createCommentDialog(refs, { onSubmit }) {
  let pendingTarget = null;

  refs.dialogForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  refs.cancelDialog.addEventListener('click', close);
  refs.commentInput.addEventListener('input', syncSubmitState);
  refs.commentInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    submit();
  });

  function submit() {
    const text = refs.commentInput.value.trim();
    if (!text || !pendingTarget) return;
    const target = pendingTarget;
    close();
    onSubmit(target, text);
  }

  function open(target) {
    pendingTarget = target;
    refs.dialogTypeBadge.textContent = labelForType(target.type);
    refs.dialogTypeBadge.dataset.type = target.type || 'comment';
    refs.dialogTitle.textContent = target.type === 'document' ? '文書全体にコメント' : 'コメントを追加';

    const headingPath = Array.isArray(target.headingPath) ? target.headingPath.filter(Boolean) : [];
    refs.dialogTargetPath.textContent = headingPath.length ? headingPath.join(' › ') : '';
    refs.dialogTargetPath.hidden = headingPath.length === 0;

    const quoted = target.type === 'document' ? '' : commentTargetText(target);
    refs.dialogTargetQuote.textContent = quoted || TYPE_HINTS[target.type] || '';
    refs.dialogTargetQuote.classList.toggle('is-hint', !quoted);

    refs.commentInput.value = '';
    syncSubmitState();
    refs.dialog.showModal();
    refs.commentInput.focus();
  }

  function close() {
    pendingTarget = null;
    refs.dialog.close();
  }

  function syncSubmitState() {
    refs.submitDialog.disabled = refs.commentInput.value.trim() === '';
  }

  return { open, close, get isOpen() { return refs.dialog.open; } };
}

/**
 * Renders the comment pane. `handlers` receives the comment index so callers do
 * not have to re-derive it from the DOM.
 */
export function renderCommentList(container, { comments, mode, pendingDeleteId, handlers }) {
  const readOnly = mode === 'edit';
  container.innerHTML = comments.length === 0
    ? '<p class="muted">まだコメントはありません。</p>'
    : ['open', 'resolved'].map((status) => commentGroupHtml(
      status,
      comments.map((comment, index) => ({ comment, index }))
        .filter(({ comment }) => statusForComment(comment) === status),
      readOnly,
      pendingDeleteId
    )).join('');

  container.querySelectorAll('textarea[data-comment-index]').forEach((textarea) => {
    textarea.addEventListener('input', () => handlers.onEdit(Number(textarea.dataset.commentIndex), textarea.value));
  });
  container.querySelectorAll('[data-action]').forEach((button) => {
    const index = Number(button.dataset.index);
    button.addEventListener('click', () => handlers[button.dataset.action]?.(index));
  });
}

function commentGroupHtml(status, entries, readOnly, pendingDeleteId) {
  if (entries.length === 0) return '';
  return `
    <section class="comment-group" data-status="${status}" aria-label="${STATUS_LABELS[status]}のコメント">
      <div class="comment-group-header">
        <h3>${STATUS_LABELS[status]}</h3>
        <span class="comment-group-count">${entries.length}</span>
      </div>
      <div class="comment-group-items">
        ${entries.map(({ comment, index }) => commentCardHtml(comment, index, readOnly, pendingDeleteId)).join('')}
      </div>
    </section>`;
}

function commentCardHtml(comment, index, readOnly, pendingDeleteId) {
  const disabled = readOnly ? ' disabled' : '';
  const confirming = comment.id && comment.id === pendingDeleteId;
  const status = statusForComment(comment);
  return `
    <article class="comment-card${comment.targetDetached ? ' detached' : ''}${confirming ? ' confirming' : ''}" data-comment-id="${escapeHtml(comment.id || '')}" data-status="${status}">
      <div class="comment-meta">
        <div class="comment-meta-labels">
          <strong><span class="target-badge" data-type="${escapeHtml(comment.type || '')}">${escapeHtml(labelForType(comment.type))}</span> ${index + 1}</strong>
          <span class="comment-status" data-status="${status}">${STATUS_LABELS[status]}</span>
          ${comment.source === 'ai' ? '<span class="comment-source">AI配置</span>' : ''}
        </div>
        <time>${escapeHtml(formatTimestamp(comment.createdAt))}</time>
      </div>
      <p class="target-summary">${escapeHtml(describeTarget(comment))}</p>
      ${comment.targetDetached ? '<span class="detached-label">編集後の対象を特定できません</span>' : ''}
      <textarea data-comment-index="${index}" rows="4"${disabled}>${escapeHtml(comment.comment || '')}</textarea>
      ${confirming ? deleteConfirmHtml(index) : actionsHtml(index, disabled, status)}
    </article>`;
}

function actionsHtml(index, disabled, status) {
  return `
    <div class="comment-actions">
      <button type="button" data-action="onRepeat" data-index="${index}"${disabled}>同じ対象に追加</button>
      <button type="button" class="status-action" data-action="onToggleStatus" data-index="${index}"${disabled}>${status === 'resolved' ? '未解決に戻す' : '解決済みにする'}</button>
      <button type="button" data-action="onRequestDelete" data-index="${index}"${disabled}>削除</button>
    </div>`;
}

function deleteConfirmHtml(index) {
  return `
    <div class="comment-confirm" role="group" aria-label="コメントの削除確認">
      <p>このコメントを削除しますか？</p>
      <div class="comment-actions">
        <button type="button" data-action="onCancelDelete" data-index="${index}">やめる</button>
        <button type="button" class="danger" data-action="onConfirmDelete" data-index="${index}">削除する</button>
      </div>
    </div>`;
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
