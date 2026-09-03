/**
 * 自動タスクが使う語彙の、唯一の定義です。
 *
 * タスクの種類・状態・優先度と、AIに任せられる自動化の一覧を持ちます。出力スキーマの
 * enum・答えを受け取るときの検証・並べ替え・画面とレビューMarkdownに出る日本語の4か所へ
 * 同時に効くので、`aiVocabulary.js` と同じく1か所に寄せてあります。
 *
 * 画面側（public/js/autoTasks.js）には同じ表がもう一組あります。ビルドを持たない構成では
 * `src/` を `public/` から import できないためです。片方を変えたらもう片方も、という関係
 * だけを覚えておいてください。
 */

/**
 * タスクの種類。`auto` が true のものは、AIが「実行」できます（調査メモ・コード例・回答案を
 * 書く）。false のものは人が動くことなので、AIは起こすだけで実行しません。
 */
export const TASK_KINDS = Object.freeze([
  Object.freeze({ id: 'action', label: '対応', auto: false }),
  Object.freeze({ id: 'decision', label: '判断', auto: false }),
  Object.freeze({ id: 'research', label: '調査', auto: true }),
  Object.freeze({ id: 'sample', label: 'サンプル実装', auto: true }),
  Object.freeze({ id: 'inquiry', label: '問い合わせ対応', auto: true })
]);

export const TASK_KIND_IDS = Object.freeze(TASK_KINDS.map(({ id }) => id));
export const TASK_KIND_LABELS = Object.freeze(Object.fromEntries(TASK_KINDS.map(({ id, label }) => [id, label])));
/** AIが実行できる種類。自動化の設定（`AUTO_TASK_ACTIONS`）のうち、この種類と同じidのものが対応します。 */
export const AUTO_TASK_KIND_IDS = Object.freeze(TASK_KINDS.filter(({ auto }) => auto).map(({ id }) => id));
/** 種類が読めないタスクの行き先。捨てるより「対応」として残すほうが失うものが少ないからです。 */
export const DEFAULT_TASK_KIND = 'action';

/**
 * タスクの状態。`running` はAIが実行している間だけの状態で、`ready` はAIが結果を用意して
 * レビュアーの確認を待っている状態です。AIが済ませたことを黙って `done` にしないのは、
 * 調査メモも回答案も、読んで採るかどうかを決めるのはレビュアーだからです。
 */
export const TASK_STATUSES = Object.freeze(['open', 'running', 'ready', 'done', 'dismissed']);
export const TASK_STATUS_LABELS = Object.freeze({
  open: '未着手', running: '実行中', ready: '確認待ち', done: '完了', dismissed: '見送り'
});
/** レビュアーが画面から付けられる状態。`running` と `ready` はAIの実行が付けるものです。 */
export const REVIEWER_TASK_STATUSES = Object.freeze(['open', 'done', 'dismissed']);
export const DEFAULT_TASK_STATUS = 'open';

/** 優先度。並び順そのものです。 */
export const TASK_PRIORITIES = Object.freeze(['now', 'next', 'later']);
export const TASK_PRIORITY_ORDER = Object.freeze({ now: 0, next: 1, later: 2 });
export const TASK_PRIORITY_LABELS = Object.freeze({ now: 'いま', next: '次に', later: 'あとで' });
export const DEFAULT_TASK_PRIORITY = 'next';

/**
 * AIに任せられる自動化。設定の `autoTasksActions` に書ける値で、書いたものだけが裏で走ります。
 *
 *   organize : 抽出のたびに、済んだタスクを完了にし、蒸し返しをまとめる
 *   focus    : 文字起こしの流れから「今すべきこと」を1つ選ぶ
 *   research / sample / inquiry : その種類のタスクをAIが実行する（メモ・コード例・回答案を書く）
 *
 * タスクを起こすこと（抽出）そのものは自動化の一覧にありません。自動タスクを有効にした
 * 時点で必ず走るもので、外すと機能ごと無い状態と同じになるからです。
 */
export const AUTO_TASK_ACTIONS = Object.freeze([
  Object.freeze({ id: 'organize', label: 'タスクの整理' }),
  Object.freeze({ id: 'focus', label: '今すべきこと' }),
  Object.freeze({ id: 'research', label: '調査の実行' }),
  Object.freeze({ id: 'sample', label: 'サンプル実装の実行' }),
  Object.freeze({ id: 'inquiry', label: '問い合わせ対応の実行' })
]);
export const AUTO_TASK_ACTION_IDS = Object.freeze(AUTO_TASK_ACTIONS.map(({ id }) => id));
export const AUTO_TASK_ACTION_LABELS = Object.freeze(
  Object.fromEntries(AUTO_TASK_ACTIONS.map(({ id, label }) => [id, label]))
);
/** 何も指定しなければ、全部を任せます。絞るのは費用を抑えたいときで、その判断は設定で行います。 */
export const DEFAULT_AUTO_TASK_ACTIONS = Object.freeze([...AUTO_TASK_ACTION_IDS]);

/** 見守りの間隔（秒）。短くすると文字起こしへの追従が速くなる代わりに、AIへ送る回数が増えます。 */
export const DEFAULT_AUTO_TASK_INTERVAL_SECONDS = 120;
export const MIN_AUTO_TASK_INTERVAL_SECONDS = 30;
export const MAX_AUTO_TASK_INTERVAL_SECONDS = 3600;

export function isTaskKind(value) {
  return TASK_KIND_IDS.includes(value);
}

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function isTaskPriority(value) {
  return TASK_PRIORITIES.includes(value);
}

export function isAutoTaskAction(value) {
  return AUTO_TASK_ACTION_IDS.includes(value);
}
