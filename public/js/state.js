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
    mode: 'comment',

    // Review comments
    comments: [],
    pendingTarget: null,
    currentSelectionTarget: null,
    commentsDirty: false,
    // Every edit bumps this so a slow save cannot overwrite newer text.
    commentsVersion: 0,
    commentSaveFailed: false,

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
  state.markdown = '';
  state.rawHtml = '';
  state.editableHtml = '';
  state.comments = [];
  state.pendingTarget = null;
  state.currentSelectionTarget = null;
  state.commentsDirty = false;
  state.commentSaveFailed = false;
  state.commentsVersion += 1;
  state.dirtyBlocks.clear();
  state.blockVersions.clear();
  state.editorCommentBlocks.clear();
  state.saveFailed = false;
}
