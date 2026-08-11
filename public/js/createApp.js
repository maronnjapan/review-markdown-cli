import { api as defaultApi } from './api.js';
import { createAiController } from './ai.js';
import { createAutosave } from './autosave.js';
import { renderCommentHighlights } from './commentAnchors.js';
import {
  copyCommentTarget,
  createCommentDialog,
  newComment,
  renderCommentList,
  statusForComment
} from './comments.js';
import { renderDiagrams } from './diagrams.js';
import { queryRefs } from './dom.js';
import { createEditor } from './editor.js';
import { createFileListView } from './fileListView.js';
import { createLinkNavigator } from './links.js';
import { collectHeadingPath, targetTextOf } from './textAnchor.js';
import { createToaster } from './toast.js';
import { createState, resetDocumentState } from './state.js';

const ROUTE_PATTERN = /^#\/review\/([^#]+)(#.*)?$/;
const SELECTION_CONTEXT_LENGTH = 120;

/**
 * Wires the controllers together and owns the routing between the file list and
 * a single document. Everything stateful lives on the object returned by
 * `createState()`, so a second instance never inherits the first one's DOM.
 */
export function createApp(document, { api = defaultApi } = {}) {
  const window = document.defaultView;
  const refs = queryRefs(document);
  const state = createState();
  const toaster = createToaster(refs.toastRegion);
  const content = refs.markdownContent;

  const fileList = createFileListView({ refs, state, api });
  const dialog = createCommentDialog(refs, { onSubmit: addComment });
  const commentSaves = createAutosave({
    save: pushComments,
    // Edit mode saves comments alongside the document, so there is nothing to flush here.
    hasPendingWork: () => state.mode !== 'edit' && state.commentsDirty
  });
  const editor = createEditor({
    refs,
    state,
    api,
    onCommentsChanged: renderComments,
    onDocumentUpdated: adoptSavedDocument
  });
  const linkNavigator = createLinkNavigator({
    root: content,
    state,
    onError: (message) => toaster.error(message)
  });
  const ai = createAiController({ refs, state, api, toaster });

  let pendingAnchor = '';
  let pendingDeleteId = null;
  let selectionCommitTimer = null;
  let pointerSelectionActive = false;
  let keyboardSelectionActive = false;

  function start() {
    bindGlobalEvents();
    ai.prepare();
    return route();
  }

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  async function route() {
    const match = window.location.hash.match(ROUTE_PATTERN);
    const nextPath = match ? decodeURIComponent(match[1]) : null;
    const anchor = match ? match[2] || '' : '';

    if (state.currentPath && nextPath !== state.currentPath && !(await leaveDocument())) {
      window.location.hash = `#/review/${encodeURIComponent(state.currentPath)}`;
      return;
    }

    if (!match) {
      fileList.revealPath(state.currentPath);
      state.currentPath = null;
      await fileList.show();
      return;
    }

    if (nextPath === state.currentPath) {
      linkNavigator.scrollToAnchor(anchor);
      return;
    }
    pendingAnchor = anchor;
    await openFile(nextPath);
  }

  /** Saves (or asks about) pending work before the current document goes away. */
  async function leaveDocument() {
    if (state.mode === 'edit') {
      if (await editor.flush()) return true;
      return window.confirm('本文を保存できていません。編集内容を破棄して移動しますか？');
    }
    if (state.commentsDirty || commentSaves.isBusy()) {
      if (await commentSaves.flush()) return true;
      if (!window.confirm('コメントを保存できていません。破棄して移動しますか？')) return false;
      state.commentsDirty = false;
    }
    return true;
  }

  async function navigateBack() {
    if (!(await leaveDocument())) return;
    state.mode = 'comment';
    state.dirtyBlocks.clear();
    state.saveFailed = false;
    window.location.hash = '#/';
  }

  /* ---------------------------------------------------------------- *
   * Opening a document
   * ---------------------------------------------------------------- */

  async function openFile(filePath) {
    editor.cancel();
    commentSaves.cancel();
    resetDocumentState(state, filePath);
    pendingDeleteId = null;

    refs.fileView.classList.add('hidden');
    refs.reviewView.classList.remove('hidden');
    refs.exportOutput.hidden = true;
    refs.documentTitle.textContent = filePath;
    setCommentStatus('idle', 'コメントは自動保存されます。');
    content.innerHTML = '<p class="muted">Markdownをレンダリング中...</p>';
    ai.showPane('comments');
    renderComments();

    try {
      const data = await api.openFile(filePath);
      if (state.currentPath !== filePath) return;
      adoptSavedDocument(data);
      renderCommentMode();
      updateModeControls();
      ai.loadDocument();
    } catch (error) {
      content.innerHTML = `<p class="load-error">このファイルを開けませんでした: ${escapeText(error.message)}</p>`;
      toaster.error(`このファイルを開けませんでした: ${error.message}`);
    }
  }

  function adoptSavedDocument(data) {
    state.markdown = data.markdown;
    state.rawHtml = data.html;
    state.editableHtml = data.editableHtml;
    if (data.review?.comments) state.comments = data.review.comments;
    state.commentsDirty = false;
  }

  /* ---------------------------------------------------------------- *
   * Comment mode
   * ---------------------------------------------------------------- */

  function renderCommentMode() {
    content.classList.remove('editing');
    content.innerHTML = state.rawHtml;
    decorateReviewTargets();
    renderComments();
    renderDiagrams(content, { isStillCurrent: () => state.mode === 'comment' });
    if (pendingAnchor) {
      linkNavigator.scrollToAnchor(pendingAnchor);
      pendingAnchor = '';
    }
  }

  function decorateReviewTargets() {
    content.querySelectorAll('p, li, blockquote, pre').forEach((element) => {
      addCommentAffordance(element, 'paragraph', '段落にコメント');
    });
    content.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((element) => {
      addCommentAffordance(element, 'section', '見出し配下にコメント');
    });
  }

  function addCommentAffordance(element, type, label) {
    element.classList.add('review-target');
    element.append(
      createTargetAction('inline-translate-button', '翻訳', (target) => ai.translate(target)),
      createTargetAction('inline-ai-button', 'AIに質問', (target) => ai.ask(target)),
      createTargetAction(
        'inline-comment-button',
        label,
        (target) => dialog.open(target),
        () => buildCommentElementTarget(element, type)
      )
    );

    function createTargetAction(className, text, action, buildTarget = () => buildElementTarget(element, type)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `${className} inline-target-action`;
      button.textContent = text;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        action(buildTarget());
      });
      return button;
    }
  }

  function buildCommentElementTarget(element, type) {
    const text = targetTextOf(element).trim();
    return {
      type,
      selectedText: text,
      targetText: text,
      heading: type === 'section' ? text : undefined,
      headingPath: collectHeadingPath(content, element)
    };
  }

  function buildElementTarget(element, type) {
    const nodes = type === 'section' ? sectionNodes(element) : [element];
    const selectedText = nodes.map((node) => targetTextOf(node).trim()).filter(Boolean).join('\n\n');
    const context = contextAroundNodes(nodes);
    return {
      type,
      selectedText,
      targetText: selectedText,
      heading: type === 'section' ? targetTextOf(element).trim() : undefined,
      headingPath: collectHeadingPath(content, element),
      contextBefore: context.before,
      contextAfter: context.after
    };
  }

  function sectionNodes(heading) {
    const nodes = [heading];
    const level = Number(heading.tagName.slice(1));
    let next = heading.nextElementSibling;
    while (next) {
      if (/^H[1-6]$/.test(next.tagName) && Number(next.tagName.slice(1)) <= level) break;
      nodes.push(next);
      next = next.nextElementSibling;
    }
    return nodes;
  }

  function contextAroundNodes(nodes) {
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(content);
    beforeRange.setEndBefore(nodes[0]);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(content);
    afterRange.setStartAfter(nodes.at(-1));
    return {
      before: cleanRangeText(beforeRange).slice(-SELECTION_CONTEXT_LENGTH).trim(),
      after: cleanRangeText(afterRange).slice(0, SELECTION_CONTEXT_LENGTH).trim()
    };
  }

  function cleanRangeText(range) {
    const fragment = range.cloneContents();
    fragment.querySelectorAll?.('.inline-target-action').forEach((button) => button.remove());
    const wrapper = document.createElement('div');
    wrapper.append(fragment);
    return wrapper.innerText || wrapper.textContent || '';
  }

  function handleSelectionChange() {
    const selection = window.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount > 0
      ? selection.getRangeAt(0)
      : null;
    const insideDocument = range
      && content.contains(selection.anchorNode)
      && content.contains(selection.focusNode)
      && content.contains(range.commonAncestorContainer);
    state.currentSelectionTarget = state.mode === 'comment' && insideDocument
      ? buildSelectionTarget(selection, range)
      : null;

    if (!state.currentSelectionTarget) {
      ai.cancelTranslationPrefetch();
      refs.selectionToolbar.classList.add('hidden');
      return;
    }
    const rect = range.getBoundingClientRect();
    refs.selectionToolbar.style.left = `${rect.left + window.scrollX}px`;
    refs.selectionToolbar.style.top = `${rect.bottom + window.scrollY + 8}px`;
    refs.selectionToolbar.classList.remove('hidden');
  }

  function queueSelectionTranslation() {
    clearTimeout(selectionCommitTimer);
    selectionCommitTimer = setTimeout(() => {
      handleSelectionChange();
      if (state.currentSelectionTarget) ai.prefetchTranslation(state.currentSelectionTarget);
    }, 0);
  }

  function buildSelectionTarget(selection, range) {
    return buildTextSelectionTarget(range, selection.toString().trim());
  }

  function buildTextSelectionTarget(range, selectedText) {
    if (!selectedText) return null;
    const containerNode = range.commonAncestorContainer;
    const containerElement = containerNode.nodeType === 3 ? containerNode.parentElement : containerNode;
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(content);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(content);
    afterRange.setStart(range.endContainer, range.endOffset);
    return {
      type: 'text-selection',
      selectedText,
      contextBefore: cleanRangeText(beforeRange).slice(-SELECTION_CONTEXT_LENGTH).trim(),
      contextAfter: cleanRangeText(afterRange).slice(0, SELECTION_CONTEXT_LENGTH).trim(),
      headingPath: collectHeadingPath(content, containerElement)
    };
  }

  /* ---------------------------------------------------------------- *
   * Comments
   * ---------------------------------------------------------------- */

  function addComment(target, text) {
    const comment = newComment(target, text);
    state.comments.push(comment);
    renderComments();
    markCommentsDirty();
    toaster.success(`${state.comments.length}件目のコメントを追加しました。自動保存します。`);
    highlightCommentCard(comment.id);
  }

  function renderComments() {
    renderCommentList(refs.commentsList, {
      comments: state.comments,
      mode: state.mode,
      pendingDeleteId,
      handlers: {
        onEdit(index, value) {
          state.comments[index].comment = value;
          markCommentsDirty();
        },
        onRepeat(index) {
          dialog.open(copyCommentTarget(state.comments[index]));
        },
        onToggleStatus(index) {
          const comment = state.comments[index];
          if (!comment) return;
          const wasResolved = statusForComment(comment) === 'resolved';
          comment.status = wasResolved ? 'open' : 'resolved';
          pendingDeleteId = null;
          renderComments();
          markCommentsDirty();
          toaster.info(wasResolved ? 'コメントを未解決に戻しました。' : 'コメントを解決済みにしました。');
        },
        onRequestDelete(index) {
          pendingDeleteId = state.comments[index]?.id ?? null;
          renderComments();
        },
        onCancelDelete() {
          pendingDeleteId = null;
          renderComments();
        },
        onConfirmDelete(index) {
          const [removed] = state.comments.splice(index, 1);
          pendingDeleteId = null;
          renderComments();
          markCommentsDirty();
          if (removed) toaster.info('コメントを削除しました。');
        }
      }
    });
    refs.commentCount.textContent = String(state.comments.length);
    if (state.mode === 'comment') {
      renderCommentHighlights(content, state.comments, {
        onSelectExisting: (comment) => dialog.open(copyCommentTarget(comment))
      });
    }
  }

  function highlightCommentCard(commentId) {
    const card = refs.commentsList.querySelector(`.comment-card[data-comment-id="${cssAttr(commentId)}"]`);
    if (!card) return;
    card.classList.add('just-added');
    card.scrollIntoView?.({ block: 'nearest' });
    setTimeout(() => card.classList.remove('just-added'), 1500);
  }

  function markCommentsDirty() {
    state.commentsDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    if (state.mode === 'edit' || !state.currentPath) return;
    setCommentStatus('dirty', '自動保存待ち…');
    commentSaves.schedule();
  }

  /** Saves whatever `state.comments` holds right now. */
  async function pushComments() {
    if (state.mode === 'edit' || !state.currentPath) return true;
    const version = state.commentsVersion;
    const path = state.currentPath;
    setCommentStatus('saving', '保存中…');

    try {
      const result = await api.saveComments({ path, comments: state.comments });
      state.commentSaveFailed = false;
      if (state.commentsVersion !== version || state.currentPath !== path) return true;
      adoptSavedCommentIds(result.review.comments);
      state.commentsDirty = false;
      // Re-rendering here would replace the textarea the reviewer is typing in, so don't.
      setCommentStatus('saved', `自動保存しました ${new Date().toLocaleTimeString()}: ${result.reviewFile}`);
      return true;
    } catch (error) {
      state.commentSaveFailed = true;
      setCommentStatus('error', `保存できませんでした: ${error.message}`);
      return false;
    }
  }

  function adoptSavedCommentIds(savedComments) {
    (savedComments || []).forEach((saved, index) => {
      const comment = state.comments[index];
      if (!comment) return;
      if (!comment.id) comment.id = saved.id;
      if (!comment.createdAt) comment.createdAt = saved.createdAt;
    });
  }

  function setCommentStatus(status, message) {
    refs.saveStatus.dataset.state = status;
    refs.saveStatus.textContent = message;
  }

  /* ---------------------------------------------------------------- *
   * Mode switching and page level events
   * ---------------------------------------------------------------- */

  async function setMode(nextMode) {
    if (nextMode === state.mode || !state.currentPath) return;
    if (nextMode === 'comment') {
      if (!(await editor.flush())) return;
      state.mode = 'comment';
      renderCommentMode();
    } else {
      if (!(await commentSaves.flush())) return;
      state.mode = 'edit';
      editor.render();
      renderComments();
    }
    updateModeControls();
  }

  function updateModeControls() {
    const editing = state.mode === 'edit';
    refs.commentModeButton.classList.toggle('active', !editing);
    refs.editModeButton.classList.toggle('active', editing);
    refs.commentModeButton.setAttribute('aria-pressed', String(!editing));
    refs.editModeButton.setAttribute('aria-pressed', String(editing));
    refs.editorToolbar.classList.toggle('hidden', !editing);
    refs.editorSaveRow.classList.toggle('hidden', !editing);
    refs.documentCommentButton.disabled = editing;
    refs.documentTranslateButton.disabled = editing;
    refs.documentAiButton.disabled = editing;
    refs.reviewView.classList.toggle('editing-mode', editing);
    if (!editing) editor.setStatus('saved', '保存済み');
  }

  async function exportReviewMarkdown() {
    if (state.mode === 'edit' && !(await editor.flush())) return;
    if (!(await commentSaves.flush())) return;
    try {
      const markdown = await api.exportReview(state.currentPath);
      refs.exportOutput.hidden = false;
      refs.exportOutput.value = markdown;
      toaster.success('レビューMarkdownを .review ディレクトリに出力しました。');
    } catch (error) {
      toaster.error(`レビューMarkdownを出力できませんでした: ${error.message}`);
    }
  }

  function hasUnsavedWork() {
    return editor.hasUnsavedChanges()
      || state.commentsDirty
      || state.commentSaveFailed
      || commentSaves.isBusy();
  }

  function beaconComments() {
    if (state.mode !== 'comment' || !state.currentPath || !state.commentsDirty) return;
    api.beaconComments({ path: state.currentPath, comments: state.comments });
  }

  function bindGlobalEvents() {
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', (event) => {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('pagehide', beaconComments);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') beaconComments();
    });
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('keydown', handleModeShortcut);
    content.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.('button, a, input, textarea, select')) return;
      pointerSelectionActive = true;
      clearTimeout(selectionCommitTimer);
    });
    document.addEventListener('pointerup', () => {
      if (!pointerSelectionActive) return;
      pointerSelectionActive = false;
      queueSelectionTranslation();
    });
    document.addEventListener('pointercancel', () => {
      pointerSelectionActive = false;
      clearTimeout(selectionCommitTimer);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Shift' && state.mode === 'comment') keyboardSelectionActive = true;
    });
    document.addEventListener('keyup', (event) => {
      const keyboardSelectionFinished = keyboardSelectionActive && event.key === 'Shift';
      const selectAllFinished = event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey);
      if (!keyboardSelectionFinished && !selectAllFinished) return;
      keyboardSelectionActive = false;
      queueSelectionTranslation();
    });

    refs.backButton.addEventListener('click', navigateBack);
    refs.headerLink.addEventListener('click', (event) => {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      navigateBack();
    });
    refs.documentCommentButton.addEventListener('click', () => dialog.open({ type: 'document' }));
    refs.documentTranslateButton.addEventListener('click', () => ai.translate({ type: 'document' }));
    refs.documentAiButton.addEventListener('click', () => ai.ask({ type: 'document' }));
    refs.saveButton.addEventListener('click', () => commentSaves.run());
    refs.exportButton.addEventListener('click', exportReviewMarkdown);
    refs.commentModeButton.addEventListener('click', () => setMode('comment'));
    refs.editModeButton.addEventListener('click', () => setMode('edit'));
    refs.selectionToolbarButton.addEventListener('click', () => {
      refs.selectionToolbar.classList.add('hidden');
      if (state.currentSelectionTarget) dialog.open(state.currentSelectionTarget);
    });
    refs.selectionTranslateButton.addEventListener('click', () => {
      refs.selectionToolbar.classList.add('hidden');
      if (state.currentSelectionTarget) ai.translate(state.currentSelectionTarget);
    });
    refs.selectionAiButton.addEventListener('click', () => {
      refs.selectionToolbar.classList.add('hidden');
      if (state.currentSelectionTarget) ai.ask(state.currentSelectionTarget);
    });
  }

  function handleModeShortcut(event) {
    const isToggle = !event.repeat
      && !event.altKey
      && event.shiftKey
      && (event.ctrlKey || event.metaKey)
      && event.key.toLowerCase() === 'e';
    if (!isToggle || !state.currentPath || dialog.isOpen) return;
    event.preventDefault();
    setMode(state.mode === 'edit' ? 'comment' : 'edit');
  }

  function cssAttr(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function escapeText(value) {
    const element = document.createElement('span');
    element.textContent = String(value);
    return element.innerHTML;
  }

  return { start, state, refs };
}
