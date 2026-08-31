import { createId, escapeHtml } from './util.js';

/** サーバー側の上限と同じです（src/aiLimits.js）。超えて送ると保存時に断られます。 */
const MAX_CONTEXT_NOTES = 20;
const MAX_CONTEXT_NOTE_CHARS = 1_000;

/**
 * メモの種類。`src/contextNotes.js` の `CONTEXT_NOTE_KINDS` と同じ並び・同じidです。
 * ビルドを持たない構成では `src/` を `public/` から import できないので、
 * `aiVocabulary.js` と同じ理由でここへもう一組置いています。
 *
 * `hint` は画面にだけ出るものですが、書いてあることはプロンプトの説明と揃えてあります。
 * レビュアーが「決定」に書いたつもりのものと、AIが「決定」として読むものがずれると、
 * 指摘が減ったり増えたりする理由が分からなくなるからです。
 */
const KINDS = [
  { id: 'background', label: '背景', hint: 'なぜこの文書があるか。どこから来たか。指摘の対象にはしません。' },
  { id: 'decision', label: '決定', hint: 'もう決めたこと。AIレビューはこの論点を蒸し返しません。' },
  { id: 'constraint', label: '制約', hint: '守る条件。破っている箇所はAIレビューが指摘します。' },
  { id: 'question', label: '未決', hint: 'まだ決まっていないこと。決着済みとしては読ませません。' }
];

const KIND_LABELS = Object.fromEntries(KINDS.map(({ id, label }) => [id, label]));

const STATUS_MESSAGES = {
  idle: '',
  dirty: '自動保存待ち…',
  saving: '保存中…',
  saved: '保存しました。次のAI操作から反映します。'
};

/**
 * その文書について分かったことを1件ずつ残す欄。
 *
 * 読み取りコンテキストが「この文書はこう読む」を1枚に整えたものなのに対して、
 * こちらは「このとき、こう分かった」を足していくものです。相談していて気づいたことを
 * 書き留めるのに、1枚の前提を毎回開いて継ぎ足すのは向かないからです。
 *
 * 残したメモは前提の一部として、翻訳・AIチャット・指摘の配置・AIレビューすべてへ渡します。
 * 保存はコメントと同じ自動保存に相乗りするので、残した直後に相談やレビューを始めても
 * そのメモの上で読ませられます。
 *
 * AIチャットの回答からも残せます（`keepFromChat`）。相談して分かったことがメモになり、
 * そのメモを次の相談とレビューが読む、という順で前提が育ちます。
 */
export function createContextNotesController({ refs, state, toaster, onChange }) {
  // 編集中のメモ。null なら「新しく残す」です。
  let editingId = null;
  // 相談から残そうとしているかどうか。出どころを画面に出すために覚えます。
  let pendingSource = 'reviewer';
  let pendingDeleteId = null;

  renderKindOptions();
  bindEvents();

  /** 文書を開いたときの初期化。書きかけは前の文書のものなので捨てます。 */
  function load() {
    resetForm();
    render();
    setStatus(state.contextNotesDirty ? 'dirty' : 'idle');
  }

  function setStatus(status, message) {
    refs.contextNotesStatus.dataset.state = status;
    refs.contextNotesStatus.textContent = message ?? STATUS_MESSAGES[status] ?? '';
  }

  /**
   * AIチャットの回答をメモの下書きにします。保存はしません。
   *
   * 回答をそのまま残さないのは、回答が長いからではなく、回答のどこが前提なのかを
   * 決められるのはレビュアーだけだからです。書き直してもらう前提で流し込みます。
   */
  function keepFromChat(text) {
    const answer = String(text || '').trim();
    const draft = answer.slice(0, MAX_CONTEXT_NOTE_CHARS);
    if (!draft) return;
    editingId = null;
    pendingSource = 'chat';
    pendingDeleteId = null;
    refs.contextNotes.open = true;
    refs.contextNoteInput.value = draft;
    render();
    refs.contextNoteInput.focus();
    refs.contextNoteInput.scrollIntoView?.({ block: 'nearest' });
    toaster.info(answer.length > MAX_CONTEXT_NOTE_CHARS
      // 黙って切ると、途中で終わった下書きを「AIがそう答えた」と読んでしまいます。
      ? `回答をメモの下書きにしました（1件${MAX_CONTEXT_NOTE_CHARS}文字までのため、末尾を切りました）。前提として残す形へ直してから「残す」を押してください。`
      : '回答をメモの下書きにしました。前提として残す形へ直してから「残す」を押してください。');
  }

  /* ---------------------------------------------------------------- *
   * 残す・直す・消す
   * ---------------------------------------------------------------- */

  function submit() {
    const body = refs.contextNoteInput.value.trim();
    if (!body) return;
    if (body.length > MAX_CONTEXT_NOTE_CHARS) {
      toaster.error(`メモ1件は${MAX_CONTEXT_NOTE_CHARS}文字までです。`);
      return;
    }
    const kind = refs.contextNoteKind.value;
    const now = new Date().toISOString();
    // resetForm() が editingId を消すので、何をしたのかはここで控えます。
    const edited = Boolean(editingId);

    // 一覧はその場で書き換えず、必ず新しい配列へ差し替えます。
    // 保存中に足した1件が失われないための約束です（public/js/createApp.js の pushComments は
    // 「保存し始めたときと同じ一覧のままか」を同一性で見て、書きかけを消さないようにしています）。
    if (editingId) {
      state.contextNotes = state.contextNotes.map((entry) => (
        entry.id === editingId ? { ...entry, kind, body, updatedAt: now } : entry
      ));
    } else {
      if (state.contextNotes.length >= MAX_CONTEXT_NOTES) {
        toaster.error(`メモは${MAX_CONTEXT_NOTES}件までです。古いものを消すか、まとめてください。`);
        return;
      }
      // 並びは残した順のままにします。プロンプトへも同じ順で載り、
      // 食い違うメモは後のほうを採る、とモデルへ伝えてあります。
      state.contextNotes = [...state.contextNotes, {
        id: createId('note'),
        kind,
        body,
        source: pendingSource,
        createdAt: now
      }];
    }
    resetForm();
    render();
    onChange();
    toaster.success(edited ? 'メモを直しました。自動保存します。' : 'メモを残しました。自動保存します。');
  }

  function startEdit(id) {
    const note = state.contextNotes.find((entry) => entry.id === id);
    if (!note) return;
    editingId = id;
    pendingSource = note.source || 'reviewer';
    pendingDeleteId = null;
    refs.contextNoteKind.value = note.kind;
    refs.contextNoteInput.value = note.body;
    render();
    refs.contextNoteInput.focus();
  }

  function confirmDelete(id) {
    const before = state.contextNotes.length;
    state.contextNotes = state.contextNotes.filter((entry) => entry.id !== id);
    if (state.contextNotes.length === before) return;
    if (editingId === id) resetForm();
    pendingDeleteId = null;
    render();
    onChange();
    toaster.info('メモを削除しました。');
  }

  function resetForm() {
    editingId = null;
    pendingSource = 'reviewer';
    pendingDeleteId = null;
    refs.contextNoteInput.value = '';
    refs.contextNoteKind.value = KINDS[0].id;
  }

  /* ---------------------------------------------------------------- *
   * 表示
   * ---------------------------------------------------------------- */

  function renderKindOptions() {
    refs.contextNoteKind.innerHTML = KINDS
      .map(({ id, label }) => `<option value="${id}">${escapeHtml(label)}</option>`)
      .join('');
    refs.contextNoteKind.value = KINDS[0].id;
  }

  function render() {
    const notes = state.contextNotes;
    // もう一方の画面で消されたメモを直しているところだった、という場合だけここに当たります。
    // 消えたものを直し続けさせると、「このメモを直す」が新しい1件を作ることになります。
    if (editingId && !notes.some((entry) => entry.id === editingId)) resetForm();
    refs.contextNotesState.textContent = notes.length ? `${notes.length}件` : '未設定';
    refs.contextNotesState.dataset.state = notes.length ? 'set' : 'unset';
    // 種類ごとに何が変わるかは、選んでいる最中にだけ要ります。常時4行出すと欄が読めません。
    refs.contextNoteKindHint.textContent = KINDS.find((kind) => kind.id === refs.contextNoteKind.value)?.hint || '';
    refs.contextNoteSubmit.textContent = editingId ? 'このメモを直す' : '残す';
    // 上限は「これ以上増やせない」であって「直せない」ではありません。編集中は当たりません。
    const full = !editingId && notes.length >= MAX_CONTEXT_NOTES;
    refs.contextNoteSubmit.disabled = full || refs.contextNoteInput.value.trim() === '';
    refs.contextNoteCancel.classList.toggle('hidden', !editingId);
    refs.contextNoteFull.hidden = !full;
    // AIレビューのパネルは別のタブなので、前提が届くことをそちらでも言います。
    // 出す条件は「指摘の配置」と揃えます（前提が1つでもあれば出す）。
    if (refs.reviewContextHint) {
      const hasPremise = Boolean((state.aiContext || '').trim() || (state.projectAiContext || '').trim())
        || Boolean(state.brief) || notes.length > 0;
      refs.reviewContextHint.hidden = !hasPremise;
      // 管理者の3点は「この資料はどうあるべきか」なので、読み方ではなく判定の基準が
      // 変わります。渡ることだけでなく、何が変わるかまで言います。
      const premises = [
        state.brief ? '「管理者」タブで決めた3点' : '',
        'AIパネルの読み取りコンテキスト',
        notes.length ? 'コンテキストメモ' : ''
      ].filter(Boolean);
      refs.reviewContextHint.textContent = `${premises.join('と')}も前提として読ませます。`
        + (state.brief ? '3点から外れた箇所は指摘します。' : '')
        + (notes.length ? '「決定」と残した論点は蒸し返しません。' : '');
    }
    refs.contextNotesList.innerHTML = notes.length
      ? notes.map(noteHtml).join('')
      : '<p class="muted">まだメモはありません。読みながら分かったことを残すと、次の相談とレビューがそれを前提に読みます。</p>';
  }

  function noteHtml(note) {
    const deleting = pendingDeleteId === note.id;
    const recordedAt = String(note.updatedAt || note.createdAt || '').slice(0, 10);
    return `
      <article class="context-note" data-note-id="${escapeHtml(note.id)}"${editingId === note.id ? ' data-editing="true"' : ''}>
        <header class="context-note-head">
          <span class="context-note-kind" data-kind="${escapeHtml(note.kind)}">${escapeHtml(KIND_LABELS[note.kind] || note.kind)}</span>
          ${recordedAt ? `<span class="context-note-date">${escapeHtml(recordedAt)}</span>` : ''}
          ${note.source === 'chat' ? '<span class="context-note-source">相談から</span>' : ''}
        </header>
        <p class="context-note-body">${escapeHtml(note.body)}</p>
        <div class="context-note-item-actions">
          ${deleting
            // 取り消せない操作なので、確認の見え方と読み上げをコメントの削除確認と揃えます。
            ? `<span class="context-note-confirm" role="group" aria-label="コンテキストメモの削除確認">このメモを削除しますか？</span>
               <button type="button" data-note-cancel-delete>やめる</button>
               <button type="button" class="danger" data-note-confirm-delete="${escapeHtml(note.id)}">削除する</button>`
            : `<button type="button" data-note-edit="${escapeHtml(note.id)}">編集</button>
               <button type="button" data-note-delete="${escapeHtml(note.id)}">削除</button>`}
        </div>
      </article>`;
  }

  function bindEvents() {
    refs.contextNoteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    refs.contextNoteInput.addEventListener('input', render);
    refs.contextNoteKind.addEventListener('change', render);
    refs.contextNoteCancel.addEventListener('click', () => {
      resetForm();
      render();
    });
    refs.contextNotesList.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.noteEdit) return startEdit(button.dataset.noteEdit);
      if (button.dataset.noteDelete) {
        pendingDeleteId = button.dataset.noteDelete;
        return render();
      }
      if (button.dataset.noteConfirmDelete) return confirmDelete(button.dataset.noteConfirmDelete);
      if (button.hasAttribute('data-note-cancel-delete')) {
        pendingDeleteId = null;
        render();
      }
    });
  }

  return { load, render, setStatus, keepFromChat };
}
