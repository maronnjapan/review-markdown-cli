const SELECTORS = {
  fileView: '#file-view',
  reviewView: '#review-view',
  markdownContent: '#markdown-content',
  documentTitle: '#document-title',
  backButton: '#back-button',
  headerLink: '.header-link',

  commentsList: '#comments-list',
  commentCount: '#comment-count',
  saveStatus: '#save-status',
  saveButton: '#save-button',
  exportButton: '#export-button',
  exportOutput: '#export-output',
  documentCommentButton: '#document-comment-button',
  documentTranslateButton: '#document-translate-button',
  documentAiButton: '#document-ai-button',

  commentsTabButton: '#comments-tab-button',
  aiTabButton: '#ai-tab-button',
  commentsPanel: '#comments-panel',
  aiPanel: '#ai-panel',
  aiProviderStatus: '#ai-provider-status',
  aiConversationSelect: '#ai-conversation-select',
  aiNewConversation: '#ai-new-conversation',
  aiDeleteConversation: '#ai-delete-conversation',
  aiTarget: '#ai-target',
  aiTargetType: '#ai-target-type',
  aiTargetPath: '#ai-target-path',
  aiTargetText: '#ai-target-text',
  translationResult: '#translation-result',
  aiMessages: '#ai-messages',
  aiChatForm: '#ai-chat-form',
  aiChatInput: '#ai-chat-input',
  aiSendButton: '#ai-send-button',
  aiStopButton: '#ai-stop-button',

  selectionToolbar: '#selection-toolbar',
  selectionToolbarButton: '#selection-comment-button',
  selectionTranslateButton: '#selection-translate-button',
  selectionAiButton: '#selection-ai-button',

  dialog: '#comment-dialog',
  dialogForm: '#comment-dialog form',
  dialogTitle: '#dialog-title',
  dialogTypeBadge: '#dialog-type-badge',
  dialogTargetPath: '#dialog-target-path',
  dialogTargetQuote: '#dialog-target-quote',
  commentInput: '#comment-input',
  submitDialog: '#submit-dialog',
  cancelDialog: '#cancel-dialog',

  commentModeButton: '#comment-mode-button',
  editModeButton: '#edit-mode-button',
  editorToolbar: '#editor-toolbar',
  editorSaveRow: '#editor-save-row',
  editorSaveStatus: '#editor-save-status',
  retrySaveButton: '#retry-save-button',
  blockFormat: '#block-format',

  toastRegion: '#toast-region'
};

/**
 * Resolves every element the app touches, once, against the given document.
 * Keeping this out of module scope means a second app instance (a new page, or
 * the next test) never reuses elements from a document that is already gone.
 */
export function queryRefs(document) {
  return Object.fromEntries(
    Object.entries(SELECTORS).map(([name, selector]) => [name, document.querySelector(selector)])
  );
}
