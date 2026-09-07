import { runAiRequest } from './aiRequest.js';
import { escapeHtml } from './util.js';

/** サーバー側の上限と同じです（src/aiLimits.js）。超えて送ると保存時に断られます。 */
const MAX_TASK_TITLE_CHARS = 200;
const MAX_TASK_KNOWLEDGE_CHARS = 2000;
const MAX_REFERENCE_FILES = 8;

/** サーバー側の上限と同じです（src/aiLimits.js の MAX_TASK_PLAN_NOTE_CHARS）。 */
const MAX_TASK_PLAN_NOTE_CHARS = 1_000;

/**
 * タスクの種類・状態・優先度・採否と、任せられる自動化。`src/autoTaskVocabulary.js` と
 * 同じ並び・同じidです。ビルドを持たない構成では `src/` を `public/` から import できないので、
 * `contextNotes.js` と同じ理由でここへもう一組置いています。片方を変えたらもう片方も。
 */
const KINDS = [
  { id: 'action', label: '対応', auto: false },
  { id: 'decision', label: '判断', auto: false },
  { id: 'research', label: '調査', auto: true },
  { id: 'sample', label: 'サンプル実装', auto: true },
  { id: 'inquiry', label: '問い合わせ対応', auto: true }
];
const KIND_LABELS = Object.fromEntries(KINDS.map(({ id, label }) => [id, label]));
const STATUS_LABELS = { open: '未着手', running: '実行中', ready: '確認待ち', done: '完了', dismissed: '見送り' };
const STATUS_ORDER = { ready: 0, open: 1, running: 2, done: 3, dismissed: 4 };
const PRIORITY_IDS = ['now', 'next', 'later'];
const PRIORITY_LABELS = { now: 'いま', next: '次に', later: 'あとで' };
const PRIORITY_ORDER = { now: 0, next: 1, later: 2 };
const COMMITMENT_LABELS = { undecided: '未定', committed: 'やる' };

/**
 * 一覧の絞り込み。AIが起こしたタスクは読まれる前から並ぶので、「すべて」のままでは
 * やると決めたものが候補に埋もれます。決めたものだけを取り出せるようにするための行です。
 */
const FILTERS = [
  { id: 'all', label: 'すべて', match: () => true, empty: 'この文書のタスクはまだありません。' },
  { id: 'committed', label: 'やると決めた', match: (task) => isCommitted(task) && !isFinished(task), empty: 'やると決めたタスクはまだありません。タスクの「やると決める」を押すと、ここに並びます。' },
  { id: 'undecided', label: '未定', match: (task) => !isCommitted(task) && !isFinished(task), empty: 'やるかどうかを決めていないタスクはありません。' },
  { id: 'finished', label: '終わったもの', match: isFinished, empty: '完了・見送りにしたタスクはまだありません。' }
];
export const AUTO_TASK_ACTIONS = [
  { id: 'organize', label: 'タスクの整理', hint: '済んだタスクを完了にし、蒸し返しをまとめる' },
  { id: 'focus', label: '今すべきこと', hint: '文字起こしの流れから、いま手を付けることを1つ選ぶ' },
  { id: 'research', label: '調査の実行', hint: '「調査」のタスクを、AIが調査メモとして書く' },
  { id: 'sample', label: 'サンプル実装の実行', hint: '「サンプル実装」のタスクを、AIがコード例として書く' },
  { id: 'inquiry', label: '問い合わせ対応の実行', hint: '「問い合わせ対応」のタスクを、AIが回答案として書く' }
];

/** 裏で増えるものなので、見守りが動いているあいだは一覧を取り直します。 */
const REFRESH_MS = 20_000;

const STATUS_MESSAGES = {
  idle: '',
  saving: '保存中…',
  saved: '保存しました。',
  running: 'タスクを起こしています…'
};

/** 端末の時間帯での「今日」を取るためだけの値です（`dueState`）。期限は日付だけで比べます。 */
const MINUTE_MS = 60_000;

/**
 * 自動タスクのパネル。
 *
 * 文字起こしや書きかけの資料から、AIが「やること」を起こします。任せてある種類
 * （調査・サンプル実装・問い合わせ対応）はAIが裏で実行し、「確認待ち」として並びます。
 * 読んで採るかどうかを決めるのはレビュアーで、このパネルはそのための場所です。
 *
 * ── 一覧はサーバーのもの ─────────────────────────────────
 * ここが持つのは写しです。裏の見守りが足したタスクは、この画面が知らないうちに増えるので、
 * 一覧まるごとを送り返す保存はしません。変えたいこと（見守り・状態・手で足す・消す）だけを
 * 送り、返ってきた一覧で写しを置き換えます。見守りが動いているあいだは定期的に取り直します。
 *
 * ── 出す条件 ───────────────────────────────────────────
 * 自動タスクが有効で、本文を読み直せる文書（MarkdownかテキストでPDFでない）のときだけ
 * タブを出します。無効なときは、裏の見守りも止まっているので、タブごと消えます。
 */
export function createAutoTasksController({ refs, state, api, toaster, prepareAi, flushComments = async () => true }) {
  const window = refs.tasksPanel.ownerDocument.defaultView;
  let pendingDeleteId = null;
  let openResultIds = new Set();
  let openPlanIds = new Set();
  /**
   * 段取りの書きかけ。一覧は裏の見守りに合わせて20秒ごとに描き直すので、書きかけの
   * 期限やメモを持っておかないと、入力の途中で消えます。保存できたぶんから捨てます。
   */
  let planDrafts = new Map();
  let filterId = 'all';
  // 開いている「参考」の欄と、まだ保存していない参考知識。段取りと同じ理由で、
  // 書きかけの文字と開いている欄を、描き直しをまたいで持ちます。
  let openReferenceIds = new Set();
  let knowledgeDrafts = new Map();
  let refreshTimer = null;
  let loadRequest = 0;

  renderKindOptions();
  bindEvents();

  /** 文書を開いたときの初期化。写しは前の文書のものなので捨て、開き終わってから取ります。 */
  function load() {
    pendingDeleteId = null;
    openResultIds = new Set();
    openPlanIds = new Set();
    planDrafts = new Map();
    filterId = 'all';
    openReferenceIds = new Set();
    knowledgeDrafts = new Map();
    stopRefreshing();
    setStatus('idle');
    render();
  }

  /**
   * 本文が入れ替わった・機能の入り切りが変わったとき。タブの出し入れをやり直し、
   * まだ写しを持っていなければ取りに行きます。持っていれば、定期の取り直しに任せます。
   */
  function sync() {
    render();
    if (available() && state.tasks === null && !loadRequest) refresh();
    else if (!available()) stopRefreshing();
  }

  function available() {
    return state.features.autoTasks === true
      && Boolean(state.currentPath)
      && ['markdown', 'text'].includes(state.documentType);
  }

  /* ---------------------------------------------------------------- *
   * サーバーの記録を写す
   * ---------------------------------------------------------------- */

  async function refresh({ quiet = false } = {}) {
    if (!available()) {
      render();
      return;
    }
    const documentPath = state.currentPath;
    const request = (loadRequest += 1);
    try {
      const payload = await api.readTasks(documentPath);
      // 取っている間に別の文書へ移ったか、もっと新しい取り直しが始まっていたら捨てます。
      if (state.currentPath !== documentPath || request !== loadRequest) return;
      adopt(payload);
    } catch (error) {
      if (state.currentPath !== documentPath || request !== loadRequest) return;
      if (!quiet) setStatus('error', `タスクを読み込めませんでした: ${error.message}`);
    }
    render();
    scheduleRefresh();
  }

  function adopt(payload) {
    state.tasks = payload.tasks || null;
    state.tasksRunner = payload.runner || null;
    state.tasksFile = payload.tasksFile || '';
  }

  /** 見守りが動いている（または裏で実行中の）文書だけ、一覧を取り直し続けます。 */
  function scheduleRefresh() {
    stopRefreshing();
    const runner = state.tasksRunner;
    if (!available() || !runner || !(runner.watching || runner.running)) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refresh({ quiet: true });
    }, REFRESH_MS);
  }

  function stopRefreshing() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  /* ---------------------------------------------------------------- *
   * AIに頼む
   * ---------------------------------------------------------------- */

  /** 「タスクを整理する」。いまの本文を読み直してタスクを起こし、任せた種類は実行します。 */
  async function runNow() {
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'tasksAbortController',
      onPrepared() {
        state.tasksStatus = 'running';
        setStatus('running');
        render();
      },
      run: ({ documentPath, signal }) => api.extractTasksWithAi({ path: documentPath }, {
        signal,
        onEvent: (event) => {
          if (event.type === 'phase') setStatus('running', phaseText(event.phase));
        }
      }),
      onResult(result) {
        adopt(result);
        setStatus('saved', `整理しました（${timeLabel(new Date().toISOString())}）。`);
        toaster.success('タスクを整理しました。');
      },
      onUnavailable(error) {
        setStatus('error', `整理できませんでした: ${error}`);
      },
      onAbort() {
        setStatus('idle', '中止しました。');
      },
      onError(error) {
        setStatus('error', `整理できませんでした: ${error.message}`);
      },
      onSettled() {
        state.tasksStatus = 'idle';
        render();
        scheduleRefresh();
      }
    });
  }

  /** タスクを1つAIに実行させます。結果は「確認待ち」として並びます。 */
  async function runTask(id) {
    const task = findTask(id);
    if (!task) return;
    await runAiRequest({
      state,
      prepareAi,
      flushComments,
      controllerKey: 'tasksAbortController',
      onPrepared() {
        state.tasksStatus = 'running';
        setStatus('running', `「${task.title}」を実行しています…`);
        render();
      },
      run: ({ documentPath, signal }) => api.runTaskWithAi({ path: documentPath, id }, { signal }),
      onResult(result) {
        adopt(result);
        openResultIds.add(id);
        setStatus('saved', `「${task.title}」を実行しました。結果を確かめてください。`);
        toaster.success('タスクを実行しました。結果は「確認待ち」に並びます。');
      },
      onUnavailable(error) {
        setStatus('error', `実行できませんでした: ${error}`);
      },
      onAbort() {
        setStatus('idle', '中止しました。');
      },
      onError(error) {
        setStatus('error', `実行できませんでした: ${error.message}`);
      },
      onSettled() {
        state.tasksStatus = 'idle';
        render();
        scheduleRefresh();
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * 変える
   * ---------------------------------------------------------------- */

  /** 変えたいことだけを送り、返ってきた一覧で写しを置き換えます。 */
  async function change(payload, successMessage) {
    const documentPath = state.currentPath;
    if (!documentPath) return false;
    setStatus('saving');
    try {
      const result = await api.changeTasks({ path: documentPath, ...payload });
      if (state.currentPath !== documentPath) return false;
      adopt(result);
      setStatus('saved');
      render();
      scheduleRefresh();
      if (successMessage) toaster.info(successMessage);
      return true;
    } catch (error) {
      if (state.currentPath !== documentPath) return false;
      setStatus('error', `保存できませんでした: ${error.message}`);
      render();
      return false;
    }
  }

  function toggleWatch(checked) {
    return change({ watch: checked }, checked
      ? '見守りを付けました。増えた分から、次の見守りでタスクを起こします。'
      : '見守りを外しました。「タスクを整理する」を押したときだけ読みます。');
  }

  function setTaskStatus(id, status) {
    const labels = { done: '完了にしました。', dismissed: '見送りました。', open: '未着手に戻しました。' };
    return change({ setStatus: [{ id, status }] }, labels[status]);
  }

  /**
   * 「やると決める」／その取り消し。決めたタスクは絞り込みで取り出せて、期限とメモを持てて、
   * AIの整理で見送られません。見送っていたタスクを決め直すと、サーバー側で未着手へ戻ります。
   */
  function setCommitment(id, commitment) {
    return change({ plan: [{ id, commitment }] }, commitment === 'committed'
      ? 'やると決めました。「やると決めた」で絞り込めます。'
      : 'やると決めたのを取り消しました。');
  }

  /** 決めたタスクの段取り（期限・優先度・担当・自分のメモ）。書きかけは保存できてから捨てます。 */
  async function savePlan(id, form) {
    const note = form.elements.note.value;
    if (note.trim().length > MAX_TASK_PLAN_NOTE_CHARS) {
      toaster.error(`メモは${MAX_TASK_PLAN_NOTE_CHARS}文字までです。`);
      return;
    }
    const saved = await change({
      plan: [{
        id,
        due: form.elements.due.value,
        priority: form.elements.priority.value,
        owner: form.elements.owner.value,
        note
      }]
    }, '段取りを保存しました。');
    if (!saved) return;
    planDrafts.delete(id);
    render();
  }

  /** 描き直しで消えないように、書きかけの段取りを控えます。 */
  function rememberPlanDraft(form) {
    planDrafts.set(form.dataset.taskPlanForm, {
      due: form.elements.due.value,
      priority: form.elements.priority.value,
      owner: form.elements.owner.value,
      note: form.elements.note.value
    });
  }

  function confirmDelete(id) {
    pendingDeleteId = null;
    return change({ remove: [id] }, 'タスクを削除しました。');
  }

  /* ---------------------------------------------------------------- *
   * タスクに添える参考知識と参照ファイル
   * ---------------------------------------------------------------- */

  /**
   * そのタスクの「参考」を保存します。書きかけの参考知識も一緒に送ります。
   * ファイルを添えた拍子に、まだ保存していない文字が消えるのを避けるためです。
   */
  async function saveReference(id, files, successMessage) {
    const task = findTask(id);
    if (!task) return false;
    const knowledge = knowledgeOf(task);
    if (knowledge.length > MAX_TASK_KNOWLEDGE_CHARS) {
      toaster.error(`参考知識は${MAX_TASK_KNOWLEDGE_CHARS}文字までです。`);
      return false;
    }
    const saved = await change({ setReference: [{ id, knowledge, files: files ?? filesOf(task) }] }, successMessage);
    // 保存できたぶんは、記録のほうを写して出します。断られたときは書いた文字を残します。
    if (saved) knowledgeDrafts.delete(id);
    render();
    return saved;
  }

  function attachReferenceFile(id, filePath) {
    const task = findTask(id);
    if (!task || !filePath) return;
    const files = filesOf(task);
    if (files.includes(filePath)) return;
    if (files.length >= MAX_REFERENCE_FILES) {
      toaster.error(`1つのタスクに添えられる参照ファイルは${MAX_REFERENCE_FILES}件までです。`);
      return;
    }
    saveReference(id, [...files, filePath], `${filePath} を添えました。このタスクを任せるときに読ませます。`);
  }

  function detachReferenceFile(id, filePath) {
    const task = findTask(id);
    if (!task) return;
    saveReference(id, filesOf(task).filter((entry) => entry !== filePath), `${filePath} を外しました。`);
  }

  /**
   * 添えられるファイルの一覧。文書に添える参照ファイルと同じものを見ます
   * （`referenceFiles.js` が開いたときに引いています）。まだ無ければここでも引きに行きます。
   * 引けなかった文書でも、参考知識だけは書けるようにしておくためで、投げません。
   */
  async function loadCandidates() {
    if (state.referenceCandidates || state.referenceCandidatesLoading || !state.currentPath) return;
    const documentPath = state.currentPath;
    state.referenceCandidatesLoading = true;
    try {
      const listed = await api.listReferenceFiles(documentPath);
      if (state.currentPath !== documentPath) return;
      state.referenceCandidates = listed;
      render();
    } catch {
      // 一覧が出ないだけです。添えてあるファイルは外せますし、参考知識は書けます。
    } finally {
      if (state.currentPath === documentPath) state.referenceCandidatesLoading = false;
    }
  }

  function knowledgeOf(task) {
    return knowledgeDrafts.has(task.id) ? knowledgeDrafts.get(task.id) : (task.reference?.knowledge || '');
  }

  function filesOf(task) {
    return task.reference?.files || [];
  }

  async function add() {
    const title = refs.tasksAddInput.value.trim();
    if (!title) return;
    if (title.length > MAX_TASK_TITLE_CHARS) {
      toaster.error(`タスクの題名は${MAX_TASK_TITLE_CHARS}文字までです。`);
      return;
    }
    const saved = await change({ add: [{ title, kind: refs.tasksAddKind.value }] }, 'タスクを足しました。');
    if (!saved) return;
    refs.tasksAddInput.value = '';
    render();
  }

  /** AIが書いた結果を、そのまま貼れる形で渡します。 */
  async function copyResult(id) {
    const task = findTask(id);
    if (!task?.result) return;
    const text = [
      `# ${task.title}`,
      task.result.summary ? `\n${task.result.summary}` : '',
      task.result.body ? `\n${task.result.body}` : ''
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toaster.success('結果をコピーしました。');
    } catch {
      toaster.error('コピーできませんでした。画面から選んでコピーしてください。');
    }
  }

  /* ---------------------------------------------------------------- *
   * 描画
   * ---------------------------------------------------------------- */

  function render() {
    const show = available();
    refs.tasksTabButton.classList.toggle('hidden', !show);
    if (!show) {
      refs.tasksTabCount.hidden = true;
      return;
    }
    const record = state.tasks;
    const tasks = record?.tasks || [];
    const busy = Boolean(state.tasksAbortController);
    const live = tasks.filter((task) => ['open', 'ready', 'running'].includes(task.status)).length;

    refs.tasksTabCount.hidden = live === 0;
    refs.tasksTabCount.textContent = live ? String(live) : '';
    refs.tasksState.textContent = record ? (tasks.length ? `${tasks.length}件` : '0件') : '読み込み中…';
    refs.tasksState.dataset.state = live ? 'set' : 'unset';

    refs.tasksWatch.checked = record?.watch === true;
    refs.tasksWatch.disabled = !record || busy;
    refs.tasksWatchHint.textContent = watchHint(record, state.tasksRunner);
    renderRunnerHint(record, state.tasksRunner);

    refs.tasksRunButton.disabled = busy || !record;
    refs.tasksStopButton.classList.toggle('hidden', !busy);
    refs.tasksAddSubmit.disabled = busy || refs.tasksAddInput.value.trim() === '';

    renderFocus(record?.focus);
    renderFilter(tasks, Boolean(record));
    renderPlanSummary(tasks);
    if (!record) {
      refs.tasksList.innerHTML = '<p class="muted">タスクを読み込んでいます…</p>';
      return;
    }
    if (!tasks.length) {
      refs.tasksList.innerHTML = emptyHtml(record);
      return;
    }
    const shown = tasks.filter(currentFilter().match);
    refs.tasksList.innerHTML = shown.length
      ? sortTasks(shown).map((task) => taskHtml(task, busy)).join('')
      : `<p class="muted">${escapeHtml(currentFilter().empty)}</p>`;
  }

  function currentFilter() {
    return FILTERS.find(({ id }) => id === filterId) || FILTERS[0];
  }

  /** 絞り込みの行。押したものだけを `aria-pressed` にし、それぞれの件数をラベルへ出します。 */
  function renderFilter(tasks, loaded) {
    for (const button of refs.tasksFilter.querySelectorAll('[data-tasks-filter]')) {
      const filter = FILTERS.find(({ id }) => id === button.dataset.tasksFilter);
      if (!filter) continue;
      const count = tasks.filter(filter.match).length;
      button.textContent = filter.id === 'all' ? filter.label : `${filter.label}（${count}）`;
      button.setAttribute('aria-pressed', String(filter.id === filterId));
      button.disabled = !loaded;
    }
  }

  /** やると決めたことの件数。期限を過ぎたものがあれば、その数も出します。 */
  function renderPlanSummary(tasks) {
    const committed = tasks.filter((task) => isCommitted(task) && !isFinished(task));
    const overdue = committed.filter((task) => dueState(task) === 'overdue').length;
    refs.tasksPlanSummary.hidden = committed.length === 0;
    refs.tasksPlanSummary.dataset.state = overdue ? 'overdue' : 'set';
    refs.tasksPlanSummary.textContent = committed.length
      ? `やると決めたこと ${committed.length}件${overdue ? `（期限を過ぎたもの ${overdue}件）` : ''}`
      : '';
  }

  function watchHint(record, runner) {
    if (!runner) return '';
    if (!runner.enabled) return '自動タスクは無効です。設定で有効にすると見守ります。';
    const interval = `${runner.intervalSeconds}秒ごとに読み直し、増えた分からタスクを起こします。`;
    if (runner.captioned) return `字幕が届いているので、会議のあいだはこの文書を見守ります。${interval}`;
    if (record?.watch) return interval;
    return `付けると、${interval}字幕が届いている文書は、付けなくても会議のあいだ見守ります。`;
  }

  /** 前回いつ読んだか、次はいつか、失敗していないか。裏で何が起きたかを画面からも辿れるようにします。 */
  function renderRunnerHint(record, runner) {
    const parts = [];
    const analysis = record?.analysis;
    // 誰のタスクを起こしているのかは、一覧を読む前に出します。絞っていることが画面に
    // 出ていないと、他の人のタスクが無いのを「起こせなかった」と読むことになります。
    if (runner?.owner) parts.push(`対象の人は「${runner.owner}」です。この人がやることだけを起こします。`);
    if (analysis?.analyzedAt) {
      parts.push(`最後に読んだのは ${timeLabel(analysis.analyzedAt)}（${analysis.sourceKind === 'transcript' ? '文字起こしとして' : '資料として'}）。`);
    }
    if (runner?.running) parts.push('いま裏で読んでいます。');
    else if (runner?.watching && runner?.nextTickAt) parts.push(`次の見守りは ${timeLabel(runner.nextTickAt)} ごろです。`);
    if (record?.lastError) parts.push(`前回の失敗: ${record.lastError.message}`);
    if (analysis?.summary) parts.push(analysis.summary);
    refs.tasksRunnerHint.hidden = parts.length === 0;
    refs.tasksRunnerHint.textContent = parts.join(' ');
  }

  function renderFocus(focus) {
    refs.tasksFocus.hidden = !focus;
    if (!focus) return;
    refs.tasksFocusNow.textContent = focus.now;
    refs.tasksFocusReason.textContent = focus.reason || '';
    refs.tasksFocusUpdated.textContent = focus.updatedAt ? `${timeLabel(focus.updatedAt)} 時点` : '';
  }

  function emptyHtml(record) {
    if (!record.analysis) {
      return '<p class="muted">まだタスクはありません。「タスクを整理する」を押すか、見守りを付けると、本文からやることを起こします。</p>';
    }
    return '<p class="muted">この文書から起こすタスクはありませんでした。本文が増えたら、次の見守りで読み直します。</p>';
  }

  function taskHtml(task, busy) {
    const deleting = pendingDeleteId === task.id;
    const result = task.result;
    const resultOpen = openResultIds.has(task.id);
    return `
      <article class="task-card" data-task-id="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}" data-committed="${isCommitted(task)}">
        <header class="task-card-head">
          <span class="task-status" data-status="${escapeHtml(task.status)}">${escapeHtml(STATUS_LABELS[task.status] || task.status)}</span>
          ${isCommitted(task) ? `<span class="task-commitment">${escapeHtml(COMMITMENT_LABELS.committed)}</span>` : ''}
          ${dueHtml(task)}
          <span class="task-kind" data-kind="${escapeHtml(task.kind)}">${escapeHtml(KIND_LABELS[task.kind] || task.kind)}</span>
          <span class="task-priority" data-priority="${escapeHtml(task.priority)}">${escapeHtml(PRIORITY_LABELS[task.priority] || task.priority)}</span>
          ${task.owner ? `<span class="task-owner">担当: ${escapeHtml(task.owner)}</span>` : ''}
          ${task.source === 'reviewer' ? '<span class="task-source">自分で足した</span>' : ''}
        </header>
        <p class="task-title">${escapeHtml(task.title)}</p>
        ${task.detail ? `<p class="task-detail">${escapeHtml(task.detail)}</p>` : ''}
        ${task.quote ? `<blockquote class="task-quote">${escapeHtml(task.quote)}</blockquote>` : ''}
        ${task.plan?.note ? `<p class="task-plan-note">自分のメモ: ${escapeHtml(task.plan.note)}</p>` : ''}
        ${task.statusReason ? `<p class="task-reason">${escapeHtml(task.statusReason)}</p>` : ''}
        ${task.error ? `<p class="ai-error task-error">実行できませんでした: ${escapeHtml(task.error)}</p>` : ''}
        ${isCommitted(task) ? planHtml(task, busy) : ''}
        ${referenceHtml(task, busy)}
        ${result ? resultHtml(task, result, resultOpen) : ''}
        <div class="context-note-item-actions task-actions">
          ${deleting
            ? `<span class="context-note-confirm" role="group" aria-label="タスクの削除確認">このタスクを削除しますか？</span>
               <button type="button" data-task-cancel-delete>やめる</button>
               <button type="button" class="danger" data-task-confirm-delete="${escapeHtml(task.id)}">削除する</button>`
            : actionButtons(task, busy)}
        </div>
      </article>`;
  }

  /**
   * そのタスクに添える参考知識と参照ファイル。渡すのは、このタスクを実行するときだけです。
   *
   * 済んだタスクには、すでに何か添えてあるときだけ出します。畳んである欄でも、残っている
   * タスクの数だけ並ぶと、一覧を読み下すときの行数がそのぶん増えるからです。
   */
  function referenceHtml(task, busy) {
    const open = openReferenceIds.has(task.id);
    const files = filesOf(task);
    const knowledge = knowledgeOf(task);
    const finished = task.status === 'done' || task.status === 'dismissed';
    if (finished && !knowledge && files.length === 0) return '';
    const disabled = busy ? ' disabled' : '';
    return `
      <details class="task-reference"${open ? ' open' : ''} data-task-reference="${escapeHtml(task.id)}">
        <summary>参考${referenceSummary(knowledge, files)}</summary>
        <p class="ai-context-hint">このタスクをAIに任せるときだけ渡します。資料の前提（読み取りコンテキスト・メモ・文書に添えた参照ファイル）は、これとは別に毎回渡します。</p>
        <textarea class="task-knowledge" rows="3" data-task-knowledge="${escapeHtml(task.id)}"
          placeholder="例：停止条件は運用チームの手順書が正。前回の会議で、再起動は無停止でやると決めた。"${disabled}>${escapeHtml(knowledge)}</textarea>
        <div class="context-note-actions">
          <button type="button" data-task-knowledge-save="${escapeHtml(task.id)}"${disabled}>参考知識を保存</button>
        </div>
        <div class="reference-file-form">
          <select data-task-reference-select="${escapeHtml(task.id)}" aria-label="このタスクに添えるファイル">${candidateOptions(files)}</select>
          <div class="reference-file-actions">
            <button type="button" data-task-reference-add="${escapeHtml(task.id)}"${files.length >= MAX_REFERENCE_FILES ? ' disabled' : disabled}>添える</button>
          </div>
        </div>
        ${files.length
          ? `<div class="reference-files-list">${files.map((file) => attachedFileHtml(task.id, file, disabled)).join('')}</div>`
          : '<p class="muted">まだ何も添えていません。仕様書や前の調査メモを添えると、AIはその中身を読んだうえで書きます。</p>'}
      </details>`;
  }

  function referenceSummary(knowledge, files) {
    const parts = [knowledge ? '参考知識あり' : '', files.length ? `ファイル${files.length}件` : ''].filter(Boolean);
    return parts.length ? `: ${parts.join('／')}` : '（未設定）';
  }

  function attachedFileHtml(taskId, file, disabled) {
    return `
      <div class="reference-file">
        <span class="reference-file-path">${escapeHtml(file)}</span>
        <span class="reference-file-item-actions">
          <button type="button" data-task-reference-remove="${escapeHtml(file)}" data-task-id="${escapeHtml(taskId)}"${disabled}>外す</button>
        </span>
      </div>`;
  }

  /** 添えられるファイルの選択欄。まだ引けていないときは、理由を1件だけ出します。 */
  function candidateOptions(attached) {
    const listed = state.referenceCandidates;
    if (!listed) return '<option value="">探しています…</option>';
    const options = listed.files.filter((entry) => !attached.includes(entry.path));
    if (options.length === 0) return '<option value="">添えられるファイルがありません</option>';
    return options.map((entry) => `<option value="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</option>`).join('');
  }

  /**
   * 決めたタスクの段取り。期限・優先度・担当・自分のメモを、その場で書き換えます。
   *
   * 畳んであるのは、決めたタスクが増えても一覧が読める長さで収まるようにするためです。
   * 開いたかどうかと書きかけは、描き直しをまたいで持ちます（`openPlanIds` / `planDrafts`）。
   */
  function planHtml(task, busy) {
    const id = escapeHtml(task.id);
    const disabled = busy ? ' disabled' : '';
    const draft = planDrafts.get(task.id) || {
      due: task.plan?.due || '',
      priority: task.priority,
      owner: task.owner || '',
      note: task.plan?.note || ''
    };
    const options = PRIORITY_IDS
      .map((priority) => `<option value="${priority}"${priority === draft.priority ? ' selected' : ''}>${escapeHtml(PRIORITY_LABELS[priority])}</option>`)
      .join('');
    return `
      <details class="task-plan"${openPlanIds.has(task.id) ? ' open' : ''} data-task-plan="${id}">
        <summary>段取り（期限・優先度・担当・メモ）</summary>
        <form class="task-plan-form" data-task-plan-form="${id}">
          <label>期限<input type="date" name="due" value="${escapeHtml(draft.due)}"${disabled}></label>
          <label>優先度<select name="priority"${disabled}>${options}</select></label>
          <label>担当<input type="text" name="owner" value="${escapeHtml(draft.owner)}" placeholder="例: 自分"${disabled}></label>
          <label>自分のメモ<textarea name="note" rows="2" placeholder="決めたときに分かっていたこと">${escapeHtml(draft.note)}</textarea></label>
          <div class="context-note-actions">
            <button type="submit"${disabled}>段取りを保存</button>
          </div>
        </form>
      </details>`;
  }

  /** 結果の本文はMarkdownですが、そのまま文字として出します。AIが書いたHTMLを画面へ流し込まないためです。 */
  function resultHtml(task, result, open) {
    return `
      <details class="task-result"${open ? ' open' : ''} data-task-result="${escapeHtml(task.id)}">
        <summary>AIの結果${result.summary ? `: ${escapeHtml(result.summary)}` : ''}</summary>
        ${result.body ? `<pre class="task-result-body">${escapeHtml(result.body)}</pre>` : ''}
        ${result.truncated ? '<p class="muted">長いので末尾を落としています。</p>' : ''}
        ${result.questions?.length
          ? `<p class="task-result-label">材料に無かったこと</p><ul class="task-result-list">${result.questions.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`
          : ''}
        ${result.completedAt ? `<p class="task-result-meta">${escapeHtml(timeLabel(result.completedAt))} に実行</p>` : ''}
        <div class="context-note-item-actions">
          <button type="button" data-task-copy="${escapeHtml(task.id)}">結果をコピー</button>
        </div>
      </details>`;
  }

  function actionButtons(task, busy) {
    const disabled = busy ? ' disabled' : '';
    const id = escapeHtml(task.id);
    const buttons = [];
    if (task.status === 'running') return '<span class="task-running">AIが実行中です…</span>';
    // 済んだタスクに「やると決める」は出しません。決めるのはこれからやることだけです。
    if (task.status !== 'done') {
      buttons.push(isCommitted(task)
        ? `<button type="button" data-task-uncommit="${id}"${disabled}>やるのを取り消す</button>`
        : `<button type="button" data-task-commit="${id}"${disabled}>やると決める</button>`);
    }
    if (task.status === 'open' || task.status === 'ready') {
      buttons.push(`<button type="button" data-task-run="${id}"${disabled}>${task.status === 'ready' ? 'もう一度実行' : 'AIに任せる'}</button>`);
      buttons.push(`<button type="button" data-task-status="done" data-task-id="${id}"${disabled}>完了にする</button>`);
      buttons.push(`<button type="button" data-task-status="dismissed" data-task-id="${id}"${disabled}>見送る</button>`);
    } else {
      buttons.push(`<button type="button" data-task-status="open" data-task-id="${id}"${disabled}>未着手に戻す</button>`);
    }
    buttons.push(`<button type="button" data-task-delete="${id}"${disabled}>削除</button>`);
    return buttons.join('\n');
  }

  function renderKindOptions() {
    refs.tasksAddKind.innerHTML = KINDS
      .map(({ id, label }) => `<option value="${id}">${escapeHtml(label)}</option>`)
      .join('');
    refs.tasksAddKind.value = KINDS[0].id;
  }

  function setStatus(status, message) {
    refs.tasksStatus.dataset.state = status;
    refs.tasksStatus.textContent = message ?? STATUS_MESSAGES[status] ?? '';
  }

  function phaseText(phase) {
    if (phase === 'extracting') return 'タスクを起こしています…';
    if (String(phase).startsWith('performing:')) return `「${phase.slice('performing:'.length)}」を実行しています…`;
    return STATUS_MESSAGES.running;
  }

  function findTask(id) {
    return (state.tasks?.tasks || []).find((task) => task.id === id) || null;
  }

  function bindEvents() {
    refs.tasksRunForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runNow();
    });
    refs.tasksStopButton.addEventListener('click', () => state.tasksAbortController?.abort());
    refs.tasksWatch.addEventListener('change', () => toggleWatch(refs.tasksWatch.checked));
    refs.tasksAddInput.addEventListener('input', render);
    refs.tasksAddForm.addEventListener('submit', (event) => {
      event.preventDefault();
      add();
    });
    refs.tasksFilter.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tasks-filter]');
      if (!button || button.dataset.tasksFilter === filterId) return;
      filterId = button.dataset.tasksFilter;
      render();
    });
    refs.tasksList.addEventListener('toggle', (event) => {
      const details = event.target;
      if (details?.dataset?.taskResult) {
        if (details.open) openResultIds.add(details.dataset.taskResult);
        else openResultIds.delete(details.dataset.taskResult);
      }
      if (details?.dataset?.taskPlan) {
        if (details.open) openPlanIds.add(details.dataset.taskPlan);
        else openPlanIds.delete(details.dataset.taskPlan);
      }
      if (details?.dataset?.taskReference) {
        if (details.open) {
          openReferenceIds.add(details.dataset.taskReference);
          // 開いたときに引きます。タスクを1件も任せない文書で、一覧を引きに行かないためです。
          loadCandidates();
        } else {
          openReferenceIds.delete(details.dataset.taskReference);
        }
      }
    }, true);
    // 書きかけを控えるのは、描き直しで消さないためです（`planDrafts` / `knowledgeDrafts`）。
    for (const type of ['input', 'change']) {
      refs.tasksList.addEventListener(type, (event) => {
        const form = event.target.closest('[data-task-plan-form]');
        if (form) rememberPlanDraft(form);
        const knowledgeId = event.target?.dataset?.taskKnowledge;
        if (knowledgeId) knowledgeDrafts.set(knowledgeId, event.target.value);
      });
    }
    refs.tasksList.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-task-plan-form]');
      if (!form) return;
      event.preventDefault();
      savePlan(form.dataset.taskPlanForm, form);
    });
    refs.tasksList.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.taskCommit) return setCommitment(button.dataset.taskCommit, 'committed');
      if (button.dataset.taskUncommit) return setCommitment(button.dataset.taskUncommit, 'undecided');
      if (button.dataset.taskRun) return runTask(button.dataset.taskRun);
      if (button.dataset.taskStatus) return setTaskStatus(button.dataset.taskId, button.dataset.taskStatus);
      if (button.dataset.taskCopy) return copyResult(button.dataset.taskCopy);
      if (button.dataset.taskKnowledgeSave) {
        return saveReference(button.dataset.taskKnowledgeSave, undefined, '参考知識を保存しました。');
      }
      if (button.dataset.taskReferenceAdd) {
        const id = button.dataset.taskReferenceAdd;
        const select = refs.tasksList.querySelector(`[data-task-reference-select="${cssEscape(id)}"]`);
        return attachReferenceFile(id, select?.value || '');
      }
      if (button.dataset.taskReferenceRemove) {
        return detachReferenceFile(button.dataset.taskId, button.dataset.taskReferenceRemove);
      }
      if (button.dataset.taskDelete) {
        pendingDeleteId = button.dataset.taskDelete;
        return render();
      }
      if (button.dataset.taskConfirmDelete) return confirmDelete(button.dataset.taskConfirmDelete);
      if (button.hasAttribute('data-task-cancel-delete')) {
        pendingDeleteId = null;
        render();
      }
    });
  }

  return { load, sync, render, refresh, available };
}

/**
 * 画面の並び。確認待ち → 未着手 → 実行中 → 完了 → 見送り。同じ状態では、やると決めたものが
 * 先で、次に期限の近い順、優先度の順、新しい順です。`src/autoTasks.js` の
 * `sortTasksForDisplay` と同じ並びで、レビューMarkdownと画面が食い違わないようにしています。
 */
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => (
    (STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    || (commitmentOrder(a) - commitmentOrder(b))
    || dueOrder(a).localeCompare(dueOrder(b))
    || (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  ));
}

/** タスクのidを属性セレクタに入れるための逃がし。idは英数字と `-` だけですが、選ぶのは値です。 */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function isCommitted(task) {
  return task?.plan?.commitment === 'committed';
}

function isFinished(task) {
  return task.status === 'done' || task.status === 'dismissed';
}

function commitmentOrder(task) {
  return isCommitted(task) ? 0 : 1;
}

/** 期限の無いタスクを後ろへ回すための並び順。日付は文字列のまま比べられます（YYYY-MM-DD）。 */
function dueOrder(task) {
  return task?.plan?.due || '9999-99-99';
}

/** 期限が過ぎたか、今日か、まだ先か。日付だけで比べます（時刻は持ちません）。 */
function dueState(task, now = new Date()) {
  const due = task?.plan?.due;
  if (!due) return '';
  const today = new Date(now.getTime() - now.getTimezoneOffset() * MINUTE_MS).toISOString().slice(0, 10);
  if (due < today) return 'overdue';
  return due === today ? 'today' : 'soon';
}

/** 期限の札。過ぎているものと今日のものは、その場で分かるように言葉を添えます。 */
function dueHtml(task) {
  const state = dueState(task);
  if (!state) return '';
  const suffix = { overdue: '（過ぎています）', today: '（今日）', soon: '' }[state];
  return `<span class="task-due" data-due="${state}">期限 ${escapeHtml(task.plan.due)}${suffix}</span>`;
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
