import { createAutosave } from './autosave.js';
import { refreshCommentAttachment } from './commentAnchors.js';
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

const HEADING_LINE = /^([\t ]{0,3}(#{1,6})[\t ]+)(.+?)[\t ]*$/gm;

/**
 * 編集モード。画面いっぱいの1枚で、生のMarkdownをそのまま書き換えます。
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
 *
 * 組み上がりを隣へ並べることはしません。書く幅が半分になるほうが困りますし、
 * 読む形は `Ctrl/⌘+Shift+E` のコメントモードが1枚で出します。
 */
export function createEditor({ refs, state, api, onCommentsChanged, onDocumentUpdated, onOutlineChanged }) {
  const source = refs.markdownSource;
  const autosave = createAutosave({ save: saveDocument, hasPendingWork: hasUnsavedText });
  let lastOutline = null;

  refs.retrySaveButton.addEventListener('click', () => autosave.run());
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
    source.scrollTop = 0;
    lastOutline = null;
    notifyOutlineChanged();
    // 開いた時点の本文は読み込み済みなので、外れたコメントはここで見分けられます。
    adoptRenderedDocument(state.rawHtml);
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
    notifyOutlineChanged();
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
   * 見出しと、コメントの行き先
   * ---------------------------------------------------------------- */

  /** 書いているMarkdownそのものから拾う見出し。打った端から一覧に出ます。 */
  function outlineEntries() {
    return [...source.value.matchAll(HEADING_LINE)].map((match) => {
      const at = match.index + match[1].length;
      return {
        level: match[2].length,
        label: match[3],
        reveal: () => revealSource(at, match[3].length)
      };
    });
  }

  /** 見出しの並びが変わったときだけ知らせます。1打ごとに一覧を組み直さないためです。 */
  function notifyOutlineChanged() {
    const signature = outlineEntries().map((entry) => `${entry.level}:${entry.label}`).join('\n');
    if (signature === lastOutline) return;
    lastOutline = signature;
    onOutlineChanged?.();
  }

  /** 選んだところまでtextareaを送ります。入れ直すのは、カーソルの位置まで巻くためです。 */
  function revealSource(index, length) {
    source.blur();
    source.setSelectionRange(index, index + length);
    source.focus();
  }

  /**
   * サーバーが返した組み上がりの上で、コメントとメモの指す先がまだ在るかを引き直します。
   *
   * 画面には出しません。書く幅を削ってまで並べるものではなく、ここで要るのは
   * 「いまの本文で見つかるか」という答えだけだからです。
   */
  function adoptRenderedDocument(html) {
    const rendered = source.ownerDocument.createElement('div');
    rendered.innerHTML = html || '';
    refreshCommentAttachment(rendered, state.comments);
    refreshCommentAttachment(rendered, state.memos, 'memo');
    onCommentsChanged();
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
      adoptRenderedDocument(result.html);
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
    outlineEntries,
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
