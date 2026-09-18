/**
 * ページの画面です。題名とブロックエディタを置き、書いたそばから保存します。
 *
 * ── 保存は間引き、離れるときは待たない ─────────────────────
 * 入力のたびに送ると、1文字ごとに要求が飛びます。0.5秒止まったら送り、送っている最中に
 * さらに変わっていたら、終わってからもう1回送ります。別のページへ移るときは間引きを待たず、
 * その場で送ります（`flush`）。移った先で古い本文が見えるのを防ぐためです。
 */

import { createEditor } from './editor.js';
import { debounce, el, formatDateTime, untitled } from './util.js';

const SAVE_DELAY_MS = 500;

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.api
 * @param {Function} options.onStatus `(state, message)`。`state` は `saved` / `saving` / `dirty` / `error`。
 * @param {Function} options.onTitleChange `(pageId, title)` サイドバーの名前を合わせるため。
 * @param {Function} options.onSaved `(page)` 保存したページ（サーバの返事）。
 */
export function createPageView({ root, api, onStatus = () => {}, onTitleChange = () => {}, onSaved = () => {} }) {
  let current = null;
  let dirty = false;
  let saving = false;
  let editor = null;
  let titleInput = null;
  let metaElement = null;

  const scheduleSave = debounce(() => save(), SAVE_DELAY_MS);

  function markDirty() {
    if (!current) return;
    dirty = true;
    onStatus('dirty', '未保存');
    scheduleSave();
  }

  async function save() {
    if (!current || !dirty) return;
    if (saving) return;
    const page = current;
    const payload = { title: titleInput.value, content: editor.getContent() };
    dirty = false;
    saving = true;
    onStatus('saving', '保存中…');
    try {
      const result = await api.patchPage(page.page_id, payload);
      if (current === page) {
        current = { ...current, ...result.page, content: payload.content, title: payload.title };
        onSaved(current);
        paintMeta();
        onStatus('saved', `保存済み ${formatDateTime(current.updated_at).slice(11)}`);
        // 索引は保存のあとで作られます。少し待って、「検索できます」へ変わったかを見に行きます。
        if (result.page?.index?.status === 'pending') {
          setTimeout(() => {
            if (current !== page || dirty || saving) return;
            api.page(page.page_id).then(refresh).catch(() => {});
          }, 1500);
        }
      }
    } catch (error) {
      if (current === page) {
        dirty = true;
        onStatus('error', `保存できませんでした: ${error.message}`);
        scheduleSave();
      }
    } finally {
      saving = false;
      if (current === page && dirty) scheduleSave();
    }
  }

  function paintMeta() {
    if (!metaElement || !current) return;
    const index = current.index || {};
    const indexLabel = index.status === 'pending' ? '索引を作成中' : index.status === 'failed' ? `索引に失敗（${index.error || ''}）` : '検索できます';
    metaElement.textContent = `最終更新 ${formatDateTime(current.updated_at)} · ${indexLabel}`;
    metaElement.dataset.state = index.status || 'indexed';
  }

  function show(page) {
    scheduleSave.cancel();
    current = page;
    dirty = false;
    root.replaceChildren();
    const article = el('article', { class: 'page' });
    titleInput = el('input', {
      class: 'page-title',
      type: 'text',
      placeholder: '無題',
      'aria-label': 'ページの題名',
      maxlength: '200',
      autocomplete: 'off',
      spellcheck: 'true'
    });
    titleInput.value = page.title || '';
    titleInput.addEventListener('input', () => {
      onTitleChange(page.page_id, titleInput.value);
      markDirty();
    });
    titleInput.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter' || event.key === 'ArrowDown') {
        event.preventDefault();
        editor.focusFirst();
      }
    });
    metaElement = el('p', { class: 'page-meta' });
    const body = el('div', { class: 'page-body' });
    article.append(titleInput, metaElement, body);
    root.append(article);

    editor = createEditor({
      root: body,
      onChange: markDirty,
      onExitUp: () => titleInput.focus()
    });
    editor.setContent(page.content || '');
    paintMeta();
    onStatus('saved', page.updated_at ? `保存済み ${formatDateTime(page.updated_at).slice(11)}` : '');
    if (!page.title && !page.content) titleInput.focus();
    document.title = `${untitled(page.title)} · Knowledge`;
  }

  /**
   * サーバから読み直したページを受け取ったとき。手元で直していなければ、別のタブや
   * エージェントが書き換えたぶんを取り込みます。直している最中なら、索引の状態だけを合わせます。
   */
  function refresh(page) {
    if (!current || current.page_id !== page.page_id) return;
    const changedElsewhere = !dirty && !saving && page.updated_at !== current.updated_at
      && (page.content !== current.content || page.title !== current.title);
    if (changedElsewhere && !editor.isEditing()) {
      show(page);
      return;
    }
    current = { ...current, index: page.index, updated_at: dirty ? current.updated_at : page.updated_at };
    paintMeta();
  }

  return {
    show,
    hide() {
      flush();
      current = null;
      root.replaceChildren();
    },
    /** 間引きを待たずに保存します。ページを離れるときと、⌘Sで呼びます。 */
    flush,
    currentPageId: () => current?.page_id ?? null,
    focusTitle: () => titleInput?.focus(),
    refresh
  };

  function flush() {
    if (!current) return Promise.resolve();
    scheduleSave.cancel();
    editor?.commit();
    return save();
  }
}
