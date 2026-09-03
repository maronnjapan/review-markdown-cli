const MAX_AI_CONTEXT_CHARS = 4_000;

const STATUS_MESSAGES = {
  idle: '',
  dirty: '自動保存待ち…',
  saving: '保存中…',
  saved: '保存しました。次のAI操作から反映します。',
  toolong: `${MAX_AI_CONTEXT_CHARS}文字までです。超えた分は保存しません。`
};

/**
 * 適用範囲ごとの文言と、書き換える state のキーです。欄は1つで、選んだ範囲によって
 * 書く先と説明が変わります。分岐を関数のあちこちに散らすより、表を1つ置いて引くほうが、
 * 範囲を足したときに直す場所を探さずに済みます。
 */
const SCOPES = {
  document: {
    value: 'aiContext',
    hint: () => 'いま開いているファイルだけに効きます。',
    otherLabel: 'このディレクトリ全体の前提（画面で設定）',
    placeholder: '例：Node.js入門書の第3章。読者はJavaScriptの基礎を知っている前提。用語は原著の訳語に合わせる。'
  },
  directory: {
    value: 'directoryAiContext',
    // 保存先はサーバーが言ってきたものを出します。どのファイルに書いたのかを、
    // 画面から辿れるようにするためです（レビューファイルのパスと同じ扱い）。
    hint: (state) => 'コマンドを実行したディレクトリ配下のすべての文書に効きます。'
      + `保存先は ${state.directoryContextFile || '.review/context.json'} です。`,
    otherLabel: 'このファイルだけの前提',
    placeholder: '例：この本は入門者向け。読者はJavaScriptの基礎を知っている。用語は原著の訳語に合わせる。'
  }
};

const DEFAULT_SCOPE = 'document';

/**
 * 「この文書はどんな前提で読むべきか」を書く欄。
 *
 * 書いた内容は翻訳・AIチャット・指摘の配置・AIレビューのどれでも、同じ前提として
 * AI へ渡します。保存はコメントと同じ自動保存に相乗りするので、書いた直後に質問しても、
 * その前提込みで読ませられます。
 *
 * ── 適用範囲を選べるようにしてある理由 ────────────────────
 * 前提には、その文書にしか当てはまらないもの（「この章は前の版から移してきた」）と、
 * 束ねている原稿すべてに当てはまるもの（「この本は入門者向け」）があります。後者を
 * 文書ごとの欄にしか書けないと、章の数だけ同じ文章を書き写し、直すときも同じ数だけ
 * 直すことになります。範囲を選べば、書く先が1か所で済みます。
 *
 * 欄を2つ並べずに1つの欄と範囲の選択にしてあるのは、サイドパネルの幅では2つ目の欄が
 * 畳まれて見えなくなるからです。代わりに、いま書いていないほうの前提を欄の下へ
 * 読み取り専用で出します。書いていないほうが消えたように見えないためです。
 */
export function createAiContextController({
  refs, state, onChange, onDirectoryChange = () => {}, onScopeChange = () => {}
}) {
  // 保存の状態は範囲ごとに持ちます。ファイルの前提を保存した直後に範囲を切り替えて
  // 「保存しました」と出ていると、まだ送っていないほうを送ったことになります。
  const statuses = { document: { state: 'idle', message: null }, directory: { state: 'idle', message: null } };

  bindEvents();

  /** Shows the context saved with the document that was just opened. */
  function load() {
    renderScope();
    setStatus(state.aiContextDirty ? 'dirty' : 'idle');
    setDirectoryStatus(state.directoryAiContextDirty ? 'dirty' : 'idle');
  }

  /** 文書ごとの前提の保存状態。呼ぶのは `createApp.js` の保存処理です。 */
  function setStatus(status, message) {
    statuses.document = { state: status, message };
    renderStatus();
    renderSummary();
  }

  /** ディレクトリ全体の前提の保存状態。行き先が違うので、状態も別に持ちます。 */
  function setDirectoryStatus(status, message) {
    statuses.directory = { state: status, message };
    renderStatus();
    renderSummary();
  }

  function scope() {
    return SCOPES[state.aiContextScope] ? state.aiContextScope : DEFAULT_SCOPE;
  }

  function textOf(scopeName) {
    return state[SCOPES[scopeName].value] || '';
  }

  function renderStatus() {
    const { state: status, message } = statuses[scope()];
    refs.aiContextStatus.dataset.state = status;
    refs.aiContextStatus.textContent = message ?? STATUS_MESSAGES[status] ?? '';
  }

  /** The pane is collapsed by default, so the summary has to say whether one is set. */
  function renderSummary() {
    const hasDocumentContext = Boolean(textOf('document').trim());
    const hasDirectoryContext = Boolean(textOf('directory').trim());
    const hasProjectContext = Boolean((state.projectAiContext || '').trim());
    refs.aiContextState.textContent = summaryLabel(hasDocumentContext, hasDirectoryContext, hasProjectContext);
    refs.aiContextState.dataset.state = hasDocumentContext || hasDirectoryContext || hasProjectContext
      ? 'set'
      : 'unset';
    // 「指摘の配置にも前提が渡る」の判定は、書いた前提・管理者の3点・メモ・
    // 添えたファイルをまとめて見ます。
    // 出す・出さないを1か所で決めるため、どれが増えたときもここを呼び直します。
    if (refs.placementContextHint) {
      refs.placementContextHint.hidden = !hasProjectContext
        && !hasDirectoryContext
        && !hasDocumentContext
        && !state.brief
        && (state.contextNotes || []).length === 0
        && (state.referenceFiles || []).length === 0;
    }
  }

  /** どの範囲に前提があるかまで出します。「設定済み」だけでは、どちらのことか分かりません。 */
  function summaryLabel(hasDocumentContext, hasDirectoryContext, hasProjectContext) {
    if (hasDocumentContext && hasDirectoryContext) return 'このファイル＋ディレクトリ全体';
    if (hasDocumentContext) return 'このファイルのみ';
    if (hasDirectoryContext) return 'ディレクトリ全体のみ';
    return hasProjectContext ? 'ディレクトリ全体の前提のみ' : '未設定';
  }

  /** 選んでいる範囲に合わせて、書く欄と説明を入れ替えます。 */
  function renderScope() {
    const current = scope();
    const spec = SCOPES[current];
    for (const input of scopeInputs()) input.checked = input.value === current;
    refs.aiContextScopeHint.textContent = spec.hint(state);
    refs.aiContextInput.placeholder = spec.placeholder;
    const { activeElement } = refs.aiContextInput.ownerDocument;
    if (activeElement !== refs.aiContextInput) refs.aiContextInput.value = textOf(current);
    renderOtherScope(current);
    renderProjectContext();
    renderStatus();
    renderSummary();
  }

  /**
   * いま書いていないほうの範囲の前提を、読み取り専用で出します。
   * 出さないと、範囲を切り替えた人には、さっきまで見えていた文章が消えたように見えます。
   */
  function renderOtherScope(current) {
    const other = current === 'document' ? 'directory' : 'document';
    const text = textOf(other).trim();
    refs.aiContextOther.hidden = !text;
    refs.aiContextOtherLabel.textContent = SCOPES[current].otherLabel;
    refs.aiContextOtherText.textContent = text;
  }

  function renderProjectContext() {
    const projectContext = (state.projectAiContext || '').trim();
    refs.aiContextProject.hidden = !projectContext;
    refs.aiContextProjectText.textContent = projectContext;
  }

  /**
   * もう一方の画面で書き換えられた前提を、こちらの欄へ映します。
   *
   * この欄は同じ内容をサイドパネルとコンテキスト画面の2か所へ出しています。片方で
   * 書いたものがもう片方に映らないと、古い文面の残った側で1文字打った瞬間に、
   * さっき書いた分がまるごと消えます。打っている最中の欄には触りません。
   * 選んでいる範囲も同じ state に置いてあるので、片方で切り替えればもう片方も従います。
   */
  function sync() {
    renderScope();
  }

  /** Text past the limit stays on screen but never becomes what we save. */
  function handleInput() {
    const current = scope();
    const text = refs.aiContextInput.value;
    if (text.trim().length > MAX_AI_CONTEXT_CHARS) {
      if (current === 'directory') setDirectoryStatus('toolong');
      else setStatus('toolong');
      return;
    }
    if (text === textOf(current)) return;
    state[SCOPES[current].value] = text;
    renderOtherScope(current);
    renderProjectContext();
    if (current === 'directory') {
      setDirectoryStatus('dirty');
      onDirectoryChange();
      return;
    }
    setStatus('dirty');
    onChange();
  }

  /**
   * 範囲を変えても、書いた前提はどちらも残します。切り替えは「どちらを書くか」の
   * 選択であって、前提の引っ越しではありません。移す仕組みにすると、押し間違いで
   * 効く範囲が黙って広がります。
   */
  function handleScopeChange(event) {
    const next = event.target.value;
    if (!SCOPES[next] || next === scope()) return;
    state.aiContextScope = next;
    renderScope();
    // 選んだ範囲も2か所で同じものを見せます。片方だけ切り替わっていると、
    // もう片方の欄がどちらの前提を映しているのか分からなくなります。
    onScopeChange();
  }

  function scopeInputs() {
    return refs.aiContextScope.querySelectorAll('input[type="radio"]');
  }

  function bindEvents() {
    refs.aiContextInput.addEventListener('input', handleInput);
    for (const input of scopeInputs()) input.addEventListener('change', handleScopeChange);
  }

  return { load, setStatus, setDirectoryStatus, renderSummary, sync };
}
