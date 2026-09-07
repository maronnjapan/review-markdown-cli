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

/**
 * 適用範囲ごとの、書き換える state のキーと画面に出す文言です。読み取りコンテキストの
 * 範囲（`aiContext.js` の `SCOPES`）と同じ形にしてあります。分岐をあちこちに散らすより、
 * 表を1つ置いて引くほうが、範囲を足したときに直す場所を探さずに済みます。
 */
const SCOPES = {
  document: {
    key: 'contextNotes',
    label: 'このファイルだけ',
    hint: () => 'いま開いているファイルだけに効きます。レビューファイルへ保存します。',
    placeholder: '例：この節は前の版から移してきた。並び順は検討済みで、変えない。'
  },
  directory: {
    key: 'directoryContextNotes',
    label: 'ディレクトリ全体',
    // 保存先はサーバーが言ってきたものを出します。どのファイルに書いたのかを画面から
    // 辿れるようにするためで、読み取りコンテキストの範囲と同じ扱いです。
    hint: (state) => 'コマンドを実行したディレクトリ配下のすべての文書に効きます。'
      + `保存先は ${state.directoryContextFile || '.review/context.json'} です。`,
    placeholder: '例：用語は原著の訳語に合わせる。この本を通して変えない。'
  }
};

const DEFAULT_SCOPE = 'document';

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
 *
 * ── 効く範囲を選んでから残す理由 ──────────────────────────
 * メモにも、その文書にしか当てはまらないもの（「この節は前の版から移してきた」）と、
 * 束ねている原稿すべてに当てはまるもの（「用語は原著の訳語に合わせる」）があります。
 * 後者を文書ごとにしか残せないと、章の数だけ同じメモを書き写し、決め直すときも同じ数だけ
 * 直すことになります。範囲を選べば、残す先が1か所で済みます。
 * 保存先も範囲で変わります。この文書だけならレビューファイル、ディレクトリ全体なら
 * 対象ディレクトリの `.review/context.json` です（`src/directoryContext.js`）。
 *
 * ── 一覧を範囲で分けずに1本で出す理由 ────────────────────────
 * 読み取りコンテキストは欄が1つしかないので、書いていないほうの範囲を下へ読み取り専用で
 * 出しています。メモは一覧なので、その必要がありません。どちらの範囲も同じ「いまこの文書に
 * 効いている前提」で、AIも1本に束ねて読みます（`src/aiContext.js`）。分けて置くと、
 * 何が渡っているのかを2か所足し算しないと分からなくなります。範囲は各メモの札で示します。
 */
export function createContextNotesController({
  refs, state, toaster, onChange, onDirectoryChange = () => {}, onScopeChange = () => {}
}) {
  // 編集中のメモ。null なら「新しく残す」です。
  let editingId = null;
  // 編集を始めたときの範囲。範囲を変えて保存したら「移した」ことになるので、元の場所を覚えます。
  let editingScope = null;
  // 相談から残そうとしているかどうか。出どころを画面に出すために覚えます。
  let pendingSource = 'reviewer';
  let pendingDeleteId = null;
  // 保存の状態は範囲ごとに持ちます。行き先が違うので、片方を保存した直後に範囲を切り替えて
  // 「保存しました」と出ていると、まだ送っていないほうを送ったことになります。
  const statuses = { document: { state: 'idle', message: null }, directory: { state: 'idle', message: null } };

  renderKindOptions();
  bindEvents();

  /** 文書を開いたときの初期化。書きかけは前の文書のものなので捨てます。 */
  function load() {
    resetForm();
    render();
    setStatus(state.contextNotesDirty ? 'dirty' : 'idle');
    setDirectoryStatus(state.directoryContextNotesDirty ? 'dirty' : 'idle');
  }

  /** この文書のメモの保存状態。呼ぶのは `createApp.js` の保存処理です。 */
  function setStatus(status, message) {
    statuses.document = { state: status, message };
    renderStatus();
  }

  /** ディレクトリ全体のメモの保存状態。行き先が違うので、状態も別に持ちます。 */
  function setDirectoryStatus(status, message) {
    statuses.directory = { state: status, message };
    renderStatus();
  }

  function scope() {
    return SCOPES[state.contextNoteScope] ? state.contextNoteScope : DEFAULT_SCOPE;
  }

  function notesOf(scopeName) {
    return state[SCOPES[scopeName].key] || [];
  }

  /** 両方の範囲のメモを、AIが読むのと同じ並びで1本にしたもの。 */
  function allNotes() {
    return [
      ...notesOf('directory').map((note) => ({ note, scope: 'directory' })),
      ...notesOf('document').map((note) => ({ note, scope: 'document' }))
    ];
  }

  function findNote(id) {
    return allNotes().find((entry) => entry.note.id === id) || null;
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
    editingScope = null;
    pendingSource = 'chat';
    pendingDeleteId = null;
    if (refs.contextNotes) refs.contextNotes.open = true;
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
    const target = scope();
    const now = new Date().toISOString();
    // resetForm() が編集中の印を消すので、何をしたのかはここで控えます。
    const from = editingScope;
    const edited = Boolean(editingId);
    const moved = edited && from !== target;

    // 一覧はその場で書き換えず、必ず新しい配列へ差し替えます。
    // 保存中に足した1件が失われないための約束です（public/js/createApp.js の pushComments は
    // 「保存し始めたときと同じ一覧のままか」を同一性で見て、書きかけを消さないようにしています）。
    if (edited && !moved) {
      replaceNotes(target, notesOf(target).map((entry) => (
        entry.id === editingId ? { ...entry, kind, body, updatedAt: now } : entry
      )));
    } else {
      if (notesOf(target).length >= MAX_CONTEXT_NOTES) {
        toaster.error(`${SCOPES[target].label}のメモは${MAX_CONTEXT_NOTES}件までです。古いものを消すか、まとめてください。`);
        return;
      }
      // 範囲を変えた保存は「移した」です。元の場所から消して、移した先の末尾へ足します。
      // 並びは残した順のままにするので、移したメモは移した時点のものとして最後に来ます。
      // プロンプトへも同じ順で載り、食い違うメモは後のほうを採る、とモデルへ伝えてあります。
      const moving = moved ? findNote(editingId)?.note : null;
      if (moved) replaceNotes(from, notesOf(from).filter((entry) => entry.id !== editingId));
      replaceNotes(target, [...notesOf(target), {
        id: moving?.id || createId('note'),
        kind,
        body,
        source: moving?.source || pendingSource,
        createdAt: moving?.createdAt || now,
        ...(moved ? { updatedAt: now } : {})
      }]);
    }
    resetForm();
    render();
    notifyChanged(moved ? [from, target] : [target]);
    toaster.success(movedMessage(moved, edited, target));
  }

  function movedMessage(moved, edited, target) {
    if (moved) return `メモを「${SCOPES[target].label}」へ移しました。自動保存します。`;
    if (edited) return 'メモを直しました。自動保存します。';
    return `メモを「${SCOPES[target].label}」に残しました。自動保存します。`;
  }

  function startEdit(id) {
    const found = findNote(id);
    if (!found) return;
    editingId = id;
    editingScope = found.scope;
    pendingSource = found.note.source || 'reviewer';
    pendingDeleteId = null;
    // 直すあいだは、そのメモが入っている範囲を選んでおきます。ここで別の範囲を選び直すのが
    // 「移す」操作です。
    state.contextNoteScope = found.scope;
    refs.contextNoteKind.value = found.note.kind;
    refs.contextNoteInput.value = found.note.body;
    onScopeChange();
    render();
    refs.contextNoteInput.focus();
  }

  function confirmDelete(id) {
    const found = findNote(id);
    if (!found) return;
    replaceNotes(found.scope, notesOf(found.scope).filter((entry) => entry.id !== id));
    if (editingId === id) resetForm();
    pendingDeleteId = null;
    render();
    notifyChanged([found.scope]);
    toaster.info('メモを削除しました。');
  }

  function replaceNotes(scopeName, notes) {
    state[SCOPES[scopeName].key] = notes;
  }

  /** 書き換えた範囲のぶんだけ、保存待ちの印を付けます。行き先が違うので分けて数えます。 */
  function notifyChanged(scopes) {
    if (scopes.includes('document')) onChange();
    if (scopes.includes('directory')) onDirectoryChange();
  }

  function resetForm() {
    editingId = null;
    editingScope = null;
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

  function renderStatus() {
    const { state: status, message } = statuses[scope()];
    refs.contextNotesStatus.dataset.state = status;
    refs.contextNotesStatus.textContent = message ?? STATUS_MESSAGES[status] ?? '';
  }

  /** 選んでいる範囲に合わせて、説明と選択を入れ替えます。 */
  function renderScope() {
    const current = scope();
    for (const input of scopeInputs()) input.checked = input.value === current;
    refs.contextNoteScopeHint.textContent = SCOPES[current].hint(state);
    refs.contextNoteInput.placeholder = SCOPES[current].placeholder;
  }

  /**
   * もう一方の画面で切り替えられた範囲を、こちらの欄へ映します。
   * 選んだ範囲は1組の state なので、片方で切り替えたらもう片方も従います。
   *
   * 描き直すのは欄だけではありません。上限に達しているかも、残す先が変われば変わります。
   * 範囲だけを映して残りを据え置くと、片方の画面が別の範囲の上限を出したままになります。
   */
  function sync() {
    render();
  }

  function render() {
    const notes = allNotes();
    const editing = editingId ? findNote(editingId) : null;
    // もう一方の画面で消されたメモを直しているところだった、という場合だけここに当たります。
    // 消えたものを直し続けさせると、「このメモを直す」が新しい1件を作ることになります。
    if (editingId && !editing) resetForm();
    renderScope();
    renderStatus();
    refs.contextNotesState.textContent = notes.length ? summaryLabel() : '未設定';
    refs.contextNotesState.dataset.state = notes.length ? 'set' : 'unset';
    // 種類ごとに何が変わるかは、選んでいる最中にだけ要ります。常時4行出すと欄が読めません。
    refs.contextNoteKindHint.textContent = KINDS.find((kind) => kind.id === refs.contextNoteKind.value)?.hint || '';
    refs.contextNoteSubmit.textContent = editingId ? 'このメモを直す' : '残す';
    // 上限は「これ以上増やせない」であって「直せない」ではありません。同じ範囲で直すあいだは
    // 当たりませんが、いっぱいの範囲へ移そうとしているときは当たります。
    const full = notesOf(scope()).length >= MAX_CONTEXT_NOTES && editingScope !== scope();
    refs.contextNoteSubmit.disabled = full || refs.contextNoteInput.value.trim() === '';
    refs.contextNoteCancel.classList.toggle('hidden', !editingId);
    refs.contextNoteFull.hidden = !full;
    refs.contextNoteFull.textContent = `${SCOPES[scope()].label}のメモが上限に達しました。古いものを消すか、まとめてください。`;
    renderReviewHint(notes.length);
    refs.contextNotesList.innerHTML = notes.length
      ? notes.map(noteHtml).join('')
      : '<p class="muted">まだメモはありません。読みながら分かったことを残すと、次の相談とレビューがそれを前提に読みます。</p>';
  }

  /** どの範囲にメモがあるかまで出します。「3件」だけでは、どこに効くメモか分かりません。 */
  function summaryLabel() {
    const own = notesOf('document').length;
    const wide = notesOf('directory').length;
    if (own && wide) return `このファイル${own}件＋全体${wide}件`;
    return own ? `このファイル${own}件` : `ディレクトリ全体${wide}件`;
  }

  /**
   * AIレビューのパネルは別のタブなので、前提が届くことをそちらでも言います。
   * 出す条件は「指摘の配置」と揃えます（前提が1つでもあれば出す）。
   */
  function renderReviewHint(noteCount) {
    if (!refs.reviewContextHint) return;
    const fileCount = (state.referenceFiles || []).length;
    const hasPremise = Boolean((state.aiContext || '').trim() || (state.directoryAiContext || '').trim()
      || (state.projectAiContext || '').trim())
      || Boolean(state.brief) || noteCount > 0 || fileCount > 0;
    refs.reviewContextHint.hidden = !hasPremise;
    // 管理者の3点は「この資料はどうあるべきか」なので、読み方ではなく判定の基準が
    // 変わります。渡ることだけでなく、何が変わるかまで言います。
    const premises = [
      state.brief ? '「管理者」の画面で決めた3点' : '',
      'AIパネルの読み取りコンテキスト',
      noteCount ? 'コンテキストメモ' : '',
      fileCount ? `添えた参照ファイル${fileCount}件` : ''
    ].filter(Boolean);
    refs.reviewContextHint.textContent = `${premises.join('と')}も前提として読ませます。`
      + (state.brief ? '3点から外れた箇所は指摘します。' : '')
      + (noteCount ? '「決定」と残した論点は蒸し返しません。' : '')
      + (fileCount ? '添えたファイルと食い違う箇所は指摘します。' : '');
  }

  function noteHtml({ note, scope: noteScope }) {
    const deleting = pendingDeleteId === note.id;
    const recordedAt = String(note.updatedAt || note.createdAt || '').slice(0, 10);
    return `
      <article class="context-note" data-note-id="${escapeHtml(note.id)}" data-note-scope="${escapeHtml(noteScope)}"${editingId === note.id ? ' data-editing="true"' : ''}>
        <header class="context-note-head">
          <span class="context-note-kind" data-kind="${escapeHtml(note.kind)}">${escapeHtml(KIND_LABELS[note.kind] || note.kind)}</span>
          <span class="context-note-scope" data-scope="${escapeHtml(noteScope)}">${escapeHtml(SCOPES[noteScope].label)}</span>
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

  function scopeInputs() {
    return refs.contextNoteScope.querySelectorAll('input[type="radio"]');
  }

  /**
   * 範囲を変えても、残したメモはどちらも残します。切り替えは「どちらへ残すか」の選択で、
   * メモの引っ越しではありません。直している最中だけは引っ越しになりますが、そのときは
   * 押した本人が「このメモを直す」を押すまで何も動きません。
   */
  function handleScopeChange(event) {
    const next = event.target.value;
    if (!SCOPES[next] || next === scope()) return;
    state.contextNoteScope = next;
    render();
    onScopeChange();
  }

  function bindEvents() {
    refs.contextNoteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    refs.contextNoteInput.addEventListener('input', render);
    refs.contextNoteKind.addEventListener('change', render);
    for (const input of scopeInputs()) input.addEventListener('change', handleScopeChange);
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

  return { load, render, setStatus, setDirectoryStatus, sync, keepFromChat };
}
