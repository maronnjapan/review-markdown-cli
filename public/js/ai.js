import { completeJsonField } from './partialJson.js';
import { createTranslationPrefetch } from './translationPrefetch.js';
import { escapeHtml, truncate } from './util.js';

const TRANSLATION_PREFETCH_DELAY_MS = 0;

const TARGET_LABELS = {
  document: '文書全体',
  section: 'セクション',
  paragraph: '段落',
  'text-selection': '範囲選択'
};

export function createAiController({
  refs, state, api, toaster, panes,
  flushComments = async () => true,
  // 相談して分かったことをコンテキストメモの下書きへ渡します。
  onKeepContext = () => {},
  onPaneRequested = () => {}
}) {
  let preparePromise = null;

  bindEvents();

  async function prepare() {
    if (state.aiStatus?.available) return true;
    if (preparePromise) return preparePromise;
    refs.aiProviderStatus.textContent = 'AIを起動中…';
    preparePromise = (async () => {
      try {
        state.aiStatus = await api.prepareAi();
        // どのAIで走っているかはサーバーが決めるので、名前もサーバーが返したものを出します。
        const label = state.aiStatus.label || 'AI';
        refs.aiProviderStatus.textContent = state.aiStatus.available
          ? [label, state.aiStatus.model, state.aiStatus.effort].filter(Boolean).join(' / ')
          : state.aiStatus.error || `${label}を利用できません`;
        refs.aiProviderStatus.dataset.state = state.aiStatus.available ? 'ready' : 'error';
        return state.aiStatus.available;
      } catch (error) {
        refs.aiProviderStatus.textContent = error.message;
        refs.aiProviderStatus.dataset.state = 'error';
        return false;
      } finally {
        preparePromise = null;
      }
    })();
    return preparePromise;
  }

  async function loadDocument() {
    const documentPath = state.currentPath;
    if (!documentPath) return;
    if (!(await prepare()) || state.currentPath !== documentPath) return;
    try {
      const result = await api.listAiConversations(documentPath);
      if (state.currentPath !== documentPath) return;
      state.aiConversations = result.conversations || [];
      renderConversationOptions();
    } catch {
      // Codex is optional until the reviewer opens the AI pane.
    }
  }

  function ask(target) {
    state.aiTarget = cloneTarget(target);
    state.activeConversationId = null;
    state.translation = null;
    panes.show('ai');
    onPaneRequested();
    renderTarget();
    renderTranslation();
    renderMessages();
    renderConversationOptions();
    refs.aiChatInput.focus();
  }

  async function translate(target) {
    if (!state.features.translation) return;
    state.aiTarget = cloneTarget(target);
    state.translation = { status: 'loading' };
    panes.show('ai');
    onPaneRequested();
    renderTarget();
    renderTranslation();

    const key = targetKey(target);
    const prefetch = state.translationPrefetch?.key === key
      ? state.translationPrefetch
      : null;
    prefetch?.start();
    const progress = prefetch?.progress || createTranslationProgress(key);
    progress.show();
    try {
      const event = prefetch
        ? await prefetch.promise
        : await requestTranslation(target, undefined, progress.onEvent);
      state.translation = { status: 'ready', ...event.translation };
      renderTranslation();
    } catch (error) {
      if (error.name === 'AbortError' && prefetch) {
        try {
          const retryProgress = createTranslationProgress(key);
          const event = await requestTranslation(target, undefined, retryProgress.onEvent);
          state.translation = { status: 'ready', ...event.translation };
        } catch (retryError) {
          state.translation = { status: 'error', error: retryError.message };
        }
      } else {
        state.translation = { status: 'error', error: error.message };
      }
      renderTranslation();
    }
  }

  function prefetchTranslation(target) {
    if (!state.features.translation) return;
    const text = String(target?.selectedText || target?.targetText || '').trim();
    if (!text) return;
    const key = targetKey(target);
    if (state.translationPrefetch?.key === key) return;
    state.translationPrefetch?.cancel();

    const prefetch = createTranslationPrefetch({
      key,
      progress: createTranslationProgress(key),
      delayMs: TRANSLATION_PREFETCH_DELAY_MS,
      request: (signal, onEvent) => requestTranslation(target, signal, onEvent)
    });
    // 先読みが失敗しても画面には出しません。押されたときに、もう一度ふつうに頼みます。
    prefetch.promise.catch(() => {
      if (state.translationPrefetch === prefetch) state.translationPrefetch = null;
    });
    state.translationPrefetch = prefetch;
  }

  function cancelTranslationPrefetch(target) {
    const prefetch = state.translationPrefetch;
    if (!prefetch) return;
    if (target && prefetch.key !== targetKey(target)) return;
    if (prefetch.cancel() && state.translationPrefetch === prefetch) {
      state.translationPrefetch = null;
    }
  }

  async function requestTranslation(target, signal, onEvent) {
    // The AI reads the saved reading context, so save what is on screen first.
    await flushComments();
    return api.translateWithAi({ path: state.currentPath, target }, { signal, onEvent });
  }

  function createTranslationProgress(key) {
    let streamed = '';
    let lastResult = null;

    function show() {
      if (!lastResult || targetKey(state.aiTarget || {}) !== key) return;
      if (['ready', 'error'].includes(state.translation?.status)) return;
      state.translation = {
        status: 'streaming',
        kind: 'term',
        result: lastResult
      };
      renderTranslation();
    }

    function onEvent(event) {
      if (event.type !== 'delta') return;
      streamed += event.delta || '';
      const contextualMeaning = completeJsonField(streamed, 'contextualMeaning');
      if (typeof contextualMeaning !== 'string' || !contextualMeaning) return;
      const meanings = completeJsonField(streamed, 'meanings');
      const explanation = completeJsonField(streamed, 'explanation');
      lastResult = {
        contextualMeaning,
        ...(Array.isArray(meanings) ? { meanings } : {}),
        ...(typeof explanation === 'string' ? { explanation } : {})
      };
      show();
    }

    return { onEvent, show };
  }

  async function sendMessage() {
    const content = refs.aiChatInput.value.trim();
    if (!content || state.aiAbortController) return;
    if (!state.aiTarget) {
      if (state.documentType === 'pdf') {
        toaster.error('PDFでは文章を選択してからAIに質問してください。');
        return;
      }
      state.aiTarget = { type: 'document' };
      renderTarget();
    }

    let conversation = activeConversation();
    try {
      // The AI reads the saved review, so hand it whatever is on screen first.
      await flushComments();
      if (!conversation) {
        const created = await api.createAiConversation({ path: state.currentPath, target: state.aiTarget });
        conversation = created.conversation;
        state.aiConversations.unshift(conversation);
        state.activeConversationId = conversation.id;
        renderConversationOptions();
      }

      refs.aiChatInput.value = '';
      const optimisticUser = {
        id: `pending-user-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString()
      };
      conversation.messages.push(optimisticUser);
      renderMessages({ streaming: '' });
      setGenerating(true);

      const controller = new AbortController();
      state.aiAbortController = controller;
      let streamed = '';
      const result = await api.sendAiMessage({ conversationId: conversation.id, message: content }, {
        signal: controller.signal,
        onEvent(event) {
          if (event.type !== 'delta') return;
          streamed += event.delta || '';
          renderMessages({ streaming: streamed });
        }
      });
      const index = state.aiConversations.findIndex((item) => item.id === conversation.id);
      if (index >= 0) state.aiConversations[index] = result.conversation;
      renderConversationOptions();
      renderMessages();
    } catch (error) {
      if (error.name !== 'AbortError') toaster.error(`Codexから回答を取得できませんでした: ${error.message}`);
      await reloadConversations();
    } finally {
      state.aiAbortController = null;
      setGenerating(false);
    }
  }

  async function reloadConversations() {
    if (!state.currentPath) return;
    try {
      const result = await api.listAiConversations(state.currentPath);
      state.aiConversations = result.conversations || [];
      renderConversationOptions();
      renderMessages();
    } catch {
      renderMessages();
    }
  }

  function selectConversation(id) {
    state.activeConversationId = id || null;
    const conversation = activeConversation();
    if (conversation) state.aiTarget = cloneTarget(conversation.target);
    renderTarget();
    renderMessages();
    renderConversationOptions();
  }

  async function deleteConversation() {
    const conversation = activeConversation();
    const window = refs.aiPanel.ownerDocument.defaultView;
    if (!conversation || !window.confirm('このAI会話を削除しますか？')) return;
    try {
      await api.deleteAiConversation(conversation.id);
      state.aiConversations = state.aiConversations.filter((item) => item.id !== conversation.id);
      state.activeConversationId = null;
      renderConversationOptions();
      renderMessages();
      toaster.info('AI会話を削除しました。');
    } catch (error) {
      toaster.error(`AI会話を削除できませんでした: ${error.message}`);
    }
  }

  function renderConversationOptions() {
    const selected = state.activeConversationId || '';
    refs.aiConversationSelect.innerHTML = [
      '<option value="">新しい会話</option>',
      ...state.aiConversations.map((conversation) => (
        `<option value="${escapeHtml(conversation.id)}">${escapeHtml(truncate(conversation.title || '会話', 44))}</option>`
      ))
    ].join('');
    refs.aiConversationSelect.value = selected;
    refs.aiDeleteConversation.disabled = !selected;
  }

  function renderTarget() {
    const target = state.aiTarget;
    refs.aiTarget.classList.toggle('hidden', !target);
    if (!target) return;
    refs.aiTargetType.textContent = target.documentType === 'pdf' && target.type === 'text-selection'
      ? 'PDF範囲選択'
      : TARGET_LABELS[target.type] || '対象';
    refs.aiTargetType.dataset.type = target.type || '';
    refs.aiTargetPath.textContent = target.documentType === 'pdf' && target.pageNumber
      ? `ページ ${target.pageNumber}`
      : (target.headingPath || []).join(' › ');
    refs.aiTargetPath.hidden = !refs.aiTargetPath.textContent;
    refs.aiTargetText.textContent = target.type === 'document'
      ? '現在の文書全体を会話開始時のスナップショットとして使用します。'
      : target.selectedText || target.targetText || '';
    renderSharedComments();
  }

  /** Says what else goes to the AI, so the target quote is not the whole story. */
  function renderSharedComments() {
    const count = state.comments.length;
    const noteCount = (state.contextNotes || []).length;
    const hasContext = Boolean((state.aiContext || '').trim() || (state.projectAiContext || '').trim());
    const shared = [
      count ? `この文書のコメント${count}件` : '',
      // 管理者が決めた3点は、この資料が何のためにあるかそのものなので先に置きます。
      state.brief ? '資料の管理者が決めた3点' : '',
      hasContext ? '読み取りコンテキスト' : '',
      // 残したメモも前提の一部です。件数まで出すのは、残したはずのメモが
      // 渡っていないことに、質問を投げる前に気づけるようにするためです。
      noteCount ? `コンテキストメモ${noteCount}件` : '',
      // 読み手ペルソナも前提の一部なので、翻訳やチャットにも一緒に渡します。
      state.persona ? '読み手ペルソナ' : ''
    ].filter(Boolean);
    refs.aiTargetComments.textContent = shared.length ? `${shared.join('と')}も渡します。` : '';
    refs.aiTargetComments.hidden = shared.length === 0;
  }

  function renderTranslation() {
    const translation = state.translation;
    refs.translationResult.classList.toggle('hidden', !translation);
    if (!translation) {
      refs.translationResult.replaceChildren();
      return;
    }
    if (translation.status === 'loading') {
      refs.translationResult.innerHTML = '<p class="ai-loading">文脈を踏まえて翻訳中…</p>';
      return;
    }
    if (translation.status === 'error') {
      refs.translationResult.innerHTML = `<p class="ai-error">翻訳できませんでした: ${escapeHtml(translation.error)}</p>`;
      return;
    }
    refs.translationResult.innerHTML = translationHtml(translation);
  }

  function renderMessages({ streaming = null } = {}) {
    const conversation = activeConversation();
    const messages = conversation?.messages || [];
    if (messages.length === 0 && streaming === null) {
      refs.aiMessages.innerHTML = state.documentType === 'pdf' && !state.aiTarget
        ? '<p class="muted">PDF内の文章を選択して「AIに質問」を選んでください。PDF全体は会話対象にできません。</p>'
        : '<p class="muted">質問を入力すると、対象文章とこの文書のコメントを含めた読み取り専用の会話を開始します。</p>';
      return;
    }
    refs.aiMessages.innerHTML = [
      // map へ直接渡すと添字が第2引数（生成中かどうか）に入り、2件目以降が
      // 生成中の扱いになります。
      ...messages.map((message) => messageHtml(message)),
      streaming !== null ? messageHtml({ role: 'assistant', content: streaming || '…' }, true) : ''
    ].join('');
    refs.aiMessages.scrollTop = refs.aiMessages.scrollHeight;
  }

  function setGenerating(generating) {
    refs.aiSendButton.disabled = generating;
    refs.aiChatInput.disabled = generating;
    refs.aiStopButton.classList.toggle('hidden', !generating);
  }

  function activeConversation() {
    return state.aiConversations.find((conversation) => conversation.id === state.activeConversationId) || null;
  }

  function bindEvents() {
    refs.aiConversationSelect.addEventListener('change', () => selectConversation(refs.aiConversationSelect.value));
    refs.aiNewConversation.addEventListener('click', () => selectConversation(''));
    refs.aiDeleteConversation.addEventListener('click', deleteConversation);
    refs.aiChatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage();
    });
    refs.aiChatInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      sendMessage();
    });
    refs.aiStopButton.addEventListener('click', () => state.aiAbortController?.abort());
    // 相談の答えは、そのままでは次の相談にもレビューにも残りません。
    // 前提として残す価値があると判断した回答だけを、レビュアーがメモへ移します。
    refs.aiMessages.addEventListener('click', (event) => {
      const button = event.target.closest('[data-keep-context]');
      if (!button) return;
      onKeepContext(button.closest('.ai-message')?.querySelector('.ai-message-body')?.textContent || '');
    });
  }

  return {
    prepare,
    loadDocument,
    ask,
    translate,
    prefetchTranslation,
    cancelTranslationPrefetch,
    // 保存した会話は、コンテキスト画面からも直せます。直したあとの記録を、
    // こちらの一覧と吹き出しへも映し直すための入口です。
    refreshConversations() {
      renderConversationOptions();
      renderMessages();
    },
    // Comments and the reading context change while the pane is open, and the
    // pane promises to say what travels with the question.
    refreshTarget: renderTarget
  };
}

function cloneTarget(target) {
  return target ? JSON.parse(JSON.stringify(target)) : null;
}

function targetKey(target) {
  return JSON.stringify([
    target.selectedText || target.targetText || '',
    target.contextBefore || '',
    target.contextAfter || '',
    target.headingPath || []
  ]);
}

function translationHtml(translation) {
  const cached = translation.cached ? '<span class="translation-cache-badge">キャッシュ</span>' : '';
  if (translation.kind === 'term') {
    const result = translation.result || {};
    const meanings = (result.meanings || []).map((meaning) => (
      `<li><strong>${escapeHtml(meaning.translation)}</strong>${meaning.nuance ? ` — ${escapeHtml(meaning.nuance)}` : ''}</li>`
    )).join('');
    return `
      <header><h3>この文脈での意味 ${cached}</h3></header>
      <p class="contextual-meaning">${escapeHtml(result.contextualMeaning || '')}</p>
      <p>${escapeHtml(result.explanation || '')}</p>
      <details${meanings ? '' : ' hidden'}><summary>ほかの意味</summary><ul>${meanings}</ul></details>
      ${translation.status === 'streaming' ? '<p class="ai-loading translation-details-loading">ほかの意味と説明を生成中…</p>' : ''}`;
  }
  const result = translation.result || {};
  return `
    <header><h3>翻訳 ${cached}</h3></header>
    <p class="translated-passage">${escapeHtml(result.translation || '')}</p>
    ${(result.notes || []).length ? `<ul>${result.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''}`;
}

function messageHtml(message, streaming = false) {
  const label = message.role === 'user' ? 'あなた' : 'Codex';
  // 生成し終えた回答にだけ出します。途中の文をメモへ移しても、前提にはなりません。
  const keepable = message.role === 'assistant' && !streaming && Boolean(message.content);
  return `
    <article class="ai-message" data-role="${escapeHtml(message.role)}"${streaming ? ' data-streaming="true"' : ''}>
      <strong>${label}</strong>
      <p class="ai-message-body">${escapeHtml(message.content || '')}</p>
      ${keepable ? '<button type="button" class="ai-message-keep" data-keep-context>コンテキストに残す</button>' : ''}
    </article>`;
}
