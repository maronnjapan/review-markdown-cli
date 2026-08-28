const MAX_AI_CONTEXT_CHARS = 4_000;

const STATUS_MESSAGES = {
  idle: '',
  dirty: '自動保存待ち…',
  saving: '保存中…',
  saved: '保存しました。次のAI操作から反映します。',
  toolong: `${MAX_AI_CONTEXT_CHARS}文字までです。超えた分は保存しません。`
};

/**
 * 「この文書はどんな前提で読むべきか」を書く欄。
 *
 * 書いた内容はレビューファイルへ保存し、翻訳・AIチャット・指摘の配置のどれでも
 * 同じ前提として AI へ渡します。保存はコメントと同じ自動保存に相乗りするので、
 * 書いた直後に質問しても、その前提込みで読ませられます。
 */
export function createAiContextController({ refs, state, onChange }) {
  bindEvents();

  /** Shows the context saved with the document that was just opened. */
  function load() {
    refs.aiContextInput.value = state.aiContext || '';
    renderProjectContext();
    setStatus(state.aiContextDirty ? 'dirty' : 'idle');
  }

  function setStatus(status, message) {
    refs.aiContextStatus.dataset.state = status;
    refs.aiContextStatus.textContent = message ?? STATUS_MESSAGES[status] ?? '';
    renderSummary();
  }

  /** The pane is collapsed by default, so the summary has to say whether one is set. */
  function renderSummary() {
    const hasDocumentContext = Boolean((state.aiContext || '').trim());
    const hasProjectContext = Boolean((state.projectAiContext || '').trim());
    refs.aiContextState.textContent = hasDocumentContext
      ? '設定済み'
      : hasProjectContext ? 'ディレクトリ全体の前提のみ' : '未設定';
    refs.aiContextState.dataset.state = hasDocumentContext || hasProjectContext ? 'set' : 'unset';
    // 「指摘の配置にも前提が渡る」の判定は、書いた前提とメモの両方を見ます。
    // 出す・出さないを1か所で決めるため、メモが増えたときもここを呼び直します。
    if (refs.placementContextHint) {
      refs.placementContextHint.hidden = !hasProjectContext
        && !hasDocumentContext
        && (state.contextNotes || []).length === 0;
    }
  }

  function renderProjectContext() {
    const projectContext = (state.projectAiContext || '').trim();
    refs.aiContextProject.hidden = !projectContext;
    refs.aiContextProjectText.textContent = projectContext;
  }

  /** Text past the limit stays on screen but never becomes what we save. */
  function handleInput() {
    const text = refs.aiContextInput.value;
    if (text.trim().length > MAX_AI_CONTEXT_CHARS) {
      setStatus('toolong');
      return;
    }
    if (text === state.aiContext) return;
    state.aiContext = text;
    renderProjectContext();
    setStatus('dirty');
    onChange();
  }

  function bindEvents() {
    refs.aiContextInput.addEventListener('input', handleInput);
  }

  return { load, setStatus, renderSummary };
}
