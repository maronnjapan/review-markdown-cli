import { createAutosave } from './autosave.js';
import { refreshCommentAttachment, renderCommentHighlights } from './commentAnchors.js';
import { renderDiagrams } from './diagrams.js';
import {
  blockFormatAt,
  continueBlockOnEnter,
  insertLink,
  linkifyPaste,
  setHeadingLevel,
  shiftListIndent,
  toggleCodeFence,
  toggleInlineMarker,
  toggleLinePrefix
} from './markdownEditing.js';

const PREVIEW_DELAY_MS = 250;
const PREVIEW_BLOCK_SELECTOR = 'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6';
const PREVIEW_PREFERENCE_KEY = 'review-markdown:editor-preview';

/**
 * 編集モード。書くのは生のMarkdownそのもので、隣に組んだ結果を出します。
 *
 * 以前はレンダリング後のHTMLを直接いじらせていました（WYSIWYG）。見たまま書けるのは
 * よいのですが、保存のたびにHTMLをMarkdownへ戻すため、`:::message` や脚注、`$式$`、
 * 画像の `=250x`、埋め込みのURLといった、Zennの記法が書き換わったり消えたりしました。
 * 触っていない行まで `  ` （行末の空白2つ）が付くのも同じ理由です。加えて、ブロックごとに
 * contenteditable を分けていたので、ブロックをまたぐ選択・行の結合・取り消し（Ctrl+Z）が
 * 揃って壊れていました。どれも作りから来るもので、直し切るには本文の内部表現を持つ
 * エディタ基盤（ProseMirror など）が要ります。このアプリはビルド無しの素のESMで動く
 * ことを選んでいるので、その道は取らず、書いたものがそのまま保存される形に戻します。
 *
 * 保存は変わった範囲だけを送ります。textareaの中身と最後に受け取った本文を比べ、
 * 前後の一致する部分を除いた1か所だけを `/api/file` へ渡すので、触っていない行は
 * ファイルの中で1バイトも動きません。
 */
export function createEditor({ refs, state, api, onCommentsChanged, onDocumentUpdated, onPreviewRendered }) {
  const source = refs.markdownSource;
  const preview = refs.markdownContent;
  const autosave = createAutosave({ save: saveDocument, hasPendingWork: hasUnsavedText });
  let previewRequest = 0;
  let previewTimer = null;
  let previewVisible = readPreviewPreference();

  refs.retrySaveButton.addEventListener('click', () => autosave.run());
  refs.previewToggle.addEventListener('click', () => setPreviewVisible(!previewVisible));
  refs.blockFormat.addEventListener('change', () => {
    const level = refs.blockFormat.value === 'p' ? 0 : Number(refs.blockFormat.value.slice(1));
    applyEdit(setHeadingLevel(source.value, source.selectionStart, source.selectionEnd, level));
  });
  refs.editorToolbar.addEventListener('mousedown', (event) => {
    // ボタンがクリックを受けるあいだも、カーソルは本文に残しておきます。
    if (event.target.closest('button, select')) event.preventDefault();
  });
  refs.editorToolbar.addEventListener('click', handleToolbarClick);

  source.addEventListener('input', handleInput);
  source.addEventListener('keydown', handleKeyDown);
  source.addEventListener('paste', handlePaste);
  source.addEventListener('keyup', syncBlockFormat);
  source.addEventListener('click', syncBlockFormat);

  function render() {
    source.value = state.markdown;
    source.setSelectionRange(0, 0);
    applyPreviewHtml(state.rawHtml, ++previewRequest);
    setPreviewVisible(previewVisible);
    source.focus();
  }

  function hasUnsavedText() {
    return state.mode === 'edit' && source.value !== state.markdown;
  }

  function handleInput() {
    if (!hasUnsavedText()) {
      // 打ち消して元通りになった。保存するものは無く、直前の失敗も無かったことになります。
      state.saveFailed = false;
      autosave.cancel();
      setStatus('saved', '保存済み');
    } else {
      setStatus('dirty', '未保存の変更があります');
      autosave.schedule();
    }
    schedulePreview();
    syncBlockFormat();
  }

  /* ---------------------------------------------------------------- *
   * 書きながらの手当て
   * ---------------------------------------------------------------- */

  function handleKeyDown(event) {
    // 変換中のEnterは確定です。ここで拾うと、変換候補を選べなくなります。
    if (event.isComposing || event.keyCode === 229) return;
    const shortcutKey = event.ctrlKey || event.metaKey;

    if (shortcutKey && !event.shiftKey && !event.altKey) {
      const marker = { b: '**', i: '*' }[event.key.toLowerCase()];
      if (marker) {
        event.preventDefault();
        return applyEdit(toggleInlineMarker(source.value, source.selectionStart, source.selectionEnd, marker));
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        return promptForLink();
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        autosave.run();
        return;
      }
    }

    if (event.key === 'Enter' && !shortcutKey && !event.shiftKey && !event.altKey) {
      const edit = continueBlockOnEnter(source.value, source.selectionStart, source.selectionEnd);
      if (!edit) return;
      event.preventDefault();
      return applyEdit(edit);
    }

    if (event.key === 'Tab' && !shortcutKey && !event.altKey) {
      const edit = shiftListIndent(source.value, source.selectionStart, source.selectionEnd,
        { outdent: event.shiftKey });
      // リストの行でなければTabは渡します。キーボードだけで編集欄から出られるようにするためです。
      if (!edit) return;
      event.preventDefault();
      return applyEdit(edit);
    }
  }

  function handlePaste(event) {
    const pasted = event.clipboardData?.getData('text/plain') || '';
    const edit = linkifyPaste(source.value, source.selectionStart, source.selectionEnd, pasted);
    if (!edit) return;
    event.preventDefault();
    applyEdit(edit);
  }

  /* ---------------------------------------------------------------- *
   * 書式のボタン
   * ---------------------------------------------------------------- */

  function handleToolbarClick(event) {
    const button = event.target.closest('button');
    if (!button || state.mode !== 'edit') return;
    const action = button.dataset.editorAction;
    if (!action) return;
    source.focus();

    const start = source.selectionStart;
    const end = source.selectionEnd;
    const marker = { bold: '**', italic: '*', 'inline-code': '`', strike: '~~' }[action];
    if (marker) return applyEdit(toggleInlineMarker(source.value, start, end, marker));

    const prefix = { 'bullet-list': '- ', 'ordered-list': '1. ', blockquote: '> ' }[action];
    if (prefix) return applyEdit(toggleLinePrefix(source.value, start, end, prefix));

    if (action === 'code-block') return applyEdit(toggleCodeFence(source.value, start, end));
    if (action === 'link') return promptForLink();
  }

  function promptForLink() {
    const url = source.ownerDocument.defaultView.prompt('リンク先URL', 'https://');
    if (url === null) return;
    applyEdit(insertLink(source.value, source.selectionStart, source.selectionEnd, url.trim()));
  }

  /**
   * 組み立てた書き換えを本文に当てます。
   *
   * `insertText` を通すのは、ブラウザの取り消し（Ctrl/⌘+Z）にこの1手を積むためです。
   * 値を直接書き換えると履歴が切れて、ボタンで入れた印だけ戻せなくなります。
   */
  function applyEdit(edit) {
    if (!edit) return;
    source.focus();
    source.setSelectionRange(edit.start, edit.end);
    const before = source.value;
    let inserted = false;
    try {
      inserted = source.ownerDocument.execCommand('insertText', false, edit.insert);
    } catch {
      inserted = false;
    }
    if (!inserted || source.value === before) source.setRangeText(edit.insert, edit.start, edit.end, 'end');
    source.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    handleInput();
  }

  function syncBlockFormat() {
    if (state.mode !== 'edit') return;
    refs.blockFormat.value = blockFormatAt(source.value, source.selectionStart);
  }

  /* ---------------------------------------------------------------- *
   * 隣に出す組み上がり
   * ---------------------------------------------------------------- */

  function setPreviewVisible(visible) {
    previewVisible = visible;
    refs.editorShell.classList.toggle('preview-hidden', !visible);
    refs.previewToggle.setAttribute('aria-pressed', String(visible));
    refs.previewToggle.textContent = visible ? 'プレビューを隠す' : 'プレビューを出す';
    try {
      source.ownerDocument.defaultView.localStorage?.setItem(PREVIEW_PREFERENCE_KEY, visible ? 'on' : 'off');
    } catch {
      // 保存できない設定（プライベートウィンドウなど）でも、この画面のあいだは効かせます。
    }
  }

  function readPreviewPreference() {
    try {
      return refs.markdownSource.ownerDocument.defaultView.localStorage?.getItem(PREVIEW_PREFERENCE_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, PREVIEW_DELAY_MS);
  }

  /** 組むのはサーバーです。読む画面と同じ手を通すので、出るものも同じになります。 */
  async function refreshPreview() {
    if (state.mode !== 'edit' || !state.currentPath) return;
    const request = ++previewRequest;
    const markdown = source.value;
    const documentPath = state.currentPath;
    try {
      const { html } = await api.renderMarkdown({ path: documentPath, markdown });
      if (request !== previewRequest || state.mode !== 'edit' || state.currentPath !== documentPath) return;
      applyPreviewHtml(html, request);
    } catch {
      // 組めなかったときは前の表示を残します。保存の可否は保存の欄が伝えます。
    }
  }

  function applyPreviewHtml(html, request) {
    preview.classList.add('preview');
    preview.innerHTML = html || '';
    // 消えた対象を先に見分けてから印を付けます。印はDOMを包み変えるので、順番が逆だと
    // 「まだあるのに見つからない」コメントが出ます。
    refreshCommentAttachment(preview, state.comments);
    renderCommentHighlights(preview, state.comments, { blockSelector: PREVIEW_BLOCK_SELECTOR });
    onCommentsChanged();
    onPreviewRendered?.();
    renderDiagrams(preview, { isStillCurrent: () => state.mode === 'edit' && request === previewRequest });
  }

  /* ---------------------------------------------------------------- *
   * 保存
   * ---------------------------------------------------------------- */

  async function saveDocument() {
    const markdown = source.value;
    const change = changedRange(state.markdown, markdown);
    if (!change) {
      state.saveFailed = false;
      setStatus('saved', '保存済み');
      return true;
    }

    setStatus('saving', '保存中…');
    const documentPath = state.currentPath;
    try {
      const result = await api.saveFile({
        path: documentPath,
        edits: [{
          blockId: 'document',
          start: change.start,
          end: change.end,
          markdown: change.insert,
          // 送った位置が今のファイルにも当てはまるかの申告です。別のエディタで書き換え
          // られていたら、当てずに断ってもらいます。
          before: state.markdown.slice(change.start, change.end)
        }],
        comments: state.comments
      });
      if (state.currentPath !== documentPath) return true;

      onDocumentUpdated(result);
      state.saveFailed = false;
      // 保存が返した本文が画面と同じなら、組み直しは要りません。返ってきたものを出します。
      if (source.value === result.markdown) {
        clearTimeout(previewTimer);
        applyPreviewHtml(result.html, ++previewRequest);
      }
      if (hasUnsavedText()) autosave.schedule();
      else setStatus('saved', '保存済み');
      return true;
    } catch (error) {
      state.saveFailed = true;
      setStatus('error', `保存できませんでした: ${error.message}`);
      return false;
    }
  }

  function setStatus(status, message) {
    refs.editorSaveRow.dataset.state = status;
    refs.editorSaveStatus.textContent = message;
    refs.retrySaveButton.classList.toggle('hidden', status !== 'error');
  }

  return {
    render,
    setStatus,
    flush: autosave.flush,
    cancel: autosave.cancel,
    hasUnsavedChanges: () => hasUnsavedText() || state.saveFailed || autosave.isBusy()
  };
}

/**
 * 2つの本文で違うのは1か所だけ、という形にまとめます。前と後ろの一致する分を削るので、
 * 打った文字のまわりだけが置き換え範囲になり、離れた行はファイルの中で動きません。
 *
 * @returns {{start: number, end: number, insert: string}|null} 同じなら null
 */
export function changedRange(before, after) {
  const source = String(before);
  const updated = String(after);
  if (source === updated) return null;

  const shortest = Math.min(source.length, updated.length);
  let head = 0;
  while (head < shortest && source[head] === updated[head]) head += 1;
  // サロゲートペアの途中では切りません。片割れだけの文字を送らないためです。
  if (head > 0 && isLowSurrogate(source.charCodeAt(head))) head -= 1;

  let tail = 0;
  while (tail < shortest - head && source[source.length - 1 - tail] === updated[updated.length - 1 - tail]) {
    tail += 1;
  }
  if (tail > 0 && isLowSurrogate(source.charCodeAt(source.length - tail))) tail -= 1;

  return { start: head, end: source.length - tail, insert: updated.slice(head, updated.length - tail) };
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}
