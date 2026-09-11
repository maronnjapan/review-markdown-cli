import { createId, escapeHtml, formatTimestamp, truncate } from './util.js';

const TYPE_LABELS = {
  document: '文書全体',
  section: 'セクション',
  paragraph: '段落',
  'text-selection': '範囲選択'
};

/**
 * 残し方。同じ対象へ、同じダイアログから、どちらとして残すかだけを選びます。
 *
 * コメントは書き手やAIエージェントへの依頼です。だから未解決・解決済みという状態を持ち、
 * レビューMarkdownへ書き出され、本文の修正では直す理由として読まれます。
 * メモ（`memos.js`）は自分に宛てた覚え書きで、そのどれにも入りません。
 * ここで選ばせているのは、読んでいて浮かんだことが、置いた瞬間に誰かの仕事に
 * なってしまわないようにするためです。
 */
const KINDS = {
  comment: {
    title: 'コメントを追加',
    documentTitle: '文書全体にコメント',
    targetLabel: 'この対象にコメントします',
    fieldLabel: 'コメント',
    submit: 'この対象にコメントを追加',
    placeholder: '修正してほしい内容や意図を書いてください',
    hint: '書き手とAIへの依頼として残します。レビューMarkdownにも書き出します。',
    typeHints: {
      document: 'この文書全体に対する指摘として保存します。',
      section: 'この見出しと、その配下の本文に対する指摘として保存します。',
      paragraph: 'この段落に対する指摘として保存します。',
      'text-selection': '選択した文字列に対する指摘として保存します。'
    }
  },
  memo: {
    title: 'メモを残す',
    documentTitle: '文書全体にメモ',
    targetLabel: 'この対象にメモを残します',
    fieldLabel: 'メモ',
    submit: 'この対象にメモを残す',
    placeholder: '例：この節、第4章と重複していないか あとで確かめる',
    hint: '自分のための覚え書きです。AIへは渡さず、レビューMarkdownにも書き出しません。',
    typeHints: {
      document: 'この文書全体についての覚え書きとして残します。',
      section: 'この見出しと、その配下の本文についての覚え書きとして残します。',
      paragraph: 'この段落についての覚え書きとして残します。',
      'text-selection': '選択した文字列についての覚え書きとして残します。'
    }
  }
};

const STATUS_LABELS = {
  open: '未解決',
  resolved: '解決済み',
  resolveAction: '解決済みにする',
  reopenAction: '未解決に戻す'
};

/** どのAI機能が置いたコメントか。手で書いたコメントには印を付けません。 */
const SOURCE_LABELS = {
  ai: 'AI配置',
  'ai-review': 'AIレビュー'
};

const SEVERITY_LABELS = {
  must: '要対応',
  should: '検討',
  idea: '提案'
};

export function labelForType(type, documentType) {
  if (documentType === 'pdf' && type === 'text-selection') return 'PDF範囲選択';
  return TYPE_LABELS[type] || type || 'コメント';
}

export function commentTargetText(comment) {
  return comment.selectedText || comment.targetText || comment.heading || '';
}

export function describeTarget(target) {
  if (target.type === 'document') return '文書全体';
  if (target.documentType === 'pdf' && target.type === 'text-selection') {
    return `ページ ${target.pageNumber || '?'}・選択範囲: ${truncate(commentTargetText(target))}`;
  }
  if (target.type === 'section') return `見出し: ${target.heading || target.targetText || ''}`;
  if (target.type === 'paragraph') return `段落: ${truncate(commentTargetText(target))}`;
  if (target.type === 'text-selection') return `選択範囲: ${truncate(commentTargetText(target))}`;
  return labelForType(target.type, target.documentType);
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
  delete target.review;
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
 *
 * 残し方（コメント／メモ）もここで選びます。対象を決める操作は本文の同じボタンなので、
 * 選ぶ場所を分けると、押してから「こちらではなかった」と気づいて開き直すことになります。
 * 選び直しても書きかけの本文は消しません。
 */
export function createCommentDialog(refs, { onSubmit }) {
  let pendingTarget = null;

  refs.dialogForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  refs.cancelDialog.addEventListener('click', close);
  refs.dialogKind.addEventListener('change', syncKind);
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
    const kind = selectedKind();
    close();
    onSubmit(target, text, kind);
  }

  function open(target, kind = 'comment') {
    pendingTarget = target;
    refs.dialogTypeBadge.textContent = labelForType(target.type, target.documentType);
    refs.dialogTypeBadge.dataset.type = target.type || 'comment';

    const headingPath = target.documentType === 'pdf' && target.pageNumber
      ? [`ページ ${target.pageNumber}`]
      : Array.isArray(target.headingPath) ? target.headingPath.filter(Boolean) : [];
    refs.dialogTargetPath.textContent = headingPath.length ? headingPath.join(' › ') : '';
    refs.dialogTargetPath.hidden = headingPath.length === 0;

    refs.commentInput.value = '';
    for (const radio of kindRadios()) radio.checked = radio.value === (KINDS[kind] ? kind : 'comment');
    syncKind();
    refs.dialog.showModal();
    refs.commentInput.focus();
  }

  function close() {
    pendingTarget = null;
    refs.dialog.close();
  }

  function kindRadios() {
    return refs.dialogKind.querySelectorAll('input[type="radio"]');
  }

  function selectedKind() {
    return [...kindRadios()].find((radio) => radio.checked)?.value === 'memo' ? 'memo' : 'comment';
  }

  /** 選んだ残し方に合わせて、題・説明・ボタンの文言を入れ替えます。 */
  function syncKind() {
    if (!pendingTarget) return;
    const labels = KINDS[selectedKind()];
    refs.dialogTitle.textContent = pendingTarget.type === 'document' ? labels.documentTitle : labels.title;
    refs.dialogTargetLabel.textContent = labels.targetLabel;
    refs.dialogKindHint.textContent = labels.hint;
    refs.dialogFieldLabel.textContent = labels.fieldLabel;
    refs.submitDialog.textContent = labels.submit;
    refs.commentInput.placeholder = labels.placeholder;

    // 対象の文字が出せないとき（文書全体）だけ、どこへ残すのかを言葉で書きます。
    const quoted = pendingTarget.type === 'document' ? '' : commentTargetText(pendingTarget);
    refs.dialogTargetQuote.textContent = quoted || labels.typeHints[pendingTarget.type] || '';
    refs.dialogTargetQuote.classList.toggle('is-hint', !quoted);
    syncSubmitState();
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
export function renderCommentList(container, {
  comments, mode, pendingDeleteId, handlers, statusLabels = STATUS_LABELS
}) {
  const labels = { ...STATUS_LABELS, ...statusLabels };
  const readOnly = mode === 'edit';
  container.innerHTML = comments.length === 0
    ? '<p class="muted">まだコメントはありません。</p>'
    : ['open', 'resolved'].map((status) => commentGroupHtml(
      status,
      comments.map((comment, index) => ({ comment, index }))
        .filter(({ comment }) => statusForComment(comment) === status),
      readOnly,
      pendingDeleteId,
      labels
    )).join('');

  container.querySelectorAll('textarea[data-comment-index]').forEach((textarea) => {
    textarea.addEventListener('input', () => handlers.onEdit(Number(textarea.dataset.commentIndex), textarea.value));
  });
  container.querySelectorAll('[data-action]').forEach((button) => {
    const index = Number(button.dataset.index);
    button.addEventListener('click', () => handlers[button.dataset.action]?.(index));
  });
}

function commentGroupHtml(status, entries, readOnly, pendingDeleteId, labels) {
  if (entries.length === 0) return '';
  return `
    <section class="comment-group" data-status="${status}" aria-label="${labels[status]}のコメント">
      <div class="comment-group-header">
        <h3>${labels[status]}</h3>
        <span class="comment-group-count">${entries.length}</span>
      </div>
      <div class="comment-group-items">
        ${entries.map(({ comment, index }) => commentCardHtml(comment, index, readOnly, pendingDeleteId, labels)).join('')}
      </div>
    </section>`;
}

function commentCardHtml(comment, index, readOnly, pendingDeleteId, labels) {
  const disabled = readOnly ? ' disabled' : '';
  const confirming = comment.id && comment.id === pendingDeleteId;
  const status = statusForComment(comment);
  return `
    <article class="comment-card${comment.targetDetached ? ' detached' : ''}${confirming ? ' confirming' : ''}" data-comment-id="${escapeHtml(comment.id || '')}" data-comment-index="${index}" data-status="${status}" tabindex="-1">
      <div class="comment-meta">
        <div class="comment-meta-labels">
          <strong><span class="target-badge" data-type="${escapeHtml(comment.type || '')}">${escapeHtml(labelForType(comment.type, comment.documentType))}</span> ${index + 1}</strong>
          <span class="comment-status" data-status="${status}">${labels[status]}</span>
          ${SOURCE_LABELS[comment.source] ? `<span class="comment-source">${escapeHtml(SOURCE_LABELS[comment.source])}</span>` : ''}
        </div>
        <time>${escapeHtml(formatTimestamp(comment.createdAt))}</time>
      </div>
      <button type="button" class="target-summary" data-action="onFocusTarget" data-index="${index}" title="本文のコメント対象へ移動">${escapeHtml(describeTarget(comment))}<span aria-hidden="true"> →</span></button>
      ${reviewedPartHtml(comment)}
      ${comment.targetDetached ? '<span class="detached-label">編集後の対象を特定できません</span>' : ''}
      <textarea data-comment-index="${index}" rows="4"${disabled}>${escapeHtml(comment.comment || '')}</textarea>
      ${confirming ? deleteConfirmHtml(index) : actionsHtml(index, disabled, status, labels)}
    </article>`;
}

/**
 * AIレビューから追加したコメントには、レビューされた部分をそのまま添えます。
 * どのスキルがどこを読んで書いた指摘か、コメント一覧だけで追えるようにするためです。
 */
function reviewedPartHtml(comment) {
  if (!comment.review) return '';
  const { skillName, severity, reason, persona } = comment.review;
  const quoted = commentTargetText(comment);
  const meta = [
    skillName ? `スキル: ${skillName}` : '',
    persona ? `読み手: ${persona}` : '',
    SEVERITY_LABELS[severity] ? `重大度: ${SEVERITY_LABELS[severity]}` : ''
  ].filter(Boolean).join(' / ');
  return `
    <section class="comment-reviewed">
      <p class="comment-reviewed-label">レビューされた部分</p>
      ${quoted ? `<blockquote class="comment-reviewed-quote">${escapeHtml(quoted)}</blockquote>` : ''}
      ${meta ? `<p class="comment-reviewed-meta">${escapeHtml(meta)}</p>` : ''}
      ${reason ? `<p class="comment-reviewed-reason">${escapeHtml(reason)}</p>` : ''}
    </section>`;
}

/**
 * コメント1件でできること。
 *
 * 「判断として保存」だけは、このコメントを別の場所（保存した判断）へ移す道です。
 * コメントは、この文書のこの場所についての依頼で、直せば役目が終わります。
 * そのなかに、次の文書でも効く決定が混ざっていることがあり、それを残すための導線です。
 * 自動では移しません。コメントを書いた時点では、まだ判断が固まっていないことが多いからです。
 */
function actionsHtml(index, disabled, status, labels) {
  return `
    <div class="comment-actions">
      <button type="button" data-action="onRepeat" data-index="${index}"${disabled}>同じ対象に追加</button>
      <button type="button" data-action="onSaveContext" data-index="${index}"${disabled}>判断として保存</button>
      <button type="button" class="status-action" data-action="onToggleStatus" data-index="${index}"${disabled}>${status === 'resolved' ? labels.reopenAction : labels.resolveAction}</button>
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
