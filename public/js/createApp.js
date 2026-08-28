import { api as defaultApi } from './api.js';
import { createAiController } from './ai.js';
import { createAiContextController } from './aiContext.js';
import { createAutosave } from './autosave.js';
import { createBodyCopier } from './bodyCopy.js';
import { commentIndexesAt, renderCommentHighlights } from './commentAnchors.js';
import {
  copyCommentTarget,
  createCommentDialog,
  newComment,
  renderCommentList,
  statusForComment
} from './comments.js';
import { createCommentPlacementController } from './commentPlacement.js';
import { createContextNotesController } from './contextNotes.js';
import { createDocumentBriefController, missingBriefFields } from './documentBrief.js';
import { renderDiagrams } from './diagrams.js';
import { createDocumentReviewController } from './documentReview.js';
import { createDocumentTargets } from './documentTargets.js';
import { queryRefs } from './dom.js';
import { createEditor } from './editor.js';
import { createFileListView } from './fileListView.js';
import { createLinkNavigator } from './links.js';
import { createSidePanes } from './sidePanes.js';
import { createRangeFor, findTextRange } from './textAnchor.js';
import { createToaster } from './toast.js';
import { createState, resetDocumentState } from './state.js';

const ROUTE_PATTERN = /^#\/review\/([^#]+)(#.*)?$/;
const REVEAL_FLASH_MS = 1600;

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
    // Edit mode saves comments alongside the document, so there is nothing to
    // flush here. The reading context has no other writer, so it always does.
    hasPendingWork: () => (state.mode !== 'edit' && state.commentsDirty)
      || state.aiContextDirty || state.briefDirty || state.contextNotesDirty || state.personaDirty
  });
  const aiContext = createAiContextController({ refs, state, onChange: markAiContextDirty });
  const documentBrief = createDocumentBriefController({
    refs,
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    flushComments: () => commentSaves.flush(),
    onChange: markBriefDirty
  });
  const contextNotes = createContextNotesController({
    refs,
    state,
    toaster,
    onChange: markContextNotesDirty
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
  const panes = createSidePanes({ refs, state });
  const targets = createDocumentTargets(document, content);
  const bodyCopy = createBodyCopier({ document, window, refs, state, editor, toaster });
  const ai = createAiController({
    refs,
    state,
    api,
    toaster,
    panes,
    // A question about a comment the reviewer just typed needs it saved first.
    flushComments: () => commentSaves.flush(),
    // 相談して分かったことは、その場でメモへ流し込めます。残すかどうかと、
    // どこまでを前提として書くかはレビュアーが決めます。
    onKeepContext: (text) => contextNotes.keepFromChat(text)
  });
  const placement = createCommentPlacementController({
    refs,
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    // The AI reads the saved context, so hand it whatever is on screen first.
    flushComments: () => commentSaves.flush(),
    onAddComments: addComments,
    onRevealTarget: revealTarget
  });
  const documentReview = createDocumentReviewController({
    refs,
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    flushComments: () => commentSaves.flush(),
    onPersonaChanged: markPersonaDirty,
    onAddComments: addComments,
    onRevealTarget: revealTarget
  });

  let pendingAnchor = '';
  let pendingDeleteId = null;
  // 管理者が3点を求めていることを、書き始めるときに言ったかどうか。文書ごとに1回だけです。
  let briefNoticeShown = false;
  let selectionCommitTimer = null;
  let pointerSelectionActive = false;
  let keyboardSelectionActive = false;

  function start() {
    bindGlobalEvents();
    panes.bind();
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
      if (!(await editor.flush())) {
        return window.confirm('本文を保存できていません。編集内容を破棄して移動しますか？');
      }
      // 編集モードでも、書いた前提（読み取りコンテキスト・資料の管理者・コンテキストメモ・
      // 読み手ペルソナ）はコメントと同じ自動保存に乗っています。本文だけ流して戻ると、
      // 直後の openFile が自動保存を取り消すので、書いた前提が黙って消えます。
      if (await commentSaves.flush()) return true;
      if (!window.confirm('AIパネルに書いた前提を保存できていません。破棄して移動しますか？')) return false;
      state.aiContextDirty = false;
      state.briefDirty = false;
      state.contextNotesDirty = false;
      state.personaDirty = false;
      return true;
    }
    if (state.commentsDirty || state.aiContextDirty || state.briefDirty || state.contextNotesDirty
      || state.personaDirty || commentSaves.isBusy()) {
      if (await commentSaves.flush()) return true;
      if (!window.confirm('コメントを保存できていません。破棄して移動しますか？')) return false;
      state.commentsDirty = false;
      state.aiContextDirty = false;
      state.briefDirty = false;
      state.contextNotesDirty = false;
      state.personaDirty = false;
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
    bodyCopy.syncControl();
    setCommentStatus('idle', 'コメントは自動保存されます。');
    content.innerHTML = '<p class="muted">Markdownをレンダリング中...</p>';
    panes.show('comments');
    placement.reset();
    briefNoticeShown = false;
    documentBrief.load();
    contextNotes.load();
    documentReview.load();
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
    state.textBody = data.textBody === true;
    if (data.review?.comments) state.comments = data.review.comments;
    if (typeof data.projectAiContext === 'string') state.projectAiContext = data.projectAiContext;
    // A save that carried the context back confirms it; nothing typed since is lost.
    if (!state.aiContextDirty) state.aiContext = data.review?.aiContext || '';
    if (!state.briefDirty) state.brief = data.review?.brief || null;
    if (!state.contextNotesDirty) state.contextNotes = data.review?.contextNotes || [];
    if (!state.personaDirty) state.persona = data.review?.persona || null;
    state.commentsDirty = false;
    aiContext.load();
    documentBrief.refresh();
    contextNotes.render();
    documentReview.refresh();
    bodyCopy.syncControl();
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
        () => targets.forComment(element, type)
      )
    );

    function createTargetAction(className, text, action, buildTarget = () => targets.forReading(element, type)) {
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
      ? targets.forSelection(range, selection.toString().trim())
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

  /* ---------------------------------------------------------------- *
   * Comments
   * ---------------------------------------------------------------- */

  function addComment(target, text) {
    addComments([{ target, comment: text }]);
  }

  /** One save, one toast, however many comments were accepted at once. */
  function addComments(entries) {
    const added = entries.map(({ target, comment }) => {
      const created = newComment(target, comment);
      state.comments.push(created);
      return created;
    });
    if (added.length === 0) return;
    renderComments();
    markCommentsDirty();
    toaster.success(added.length === 1
      ? `${state.comments.length}件目のコメントを追加しました。自動保存します。`
      : `${added.length}件のコメントを追加しました。自動保存します。`);
    highlightCommentCard(added.at(-1).id);
  }

  /**
   * Scrolls to where a proposed comment would land, so the reviewer can check
   * the AI picked the right place before accepting it.
   */
  function revealTarget(target) {
    if (state.mode !== 'comment') return false;
    const text = target.selectedText || target.targetText || target.heading || '';
    const match = text ? findTextRange(content, text, target.contextBefore, target.contextAfter) : null;
    if (!match) return false;

    const startElement = match.startNode.parentElement;
    const element = startElement?.closest('.review-target') || startElement;
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center' });
    element.classList.add('reveal-flash');
    setTimeout(() => element.classList.remove('reveal-flash'), REVEAL_FLASH_MS);
    selectRange(match);
    return true;
  }

  /** Puts the caret on the located text so the exact target is visible, not just its block. */
  function selectRange(match) {
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(createRangeFor(content, match));
  }

  function renderComments() {
    ai.refreshTarget();
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
    if (state.mode === 'comment') renderCommentHighlights(content, state.comments);
  }

  /**
   * Clicking a highlighted place brings up what was written about it. The
   * comment lives in the pane, in full and ready to edit, so the click takes the
   * reviewer there instead of repeating the text over the document.
   */
  function revealCommentsFromHighlight(event) {
    if (state.mode !== 'comment') return;
    const spot = event.target.closest?.('.comment-highlight-text, .comment-highlight-target');
    if (!spot) return;
    // The marker is ours; the other buttons inside a block have their own jobs.
    const marker = event.target.closest('.comment-marker');
    if (!marker && event.target.closest('button, a, input, textarea, select')) return;
    // A click that finished a selection was aimed at the text, not the comment.
    if (!marker && window.getSelection()?.isCollapsed === false) return;
    revealComments(commentIndexesAt(spot));
  }

  function revealCommentsFromKeyboard(event) {
    if (state.mode !== 'comment' || (event.key !== 'Enter' && event.key !== ' ')) return;
    const spot = event.target.closest?.('.comment-highlight-text');
    if (!spot) return;
    event.preventDefault();
    revealComments(commentIndexesAt(spot));
  }

  /** Brings the comments written for one place into view, and flashes them. */
  function revealComments(indexes) {
    if (indexes.length === 0) return;
    panes.show('comments');
    const cards = indexes
      .map((index) => refs.commentsList.querySelector(`.comment-card[data-comment-index="${index}"]`))
      .filter(Boolean);
    if (cards.length === 0) return;
    cards[0].scrollIntoView?.({ block: 'nearest' });
    cards.forEach((card) => {
      card.classList.add('revealed');
      setTimeout(() => card.classList.remove('revealed'), REVEAL_FLASH_MS);
    });
  }

  function highlightCommentCard(commentId) {
    const card = refs.commentsList.querySelector(`.comment-card[data-comment-id="${cssAttr(commentId)}"]`);
    if (!card) return;
    card.classList.add('just-added');
    card.scrollIntoView?.({ block: 'nearest' });
    setTimeout(() => card.classList.remove('just-added'), 1500);
  }

  function markAiContextDirty() {
    state.aiContextDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    // The AI pane promises to say what travels with a question; now it does.
    ai.refreshTarget();
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  /**
   * 残したメモも、コメントと同じ自動保存でレビューファイルへ入ります。
   * 相談やレビューを始める直前にも保存するので、残した直後のメモがその回から効きます。
   */
  function markContextNotesDirty() {
    state.contextNotesDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    // The AI pane promises to say what travels with a question; the notes are part of it.
    ai.refreshTarget();
    // 「指摘の配置にも渡る」の表示は書いた前提と合わせて決まるので、そちらへ見直させます。
    aiContext.renderSummary();
    contextNotes.setStatus('dirty');
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  /**
   * 決めた3点も、コメントと同じ自動保存でレビューファイルへ入ります。
   * 決めた直後にレビューを始めても、その回から3点が前提として効きます。
   */
  function markBriefDirty() {
    state.briefDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    // The AI pane promises to say what travels with a question; the brief is part of it.
    ai.refreshTarget();
    // 「指摘の配置にも渡る」と「レビューへも渡る」の表示は、前提をまとめて見て決まります。
    aiContext.renderSummary();
    contextNotes.render();
    // 関門はいま画面にある3点で開くので、レビューのパネルにも見直させます。
    documentReview.refresh();
    documentBrief.setStatus('dirty');
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  /** 組み直したペルソナは、コメントと同じ自動保存でレビューファイルへ入ります。 */
  function markPersonaDirty() {
    state.personaDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  function markCommentsDirty() {
    state.commentsDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    if (state.mode === 'edit' || !state.currentPath) return;
    setCommentStatus('dirty', '自動保存待ち…');
    commentSaves.schedule();
  }

  /**
   * Saves whatever `state.comments` and the reading context hold right now.
   * Edit mode saves its comments through `/api/file`, so only a changed reading
   * context brings it here.
   */
  async function pushComments() {
    if (!state.currentPath) return true;
    if (state.mode === 'edit' && !state.aiContextDirty && !state.briefDirty
      && !state.contextNotesDirty && !state.personaDirty) {
      return true;
    }
    const version = state.commentsVersion;
    const path = state.currentPath;
    const savedContext = state.aiContext;
    const savedNotes = state.contextNotes;
    // メモは変わったときだけ送るので、状態表示もそのときだけ動かします。
    // 触っていない保存で「保存しました」と出ると、送っていないものを送ったと言うことになります。
    const savingNotes = state.contextNotesDirty;
    // 3点も、変わったときだけ送ります。状態表示を動かす条件もメモと同じです。
    const savedBrief = state.brief;
    const savingBrief = state.briefDirty;
    const savedPersona = state.persona;
    // Leaving the comments out keeps the ones on file, which is what edit mode wants.
    const savingComments = state.mode !== 'edit';
    setCommentStatus('saving', '保存中…');
    aiContext.setStatus('saving');
    if (savingBrief) documentBrief.setStatus('saving');
    if (savingNotes) contextNotes.setStatus('saving');

    try {
      const result = await api.saveComments({
        path,
        comments: savingComments ? state.comments : undefined,
        aiContext: savedContext,
        // null は「3つを消す」なので、未変更の undefined と区別して送ります。
        ...(savingBrief ? { brief: savedBrief } : {}),
        // 空の配列は「最後の1件を消した」なので、未変更の undefined と区別して送ります。
        ...(savingNotes ? { contextNotes: savedNotes } : {}),
        // null は「ペルソナを消す」なので、未変更の undefined と区別して送ります。
        ...(state.personaDirty ? { persona: savedPersona } : {})
      });
      state.commentSaveFailed = false;
      if (state.currentPath === path && state.aiContext === savedContext) state.aiContextDirty = false;
      if (state.currentPath === path && state.brief === savedBrief) state.briefDirty = false;
      if (state.currentPath === path && state.contextNotes === savedNotes) state.contextNotesDirty = false;
      if (state.currentPath === path && state.persona === savedPersona) state.personaDirty = false;
      if (state.commentsVersion !== version || state.currentPath !== path) return true;
      if (savingComments) {
        adoptSavedCommentIds(result.review.comments);
        state.commentsDirty = false;
        // Re-rendering here would replace the textarea the reviewer is typing in, so don't.
        setCommentStatus('saved', `自動保存しました ${new Date().toLocaleTimeString()}: ${result.reviewFile}`);
      }
      aiContext.setStatus(state.aiContextDirty ? 'dirty' : 'saved');
      if (savingBrief) documentBrief.setStatus(state.briefDirty ? 'dirty' : 'saved');
      if (savingNotes) contextNotes.setStatus(state.contextNotesDirty ? 'dirty' : 'saved');
      return true;
    } catch (error) {
      state.commentSaveFailed = true;
      setCommentStatus('error', `保存できませんでした: ${error.message}`);
      aiContext.setStatus('error', `保存できませんでした: ${error.message}`);
      if (savingBrief) documentBrief.setStatus('error', `保存できませんでした: ${error.message}`);
      if (savingNotes) contextNotes.setStatus('error', `保存できませんでした: ${error.message}`);
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
      noticeMissingBrief();
      editor.render();
      renderComments();
    }
    updateModeControls();
  }

  /**
   * 書き始めるとき、管理者がまだ3点を求めていたら1度だけ言います。
   *
   * ここでは止めません。このアプリは書くためだけのものではなく、既にある資料を読みに
   * 来た人まで編集の手前で締め出すことになるからです。止めるのはAIレビューのほうで、
   * あちらは3点が無いと「良い資料か」を判定する基準そのものが無くなります。
   */
  function noticeMissingBrief() {
    if (briefNoticeShown) return;
    const missing = missingBriefFields(state.brief);
    if (missing.length === 0) return;
    briefNoticeShown = true;
    toaster.info(`資料の管理者が${missing.map(({ label }) => label).join('・')}を求めています。`
      + '書き始める前に「管理者」タブで決めておくと、AIレビューもその3点を基準に読みます。');
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
      || state.aiContextDirty
      || state.briefDirty
      || state.contextNotesDirty
      || state.personaDirty
      || state.commentSaveFailed
      || commentSaves.isBusy();
  }

  function beaconComments() {
    if (!state.currentPath) return;
    const savingComments = state.mode === 'comment' && state.commentsDirty;
    if (!savingComments && !state.aiContextDirty && !state.briefDirty
      && !state.contextNotesDirty && !state.personaDirty) return;
    api.beaconComments({
      path: state.currentPath,
      // Edit mode owns the comments; only the reading context is ours to send.
      comments: savingComments ? state.comments : undefined,
      aiContext: state.aiContext,
      ...(state.briefDirty ? { brief: state.brief } : {}),
      ...(state.contextNotesDirty ? { contextNotes: state.contextNotes } : {}),
      ...(state.personaDirty ? { persona: state.persona } : {})
    });
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
    content.addEventListener('click', revealCommentsFromHighlight);
    content.addEventListener('keydown', revealCommentsFromKeyboard);
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
    refs.copyBodyButton?.addEventListener('click', bodyCopy.copy);
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
