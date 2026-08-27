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

    // Open document
    currentPath: null,
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

    // Edit mode bookkeeping
    dirtyBlocks: new Set(),
    blockVersions: new Map(),
    editorCommentBlocks: new Map(),
    saveFailed: false
  };
}

export function resetDocumentState(state, filePath) {
  state.currentPath = filePath;
  state.mode = 'comment';
  state.textBody = false;
  state.markdown = '';
  state.rawHtml = '';
  state.editableHtml = '';
  state.comments = [];
  state.aiContext = '';
  state.aiContextDirty = false;
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
  state.commentsVersion += 1;
  state.dirtyBlocks.clear();
  state.blockVersions.clear();
  state.editorCommentBlocks.clear();
  state.saveFailed = false;
}
