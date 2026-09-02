/**
 * Meet連携のダイアログです。
 *
 * 同梱の拡張機能（`extension/`）とこのCLIを繋ぐのに要るのは、拡張機能フォルダの場所と、
 * 連携コードの2つだけです。どちらもターミナルの起動ログにも出ますが、原稿を読んでいる
 * 途中でターミナルへ戻り、長い文字列を目で拾って写すのは、いちばん間違えやすいところ
 * でした。画面から「コピー」で運べるようにして、写し間違いを無くします。
 *
 * トークンは起動のたびに変わるので、この画面が出す値も起動のたびに変わります。開くたびに
 * 取りに行くのは、前の起動のコードを掴んだまま「繋がらない」と悩ませないためです。
 */

export function createLiveCaptionsController({ refs, api, toaster }) {
  bindEvents();

  async function open() {
    refs.liveCaptionsDialog.showModal();
    setError('');
    setState('読み込み中…', null);
    try {
      render(await api.readLiveCaptions());
    } catch (error) {
      // 繋ぐための値が出せないときは、空欄をコピーさせません。空の連携コードを貼ると、
      // 拡張機能側では「設定していない」と区別が付かなくなります。
      refs.liveCaptionsCode.value = '';
      refs.liveCaptionsExtensionDir.value = '';
      setState('連携情報を読み込めません', 'error');
      setError(`連携情報を読み込めませんでした: ${error.message}`);
    }
  }

  function close() {
    refs.liveCaptionsDialog.close();
  }

  function render(info) {
    refs.liveCaptionsCode.value = info.pairingCode || '';
    refs.liveCaptionsExtensionDir.value = info.extensionDir || '';
    refs.liveCaptionsDetail.textContent = info.serverUrl
      ? `内訳: サーバー ${info.serverUrl} ／ トークンは起動ごとに変わります`
      : '';
    setState('連携できます', 'ready');
  }

  /**
   * クリップボードは、ページが表に出ていないと断られることがあります。断られたときは
   * 欄を選択状態にして、手でコピーできる形にしてから知らせます。
   */
  async function copy(input, label) {
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      toaster.success(`${label}をコピーしました。`);
    } catch {
      toaster.error(`${label}をコピーできませんでした。選択したので、手でコピーしてください。`);
    }
  }

  function setState(text, state) {
    refs.liveCaptionsState.textContent = text;
    if (state) refs.liveCaptionsState.dataset.state = state;
    else delete refs.liveCaptionsState.dataset.state;
  }

  function setError(text) {
    refs.liveCaptionsError.textContent = text;
    refs.liveCaptionsError.hidden = !text;
  }

  function bindEvents() {
    refs.liveCaptionsButton.addEventListener('click', open);
    refs.liveCaptionsClose.addEventListener('click', close);
    refs.liveCaptionsCopyCode.addEventListener('click', () => copy(refs.liveCaptionsCode, '連携コード'));
    refs.liveCaptionsCopyDir.addEventListener(
      'click',
      () => copy(refs.liveCaptionsExtensionDir, '拡張機能フォルダ')
    );
  }

  return { open, close };
}
