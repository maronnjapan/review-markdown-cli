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

/**
 * 「やる」と決めたかどうか（採否）。状態（`TASK_STATUSES`）とは別の軸です。
 *
 * 状態は「どこまで進んだか」で、こちらは「やると決めたか」です。分けてあるのは、
 * AIが起こしただけのタスクと、読んで自分がやると決めたタスクが、どちらも「未着手」に
 * 並んでしまうと、一覧から「自分がやること」を取り出せなくなるからです。決めたものは
 * `committed` になり、期限と自分のメモを持てます（`autoTasks.js` の `plan`）。
 *
 * 「やらないと決めた」に当たる値は置いていません。それは状態の `dismissed`（見送り）
 * だからです。同じことを2か所で言えるようにすると、どちらが本当かを決める規則が要ります。
 */
export const TASK_COMMITMENTS = Object.freeze(['undecided', 'committed']);
export const TASK_COMMITMENT_LABELS = Object.freeze({ undecided: '未定', committed: 'やる' });
export const DEFAULT_TASK_COMMITMENT = 'undecided';

/**
 * 優先度。並び順そのものです。
 *
 * 値は agent-xaa-platform の ToDo と同じ3つにしてあります（`high` / `normal` / `low`）。
 * 決めたタスクはあちらの ToDo として登録されるので、違う言葉で持つと、渡すときに必ず
 * どちらかの読み替え表が要ります。表は片方だけ足された値を黙って既定値へ落とすので、
 * 揃えられるなら揃えておくほうが失うものがありません。
 *
 * 並び順の意味は変えていません。「いま手を付ける」が `high`、「次に」が `normal`、
 * 「あとで」が `low` です。何をどれにするかは `prompts/tasks.js` が言葉で決めています。
 */
export const TASK_PRIORITIES = Object.freeze(['high', 'normal', 'low']);
export const TASK_PRIORITY_ORDER = Object.freeze({ high: 0, normal: 1, low: 2 });
export const TASK_PRIORITY_LABELS = Object.freeze({ high: '高', normal: 'ふつう', low: '低' });
export const DEFAULT_TASK_PRIORITY = 'normal';

/**
 * 揃える前の優先度。この機能より前に書かれた記録に入っています。
 *
 * 読むときだけ当てます（`readTaskPriority`）。書くときに受け取ると、古い値を送り続ける
 * 画面やスクリプトがそのまま動いてしまい、記録に2つの言葉が混ざり続けるからです。
 */
export const LEGACY_TASK_PRIORITIES = Object.freeze({ now: 'high', next: 'normal', later: 'low' });

/**
 * 保存済みの優先度を読みます。読めなければ null です。
 *
 * 既定値へ落とすのは呼ぶ側の仕事にしてあります。ここで落とすと、送られた値が読めなかった
 * ことを、断りたい側（`normalizeTaskInput`）が知れなくなります。
 */
export function readTaskPriority(value) {
  if (isTaskPriority(value)) return value;
  return LEGACY_TASK_PRIORITIES[value] || null;
}

/**
 * タスクに書ける3つの並び。渡す先（agent-xaa-platform の ToDo）の `done_criteria` /
 * `steps` / `notes` と、名前も意味も同じ3つです。
 *
 *   完了条件 : 何が満たされたら終わりか。これが無いと、任せた相手は終わりを決められません
 *   手順     : どう進めるか。決め打ちにしたいところだけ書きます
 *   補足     : 進めるあいだ頭に置いてほしいこと
 *
 * 書くのはレビュアーです。ただし完了条件だけは、AIが起こしたタスクにも入ります。引用した
 * 一文から「終わり」を書けることがあり、そこを空で渡すと、受け取った側が自分で決めるか、
 * 決められずに止まるかのどちらかになるからです。手順と補足は、文書が言っていないことを
 * 書くことになるので入れません。
 */
export const TASK_LINES = Object.freeze([
  Object.freeze({ id: 'doneCriteria', label: '完了条件', fromAi: true }),
  Object.freeze({ id: 'steps', label: '手順', fromAi: false }),
  Object.freeze({ id: 'notes', label: '補足', fromAi: false })
]);
export const TASK_LINE_FIELDS = Object.freeze(TASK_LINES.map(({ id }) => id));
export const TASK_LINE_LABELS = Object.freeze(Object.fromEntries(TASK_LINES.map(({ id, label }) => [id, label])));
/** AIの答えから受け取る並び。ここに無いものは、答えに入っていても捨てます。 */
export const AI_TASK_LINE_FIELDS = Object.freeze(TASK_LINES.filter(({ fromAi }) => fromAi).map(({ id }) => id));

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

export function isTaskCommitment(value) {
  return TASK_COMMITMENTS.includes(value);
}

export function isAutoTaskAction(value) {
  return AUTO_TASK_ACTION_IDS.includes(value);
}
