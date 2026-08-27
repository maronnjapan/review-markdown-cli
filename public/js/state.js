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
  state.commentsVersion += 1;
  state.dirtyBlocks.clear();
  state.blockVersions.clear();
  state.editorCommentBlocks.clear();
  state.saveFailed = false;
}
