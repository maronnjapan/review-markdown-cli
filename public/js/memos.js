import { describeTarget, labelForType } from './comments.js';
import { createId, escapeHtml, formatTimestamp } from './util.js';

/**
 * メモは、本文のその場所に残す「自分のための覚え書き」です。
 *
 * コメントとの違いは宛先です。コメントは書き手やAIエージェントへの依頼なので、
 * 未解決・解決済みという状態を持ち、レビューMarkdownへ書き出され、本文の修正では
 * 直す理由として読まれます。メモは自分宛てなので、そのどれにも入りません。
 * 読んでいて浮かんだこと（あとで確かめる、この語は前の章と揃っていない気がする）を
 * その場に置けて、置いた瞬間に誰かの仕事にならない、というのがこの機能の全部です。
 *
 * 残す先の決め方（対象）はコメントとまったく同じで、追加ダイアログも同じものを使います
 * （`comments.js` の `KINDS`）。違うのは、保存先の項目と、この一覧と、本文での色だけです。
 *
 * 同じ「メモ」でも、AIに前提として読ませたいことはコンテキストメモ（`contextNotes.js`）
 * のほうです。分かれているのは「AIに読ませるために書く」か「自分のために書く」かという、
 * 書くときの構えの違いです。
 */

/** 状態を持たないので、コメントのような未解決・解決済みの見出しはありません。 */
export function newMemo(target, body) {
  return {
    id: createId('memo'),
    ...target,
    body,
    createdAt: new Date().toISOString()
  };
}

/** A fresh memo aimed at the same place as an existing one. */
export function copyMemoTarget(memo) {
  const target = { ...memo };
  delete target.id;
  delete target.body;
  delete target.createdAt;
  delete target.updatedAt;
  delete target.targetDetached;
  return target;
}

/**
 * メモの一覧を描きます。`handlers` には一覧での位置を渡すので、呼ぶ側がDOMから
 * 数え直さずに済みます（コメント一覧と同じ約束です）。
 */
export function renderMemoList(container, { memos, mode, pendingDeleteId, handlers }) {
  const readOnly = mode === 'edit';
  container.innerHTML = memos.length === 0
    ? '<p class="muted">まだメモはありません。読みながら浮かんだことを、その場所に残せます。</p>'
    : memos.map((memo, index) => memoCardHtml(memo, index, readOnly, pendingDeleteId)).join('');

  container.querySelectorAll('textarea[data-memo-index]').forEach((textarea) => {
    textarea.addEventListener('input', () => handlers.onEdit(Number(textarea.dataset.memoIndex), textarea.value));
  });
  container.querySelectorAll('[data-action]').forEach((button) => {
    const index = Number(button.dataset.index);
    button.addEventListener('click', () => handlers[button.dataset.action]?.(index));
  });
}

/**
 * カードの作りはコメントと同じにしてあります（`comment-card` を重ねています）。
 * 別物であることは色と「メモ」の札で伝わるので、押す場所まで変えると、
 * 同じ画面で2通りの操作を覚えることになります。
 */
function memoCardHtml(memo, index, readOnly, pendingDeleteId) {
  const disabled = readOnly ? ' disabled' : '';
  const confirming = memo.id && memo.id === pendingDeleteId;
  return `
    <article class="comment-card memo-card${memo.targetDetached ? ' detached' : ''}${confirming ? ' confirming' : ''}" data-memo-id="${escapeHtml(memo.id || '')}" data-memo-index="${index}" tabindex="-1">
      <div class="comment-meta">
        <div class="comment-meta-labels">
          <strong><span class="target-badge" data-type="${escapeHtml(memo.type || '')}">${escapeHtml(labelForType(memo.type, memo.documentType))}</span> ${index + 1}</strong>
          <span class="memo-badge">メモ</span>
        </div>
        <time>${escapeHtml(formatTimestamp(memo.updatedAt || memo.createdAt))}</time>
      </div>
      <button type="button" class="target-summary" data-action="onFocusTarget" data-index="${index}" title="本文のメモ対象へ移動">${escapeHtml(describeTarget(memo))}<span aria-hidden="true"> →</span></button>
      ${memo.targetDetached ? '<span class="detached-label">編集後の対象を特定できません</span>' : ''}
      <textarea data-memo-index="${index}" rows="4"${disabled}>${escapeHtml(memo.body || '')}</textarea>
      ${confirming ? deleteConfirmHtml(index) : actionsHtml(index, disabled)}
    </article>`;
}

function actionsHtml(index, disabled) {
  return `
    <div class="comment-actions">
      <button type="button" data-action="onRepeat" data-index="${index}"${disabled}>同じ対象に追加</button>
      <button type="button" data-action="onRequestDelete" data-index="${index}"${disabled}>削除</button>
    </div>`;
}

/** 取り消せない操作なので、確認の見え方と読み上げをコメントの削除確認と揃えます。 */
function deleteConfirmHtml(index) {
  return `
    <div class="comment-confirm" role="group" aria-label="メモの削除確認">
      <p>このメモを削除しますか？</p>
      <div class="comment-actions">
        <button type="button" data-action="onCancelDelete" data-index="${index}">やめる</button>
        <button type="button" class="danger" data-action="onConfirmDelete" data-index="${index}">削除する</button>
      </div>
    </div>`;
}
