import { api as defaultApi } from './api.js';
import { createAiController } from './ai.js';
import { createAiContextController } from './aiContext.js';
import { createAutosave } from './autosave.js';
import { createAutoTasksController } from './autoTasks.js';
import { createBodyCopier } from './bodyCopy.js';
import { createCaptionRecapController } from './captionRecap.js';
import { highlightIndexesAt, refreshCommentAttachment, renderCommentHighlights } from './commentAnchors.js';
import {
  copyCommentTarget,
  createCommentDialog,
  newComment,
  renderCommentList,
  statusForComment
} from './comments.js';
import { createCommentPlacementController } from './commentPlacement.js';
import { createContextNotesController } from './contextNotes.js';
import { createContextPageController } from './contextPage.js';
import { createDocumentBriefController, hasWrittenBody, missingBriefFields } from './documentBrief.js';
import { renderDiagrams } from './diagrams.js';
import { createDocumentReviewController } from './documentReview.js';
import { createDocumentReviseController } from './documentRevise.js';
import { createDocumentTargets } from './documentTargets.js';
import { createReferenceFilesController } from './referenceFiles.js';
import { createSavedContextController } from './savedContext.js';
import { aliasRefs, queryRefs } from './dom.js';
import { createEditor } from './editor.js';
import { createFileListView } from './fileListView.js';
import { createPersonaController } from './persona.js';
import { createLinkNavigator, isPlainClick, onPlainClick } from './links.js';
import { createLiveCaptionsController } from './liveCaptions.js';
import { copyMemoTarget, createMemoComposer, newMemo, renderMemoList } from './memos.js';
import { createSettingsController } from './settings.js';
import { createSidePanes } from './sidePanes.js';
import {
  TOOL_PAGES,
  TOOL_ROUTES,
  markCurrentToolLink,
  toolPageByKey,
  toolPageByRoute,
  updateToolLinks
} from './toolPages.js';
import { createRangeFor, findTextRange } from './textAnchor.js';
import { createPdfViewer } from './pdf/viewer.js';
import { targetTextOf } from './textAnchor.js';
import { createToaster } from './toast.js';
import { normalizeText } from './util.js';
import { createState, resetDocumentState } from './state.js';

const ROUTE_PATTERN = /^#\/review\/([^#]+)(#.*)?$/;
/**
 * 本文の隣に置かないものを開く画面です（`toolPages.js`）。同じ文書の別の面なので、
 * 行き来しても文書は開いたままにします。
 */
const TOOL_ROUTE_PATTERN = new RegExp(`^#/(${TOOL_ROUTES.join('|')})/([^#]+)$`);

/**
 * 広い画面へ出す操作盤の、要素の読み替え表です。
 *
 * 読み取りコンテキスト・コンテキストメモ・読み手ペルソナ・参照ファイルは、サイドパネルと
 * それぞれの画面の2か所から書けます。操作盤（`aiContext.js` などが返すもの）を2つ作って、
 * 片方にはこの表で読み替えた要素を渡します。画面ごとに同じ処理を書き写さずに
 * 済ませるためで、書き換えた中身はどちらも同じ state に入ります。
 */
const WORKSPACE_AI_CONTEXT_REFS = {
  aiContextInput: 'workspaceAiContextInput',
  aiContextStatus: 'workspaceAiContextStatus',
  aiContextState: 'workspaceAiContextState',
  aiContextScope: 'workspaceAiContextScope',
  aiContextScopeHint: 'workspaceAiContextScopeHint',
  aiContextOther: 'workspaceAiContextOther',
  aiContextOtherLabel: 'workspaceAiContextOtherLabel',
  aiContextOtherText: 'workspaceAiContextOtherText',
  aiContextProject: 'workspaceAiContextProject',
  aiContextProjectText: 'workspaceAiContextProjectText'
};
const WORKSPACE_NOTES_REFS = {
  contextNotes: 'workspaceNotes',
  contextNotesState: 'workspaceContextNotesState',
  contextNoteForm: 'workspaceContextNoteForm',
  contextNoteScope: 'workspaceContextNoteScope',
  contextNoteScopeHint: 'workspaceContextNoteScopeHint',
  contextNoteKind: 'workspaceContextNoteKind',
  contextNoteKindHint: 'workspaceContextNoteKindHint',
  contextNoteInput: 'workspaceContextNoteInput',
  contextNoteCancel: 'workspaceContextNoteCancel',
  contextNoteSubmit: 'workspaceContextNoteSubmit',
  contextNoteFull: 'workspaceContextNoteFull',
  contextNotesStatus: 'workspaceContextNotesStatus',
  contextNotesList: 'workspaceContextNotesList'
};
/**
 * AIレビューの操作盤へ出す、参照ファイル欄の読み替え表です。
 *
 * レビューを実行するのはこのパネルなので、何を読ませるかもここで決められるようにします。
 * 中身はサイドパネルやコンテキスト画面と同じ state なので、どこで添えても同じ1組です。
 */
const REVIEW_REFERENCE_FILE_REFS = {
  referenceFilesState: 'reviewReferenceFilesState',
  referenceFileForm: 'reviewReferenceFileForm',
  referenceFileFilter: 'reviewReferenceFileFilter',
  referenceFileSelect: 'reviewReferenceFileSelect',
  referenceFileAdd: 'reviewReferenceFileAdd',
  referenceFilesFull: 'reviewReferenceFilesFull',
  referenceFilesStatus: 'reviewReferenceFilesStatus',
  referenceFilesList: 'reviewReferenceFilesList'
};

const WORKSPACE_REFERENCE_FILE_REFS = {
  referenceFilesState: 'workspaceReferenceFilesState',
  referenceFileForm: 'workspaceReferenceFileForm',
  referenceFileFilter: 'workspaceReferenceFileFilter',
  referenceFileSelect: 'workspaceReferenceFileSelect',
  referenceFileAdd: 'workspaceReferenceFileAdd',
  referenceFilesFull: 'workspaceReferenceFilesFull',
  referenceFilesStatus: 'workspaceReferenceFilesStatus',
  referenceFilesList: 'workspaceReferenceFilesList'
};
/**
 * 読み手ペルソナの操作盤を、専用の画面へもう1つ出すための読み替え表です。
 *
 * 決める場所は「AIレビュー」の画面にも残してあります。読み手はレビューの直前に
 * 決まるものだからです。どちらで決めても同じ1組の state です。
 * `reviewPersonaHint`（読み手が未設定だとレビューがどうなるか）はレビューを実行する
 * 場所にしかないので、こちらの表には入れません。
 */
const WORKSPACE_PERSONA_REFS = {
  personaState: 'workspacePersonaState',
  personaForm: 'workspacePersonaForm',
  personaInput: 'workspacePersonaInput',
  personaComposeButton: 'workspacePersonaComposeButton',
  personaUseButton: 'workspacePersonaUseButton',
  personaStopButton: 'workspacePersonaStopButton',
  personaClearButton: 'workspacePersonaClearButton',
  personaResult: 'workspacePersonaResult'
};
/** パネルを1枚ずつ出し入れするツール画面。コンテキストは専用の面なので入りません。 */
const TOOL_PAGES_WITH_PANEL = TOOL_PAGES.filter((page) => page.panel);
const REVEAL_FLASH_MS = 1600;
const PDF_STATUS_LABELS = {
  open: '未確認',
  resolved: '確認済み',
  resolveAction: '確認済みにする',
  reopenAction: '未確認に戻す'
};
const SCROLL_RESTORE_KEY = 'review-markdown:scroll-position';

/**
 * Wires the controllers together and owns the routing between the file list and
 * a single document. Everything stateful lives on the object returned by
 * `createState()`, so a second instance never inherits the first one's DOM.
 */
export function createApp(document, { api = defaultApi, pdfViewerFactory = createPdfViewer } = {}) {
  const window = document.defaultView;
  const refs = queryRefs(document);
  const state = createState();
  const toaster = createToaster(refs.toastRegion);
  const content = refs.markdownContent;

  const fileList = createFileListView({ refs, state, api, toaster });
  const dialog = createCommentDialog(refs, {
    // 同じ対象へ、コメントとして依頼を残すか、自分のためのメモを残すかはダイアログで選びます。
    onSubmit: (target, text, kind) => (kind === 'memo' ? addMemo(target, text) : addComment(target, text))
  });
  const commentSaves = createAutosave({
    save: pushComments,
    // Edit mode saves comments alongside the document, so there is nothing to
    // flush here. The reading context has no other writer, so it always does.
    // メモは編集モードでも書き換えられないので、コメントと同じ扱いです。
    hasPendingWork: () => (state.mode !== 'edit' && state.commentsDirty)
      || state.aiContextDirty || state.directoryAiContextDirty || state.briefDirty || state.contextNotesDirty
      || state.directoryContextNotesDirty
      || state.memosDirty || state.personaDirty || state.referenceFilesDirty
  });
  // 前提を書く欄は、サイドパネルとコンテキスト画面の2か所に出ます。操作盤を2つ作って
  // 束ね、どちらから書き換えても同じ state を見て両方が描き直すようにしています。
  const aiContextControllerOptions = {
    state,
    onChange: markAiContextDirty,
    onDirectoryChange: markDirectoryAiContextDirty,
    // 選んだ適用範囲は1組の state なので、片方で切り替えたらもう片方も描き直させます。
    onScopeChange: () => aiContext.sync()
  };
  const aiContext = fanOut([
    createAiContextController({ refs, ...aiContextControllerOptions }),
    createAiContextController({
      refs: aliasRefs(refs, WORKSPACE_AI_CONTEXT_REFS),
      ...aiContextControllerOptions
    })
  ]);
  const briefControllerOptions = {
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    flushComments: () => commentSaves.flush(),
    onChange: markBriefDirty
  };
  // 3点を決める場所は「管理者」の画面1か所です。前提のなかで唯一「この資料はどうあるべきか」
  // なので、読み方を決める欄と並べず、決めるための画面をそれだけで1枚使います。
  const documentBrief = createDocumentBriefController({ refs, ...briefControllerOptions });
  // 相談の答えを下書きにする導線は、押した画面の欄へ入れます。両方へ入れると、
  // 見えていないほうの欄にも書きかけが残ります。
  const contextNoteOptions = {
    state,
    toaster,
    onChange: markContextNotesDirty,
    onDirectoryChange: markDirectoryContextNotesDirty,
    // 選んだ範囲は1組の state なので、片方で切り替えたらもう片方も描き直させます。
    onScopeChange: () => contextNotes.sync()
  };
  const sideContextNotes = createContextNotesController({ refs, ...contextNoteOptions });
  const workspaceContextNotes = createContextNotesController({
    refs: aliasRefs(refs, WORKSPACE_NOTES_REFS),
    ...contextNoteOptions
  });
  const contextNotes = fanOut([sideContextNotes, workspaceContextNotes]);
  // 添えたファイルも2か所から選べます。一覧を取りに行くのは先に load() された1つだけで、
  // 届いたらここで両方を描き直します。
  const referenceFileOptions = {
    state,
    api,
    toaster,
    onChange: markReferenceFilesDirty,
    onCandidatesChanged: (message, status) => {
      referenceFiles.render();
      referenceFiles.setStatus(status || (state.referenceFilesDirty ? 'dirty' : 'idle'), message);
    }
  };
  const referenceFiles = fanOut([
    createReferenceFilesController({ refs, ...referenceFileOptions }),
    createReferenceFilesController({
      refs: aliasRefs(refs, WORKSPACE_REFERENCE_FILE_REFS),
      ...referenceFileOptions
    }),
    createReferenceFilesController({
      refs: aliasRefs(refs, REVIEW_REFERENCE_FILE_REFS),
      ...referenceFileOptions
    })
  ]);
  // 保存した判断（Context）。文書ごとの前提ではなくWorkspaceのものなので、操作盤は1つです。
  const savedContextPage = createSavedContextController({ refs, state, api, toaster });
  const editor = createEditor({
    refs,
    state,
    api,
    onCommentsChanged: renderComments,
    onDocumentUpdated(data) {
      adoptSavedDocument(data);
    },
    onOutlineChanged: renderOutline
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
    // 届いた記録は、直すための画面（AIチャットの記録）にも並べます。
    onConversationsLoaded: () => contextPage.renderConversations(),
    // 相談して分かったことは、その場でメモへ流し込めます。残すかどうかと、
    // どこまでを前提として書くかはレビュアーが決めます。
    onKeepContext: (text) => sideContextNotes.keepFromChat(text),
    // 相談の答えのうち、次の会話でも前提にしたいものを「保存した判断」の下書きへ移します。
    // AIが書いたものをそのまま残さず、必ず本人が見てから確定させます（仕様7.5）。
    onSaveContext(text) {
      state.savedContextDraftSource = 'agent';
      window.location.hash = `#/saved-context/${encodeURIComponent(state.currentPath)}`;
      savedContextPage.draft(text);
    },
    // 根拠に出た判断から、その場で直しに行けるようにします（仕様7.5の訂正の導線）。
    onOpenSavedContext() {
      if (state.currentPath) window.location.hash = `#/saved-context/${encodeURIComponent(state.currentPath)}`;
    },
    onPaneRequested: openSidePane
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
    onAddComments: addComments,
    onRevealTarget: revealTarget
  });
  // 読み手を決める欄も2か所に出ます。レビューを実行する画面と、読み手だけを開く画面です。
  // 片方で決め直したらもう片方も描き直し、レビューの実行できる・できないも見直します。
  const personaControllerOptions = {
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    flushComments: () => commentSaves.flush(),
    onChange: markPersonaDirty,
    onSettled: () => {
      persona.refresh();
      documentReview.refresh();
    }
  };
  const persona = fanOut([
    createPersonaController({ refs, ...personaControllerOptions }),
    createPersonaController({ refs: aliasRefs(refs, WORKSPACE_PERSONA_REFS), ...personaControllerOptions })
  ]);
  const revise = createDocumentReviseController({
    refs,
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    // 修正案はファイル内の位置を持つので、AIにはいま保存されている本文を読ませます。
    // 編集モードで打ちかけのブロックが残っていると、その位置がもう当たりません。
    flushComments: async () => (await editor.flush()) && (await commentSaves.flush()),
    onApplyEdits: applyDocumentEdits,
    onRevealTarget: revealTarget
  });
  // 会議中の聞き直し。文字起こしのファイルを開いたときだけリンクが出ます。
  const recap = createCaptionRecapController({
    refs,
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    // 読ませるのは発言だけですが、前提（読み取りコンテキスト）は保存済みのものを
    // 読むので、他のAI機能と同じく先に画面の内容を保存します。
    flushComments: () => commentSaves.flush()
  });
  // タスク。本文を読み直せる文書ならリンクが出て、一覧はサーバーの記録の写しです。
  const autoTasks = createAutoTasksController({
    refs,
    state,
    api,
    toaster,
    prepareAi: () => ai.prepare(),
    // タスクを起こすときも前提（3点・メモ・参照ファイル）を読むので、先に画面の内容を保存します。
    flushComments: () => commentSaves.flush(),
    // タスクが出せる文書かどうかは裏でも変わるので、そのつどリンクを出し入れします。
    onVisibilityChanged: () => syncToolLinks()
  });
  // 「メモ」のタブから、対象を選ばずにその場で残せる欄です。残す先は文書全体になります。
  const memoComposer = createMemoComposer({
    refs,
    state,
    onSubmit: (body) => addMemo({ type: 'document' }, body)
  });
  const pdfViewer = pdfViewerFactory({
    document,
    content,
    onSelectComment: (id, kind) => (kind === 'memo' ? focusMemoCard(id) : focusCommentCard(id))
  });
  // 設定は文書に紐づかないので、ファイル一覧でもレビュー画面でも同じヘッダーから開きます。
  // 開くのはヘッダーのボタンからだけなので、ここでは持ち回りません。
  createSettingsController({
    refs,
    state,
    api,
    toaster,
    onApplied: (payload) => applyFeatureChange(payload.features)
  });
  // Meet連携も文書に紐づかないので、同じヘッダーから開きます。中身は起動ごとに変わる
  // 連携コードなので、開くたびに取りに行きます（`liveCaptions.js`）。
  createLiveCaptionsController({ refs, api, toaster });
  const contextPage = createContextPageController({
    refs,
    state,
    api,
    toaster,
    // 記録から残すメモは、いま開いているコンテキスト画面の欄へ入れます。
    onKeepNote: (text) => workspaceContextNotes.keepFromChat(text),
    // 会話を直したら、サイドパネルのAIチャットも同じ記録を映し直します。
    onConversationsChanged: () => ai.refreshConversations()
  });

  let pendingAnchor = '';
  /*
   * AIチャットの、サイドパネルでの置き場所です。広い画面へ運んだあと同じ場所へ戻すために、
   * 1度も動かしていないうちに覚えます。動かしてから調べると、運んだ先が「元の場所」になります。
   */
  const chatPanelHome = refs.aiPanel.parentElement;
  const chatPanelHomeNext = refs.aiPanel.nextSibling;
  let pendingDeleteId = null;
  // 削除の確認は一覧ごとに持ちます。1つにまとめると、コメントの確認を出したまま
  // メモの削除を押したときに、押していないほうの一覧を描き直すことになります。
  let pendingMemoDeleteId = null;
  // 管理者が3点を求めていることを、書き始めるときに言ったかどうか。文書ごとに1回だけです。
  let briefNoticeShown = false;
  let selectionCommitTimer = null;
  let pointerSelectionActive = false;
  let keyboardSelectionActive = false;

  function start() {
    bindGlobalEvents();
    panes.bind();
    ai.prepare();
    // 保存した判断は、その画面を開く前から効きます。何が渡りうるかをAIパネルが
    // 名乗れるよう、預け先へ繋がるかどうかだけを起動時に1回確かめます。
    savedContextPage.load().then(() => ai.refreshTarget());
    return route();
  }

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  async function route() {
    const hash = window.location.hash;
    const reviewMatch = hash.match(ROUTE_PATTERN);
    // ツール画面は同じ文書の別の面なので、行き来しても文書は開いたままです。
    const toolMatch = hash.match(TOOL_ROUTE_PATTERN);
    const match = reviewMatch || toolMatch;
    const nextPath = match ? decodeURIComponent(reviewMatch ? reviewMatch[1] : toolMatch[2]) : null;
    const anchor = reviewMatch ? reviewMatch[2] || '' : '';
    const tool = toolMatch ? toolPageByRoute(toolMatch[1]).key : null;

    if (state.currentPath && nextPath !== state.currentPath && !(await leaveDocument())) {
      window.location.hash = `#/review/${encodeURIComponent(state.currentPath)}`;
      return;
    }

    if (!match) {
      pdfViewer.dispose();
      mountChatPanel(false);
      refs.contextView.classList.add('hidden');
      refs.toolView.classList.add('hidden');
      fileList.revealPath(state.currentPath);
      state.currentPath = null;
      state.documentType = null;
      syncToolLinks();
      hideSidePane();
      await fileList.show();
      return;
    }

    if (nextPath === state.currentPath) {
      showDocumentView(tool);
      if (reviewMatch) linkNavigator.scrollToAnchor(anchor);
      return;
    }
    pendingAnchor = anchor;
    await openFile(nextPath);
    if (tool && state.currentPath === nextPath) showDocumentView(tool);
  }

  /**
   * 開いている文書の、どの面を出すか。`tool` が null ならレビュー本文です。
   *
   * ツール画面はレビュー本文と同じ文書を別の面から見るもので、開き直しではありません。
   * サイドパネルは本文の隣に置くものなので、ツール画面では畳みます。隠れた要素の中に
   * フォーカスや読み上げが入り込まないようにするためです。
   */
  function showDocumentView(tool) {
    // その文書では開けない画面のアドレスを踏んだとき（PDFの「本文の修正」など）は、
    // 空の操作盤を見せずに本文へ戻します。履歴には積まないので、戻るで往復しません。
    if (tool && !toolAvailable(tool)) {
      window.location.replace(`#/review/${encodeURIComponent(state.currentPath)}`);
      return;
    }
    refs.fileView.classList.add('hidden');
    const page = tool ? toolPageByKey(tool) : null;
    // コンテキストだけは前提を一覧に並べる専用の面なので、パネルの入れ物とは別立てです。
    const context = tool === 'context';
    refs.contextView.classList.toggle('hidden', !context);
    refs.toolView.classList.toggle('hidden', !page || context);
    refs.reviewView.classList.toggle('hidden', Boolean(page));
    markCurrentToolLink(document, tool);
    mountChatPanel(tool === 'chat');
    if (page) {
      hideSidePane();
      if (context) contextPage.render();
      else showToolPanel(page);
      // 保存した判断は、開くたびに引き直します。別の画面やAIの提案から増えていることが
      // あるので、前に開いたときの一覧をそのまま出すと、直したはずのものが残って見えます。
      if (page.key === 'savedContext') savedContextPage.load();
      // 別の画面で交わした相談も、開いた時点の記録として並べ直します。
      if (page.key === 'chatLog') contextPage.renderConversations();
      return;
    }
    closeSidePane();
  }

  /**
   * AIチャットを、サイドパネルのタブと `#/chat/<path>` の画面のあいだで運びます。
   *
   * 広い画面のためにもう1つ操作盤を作ると、話している最中のものが片方へ取り残されます。
   * 生成の途中だった回答、書きかけの質問、選んでいた対象、開いていた会話。どれも
   * 「タブで交わしていた続きを広い画面で」の続きそのものなので、作り直さずに、同じ要素を
   * 置き場所ごと動かします。動かすだけなので、送っている最中に移っても答えは途切れません。
   *
   * 戻すときに出し入れを決めるのはサイドパネルのタブです（`panes.show`）。ここで直に
   * `hidden` を外すと、コメントのタブを選んでいた人にAIの欄が重なって出ます。
   */
  function mountChatPanel(onPage) {
    const host = onPage ? refs.chatPageHost : chatPanelHome;
    refs.chatPageHost.classList.toggle('hidden', !onPage);
    // 広い画面では、送信欄を下に残したまま、やり取りだけをスクロールさせます。
    refs.toolView.classList.toggle('chat-page', onPage);
    refs.aiPanel.classList.toggle('ai-panel-page', onPage);
    if (refs.aiPanel.parentElement === host) return;
    if (onPage) {
      host.append(refs.aiPanel);
      refs.aiPanel.classList.remove('hidden');
      // タブの中身ではなくなるので、名乗り方も変えます。タブ列を離れたものが
      // 「AIタブの中身」と名乗ると、読み上げは在りもしないタブを探しに行きます。
      refs.aiPanel.setAttribute('role', 'region');
      refs.aiPanel.setAttribute('aria-label', 'AIチャット');
      refs.aiPanel.removeAttribute('aria-labelledby');
      return;
    }
    chatPanelHome.insertBefore(refs.aiPanel, chatPanelHomeNext);
    refs.aiPanel.setAttribute('role', 'tabpanel');
    refs.aiPanel.setAttribute('aria-labelledby', 'ai-tab-button');
    refs.aiPanel.removeAttribute('aria-label');
    panes.show(state.sidePane);
  }

  /** ツール画面の中身。開いた1枚だけを出し、残りは畳んでおきます。 */
  function showToolPanel(page) {
    refs.toolPageLabel.textContent = page.title;
    refs.toolPageLead.textContent = page.lead;
    refs.toolDocumentTitle.textContent = state.currentPath || '';
    refs.toolDocumentTitle.title = state.currentPath || '';
    for (const other of TOOL_PAGES_WITH_PANEL) {
      refs[other.panel].classList.toggle('hidden', other.key !== page.key);
    }
  }

  /**
   * `<a data-tool-link>` の行き先を、いま開いている文書へ向け直します。
   *
   * 押したときの処理はブラウザに任せているので、ここで書き換えるのは行き先と、
   * その文書で使えるかどうかだけです。使えない画面へのリンクは出しません。
   */
  function syncToolLinks() {
    updateToolLinks(document, { path: state.currentPath, visible: toolAvailable });
  }

  /** その文書でその画面を開けるか。開けないものは、リンクごと出しません。 */
  function toolAvailable(key) {
    if (key === 'manager') return state.features.manager;
    if (key === 'recap') return recap.visible();
    if (key === 'tasks') return autoTasks.available();
    // 指摘の配置はPDFに置けず、本文の修正はMarkdown以外を書き換えられません。
    if (key === 'placement') return state.documentType !== 'pdf';
    // 読み手・参照ファイル・相談の記録は前提そのもので、どの文書でも決められます。
    if (key === 'revise') return state.documentType === 'markdown';
    return true;
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
      state.directoryAiContextDirty = false;
      state.briefDirty = false;
      state.contextNotesDirty = false;
      state.directoryContextNotesDirty = false;
      state.personaDirty = false;
      state.referenceFilesDirty = false;
      return true;
    }
    if (state.commentsDirty || state.aiContextDirty || state.directoryAiContextDirty || state.briefDirty
      || state.contextNotesDirty || state.directoryContextNotesDirty || state.personaDirty
      || state.referenceFilesDirty || commentSaves.isBusy()) {
      if (await commentSaves.flush()) return true;
      if (!window.confirm('コメントを保存できていません。破棄して移動しますか？')) return false;
      state.commentsDirty = false;
      state.aiContextDirty = false;
      state.directoryAiContextDirty = false;
      state.briefDirty = false;
      state.contextNotesDirty = false;
      state.directoryContextNotesDirty = false;
      state.personaDirty = false;
      state.referenceFilesDirty = false;
    }
    return true;
  }

  async function navigateBack() {
    if (!(await leaveDocument())) return;
    state.mode = 'comment';
    state.saveFailed = false;
    window.location.hash = '#/';
  }

  /* ---------------------------------------------------------------- *
   * Opening a document
   * ---------------------------------------------------------------- */

  async function openFile(filePath) {
    pdfViewer.dispose();
    editor.cancel();
    commentSaves.cancel();
    resetDocumentState(state, filePath);
    closeSidePane();
    // 別の文書を開くときは、広い画面へ運んだままのチャットもサイドパネルへ戻します。
    mountChatPanel(false);
    pendingDeleteId = null;
    pendingMemoDeleteId = null;

    refs.fileView.classList.add('hidden');
    refs.reviewView.classList.remove('hidden');
    refs.exportOutput.hidden = true;
    refs.documentTitle.textContent = filePath;
    refs.documentTitle.title = filePath;
    syncToolLinks();
    refs.outlineList.innerHTML = '<p class="muted">見出しを読み込み中です。</p>';
    refs.outlineCount.textContent = '0';
    bodyCopy.syncControl();
    setCommentStatus('idle', 'コメントは自動保存されます。');
    setMemoStatus('idle', 'メモは自動保存されます。');
    content.innerHTML = '<p class="muted">文書を読み込み中...</p>';
    panes.show('comments');
    placement.reset();
    briefNoticeShown = false;
    documentBrief.load();
    contextNotes.load();
    referenceFiles.load();
    contextPage.load();
    persona.load();
    documentReview.load();
    revise.reset();
    recap.load();
    autoTasks.load();
    renderComments();
    memoComposer.reset();
    renderMemos();

    try {
      const data = await api.openFile(filePath);
      if (state.currentPath !== filePath) return;
      adoptSavedDocument(data);
      updateModeControls();
      if (state.documentType === 'pdf') {
        await pdfViewer.open(data);
        if (state.currentPath !== filePath) return;
        renderOutline();
        renderComments();
      } else {
        renderCommentMode();
      }
      ai.loadDocument();
      restoreScrollPosition(filePath);
    } catch (error) {
      if (state.currentPath !== filePath) return;
      content.innerHTML = `<p class="load-error">このファイルを開けませんでした: ${escapeText(error.message)}</p>`;
      toaster.error(`このファイルを開けませんでした: ${error.message}`);
    }
  }

  function rememberScrollPosition() {
    if (!state.currentPath) return;
    const pane = refs.markdownContent.closest('.document-pane');
    window.sessionStorage?.setItem(SCROLL_RESTORE_KEY, JSON.stringify({
      path: state.currentPath,
      windowY: window.scrollY,
      paneY: pane?.scrollTop || 0
    }));
  }

  function restoreScrollPosition(filePath) {
    let saved;
    try { saved = JSON.parse(window.sessionStorage?.getItem(SCROLL_RESTORE_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.path !== filePath) return;
    window.sessionStorage.removeItem(SCROLL_RESTORE_KEY);
    window.requestAnimationFrame(() => {
      window.scrollTo?.(0, saved.windowY || 0);
      const pane = refs.markdownContent.closest('.document-pane');
      if (pane) pane.scrollTop = saved.paneY || 0;
    });
  }

  function adoptSavedDocument(data) {
    adoptFeatures(data.features);
    state.documentType = data.documentType || 'markdown';
    state.markdown = data.markdown || '';
    state.rawHtml = data.html || '';
    state.textBody = data.textBody === true;
    state.transcript = data.transcript === true;
    if (Array.isArray(data.transcriptFiles)) state.transcriptFiles = data.transcriptFiles;
    if (data.review?.comments) state.comments = data.review.comments;
    // 残したメモは、書きかけが無いときだけ保存済みのもので置き換えます。コメントの
    // 前提や3点と同じ約束で、送っている最中に書き足した1件を落とさないためです。
    if (!state.memosDirty) state.memos = data.review?.memos || [];
    if (typeof data.projectAiContext === 'string') state.projectAiContext = data.projectAiContext;
    if (typeof data.directoryContextFile === 'string') state.directoryContextFile = data.directoryContextFile;
    // ディレクトリ全体の前提は文書ごとの持ち物ではないので、開くたびに読み直します。
    // 別のディレクトリを開いたときも、その場でこの画面の欄が入れ替わります。
    if (typeof data.directoryAiContext === 'string' && !state.directoryAiContextDirty) {
      state.directoryAiContext = data.directoryAiContext;
    }
    if (Array.isArray(data.directoryContextNotes) && !state.directoryContextNotesDirty) {
      state.directoryContextNotes = data.directoryContextNotes;
    }
    // A save that carried the context back confirms it; nothing typed since is lost.
    if (!state.aiContextDirty) state.aiContext = data.review?.aiContext || '';
    if (!state.briefDirty) state.brief = state.features.manager ? (data.review?.brief || null) : null;
    if (!state.contextNotesDirty) state.contextNotes = data.review?.contextNotes || [];
    if (!state.personaDirty) state.persona = data.review?.persona || null;
    if (!state.referenceFilesDirty) state.referenceFiles = data.review?.referenceFiles || [];
    state.commentsDirty = false;
    aiContext.load();
    renderMemos();
    documentBrief.refresh();
    contextNotes.render();
    referenceFiles.render();
    persona.refresh();
    documentReview.refresh();
    contextPage.render();
    bodyCopy.syncControl();
    // 文字起こしでない文書にはリンクを出しません。本文が入れ替わるたびに見直すのは、
    // 会議中に書き足されたファイルを開き直したときも、その場でリンクが出るようにするためです。
    // 発言が並んでいるのに文字起こし用のファイルではない文書にはリンクを出し、聞き直せない
    // 理由を画面に書きます。黙って消すと、機能ごと無いものとして読まれるからです。
    syncToolLinks();
    recap.refresh();
    // タスクのリンクは文書の種類（PDFでは出さない）で、見守りの欄は文字起こしかどうかで
    // 出し入れします。
    autoTasks.sync();
  }

  function adoptFeatures(features) {
    state.features = {
      manager: features?.manager === true,
      translation: features?.translation === true,
      autoTasks: features?.autoTasks === true
    };
    syncToolLinks();
    // 管理者が無効なときの3点は、保存側も断ります。画面ごと出さないので、書ける欄が
    // 出たまま、書いたあとの保存で初めて断られることにはなりません（`toolAvailable`）。
    refs.documentTranslateButton.classList.toggle('hidden', !state.features.translation);
    refs.sideDocumentTranslateButton.classList.toggle('hidden', !state.features.translation);
    refs.selectionTranslateButton.classList.toggle('hidden', !state.features.translation);
    refs.aiTabButton.childNodes[0].textContent = state.features.translation ? '翻訳・AI' : 'AI';
    refs.aiPanel.querySelector('.ai-header h2').textContent = state.features.translation
      ? '翻訳・AIチャット'
      : 'AIチャット';
    if (!state.features.translation) {
      ai.cancelTranslationPrefetch();
      state.translation = null;
      refs.translationResult.classList.add('hidden');
    }
  }

  /**
   * 設定で翻訳の入り切りが変わったときの反映です。
   *
   * 段落ごとの「翻訳」ボタンは本文を描くときに付けているので、印を付け替えるだけでは
   * 出ません。開いている文書をその場で描き直します（編集中の本文は触りません。
   * 打ちかけを、設定を変えただけで捨てることになるからです）。
   */
  function applyFeatureChange(features) {
    if (!features) return;
    adoptFeatures(features);
    // 見守りは、設定で入れた直後から欄が出て、切った直後に消えます。
    autoTasks.sync();
    if (!state.currentPath || state.mode === 'edit') return;
    if (state.documentType === 'pdf') pdfViewer.renderHighlights(state.comments, state.memos);
    else renderCommentMode();
  }

  /* ---------------------------------------------------------------- *
   * Comment mode
   * ---------------------------------------------------------------- */

  function renderCommentMode() {
    if (state.documentType === 'pdf') {
      pdfViewer.renderHighlights(state.comments, state.memos);
      renderComments();
      renderMemos();
      return;
    }
    content.innerHTML = state.rawHtml;
    decorateReviewTargets();
    // 印を付ける前に引き直します。外れたコメントは編集モードだけの話ではないので、
    // 読むときにも「もう指す先が無い」と分かる必要があります。メモも同じです。
    refreshCommentAttachment(content, state.comments);
    refreshCommentAttachment(content, state.memos, 'memo');
    renderOutline();
    renderComments();
    renderMemos();
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
      ...(state.features.translation
        ? [createTargetAction('inline-translate-button', '翻訳', (target) => ai.translate(target))]
        : []),
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

  /* ---------------------------------------------------------------- *
   * Persistent side pane and document outline
   * ---------------------------------------------------------------- */

  function openSidePane() {
    if (!state.currentPath) return;
    refs.selectionToolbar.classList.add('hidden');
    refs.reviewView.classList.add('side-pane-open');
    refs.sidePaneToggle.classList.add('hidden');
    refs.sidePaneBackdrop.classList.remove('hidden');
    refs.sidePaneToggle.setAttribute('aria-expanded', 'true');
    refs.sidePane.removeAttribute('aria-hidden');
    refs.sidePane.removeAttribute('inert');
  }

  function closeSidePane({ hideToggle = false, restoreFocus = false } = {}) {
    refs.reviewView.classList.remove('side-pane-open');
    refs.sidePaneBackdrop.classList.add('hidden');
    refs.sidePaneToggle.setAttribute('aria-expanded', 'false');
    refs.sidePaneToggle.classList.toggle('hidden', hideToggle || !state.currentPath);
    syncSidePaneAccessibility();
    if (restoreFocus && !hideToggle && state.currentPath) refs.sidePaneToggle.focus();
  }

  function hideSidePane() {
    closeSidePane({ hideToggle: true });
    refs.sidePane.setAttribute('aria-hidden', 'true');
    refs.sidePane.setAttribute('inert', '');
  }

  function syncSidePaneAccessibility() {
    const drawerClosed = isDrawerLayout() && !refs.reviewView.classList.contains('side-pane-open');
    const inaccessible = !state.currentPath || drawerClosed;
    if (inaccessible) {
      refs.sidePane.setAttribute('aria-hidden', 'true');
      refs.sidePane.setAttribute('inert', '');
    } else {
      refs.sidePane.removeAttribute('aria-hidden');
      refs.sidePane.removeAttribute('inert');
    }
  }

  function isDrawerLayout() {
    return window.matchMedia
      ? window.matchMedia('(max-width: 1100px)').matches
      : (window.innerWidth || 1024) <= 1100;
  }

  function renderOutline() {
    const entries = outlineEntries();
    refs.outlineCount.textContent = String(entries.length);
    refs.outlineList.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = state.documentType === 'pdf'
        ? '表示できるページはありません。'
        : 'この文書には見出しがありません。';
      refs.outlineList.append(empty);
      return;
    }

    entries.forEach((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-item';
      button.dataset.level = String(entry.level);

      const number = document.createElement('span');
      number.className = 'outline-item-number';
      number.textContent = entry.badge || String(index + 1);
      const text = document.createElement('span');
      text.className = 'outline-item-label';
      text.textContent = entry.label || `見出し ${index + 1}`;
      button.append(number, text);
      button.addEventListener('click', () => {
        closeSidePane();
        entry.reveal();
      });
      refs.outlineList.append(button);
    });
  }

  /**
   * 目次に並べるもの。どこから拾うかは画面によって違います。
   *
   * 編集モードだけは、組み上がりではなく書いているMarkdownそのものから拾います。
   * いま打った見出しがその場で並ぶのと、押した先がカーソルの行になるためです。
   */
  function outlineEntries() {
    if (state.documentType === 'pdf') {
      return [...content.querySelectorAll('.pdf-page[data-page-number]')].map((page) => ({
        level: 1,
        badge: page.dataset.pageNumber,
        label: `ページ ${page.dataset.pageNumber}`,
        reveal: () => revealOutlineTarget(page)
      }));
    }
    if (state.mode === 'edit') return editor.outlineEntries();
    return [...content.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      label: targetTextOf(heading).trim(),
      reveal: () => revealOutlineTarget(heading)
    }));
  }

  function revealOutlineTarget(target) {
    target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    focusReviewElement(target);
  }

  function scrollToDocumentTop() {
    const documentPane = document.querySelector('.document-pane');
    documentPane?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    closeSidePane();
    focusReviewElement(documentPane);
  }

  function focusReviewElement(element) {
    if (!element) return;
    if (!element.hasAttribute('tabindex')) element.tabIndex = -1;
    element.focus?.({ preventScroll: true });
  }

  function syncStickyToolbarOffset() {
    const update = () => {
      const height = Math.ceil(refs.documentToolbar.getBoundingClientRect().height);
      if (height > 0) refs.reviewView.style.setProperty('--document-toolbar-height', `${height}px`);
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(update);
    else setTimeout(update, 0);
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
      ? state.documentType === 'pdf'
        ? pdfViewer.selectionTarget(range, selection.toString().trim())
        : targets.forSelection(range, selection.toString().trim())
      : null;

    if (!state.currentSelectionTarget) {
      ai.cancelTranslationPrefetch();
      refs.selectionToolbar.classList.add('hidden');
      return;
    }
    const rect = range.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const toolbarWidth = Math.min(refs.selectionToolbar.offsetWidth || 250, viewportWidth - 16);
    const left = Math.max(8, Math.min(rect.left, viewportWidth - toolbarWidth - 8));
    const below = rect.bottom + 8;
    const top = below + 52 <= viewportHeight ? below : Math.max(8, rect.top - 52);
    refs.selectionToolbar.style.left = `${left}px`;
    refs.selectionToolbar.style.top = `${top}px`;
    refs.selectionToolbar.classList.remove('hidden');
  }

  function queueSelectionTranslation() {
    if (!state.features.translation) return;
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
   * その場所に、自分のための覚え書きを残します。
   *
   * 一覧をその場で書き換えず、必ず新しい配列へ差し替えます。保存中に足した1件が
   * 失われないための約束で、コンテキストメモと同じです（`pushComments` は
   * 「保存し始めたときと同じ一覧のままか」を同一性で見ています）。
   */
  function addMemo(target, body) {
    const created = newMemo(target, body);
    state.memos = [...state.memos, created];
    renderMemos();
    markMemosDirty();
    toaster.success(`${state.memos.length}件目のメモを残しました。自動保存します。`);
    highlightMemoCard(created.id);
  }

  /**
   * Scrolls to where a proposed comment would land, so the reviewer can check
   * the AI picked the right place before accepting it.
   *
   * 候補を並べているのはツール画面（指摘の配置・AIレビュー・本文の修正）なので、押されたら
   * 本文の画面へ戻してから見せます。隠れたままの本文を動かしても、何も見えません。
   * アドレスも書き換えるので、確かめたあとは「戻る」で候補の一覧へ帰れます。
   */
  function revealTarget(target) {
    if (state.mode !== 'comment') return false;
    const text = target.selectedText || target.targetText || target.heading || '';
    const match = text ? findTextRange(content, text, target.contextBefore, target.contextAfter) : null;
    if (!match) return false;
    showBodyForReveal();

    const startElement = match.startNode.parentElement;
    const element = startElement?.closest('.review-target') || startElement;
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center' });
    element.classList.add('reveal-flash');
    setTimeout(() => element.classList.remove('reveal-flash'), REVEAL_FLASH_MS);
    selectRange(match);
    return true;
  }

  /** ツール画面から本文を確かめに行くとき、本文の画面へ戻します。 */
  function showBodyForReveal() {
    if (!state.currentPath || !refs.reviewView.classList.contains('hidden')) return;
    window.location.hash = `#/review/${encodeURIComponent(state.currentPath)}`;
    // アドレスの反映を待たずに出します。待つあいだに位置まで動かしても、まだ隠れています。
    showDocumentView(null);
  }

  /**
   * 許可された修正案を本文へ書き込みます。
   *
   * 通る道は編集モードと同じ `/api/file` です。AIがファイルへ触ることはなく、書くのは
   * レビュアーが1件ずつ本文と見比べて許可した、この1回だけです。`baseRevision` は
   * 「その修正案を作ったときの本文か」の申告で、違っていればサーバーが断ります。
   */
  async function applyDocumentEdits(chosen, baseRevision) {
    if (state.mode !== 'comment') {
      throw new Error('編集モードでは適用できません。コメントモードへ切り替えてください');
    }
    // 版の申告できない修正案は当てません。どの本文の上で作られたか分からない書き換えは、
    // 当たっているかどうかを誰も確かめられないからです。
    if (!baseRevision) throw new Error('修正案を作り直してください');
    // 書きかけのコメントを先に保存します。この保存の応答は保存済みのコメントを返すので、
    // 先に流しておかないと、書きかけが画面から消えます。
    const documentPath = state.currentPath;
    if (!(await commentSaves.flush())) throw new Error('コメントを保存できませんでした');
    // 保存を待っている間に別の文書へ移っていたら、この修正案の宛先はもうありません。
    if (state.currentPath !== documentPath) throw new Error('別の文書へ移動したため、適用を取りやめました');

    const result = await api.saveFile({
      path: documentPath,
      baseRevision,
      edits: chosen.map(({ blockId, start, end, after, delete: remove }) => {
        // 修正案を空にして適用したときは、削除として扱います。空の原文を書き戻すと、
        // 前後の空行だけが残った段落が本文に増えるためです。
        const removing = remove || String(after).trim() === '';
        return { blockId, start, end, markdown: removing ? '' : after, ...(removing ? { delete: true } : {}) };
      })
    });
    // 書き込みは済んでいるので、結果は返します。映すのは、まだその文書を開いているときだけです。
    if (state.currentPath === documentPath) {
      adoptSavedDocument(result);
      renderCommentMode();
    }
    return result;
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
    // 本文の修正は未解決のコメントを依頼として渡すので、件数が変わったら言い直させます。
    revise.refresh();
    renderCommentList(refs.commentsList, {
      comments: state.comments,
      mode: state.mode,
      pendingDeleteId,
      statusLabels: state.documentType === 'pdf' ? PDF_STATUS_LABELS : undefined,
      handlers: {
        onEdit(index, value) {
          state.comments[index].comment = value;
          markCommentsDirty();
        },
        onRepeat(index) {
          dialog.open(copyCommentTarget(state.comments[index]));
        },
        // コメントに混ざっていた「次の文書でも効く決定」を、保存した判断へ移します。
        // 移すのは本文だけで、保存するかどうかはあちらの画面で本人が決めます（仕様4.4）。
        onSaveContext(index) {
          const comment = state.comments[index];
          if (!comment?.comment?.trim()) return;
          state.savedContextDraftSource = 'comment';
          window.location.hash = `#/saved-context/${encodeURIComponent(state.currentPath)}`;
          savedContextPage.draft(comment.comment);
        },
        onFocusTarget(index) {
          focusCommentTarget(index);
        },
        onToggleStatus(index) {
          const comment = state.comments[index];
          if (!comment) return;
          const wasResolved = statusForComment(comment) === 'resolved';
          comment.status = wasResolved ? 'open' : 'resolved';
          pendingDeleteId = null;
          renderComments();
          markCommentsDirty();
          if (state.documentType === 'pdf') {
            toaster.info(wasResolved ? 'コメントを未確認に戻しました。' : 'コメントを確認済みにしました。');
          } else {
            toaster.info(wasResolved ? 'コメントを未解決に戻しました。' : 'コメントを解決済みにしました。');
          }
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
    refs.sidePaneToggleCount.textContent = String(state.comments.length);
    renderTargetHighlights();
  }

  /**
   * 残したメモの一覧です。コメントのような未解決・解決済みの分け方はありません。
   * メモは誰かへの依頼ではないので、片付いたかどうかを持たせる意味がないからです。
   * 要らなくなったら消す、というだけにしてあります。
   */
  function renderMemos() {
    memoComposer.sync();
    renderMemoList(refs.memosList, {
      memos: state.memos,
      mode: state.mode,
      pendingDeleteId: pendingMemoDeleteId,
      handlers: {
        onEdit(index, value) {
          state.memos[index].body = value;
          state.memos[index].updatedAt = new Date().toISOString();
          markMemosDirty();
        },
        onRepeat(index) {
          dialog.open(copyMemoTarget(state.memos[index]), 'memo');
        },
        onFocusTarget(index) {
          focusTarget(state.memos[index], 'memo');
        },
        onRequestDelete(index) {
          pendingMemoDeleteId = state.memos[index]?.id ?? null;
          renderMemos();
        },
        onCancelDelete() {
          pendingMemoDeleteId = null;
          renderMemos();
        },
        onConfirmDelete(index) {
          const removed = state.memos[index];
          state.memos = state.memos.filter((_, position) => position !== index);
          pendingMemoDeleteId = null;
          renderMemos();
          markMemosDirty();
          if (removed) toaster.info('メモを削除しました。');
        }
      }
    });
    refs.memoCount.textContent = String(state.memos.length);
    renderTargetHighlights();
  }

  /**
   * 本文に付ける印。コメントとメモを1度で引きます。別々に引くと、同じ文字に両方が
   * 付いているときに、片方の印がもう片方の印の中へ入れ子で入ります。
   */
  function renderTargetHighlights() {
    if (state.mode !== 'comment') return;
    if (state.documentType === 'pdf') pdfViewer.renderHighlights(state.comments, state.memos);
    else renderCommentHighlights(content, state.comments, state.memos);
  }

  /**
   * Clicking a highlighted place brings up what was written about it. The
   * comment lives in the pane, in full and ready to edit, so the click takes the
   * reviewer there instead of repeating the text over the document.
   */
  function revealCommentsFromHighlight(event) {
    if (state.mode !== 'comment') return;
    const spot = event.target.closest?.(
      '.comment-highlight-text, .comment-highlight-target, .memo-highlight-text, .memo-highlight-target'
    );
    if (!spot) return;
    // The marker is ours; the other buttons inside a block have their own jobs.
    const marker = event.target.closest('.comment-marker');
    if (!marker && event.target.closest('button, a, input, textarea, select')) return;
    // A click that finished a selection was aimed at the text, not the comment.
    if (!marker && window.getSelection()?.isCollapsed === false) return;
    revealWritingAt(spot);
  }

  function revealCommentsFromKeyboard(event) {
    if (state.mode !== 'comment' || (event.key !== 'Enter' && event.key !== ' ')) return;
    const spot = event.target.closest?.('.comment-highlight-text, .memo-highlight-text');
    if (!spot) return;
    event.preventDefault();
    revealWritingAt(spot);
  }

  /**
   * 印を押したときに開くもの。同じ場所にコメントとメモの両方があるときは、コメントを
   * 開きます。手を入れる理由になるのはコメントのほうで、メモは「メモ」タブに同じ順で
   * 並んでいるからです。
   */
  function revealWritingAt(spot) {
    const { comments, memos } = highlightIndexesAt(spot);
    if (comments.length) revealCards('comments', refs.commentsList, 'comment', comments);
    else revealCards('memos', refs.memosList, 'memo', memos);
  }

  /** Brings what was written for one place into view, and flashes it. */
  function revealCards(pane, list, kind, indexes) {
    if (indexes.length === 0) return;
    panes.show(pane);
    openSidePane();
    const cards = indexes
      .map((index) => list.querySelector(`.comment-card[data-${kind}-index="${index}"]`))
      .filter(Boolean);
    if (cards.length === 0) return;
    cards[0].scrollIntoView?.({ block: 'nearest' });
    cards.forEach((card) => {
      card.classList.add('revealed');
      setTimeout(() => card.classList.remove('revealed'), REVEAL_FLASH_MS);
    });
  }

  function highlightCommentCard(commentId) {
    highlightCard('comments', refs.commentsList, `[data-comment-id="${cssAttr(commentId)}"]`);
  }

  function highlightMemoCard(memoId) {
    highlightCard('memos', refs.memosList, `[data-memo-id="${cssAttr(memoId)}"]`);
  }

  function highlightCard(pane, list, selector) {
    panes.show(pane);
    openSidePane();
    const card = list.querySelector(`.comment-card${selector}`);
    if (!card) return;
    card.classList.add('just-added');
    card.scrollIntoView?.({ block: 'nearest' });
    setTimeout(() => card.classList.remove('just-added'), 1500);
  }

  function markAiContextDirty() {
    state.aiContextDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    // 同じ前提を2か所へ出しているので、書いていないほうの欄にも同じ文面を映します。
    aiContext.sync();
    // The AI pane promises to say what travels with a question; now it does.
    ai.refreshTarget();
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  /**
   * ディレクトリ全体に効く前提も、コメントと同じ自動保存に乗せます。行き先だけが
   * レビューファイルではなく `.review/context.json` です（`pushDirectoryAiContext`）。
   *
   * 同じ自動保存に乗せているのは、相談やレビューを始める直前の保存（`flush`）と、
   * 画面を離れるときの確認を、文書ごとの前提と1本で済ませるためです。別の仕組みにすると、
   * 書いた直後に質問したときだけ、ディレクトリ全体の前提が渡らないことになります。
   */
  /**
   * ディレクトリ全体へ残したメモも、文書ごとのメモと同じ自動保存に乗せます。行き先だけが
   * 別のファイルで、レビュアーにとっては同じ「メモを残した」1つの操作だからです。
   */
  function markDirectoryContextNotesDirty() {
    state.directoryContextNotesDirty = true;
    // The AI pane promises to say what travels with a question; the notes are part of it.
    ai.refreshTarget();
    // 「指摘の配置にも渡る」の表示は書いた前提と合わせて決まるので、そちらへ見直させます。
    aiContext.renderSummary();
    // 残したメモは2か所へ出しているので、押していないほうの一覧も描き直します。
    contextNotes.render();
    contextNotes.setDirectoryStatus('dirty');
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  function markDirectoryAiContextDirty() {
    state.directoryAiContextDirty = true;
    // 同じ前提を2か所へ出しているので、書いていないほうの欄にも同じ文面を映します。
    aiContext.sync();
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
    // 残したメモは2か所へ出しているので、押していないほうの一覧も描き直します。
    contextNotes.render();
    contextNotes.setStatus('dirty');
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  /**
   * 添えたファイルも、コメントと同じ自動保存でレビューファイルへ入ります。
   * 添えた直後に相談やレビューを始めても、その回からその中身を読ませられます。
   */
  function markReferenceFilesDirty() {
    state.referenceFilesDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    // The AI pane promises to say what travels with a question; the files are part of it.
    ai.refreshTarget();
    // 添えたファイルも2か所へ出しているので、押していないほうの一覧も描き直します。
    referenceFiles.render();
    referenceFiles.setStatus('dirty');
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
    // 3点も2か所から書けるので、書いていないほうの欄へ同じ内容を映します。
    documentBrief.sync();
    documentBrief.setStatus('dirty');
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  /** 組み直したペルソナは、コメントと同じ自動保存でレビューファイルへ入ります。 */
  function markPersonaDirty() {
    state.personaDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    // 読み手は2か所から決められるので、押していないほうの欄にも決まった読み手を映します。
    persona.refresh();
    if (!state.currentPath) return;
    commentSaves.schedule();
  }

  function focusCommentCard(commentId) {
    if (!commentId) return;
    highlightCommentCard(commentId);
    refs.commentsList.querySelector(`.comment-card[data-comment-id="${cssAttr(commentId)}"]`)?.focus?.();
  }

  function focusMemoCard(memoId) {
    if (!memoId) return;
    highlightMemoCard(memoId);
    refs.memosList.querySelector(`.comment-card[data-memo-id="${cssAttr(memoId)}"]`)?.focus?.();
  }

  function focusCommentTarget(index) {
    focusTarget(state.comments[index], 'comment');
  }

  /** カードから本文の対象へ移動します。コメントもメモも、指す先の探し方は同じです。 */
  function focusTarget(written, kind) {
    if (!written) return;
    let target = null;

    if (written.type === 'document') {
      target = document.querySelector('.document-pane');
    } else if (state.documentType === 'pdf') {
      target = content.querySelector(`.pdf-comment-highlight[data-${kind}-id="${cssAttr(written.id || '')}"]`)
        || content.querySelector(`.pdf-page[data-page-number="${cssAttr(written.pageNumber || '')}"]`);
    } else {
      const wanted = normalizeText(written.selectedText || written.targetText || written.heading || '');
      const selector = written.type === 'section'
        ? 'h1, h2, h3, h4, h5, h6'
        : written.type === 'text-selection'
          ? '.comment-highlight-text, .memo-highlight-text, .editor-comment-anchor'
          : 'p, li, blockquote, pre';
      target = [...content.querySelectorAll(selector)]
        .find((element) => normalizeText(targetTextOf(element)) === wanted) || null;
    }

    if (!target) {
      toaster.error(kind === 'memo'
        ? 'メモ対象を本文内で見つけられませんでした。'
        : 'コメント対象を本文内で見つけられませんでした。');
      return;
    }
    closeSidePane();
    target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    target.classList.add('focused-review-target');
    focusReviewElement(target);
    setTimeout(() => target.classList.remove('focused-review-target'), 1800);
  }

  /**
   * 残したメモも、コメントと同じ自動保存でレビューファイルへ入ります。
   * AIへは渡らないので、他の前提のように相談やレビューの表示を見直させる必要はありません。
   */
  function markMemosDirty() {
    state.memosDirty = true;
    // Every edit invalidates in-flight saves: their response must not overwrite newer text.
    state.commentsVersion += 1;
    if (!state.currentPath) return;
    setMemoStatus('dirty', '自動保存待ち…');
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
    // ディレクトリ全体の前提は開いている文書に紐づかないので、文書の有無より先に片づけます。
    // ここを `currentPath` の後ろに置くと、文書を閉じたあとに保存待ちが残ったとき、
    // 送る先がないまま「まだ保存するものがある」と言い続けることになります。
    if (!(await pushDirectoryPremise())) return false;
    if (!state.currentPath) return true;
    if (state.mode === 'edit' && !state.aiContextDirty && !state.briefDirty
      && !state.contextNotesDirty && !state.memosDirty && !state.personaDirty && !state.referenceFilesDirty) {
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
    // 自分のためのメモも、変わったときだけ送ります。状態表示を動かす条件も同じです。
    const savedMemos = state.memos;
    const savingMemos = state.memosDirty;
    const savedPersona = state.persona;
    // 添えたファイルも、変わったときだけ送ります。状態表示を動かす条件もメモと同じです。
    const savedReferenceFiles = state.referenceFiles;
    const savingReferenceFiles = state.referenceFilesDirty;
    // Leaving the comments out keeps the ones on file, which is what edit mode wants.
    const savingComments = state.mode !== 'edit';
    setCommentStatus('saving', '保存中…');
    aiContext.setStatus('saving');
    if (savingBrief) documentBrief.setStatus('saving');
    if (savingNotes) contextNotes.setStatus('saving');
    if (savingReferenceFiles) referenceFiles.setStatus('saving');
    if (savingMemos) setMemoStatus('saving', '保存中…');

    try {
      const result = await api.saveComments({
        path,
        comments: savingComments ? state.comments : undefined,
        aiContext: savedContext,
        // null は「3つを消す」なので、未変更の undefined と区別して送ります。
        ...(savingBrief ? { brief: savedBrief } : {}),
        // 空の配列は「最後の1件を消した」なので、未変更の undefined と区別して送ります。
        ...(savingNotes ? { contextNotes: savedNotes } : {}),
        // メモも同じです。最後の1件を消した状態を、送らなかったことにはできません。
        ...(savingMemos ? { memos: savedMemos } : {}),
        // null は「ペルソナを消す」なので、未変更の undefined と区別して送ります。
        ...(state.personaDirty ? { persona: savedPersona } : {}),
        // 空の配列は「最後の1件を外した」なので、未変更の undefined と区別して送ります。
        ...(savingReferenceFiles ? { referenceFiles: savedReferenceFiles } : {})
      });
      state.commentSaveFailed = false;
      if (state.currentPath === path && state.aiContext === savedContext) state.aiContextDirty = false;
      if (state.currentPath === path && state.brief === savedBrief) state.briefDirty = false;
      if (state.currentPath === path && state.contextNotes === savedNotes) state.contextNotesDirty = false;
      if (state.currentPath === path && state.memos === savedMemos) state.memosDirty = false;
      if (state.currentPath === path && state.persona === savedPersona) state.personaDirty = false;
      if (state.currentPath === path && state.referenceFiles === savedReferenceFiles) {
        state.referenceFilesDirty = false;
      }
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
      if (savingReferenceFiles) referenceFiles.setStatus(state.referenceFilesDirty ? 'dirty' : 'saved');
      if (savingMemos) {
        setMemoStatus(...(state.memosDirty
          ? ['dirty', '自動保存待ち…']
          : ['saved', `自動保存しました ${new Date().toLocaleTimeString()}`]));
      }
      return true;
    } catch (error) {
      state.commentSaveFailed = true;
      setCommentStatus('error', `保存できませんでした: ${error.message}`);
      aiContext.setStatus('error', `保存できませんでした: ${error.message}`);
      if (savingBrief) documentBrief.setStatus('error', `保存できませんでした: ${error.message}`);
      if (savingNotes) contextNotes.setStatus('error', `保存できませんでした: ${error.message}`);
      if (savingReferenceFiles) referenceFiles.setStatus('error', `保存できませんでした: ${error.message}`);
      if (savingMemos) setMemoStatus('error', `保存できませんでした: ${error.message}`);
      return false;
    }
  }

  /**
   * ディレクトリ全体の前提を `.review/context.json` へ保存します。
   *
   * 触っていないときは何も送りません。文書を開くたびに送ると、書き換えてもいない前提の
   * 更新日時だけが動き、レビューファイルの隣に「いつ変えたのか」の当てにならない記録が
   * 残ります。
   */
  async function pushDirectoryPremise() {
    const savingContext = state.directoryAiContextDirty;
    const savingNotes = state.directoryContextNotesDirty;
    if (!savingContext && !savingNotes) return true;
    const savedContext = state.directoryAiContext;
    const savedNotes = state.directoryContextNotes;
    if (savingContext) aiContext.setDirectoryStatus('saving');
    if (savingNotes) contextNotes.setDirectoryStatus('saving');
    try {
      const result = await api.saveDirectoryContext({
        ...(savingContext ? { aiContext: savedContext } : {}),
        // 空の配列は「最後の1件を消した」なので、触っていない undefined と区別して送ります。
        ...(savingNotes ? { contextNotes: savedNotes } : {})
      });
      state.directoryContextFile = result.directoryContextFile || state.directoryContextFile;
      // 送っている間に書き足されていれば、保存待ちのままにします。次の自動保存で送ります。
      if (savingContext && state.directoryAiContext === savedContext) state.directoryAiContextDirty = false;
      if (savingNotes && state.directoryContextNotes === savedNotes) state.directoryContextNotesDirty = false;
      if (savingContext) aiContext.setDirectoryStatus(state.directoryAiContextDirty ? 'dirty' : 'saved');
      if (savingNotes) contextNotes.setDirectoryStatus(state.directoryContextNotesDirty ? 'dirty' : 'saved');
      return true;
    } catch (error) {
      if (savingContext) aiContext.setDirectoryStatus('error', `保存できませんでした: ${error.message}`);
      if (savingNotes) contextNotes.setDirectoryStatus('error', `保存できませんでした: ${error.message}`);
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

  function setMemoStatus(status, message) {
    refs.memoStatus.dataset.state = status;
    refs.memoStatus.textContent = message;
  }

  /* ---------------------------------------------------------------- *
   * Mode switching and page level events
   * ---------------------------------------------------------------- */

  async function setMode(nextMode) {
    if (state.documentType === 'pdf') return;
    if (nextMode === state.mode || !state.currentPath) return;
    if (nextMode === 'comment') {
      if (!(await editor.flush())) return;
      state.mode = 'comment';
      renderCommentMode();
    } else {
      if (!(await commentSaves.flush())) return;
      if (!allowedToWrite()) return;
      state.mode = 'edit';
      updateModeControls();
      editor.render();
      renderComments();
      renderMemos();
    }
    updateModeControls();
  }

  /**
   * 書き始める手前の、資料の管理者の関門です。
   *
   * まだ本文の無い資料は、これから作るものです。3点が決まっていなければ編集モードへ
   * 入れず、管理者のパネルを開いて求めます。「資料そのものを作るより先に求める」を
   * 一番そのままに置ける場所がここだからです。
   *
   * すでに書かれている資料では止めず、1度だけ言うに留めます。このアプリは書くための
   * ものだけではなく、直しに来た人や読みに来ただけの人まで編集の手前で締め出すと、
   * レビューの道具でなくなります。
   *
   * どちらも1度きりです。押し直せば、決めないままでも書き始められます。関門は
   * 決めないまま進んでいることに気づかせるためのもので、書き手の判断より上に
   * 置くものではありません。
   */
  function allowedToWrite() {
    if (!state.features.manager) return true;
    const missing = missingBriefFields(state.brief);
    if (missing.length === 0 || briefNoticeShown) return true;
    briefNoticeShown = true;
    const names = missing.map(({ label }) => label).join('・');
    if (hasWrittenBody(state.markdown)) {
      toaster.info(`資料の管理者が${names}を求めています。`
        + '「管理者」の画面で決めておくと、AIレビューもその3点を基準に読みます。');
      return true;
    }
    // 求める役が黙っていては求めたことにならないので、その画面まで連れて行きます。
    window.location.hash = `#/manager/${encodeURIComponent(state.currentPath)}`;
    toaster.info(`まだ本文の無い資料です。資料の管理者が${names}を求めています。`
      + 'ここで決めてから書き始めるか、もう一度「編集」を押してください。');
    return false;
  }

  function updateModeControls() {
    const pdfReadOnly = state.documentType === 'pdf';
    const bodyReadOnly = state.documentType !== 'markdown';
    if (bodyReadOnly) state.mode = 'comment';
    const editing = state.mode === 'edit';
    refs.modeSwitch.classList.toggle('hidden', bodyReadOnly);
    refs.modeShortcut.classList.toggle('hidden', bodyReadOnly);
    refs.editModeButton.disabled = bodyReadOnly;
    refs.commentModeButton.classList.toggle('active', !editing);
    refs.editModeButton.classList.toggle('active', editing);
    refs.commentModeButton.setAttribute('aria-pressed', String(!editing));
    refs.editModeButton.setAttribute('aria-pressed', String(editing));
    refs.editorToolbar.classList.toggle('hidden', !editing);
    refs.editorSaveRow.classList.toggle('hidden', !editing);
    refs.markdownSource.classList.toggle('hidden', !editing);
    refs.documentCommentButton.disabled = editing;
    refs.documentTranslateButton.disabled = editing || pdfReadOnly;
    refs.documentAiButton.disabled = editing || pdfReadOnly;
    refs.sideDocumentCommentButton.disabled = editing;
    refs.sideDocumentTranslateButton.disabled = editing || pdfReadOnly;
    refs.sideDocumentAiButton.disabled = editing || pdfReadOnly;
    refs.saveButton.disabled = editing;
    // 置けない・書き換えられない文書では、その画面へのリンクごと出しません。
    syncToolLinks();
    refs.documentTranslateButton.title = pdfReadOnly ? 'PDF全体の翻訳には対応していません。文章を選択してください。' : '';
    refs.documentAiButton.title = pdfReadOnly ? 'PDF全体ではなく、文章を選択してAIに相談してください。' : '';
    refs.sideDocumentTranslateButton.title = refs.documentTranslateButton.title;
    refs.sideDocumentAiButton.title = refs.documentAiButton.title;
    refs.documentNotice.hidden = !pdfReadOnly;
    refs.documentNotice.textContent = pdfReadOnly
      ? 'PDFは読み取り専用です。本体は変更されません。コメントの状態は、PDF外での対応を含めて「未確認／確認済み」として管理します。範囲選択は1ページ内で行ってください。'
      : '';
    refs.reviewView.classList.toggle('editing-mode', editing);
    refs.reviewView.classList.toggle('pdf-mode', pdfReadOnly);
    syncStickyToolbarOffset();
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
      || state.directoryAiContextDirty
      || state.briefDirty
      || state.contextNotesDirty
      || state.directoryContextNotesDirty
      || state.memosDirty
      || state.personaDirty
      || state.referenceFilesDirty
      || state.commentSaveFailed
      || commentSaves.isBusy();
  }

  function beaconComments() {
    // ディレクトリ全体の前提は行き先が別のファイルで、開いている文書にも紐づきません。
    // 閉じ際も、文書の有無より先に別便で送ります。
    if (state.directoryAiContextDirty || state.directoryContextNotesDirty) {
      api.beaconDirectoryContext({
        ...(state.directoryAiContextDirty ? { aiContext: state.directoryAiContext } : {}),
        ...(state.directoryContextNotesDirty ? { contextNotes: state.directoryContextNotes } : {})
      });
    }
    if (!state.currentPath) return;
    const savingComments = state.mode === 'comment' && state.commentsDirty;
    if (!savingComments && !state.aiContextDirty && !state.briefDirty
      && !state.contextNotesDirty && !state.memosDirty && !state.personaDirty
      && !state.referenceFilesDirty) return;
    api.beaconComments({
      path: state.currentPath,
      // Edit mode owns the comments; only the reading context is ours to send.
      comments: savingComments ? state.comments : undefined,
      aiContext: state.aiContext,
      ...(state.briefDirty ? { brief: state.brief } : {}),
      ...(state.contextNotesDirty ? { contextNotes: state.contextNotes } : {}),
      ...(state.memosDirty ? { memos: state.memos } : {}),
      ...(state.personaDirty ? { persona: state.persona } : {}),
      ...(state.referenceFilesDirty ? { referenceFiles: state.referenceFiles } : {})
    });
  }

  function bindGlobalEvents() {
    window.addEventListener('hashchange', route);
    window.addEventListener('resize', () => {
      syncStickyToolbarOffset();
      syncSidePaneAccessibility();
    });
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
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !refs.reviewView.classList.contains('side-pane-open') || dialog.isOpen) return;
      closeSidePane({ restoreFocus: true });
    });

    onPlainClick(refs.backButton, navigateBack);
    refs.refreshButton.addEventListener('click', () => {
      rememberScrollPosition();
      window.location.reload();
    });
    window.addEventListener('beforeunload', rememberScrollPosition);
    document.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'r' || !event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      rememberScrollPosition();
      window.location.reload();
    });
    refs.headerLink.addEventListener('click', (event) => {
      // 別タブで開こうとしているなら、いま開いている文書はそのままなので止めません。
      if (!isPlainClick(event) || !hasUnsavedWork()) return;
      event.preventDefault();
      navigateBack();
    });
    refs.documentCommentButton.addEventListener('click', () => dialog.open({ type: 'document' }));
    refs.documentTranslateButton.addEventListener('click', () => ai.translate({ type: 'document' }));
    refs.documentAiButton.addEventListener('click', () => ai.ask({ type: 'document' }));
    refs.copyBodyButton?.addEventListener('click', bodyCopy.copy);
    refs.sideDocumentCommentButton.addEventListener('click', () => dialog.open({ type: 'document' }));
    refs.sideDocumentTranslateButton.addEventListener('click', () => ai.translate({ type: 'document' }));
    refs.sideDocumentAiButton.addEventListener('click', () => ai.ask({ type: 'document' }));
    refs.outlineTopButton.addEventListener('click', scrollToDocumentTop);
    refs.sidePaneToggle.addEventListener('click', openSidePane);
    refs.sidePaneClose.addEventListener('click', () => closeSidePane({ restoreFocus: true }));
    refs.sidePaneBackdrop.addEventListener('click', () => closeSidePane({ restoreFocus: true }));
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

  /**
   * 同じ操作盤を2か所へ出したときの、まとめ役です。
   *
   * 呼ぶ側からは1つの操作盤に見えたまま、`load()` も `setStatus()` も両方へ届きます。
   * 中身はどちらも同じ state を読むので、片方で書き換えたものがもう片方にも出ます。
   */
  function fanOut(controllers) {
    const names = [...new Set(controllers.flatMap((controller) => Object.keys(controller)))];
    return Object.fromEntries(names.map((name) => [
      name,
      (...args) => controllers.map((controller) => controller[name]?.(...args))
    ]));
  }

  function escapeText(value) {
    const element = document.createElement('span');
    element.textContent = String(value);
    return element.innerHTML;
  }

  return { start, state, refs };
}
