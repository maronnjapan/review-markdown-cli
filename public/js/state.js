/**
 * One mutable object shared by the controllers. Created per app instance so
 * nothing leaks between page loads (or between tests).
 */
export function createState() {
  return {
    // File list
    rootDir: '',
    files: [],
    filters: { include: [], exclude: [] },
    openDirs: new Set(),

    // Optional features are opt-in. The server repeats these flags with each
    // document response so a direct URL and a file-list navigation behave alike.
    features: { manager: false, translation: false },
    // 設定ダイアログが最後に受け取ったもの（`public/js/settings.js`）。開くまでは null です。
    settings: null,

    // Open document
    currentPath: null,
    documentType: null,
    markdown: '',
    rawHtml: '',
    editableHtml: '',
    // Only a text body (Markdown or a plain-text file) can be copied out.
    textBody: false,
    mode: 'comment',

    // Review comments
    comments: [],
    // What the AI should assume while reading this document, and the directory
    // wide one the server was started with.
    aiContext: '',
    aiContextDirty: false,
    projectAiContext: '',
    // 画面で「ディレクトリ全体」を選んで書いた前提。保存先は対象ディレクトリの
    // `.review/context.json` で、配下のどの文書を開いても同じものが効きます。
    directoryAiContext: '',
    directoryAiContextDirty: false,
    directoryContextFile: '',
    // 読み取りコンテキストの欄がいまどちらを書いているか（`document` / `directory`）。
    // 文書をまたいでも変えません。同じ範囲で書き続けるレビューのほうが多いからです。
    aiContextScope: 'document',
    // 資料の管理者が決めた目的・ストーリー・期待値。前提としてAIへ渡し、
    // 3つが揃うまでAIレビューは一度止まります。
    brief: null,
    briefDirty: false,
    briefStatus: 'idle',
    briefAbortController: null,
    // 管理者が返した問いと、走り書きから補った点。保存はしません。
    briefDraft: null,
    // その文書について残したメモ。読み取りコンテキストと同じく前提としてAIへ渡します。
    contextNotes: [],
    contextNotesDirty: false,
    // 同階層以下から添えたファイルのパス。中身は保存せず、AIへ渡すたびにサーバーが読みます。
    referenceFiles: [],
    referenceFilesDirty: false,
    // 選べるファイルの一覧。文書ごとに引き直すので、開くたびに空へ戻します。
    referenceCandidates: null,
    referenceCandidatesLoading: false,
    pendingTarget: null,
    currentSelectionTarget: null,
    commentsDirty: false,
    // Every edit bumps this so a slow save cannot overwrite newer text.
    commentsVersion: 0,
    commentSaveFailed: false,

    // Read-only Codex translation and chat
    sidePane: 'comments',
    aiStatus: null,
    aiTarget: null,
    aiConversations: [],
    activeConversationId: null,
    translation: null,
    translationPrefetch: null,
    aiAbortController: null,

    // AI comment placement proposals, held until the reviewer accepts them
    placement: null,
    placementAbortController: null,

    // AI review: the skills it reads with, the reader it reads as, and the
    // proposals it produced. Proposals are held until the reviewer accepts them.
    reviewSkills: [],
    reviewSkillIds: [],
    // 画面で開いたスキルの本文。取りに行った文書をまたいでも中身は同じです。
    reviewSkillDetails: new Map(),
    openReviewSkillIds: new Set(),
    persona: null,
    personaDirty: false,
    personaStatus: 'idle',
    personaAbortController: null,
    review: null,
    reviewAbortController: null,

    // 本文の修正案。適用を許可するまで、ここに載っているだけでファイルは変わりません。
    revise: null,
    reviseAbortController: null,

    // Edit mode bookkeeping
    dirtyBlocks: new Set(),
    blockVersions: new Map(),
    editorCommentBlocks: new Map(),
    saveFailed: false
  };
}

export function resetDocumentState(state, filePath) {
  state.currentPath = filePath;
  state.documentType = null;
  state.mode = 'comment';
  state.textBody = false;
  state.markdown = '';
  state.rawHtml = '';
  state.editableHtml = '';
  state.comments = [];
  state.aiContext = '';
  state.aiContextDirty = false;
  state.brief = null;
  state.briefDirty = false;
  state.briefStatus = 'idle';
  state.briefAbortController?.abort();
  state.briefAbortController = null;
  state.briefDraft = null;
  state.contextNotes = [];
  state.contextNotesDirty = false;
  state.referenceFiles = [];
  state.referenceFilesDirty = false;
  state.referenceCandidates = null;
  state.referenceCandidatesLoading = false;
  state.pendingTarget = null;
  state.currentSelectionTarget = null;
  state.commentsDirty = false;
  state.commentSaveFailed = false;
  state.sidePane = 'comments';
  state.aiTarget = null;
  state.aiConversations = [];
  state.activeConversationId = null;
  state.translation = null;
  state.translationPrefetch?.controller?.abort();
  state.translationPrefetch = null;
  state.aiAbortController?.abort();
  state.aiAbortController = null;
  state.placement = null;
  state.placementAbortController?.abort();
  state.placementAbortController = null;
  // 選んだレビュースキルと開いた詳細は文書をまたいでも変わりません。ペルソナは文書ごとです。
  state.persona = null;
  state.personaDirty = false;
  state.personaStatus = 'idle';
  state.personaAbortController?.abort();
  state.personaAbortController = null;
  state.review = null;
  state.reviewAbortController?.abort();
  state.reviewAbortController = null;
  // 修正案が指すのはこの文書のファイル内の位置なので、別の文書へは持ち越せません。
  state.revise = null;
  state.reviseAbortController?.abort();
  state.reviseAbortController = null;
  state.commentsVersion += 1;
  state.dirtyBlocks.clear();
  state.blockVersions.clear();
  state.editorCommentBlocks.clear();
  state.saveFailed = false;
}
