import { personaHtml } from './documentReview.js';
import { escapeHtml, truncate } from './util.js';

/** サーバー側の上限と同じです（src/aiLimits.js の CONVERSATION_TITLE_CHARS）。 */
const MAX_CONVERSATION_TITLE_CHARS = 48;

const ROLE_LABELS = { user: 'あなた', assistant: 'Codex' };

/**
 * コンテキスト画面。
 *
 * サイドパネルは本文の隣に置くものなので、幅も高さも本文に譲ります。前提を書くのは
 * そこでもできますが、「いま何が前提として渡っているのか」を一度に見るには狭すぎます。
 * この画面は、その全部を1枚に開くための場所です。
 *
 * 出しているものは4つ。資料の管理者が決めた3点、読み取りコンテキスト、コンテキストメモ、
 * 読み手ペルソナ。前の3つはここで書き換えられます（同じ操作盤をサイドパネルと2か所へ
 * 出しているだけで、実体は `createApp.js` が作る1組の state です）。ペルソナだけは
 * 表示に留めて、決めるのはレビューを実行する場所と同じ「AIレビュー」タブに残しました。
 * 読み手はレビューの直前に決めるもので、決める場所を本文から離すと手順が増えるからです。
 *
 * ── AIチャットの記録をここへ置いた理由 ────────────────────
 * 相談の記録も前提です。Codexのスレッドが切れていれば、次に同じ会話を続けるときの
 * 1回目のプロンプトへ、残っている発言がそのまま入ります（`src/prompts/chat.js`）。
 * 言い間違えた質問や、間違ったまま残っている回答を直せないと、その会話を続けるかぎり
 * 間違いを読ませ続けることになります。だから読むだけでなく、直せる場所にしてあります。
 *
 * 直した記録は保存した時点でCodexのスレッドを畳みます（`src/aiService.js`）。畳まないと、
 * モデルは直す前の発言を覚えたまま、こちらの書き換えを読み直しません。
 */
export function createContextPageController({
  refs, state, api, toaster,
  onKeepNote = () => {},
  onEditPersona = () => {},
  onConversationsChanged = () => {}
}) {
  // 開いている会話。null なら、まだどれも選んでいません。
  let openConversationId = null;
  // 直している発言。null なら、どれも直していません。
  let editingMessageId = null;
  let pendingDeleteMessageId = null;
  // 保存の往復中。押し直しで同じ書き換えを2回送らないための錠です。
  let saving = false;

  bindEvents();

  /** 文書を開いたときの初期化。開いていた会話は前の文書のものなので捨てます。 */
  function load() {
    openConversationId = null;
    editingMessageId = null;
    pendingDeleteMessageId = null;
    saving = false;
    render();
  }

  function render() {
    refs.workspaceDocumentTitle.textContent = state.currentPath || '';
    refs.workspaceDocumentTitle.title = state.currentPath || '';
    renderPersona();
    renderConversations();
  }

  /* ---------------------------------------------------------------- *
   * 読み手ペルソナ（表示だけ）
   * ---------------------------------------------------------------- */

  function renderPersona() {
    refs.workspacePersonaState.textContent = state.persona ? '設定済み' : '未設定';
    refs.workspacePersonaState.dataset.state = state.persona ? 'set' : 'unset';
    refs.workspacePersonaResult.innerHTML = state.persona
      ? personaHtml(state.persona)
      : '<p class="muted">まだ読み手は決まっていません。「AIレビュー」タブで、書いた文章をそのまま使うか、AIに立場・前提知識・目的へ組み直させるかを選べます。</p>';
  }

  /* ---------------------------------------------------------------- *
   * AIチャットの記録
   * ---------------------------------------------------------------- */

  function renderConversations() {
    const conversations = state.aiConversations || [];
    // 別の画面で消された会話を開いたままにしません。空の詳細を出し続けるより、
    // 一覧へ戻したほうが、消えたことがそのまま分かります。
    if (openConversationId && !conversations.some((entry) => entry.id === openConversationId)) {
      openConversationId = null;
      editingMessageId = null;
    }
    refs.workspaceConversationState.textContent = conversations.length ? `${conversations.length}件` : '0件';
    refs.workspaceConversationState.dataset.state = conversations.length ? 'set' : 'unset';
    refs.workspaceConversationList.innerHTML = conversations.length
      ? conversations.map(conversationItemHtml).join('')
      : '<p class="muted">まだ相談の記録はありません。「AI」タブで質問すると、ここに残ります。</p>';
    refs.workspaceConversationDetail.innerHTML = detailHtml(openConversation());
  }

  function conversationItemHtml(conversation) {
    const messages = conversation.messages?.length || 0;
    const updatedAt = String(conversation.updatedAt || conversation.createdAt || '').slice(0, 10);
    return `
      <button type="button" class="workspace-conversation-item" data-open-conversation="${escapeHtml(conversation.id)}"
        ${conversation.id === openConversationId ? 'data-open="true" aria-current="true"' : ''}>
        <span class="workspace-conversation-title-text">${escapeHtml(truncate(conversation.title || '会話', 44))}</span>
        <span class="workspace-conversation-meta">${messages}往復ぶん・${escapeHtml(updatedAt)}</span>
      </button>`;
  }

  function detailHtml(conversation) {
    if (!conversation) {
      return '<p class="muted">左の一覧から会話を選ぶと、やり取りをここで読んで直せます。</p>';
    }
    const target = conversation.target || {};
    const quote = target.type === 'document'
      ? '文書全体を対象にした会話です。'
      : truncate(String(target.selectedText || target.targetText || ''), 400);
    const headingPath = (target.headingPath || []).join(' › ');
    return `
      <form class="workspace-conversation-title-form" data-title-form>
        <label class="workspace-field-label" for="workspace-conversation-title-input">会話の題名</label>
        <div class="workspace-title-row">
          <input id="workspace-conversation-title-input" type="text" maxlength="${MAX_CONVERSATION_TITLE_CHARS}"
            value="${escapeHtml(conversation.title || '')}">
          <button type="submit">題名を保存</button>
          <button type="button" class="danger" data-delete-conversation>この会話を削除</button>
        </div>
      </form>
      <p class="workspace-note">対象：${escapeHtml(headingPath || (target.type === 'document' ? '文書全体' : '選択した文章'))}</p>
      <blockquote class="workspace-conversation-target">${escapeHtml(quote)}</blockquote>
      <p class="workspace-note">直したやり取りは、次にこの会話を続けるときAIが読み直します。いま開いているCodexのスレッドは、保存した時点で畳みます。</p>
      <div class="workspace-messages">
        ${conversation.messages?.length
          ? conversation.messages.map(messageHtml).join('')
          : '<p class="muted">この会話には、残っている発言がありません。</p>'}
      </div>`;
  }

  function messageHtml(message) {
    const editing = editingMessageId === message.id;
    const deleting = pendingDeleteMessageId === message.id;
    const createdAt = String(message.createdAt || '').slice(0, 10);
    return `
      <article class="ai-message workspace-message" data-role="${escapeHtml(message.role)}"
        data-message-id="${escapeHtml(message.id)}">
        <header class="workspace-message-head">
          <strong>${escapeHtml(ROLE_LABELS[message.role] || message.role)}</strong>
          ${createdAt ? `<span class="context-note-date">${escapeHtml(createdAt)}</span>` : ''}
          ${message.editedAt ? '<span class="context-note-source">あとから編集</span>' : ''}
        </header>
        ${editing
          ? `<form class="workspace-message-form" data-message-form="${escapeHtml(message.id)}">
               <textarea rows="8">${escapeHtml(message.content || '')}</textarea>
               <div class="context-note-item-actions">
                 <button type="button" data-cancel-edit>やめる</button>
                 <button type="submit">この発言を直す</button>
               </div>
             </form>`
          : `<p class="ai-message-body">${escapeHtml(message.content || '')}</p>
             <div class="context-note-item-actions">
               ${deleting
                 // 取り消せない操作なので、確認の見え方をコメントとメモの削除確認と揃えます。
                 ? `<span class="context-note-confirm" role="group" aria-label="やり取りの削除確認">この発言を削除しますか？</span>
                    <button type="button" data-cancel-delete>やめる</button>
                    <button type="button" class="danger" data-confirm-delete="${escapeHtml(message.id)}">削除する</button>`
                 : `<button type="button" data-edit-message="${escapeHtml(message.id)}">編集</button>
                    <button type="button" data-delete-message="${escapeHtml(message.id)}">削除</button>
                    ${message.role === 'assistant'
                      ? `<button type="button" data-keep-note="${escapeHtml(message.id)}">コンテキストメモに残す</button>`
                      : ''}`}
             </div>`}
      </article>`;
  }

  /* ---------------------------------------------------------------- *
   * 直す・消す
   * ---------------------------------------------------------------- */

  async function saveTitle(title) {
    const conversation = openConversation();
    if (!conversation) return;
    await save({ id: conversation.id, title }, '題名を直しました。');
  }

  async function saveMessage(messageId, content) {
    const conversation = openConversation();
    if (!conversation) return;
    const messages = (conversation.messages || []).map((message) => ({
      id: message.id,
      content: message.id === messageId ? content : message.content
    }));
    // 直したことが通ってから編集欄を閉じます。断られたときに書いた文が消えると、
    // 打ち直しからやり直しになります。
    const saved = await save({ id: conversation.id, messages }, '発言を直しました。次の質問から、直したやり取りをAIが読み直します。');
    if (!saved) return;
    editingMessageId = null;
    renderConversations();
  }

  async function deleteMessage(messageId) {
    const conversation = openConversation();
    if (!conversation) return;
    const messages = (conversation.messages || [])
      .filter((message) => message.id !== messageId)
      .map(({ id, content }) => ({ id, content }));
    pendingDeleteMessageId = null;
    await save({ id: conversation.id, messages }, '発言を削除しました。次の質問から、残したやり取りだけをAIが読みます。');
  }

  /** 会話まるごとの削除。取り消せないので、ここだけは確認を挟みます。 */
  async function deleteConversation() {
    const conversation = openConversation();
    const window = refs.workspaceConversationDetail.ownerDocument.defaultView;
    if (!conversation || saving || !window.confirm('この会話を削除しますか？')) return;
    saving = true;
    try {
      await api.deleteAiConversation(conversation.id);
      state.aiConversations = state.aiConversations.filter((entry) => entry.id !== conversation.id);
      if (state.activeConversationId === conversation.id) state.activeConversationId = null;
      openConversationId = null;
      editingMessageId = null;
      renderConversations();
      onConversationsChanged();
      toaster.info('会話を削除しました。');
    } catch (error) {
      toaster.error(`会話を削除できませんでした: ${error.message}`);
    } finally {
      saving = false;
    }
  }

  /** 書き換えを1本にまとめた保存。返ってきた会話で、画面が持っている記録を置き換えます。 */
  async function save(payload, successMessage) {
    if (saving) return false;
    saving = true;
    try {
      const result = await api.updateAiConversation(payload);
      state.aiConversations = state.aiConversations
        .map((entry) => (entry.id === result.conversation.id ? result.conversation : entry));
      renderConversations();
      onConversationsChanged();
      toaster.success(successMessage);
      return true;
    } catch (error) {
      toaster.error(`会話を直せませんでした: ${error.message}`);
      return false;
    } finally {
      saving = false;
    }
  }

  function openConversation() {
    return (state.aiConversations || []).find((entry) => entry.id === openConversationId) || null;
  }

  function keepAsNote(messageId) {
    const message = (openConversation()?.messages || []).find((entry) => entry.id === messageId);
    if (message) onKeepNote(message.content || '');
  }

  function bindEvents() {
    refs.workspacePersonaEditButton.addEventListener('click', onEditPersona);

    refs.workspaceConversationList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-conversation]');
      if (!button) return;
      openConversationId = button.dataset.openConversation;
      editingMessageId = null;
      pendingDeleteMessageId = null;
      renderConversations();
    });

    refs.workspaceConversationDetail.addEventListener('submit', (event) => {
      event.preventDefault();
      const messageForm = event.target.closest('[data-message-form]');
      if (messageForm) {
        saveMessage(messageForm.dataset.messageForm, messageForm.querySelector('textarea').value);
        return;
      }
      if (event.target.closest('[data-title-form]')) {
        saveTitle(event.target.querySelector('input').value);
      }
    });

    refs.workspaceConversationDetail.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.editMessage) {
        editingMessageId = button.dataset.editMessage;
        pendingDeleteMessageId = null;
        return renderConversations();
      }
      if (button.hasAttribute('data-cancel-edit')) {
        editingMessageId = null;
        return renderConversations();
      }
      if (button.dataset.deleteMessage) {
        pendingDeleteMessageId = button.dataset.deleteMessage;
        return renderConversations();
      }
      if (button.hasAttribute('data-cancel-delete')) {
        pendingDeleteMessageId = null;
        return renderConversations();
      }
      if (button.dataset.confirmDelete) return deleteMessage(button.dataset.confirmDelete);
      if (button.dataset.keepNote) return keepAsNote(button.dataset.keepNote);
      if (button.hasAttribute('data-delete-conversation')) deleteConversation();
    });
  }

  return { load, render, renderConversations };
}
