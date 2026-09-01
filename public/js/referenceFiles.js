import { escapeHtml } from './util.js';

/** サーバー側の上限と同じです（src/aiLimits.js）。超えて送ると保存時に断られます。 */
const MAX_REFERENCE_FILES = 8;

const STATUS_MESSAGES = {
  idle: '',
  loading: '添えられるファイルを探しています…',
  dirty: '自動保存待ち…',
  saving: '保存中…',
  saved: '保存しました。次のAI操作から反映します。'
};

/**
 * 同階層以下のファイルを、この文書に添える欄。
 *
 * 添えたファイルは読み取りコンテキストと同じ前提として、翻訳・AIチャット・指摘の配置・
 * AIレビューすべてへ渡ります。保存するのはパスだけで、中身はAIへ渡すたびにサーバーが
 * 読み直します（`src/referenceFiles.js`）。隣のファイルを直したら、次のAI操作から
 * 直したあとの中身で読ませられます。
 *
 * 選べるのはこの文書のディレクトリと、その下だけです。
 *
 * ── 一覧を引くのは1回だけ ────────────────────────────────
 * この操作盤はサイドパネルとコンテキスト画面の2つ作られます（`createApp.js` の fanOut）。
 * 一覧はどちらも同じものを見るので、取りに行くのは先に `load()` された1つだけにして、
 * 届いたことは `onCandidatesChanged` で呼び側へ返します。呼び側が両方を描き直します。
 */
export function createReferenceFilesController({ refs, state, api, toaster, onChange, onCandidatesChanged }) {
  bindEvents();

  /** 文書を開いたときの初期化。選べるファイルの一覧は、まだ無ければ引きます。 */
  function load() {
    refs.referenceFileFilter.value = '';
    render();
    if (state.referenceCandidates || !state.currentPath) {
      return setStatus(state.referenceFilesDirty ? 'dirty' : 'idle');
    }
    setStatus('loading');
    // 取りに行くかどうかは、awaitより前に決めます。あとで決めると、2つの操作盤が
    // どちらも「まだ無い」を見て、同じ一覧を2回取りに行きます。
    if (state.referenceCandidatesLoading) return;
    state.referenceCandidatesLoading = true;
    loadCandidates(state.currentPath);
  }

  /**
   * 選べるファイルの一覧をサーバーから引きます。
   *
   * 引けなくても投げません。添えたファイルはすでに保存済みで、外すことは一覧が無くても
   * できます。引けないのは「新しく添えられない」だけです。
   */
  async function loadCandidates(path) {
    try {
      const listed = await api.listReferenceFiles(path);
      // 引いている間に別の文書へ移っていたら、そちらの一覧で上書きしません。
      if (state.currentPath !== path) return;
      state.referenceCandidates = listed;
      // 一覧に載りきらなかったことは、届いたこの1回だけ言います。描き直すたびに言うと、
      // 保存の「保存しました」を上書きし続けます。
      onCandidatesChanged(listed.total > listed.files.length
        ? `同階層以下に${listed.total}件あります。先頭${listed.files.length}件を出しているので、絞り込んでください。`
        : undefined);
    } catch (error) {
      if (state.currentPath !== path) return;
      onCandidatesChanged(`添えられるファイルを探せませんでした: ${error.message}`, 'error');
    } finally {
      if (state.currentPath === path) state.referenceCandidatesLoading = false;
    }
  }

  function setStatus(status, message) {
    refs.referenceFilesStatus.dataset.state = status;
    refs.referenceFilesStatus.textContent = message ?? STATUS_MESSAGES[status] ?? '';
  }

  /* ---------------------------------------------------------------- *
   * 添える・外す
   * ---------------------------------------------------------------- */

  function attach() {
    const path = refs.referenceFileSelect.value;
    if (!path || state.referenceFiles.includes(path)) return;
    if (state.referenceFiles.length >= MAX_REFERENCE_FILES) {
      toaster.error(`参照ファイルは${MAX_REFERENCE_FILES}件までです。読ませないものを外してください。`);
      return;
    }
    // 一覧はその場で書き換えず、必ず新しい配列へ差し替えます。保存中に添えた1件が
    // 失われないための約束です（`createApp.js` の pushComments が同一性で見ています）。
    state.referenceFiles = [...state.referenceFiles, path];
    onChange();
    toaster.success(`${path} を添えました。自動保存します。`);
  }

  function detach(path) {
    if (!state.referenceFiles.includes(path)) return;
    state.referenceFiles = state.referenceFiles.filter((entry) => entry !== path);
    onChange();
    toaster.info(`${path} を外しました。もう読ませません。`);
  }

  /* ---------------------------------------------------------------- *
   * 表示
   * ---------------------------------------------------------------- */

  function render() {
    const attached = state.referenceFiles;
    refs.referenceFilesState.textContent = attached.length ? `${attached.length}件` : '未設定';
    refs.referenceFilesState.dataset.state = attached.length ? 'set' : 'unset';
    refs.referenceFilesFull.hidden = attached.length < MAX_REFERENCE_FILES;
    refs.referenceFilesList.innerHTML = attached.length
      ? attached.map(attachedHtml).join('')
      : '<p class="muted">まだ何も添えていません。用語集や前の章を添えると、AIはその中身も読んだうえで答えます。</p>';
    renderCandidates();
  }

  /**
   * 添えられるファイルの選択欄。すでに添えたものは出しません。
   *
   * 一覧をまだ引けていないときも、選択欄に1件だけ理由を出します。空のまま出すと、
   * 「探している最中」と「選べるファイルが1つも無い」が見分けられません。
   */
  function renderCandidates() {
    const listed = state.referenceCandidates;
    const filter = refs.referenceFileFilter.value.trim().toLowerCase();
    const attached = new Set(state.referenceFiles);
    const candidates = (listed?.files || [])
      .filter((entry) => !attached.has(entry.path))
      .filter((entry) => !filter || entry.path.toLowerCase().includes(filter));

    refs.referenceFileSelect.innerHTML = candidates.length
      ? candidates.map(candidateHtml).join('')
      : `<option value="">${escapeHtml(emptyCandidateLabel(listed, filter))}</option>`;
    refs.referenceFileAdd.disabled = candidates.length === 0
      || state.referenceFiles.length >= MAX_REFERENCE_FILES;
    refs.referenceFileFilter.disabled = !listed;
  }

  function emptyCandidateLabel(listed, filter) {
    if (!listed) return '探しています…';
    if (filter) return '絞り込みに一致するファイルがありません';
    return listed.files.length ? 'すべて添えてあります' : '同階層以下に添えられるファイルがありません';
  }

  function candidateHtml({ path, kind }) {
    return `<option value="${escapeHtml(path)}">${escapeHtml(kind === 'pdf' ? `${path}（PDF）` : path)}</option>`;
  }

  function attachedHtml(path) {
    const kind = state.referenceCandidates?.files?.find((entry) => entry.path === path)?.kind;
    return `
      <article class="reference-file" data-reference-path="${escapeHtml(path)}">
        <p class="reference-file-path">${escapeHtml(path)}</p>
        ${kind === 'pdf' ? '<span class="reference-file-kind">PDF</span>' : ''}
        <div class="reference-file-item-actions">
          <button type="button" data-reference-detach="${escapeHtml(path)}">外す</button>
        </div>
      </article>`;
  }

  function bindEvents() {
    refs.referenceFileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      attach();
    });
    refs.referenceFileFilter.addEventListener('input', renderCandidates);
    refs.referenceFilesList.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button?.dataset.referenceDetach) detach(button.dataset.referenceDetach);
    });
  }

  return { load, render, setStatus };
}
