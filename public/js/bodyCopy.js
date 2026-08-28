/**
 * 本文をクリップボードへ渡します。
 *
 * コピーできるのは本文を持つファイルだけです。PDFや画像には貼り付けられる本文が
 * 無いので、ボタンはツールバーへ出しません。押せないボタンを置いておくより、
 * 無いほうが分かるからです。
 */
export function createBodyCopier({ document, window, refs, state, editor, toaster }) {
  /** ツールバーにコピーボタンを出すかどうか。文書を開くたびに呼びます。 */
  function syncControl() {
    refs.copyBodyButton?.classList.toggle('hidden', !state.textBody);
  }

  async function copy() {
    if (!state.textBody || !state.currentPath) return;
    // 編集中の変更がまだ残っていることがあります。コピーするのはファイルの中身です。
    if (state.mode === 'edit' && !(await editor.flush())) {
      toaster.error('本文を保存できていないため、コピーを中止しました。');
      return;
    }
    try {
      await writeToClipboard(state.markdown);
      toaster.success('本文をコピーしました。');
    } catch (error) {
      toaster.error(`本文をコピーできませんでした: ${error.message}`);
    }
  }

  function writeToClipboard(text) {
    const clipboard = window.navigator?.clipboard;
    if (clipboard?.writeText) return clipboard.writeText(text);
    return copyThroughHiddenField(text);
  }

  /** Fallback for browsers that withhold the async clipboard API on http://. */
  async function copyThroughHiddenField(text) {
    const carrier = document.createElement('textarea');
    carrier.value = text;
    carrier.setAttribute('readonly', '');
    carrier.style.position = 'fixed';
    carrier.style.top = '-1000px';
    document.body.append(carrier);
    try {
      carrier.select();
      if (!document.execCommand?.('copy')) throw new Error('クリップボードへ書き込めませんでした');
    } finally {
      carrier.remove();
    }
  }

  return { syncControl, copy };
}
