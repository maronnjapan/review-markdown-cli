import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_AUTO_TASK_INSTRUCTIONS_CHARS,
  MAX_AUTO_TASK_OWNER_CHARS,
  MAX_NEW_TASKS_PER_RUN,
  MAX_TASK_DETAIL_CHARS,
  MAX_TASK_FOLLOW_UPS,
  MAX_TASK_KNOWLEDGE_CHARS,
  MAX_TASK_OWNER_CHARS,
  MAX_TASK_QUESTIONS,
  MAX_TASK_QUOTE_CHARS,
  MAX_TASK_RESULT_CHARS,
  MAX_TASK_SOURCE_CHARS,
  MAX_TASK_TITLE_CHARS,
  MAX_TASKS_PER_DOCUMENT,
  MIN_TASK_SOURCE_GROWTH_CHARS,
  TASK_SOURCE_TAIL_CHARS
} from './aiLimits.js';
import {
  AUTO_TASK_ACTION_IDS,
  AUTO_TASK_KIND_IDS,
  DEFAULT_AUTO_TASK_ACTIONS,
  DEFAULT_TASK_KIND,
  DEFAULT_TASK_PRIORITY,
  DEFAULT_TASK_STATUS,
  MAX_AUTO_TASK_INTERVAL_SECONDS,
  MIN_AUTO_TASK_INTERVAL_SECONDS,
  REVIEWER_TASK_STATUSES,
  TASK_PRIORITY_ORDER,
  isAutoTaskAction,
  isTaskKind,
  isTaskPriority,
  isTaskStatus
} from './autoTaskVocabulary.js';
import { parseCaptionEntries } from './captionRecap.js';
import { normalizeReferenceFiles, readReferenceFilePaths } from './referenceFiles.js';
import { REVIEW_DIR } from './reviewStore.js';

/**
 * 自動タスクは、文字起こしや書きかけの資料から「やること」をAIに起こさせ、任せられる
 * ものは裏で済ませておく機能です。
 *
 * 持っているものは3つです。
 *   - タスクの一覧。AIが起こしたものと、レビュアーが手で足したもの。状態と結果を持ちます。
 *   - 今すべきこと。文字起こしの流れから、いま手を付けるべきことを1つ選んだもの。
 *   - 解析の記録。どこまで読んだか（長さと版）で、次に読むのは増えた分だけで済ませます。
 *
 * ── 保存先をレビューファイルと分けている理由 ──────────────────
 * レビューファイル（`.review/<target>.review.json`）はレビュアーが書いた前提とコメントの
 * 置き場で、書き込むのは画面だけです。タスクはサーバーが裏で書き足すものなので、同じ
 * ファイルに置くと、画面の自動保存と裏の書き込みが同じ瞬間に走ったときに片方が消えます。
 * `.review/<target>.tasks.json` へ分け、書き込みはファイルごとに1本の列に並べます
 * （`updateTasks`）。
 *
 * ── 読むときは通し、書くときだけ断る ──────────────────────
 * `readTasksRecord` は保存済みの値を読むためのもので、何が入っていても投げません。
 * 断るのは、レビュアーが送ってきた値を受け取る `normalizeTaskInput` などだけです
 * （`contextNotes.js` と同じ切り分けです）。
 *
 * このモジュールが持つのは、形の検証・保存・抽出結果の重ね合わせだけです。モデルが読む
 * 文面は `prompts/tasks.js`、いつ読み直すかを決めるのは `autoTaskRunner.js` です。
 */

export const TASKS_FILE_SUFFIX = '.tasks.json';

/** ISO 8601 の日時が収まる長さ。長い文字列を書かれても切り詰めるためだけの上限です。 */
const TIMESTAMP_CHARS = 40;
const ID_CHARS = 80;
const MAX_SUMMARY_CHARS = 600;
const MAX_FOCUS_CHARS = 600;
const MAX_REASON_CHARS = 400;

/** 文字起こしと見なす発言の数。1〜2件では、太字と時刻を偶然含む資料と見分けられません。 */
const CAPTION_ENTRIES_FOR_TRANSCRIPT = 3;

export function tasksPathFor(rootDir, relativeFile) {
  return path.join(rootDir, REVIEW_DIR, `${relativeFile}${TASKS_FILE_SUFFIX}`);
}

/** 画面とREADMEに出す保存先（対象ディレクトリからの相対パス）。 */
export function relativeTasksPath(relativeFile) {
  return `${REVIEW_DIR}/${relativeFile}${TASKS_FILE_SUFFIX}`;
}

/* ---------------------------------------------------------------- *
 * 読む
 * ---------------------------------------------------------------- */

/** まだ何も無い文書の記録。 */
export function emptyTasksRecord(targetFile) {
  return { targetFile, watch: false, analysis: null, focus: null, tasks: [], lastError: null, updatedAt: undefined };
}

export async function readTasks(rootDir, relativeFile) {
  const targetFile = relativeFile.split(path.sep).join('/');
  try {
    const raw = await fs.readFile(tasksPathFor(rootDir, targetFile), 'utf8');
    return readTasksRecord(JSON.parse(raw), targetFile);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return emptyTasksRecord(targetFile);
  }
}

/** 保存済みの記録を読みます。何が入っていても投げません。 */
export function readTasksRecord(value, targetFile) {
  const record = emptyTasksRecord(targetFile);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return record;
  record.watch = value.watch === true;
  record.analysis = readAnalysis(value.analysis);
  record.focus = readFocus(value.focus);
  record.tasks = Array.isArray(value.tasks) ? value.tasks.map((task) => readTask(task, targetFile)).filter(Boolean) : [];
  record.lastError = readError(value.lastError);
  record.updatedAt = timestamp(value.updatedAt) || undefined;
  return record;
}

function readAnalysis(value) {
  if (!value || typeof value !== 'object') return null;
  const revision = text(value.revision, 80);
  const length = Number.isInteger(value.length) && value.length >= 0 ? value.length : null;
  if (!revision || length === null) return null;
  return {
    revision,
    length,
    sourceKind: value.sourceKind === 'transcript' ? 'transcript' : 'document',
    analyzedAt: timestamp(value.analyzedAt),
    summary: text(value.summary, MAX_SUMMARY_CHARS)
  };
}

function readFocus(value) {
  if (!value || typeof value !== 'object') return null;
  const now = text(value.now, MAX_FOCUS_CHARS);
  if (!now) return null;
  return { now, reason: text(value.reason, MAX_REASON_CHARS), updatedAt: timestamp(value.updatedAt) };
}

function readError(value) {
  if (!value || typeof value !== 'object') return null;
  const message = text(value.message, 600);
  if (!message) return null;
  return { message, at: timestamp(value.at) };
}

/** 題名の無いタスクは、残す意味がないので落とします（null を返します）。 */
function readTask(value, targetFile = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = text(value.title, MAX_TASK_TITLE_CHARS);
  if (!title) return null;
  const result = readResult(value.result);
  const reference = readTaskReference(value.reference, targetFile);
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, ID_CHARS) : createTaskId(),
    title,
    detail: text(value.detail, MAX_TASK_DETAIL_CHARS),
    kind: isTaskKind(value.kind) ? value.kind : DEFAULT_TASK_KIND,
    priority: isTaskPriority(value.priority) ? value.priority : DEFAULT_TASK_PRIORITY,
    // 実行中のまま保存されたタスクは、途中で落ちたものです。未着手へ戻して読みます。
    status: isTaskStatus(value.status) && value.status !== 'running' ? value.status : DEFAULT_TASK_STATUS,
    source: value.source === 'reviewer' ? 'reviewer' : 'ai',
    quote: text(value.quote, MAX_TASK_QUOTE_CHARS),
    owner: text(value.owner, MAX_TASK_OWNER_CHARS),
    ...(text(value.statusReason, MAX_REASON_CHARS) ? { statusReason: text(value.statusReason, MAX_REASON_CHARS) } : {}),
    ...(typeof value.parentId === 'string' && value.parentId ? { parentId: value.parentId.slice(0, ID_CHARS) } : {}),
    ...(result ? { result } : {}),
    ...(reference ? { reference } : {}),
    ...(text(value.error, 600) ? { error: text(value.error, 600) } : {}),
    ...(timestamp(value.createdAt) ? { createdAt: timestamp(value.createdAt) } : {}),
    ...(timestamp(value.updatedAt) ? { updatedAt: timestamp(value.updatedAt) } : {})
  };
}

function readResult(value) {
  if (!value || typeof value !== 'object') return null;
  const body = text(value.body, MAX_TASK_RESULT_CHARS);
  const summary = text(value.summary, MAX_SUMMARY_CHARS);
  if (!body && !summary) return null;
  return {
    summary,
    body,
    truncated: value.truncated === true,
    followUps: stringList(value.followUps, MAX_TASK_FOLLOW_UPS, MAX_TASK_TITLE_CHARS),
    questions: stringList(value.questions, MAX_TASK_QUESTIONS, MAX_REASON_CHARS),
    completedAt: timestamp(value.completedAt)
  };
}

/**
 * そのタスクを実行するときだけ渡す「参考」。レビュアーが書いた知識と、添えたファイルです。
 *
 * 保存済みの値を読むところなので投げません。同階層以下から外れたパスは落とします
 * （`readReferenceFilePaths` と同じ理由で、記録を手で直した1行のせいで、その文書の
 * タスクが1件も読めなくなるのを避けます）。
 */
function readTaskReference(value, targetFile) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const knowledge = text(value.knowledge, MAX_TASK_KNOWLEDGE_CHARS);
  const files = readReferenceFilePaths(value.files, targetFile);
  if (!knowledge && files.length === 0) return null;
  return { knowledge, files };
}

/* ---------------------------------------------------------------- *
 * 書く
 * ---------------------------------------------------------------- */

/**
 * ファイルごとに1本の列。画面からの状態変更と、裏の抽出の書き込みが同じファイルへ
 * 同時に来ても、読んで・変えて・書くの3つが割り込まれずに済むようにします。
 * プロセスを跨いでは持ちません。
 */
const writeQueues = new Map();

/**
 * 記録を読み、`mutate` で変えて、書き戻します。`mutate` は新しい記録を返してください
 * （同じものを返しても構いません）。書いた記録を返します。
 */
export async function updateTasks(rootDir, relativeFile, mutate) {
  const filePath = tasksPathFor(rootDir, relativeFile);
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const current = await readTasks(rootDir, relativeFile);
    const next = (await mutate(current)) || current;
    const payload = {
      targetFile: next.targetFile || current.targetFile,
      updatedAt: new Date().toISOString(),
      watch: next.watch === true,
      ...(next.analysis ? { analysis: next.analysis } : {}),
      ...(next.focus ? { focus: next.focus } : {}),
      tasks: next.tasks,
      ...(next.lastError ? { lastError: next.lastError } : {})
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return readTasksRecord(payload, payload.targetFile);
  });
  writeQueues.set(filePath, run);
  try {
    return await run;
  } finally {
    if (writeQueues.get(filePath) === run) writeQueues.delete(filePath);
  }
}

/**
 * 見守りを付けた文書の一覧。`.review` 配下の `*.tasks.json` を辿ります。
 * 実行係（`autoTaskRunner.js`）が、毎回の見守りで読み直す対象を集めるのに使います。
 */
export async function listWatchedFiles(rootDir) {
  const reviewDir = path.join(rootDir, REVIEW_DIR);
  const watched = [];
  await walk(reviewDir, '');
  return watched.sort((a, b) => a.localeCompare(b));

  async function walk(currentDir, relativeDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name), relativePath);
      } else if (entry.isFile() && entry.name.endsWith(TASKS_FILE_SUFFIX)) {
        const targetFile = relativePath.slice(0, -TASKS_FILE_SUFFIX.length);
        const record = await readTasks(rootDir, targetFile);
        if (record.watch) watched.push(targetFile);
      }
    }
  }
}

/* ---------------------------------------------------------------- *
 * レビュアーから受け取る
 * ---------------------------------------------------------------- */

/**
 * 画面から届いた変更です。一覧まるごとではなく、変えたいことだけを受け取ります。
 * まるごと送り返させると、画面が読んだあとに裏で足されたタスクを、その保存で消すことになります。
 *
 * @param {object} body
 * @param {boolean} [body.watch] 見守りの入り切り。
 * @param {Array<{id: string, status: string}>} [body.setStatus] 状態の変更。
 * @param {Array<{title: string, detail?: string, kind?: string, priority?: string}>} [body.add] 手で足すタスク。
 * @param {string[]} [body.remove] 消すタスクのid。
 * @param {Array<{id: string, knowledge?: string, files?: string[]}>} [body.setReference] 参考知識と参照ファイル。
 * @param {boolean} [body.clearFocus] 今すべきことを消す。
 * @param {string} [documentPath] タスクの対象文書。参照ファイルが同階層以下かをここで確かめます。
 */
export function normalizeTasksChange(body = {}, documentPath = '') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('変更はJSONオブジェクトで送ってください');
  const change = {};
  if (body.watch !== undefined) {
    if (typeof body.watch !== 'boolean') throw new Error('watch は true / false で指定してください');
    change.watch = body.watch;
  }
  if (body.setStatus !== undefined) {
    if (!Array.isArray(body.setStatus)) throw new Error('setStatus は配列で指定してください');
    change.setStatus = body.setStatus.map((entry) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) throw new Error('状態を変えるタスクのidが要ります');
      if (!REVIEWER_TASK_STATUSES.includes(entry.status)) {
        throw new Error(`タスクの状態は ${REVIEWER_TASK_STATUSES.join(' / ')} のいずれかです: ${entry.status}`);
      }
      return { id, status: entry.status };
    });
  }
  if (body.add !== undefined) {
    if (!Array.isArray(body.add)) throw new Error('add は配列で指定してください');
    change.add = body.add.map((entry) => normalizeTaskInput(entry, 'タスク', documentPath));
  }
  if (body.setReference !== undefined) {
    if (!Array.isArray(body.setReference)) throw new Error('setReference は配列で指定してください');
    change.setReference = body.setReference.map((entry) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) throw new Error('参考を変えるタスクのidが要ります');
      return { id, ...normalizeTaskReference(entry, documentPath) };
    });
  }
  if (body.remove !== undefined) {
    if (!Array.isArray(body.remove) || body.remove.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('remove はタスクのidの配列で指定してください');
    }
    change.remove = body.remove;
  }
  if (body.clearFocus === true) change.clearFocus = true;
  return change;
}

/** レビュアーが手で足すタスク。長すぎる題名は、切り詰めずに断ります。 */
export function normalizeTaskInput(value, source = 'タスク', documentPath = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}はオブジェクトで指定してください`);
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) throw new Error(`${source}の題名を入力してください`);
  if (title.length > MAX_TASK_TITLE_CHARS) throw new Error(`${source}の題名が長すぎます（${MAX_TASK_TITLE_CHARS}文字まで）`);
  const detail = typeof value.detail === 'string' ? value.detail.trim() : '';
  if (detail.length > MAX_TASK_DETAIL_CHARS) throw new Error(`${source}の詳細が長すぎます（${MAX_TASK_DETAIL_CHARS}文字まで）`);
  if (value.kind !== undefined && !isTaskKind(value.kind)) throw new Error(`${source}の種類が読めません: ${value.kind}`);
  if (value.priority !== undefined && !isTaskPriority(value.priority)) {
    throw new Error(`${source}の優先度が読めません: ${value.priority}`);
  }
  const reference = normalizeTaskReference(value, documentPath, source);
  return {
    title,
    detail,
    kind: value.kind || DEFAULT_TASK_KIND,
    priority: value.priority || DEFAULT_TASK_PRIORITY,
    ...(reference.knowledge || reference.files.length ? { reference } : {})
  };
}

/**
 * タスク1件に添える「参考」。実行を頼むときだけ、そのタスクの文面へ入ります。
 *
 * 参照ファイルの確かめ方は、文書に添える参照ファイルと同じものを使います
 * （`referenceFiles.js` の `normalizeReferenceFiles`）。同階層以下から外れたパスと、
 * 上限を超えた件数は、切り詰めずに断ります。何件か落ちた状態で実行させると、
 * 渡したはずの資料を読まずに書かれた成果を、渡した前提で読むことになるからです。
 */
export function normalizeTaskReference(value, documentPath = '', source = 'タスク') {
  const knowledge = typeof value?.knowledge === 'string' ? value.knowledge.trim() : '';
  if (knowledge.length > MAX_TASK_KNOWLEDGE_CHARS) {
    throw new Error(`${source}の参考知識が長すぎます（${MAX_TASK_KNOWLEDGE_CHARS}文字まで）`);
  }
  const files = value?.files === undefined || value?.files === null
    ? []
    : normalizeReferenceFiles(value.files, documentPath, `${source}の参照ファイル`);
  return { knowledge, files };
}

/** 変更を記録へ当てます。無いidへの変更は黙って飛ばします（裏で消えていただけなので）。 */
export function applyTasksChange(record, change, now = new Date()) {
  const at = now.toISOString();
  const next = { ...record, tasks: [...record.tasks] };
  if (change.watch !== undefined) next.watch = change.watch;
  for (const { id, status } of change.setStatus || []) {
    next.tasks = next.tasks.map((task) => (
      task.id === id && task.status !== 'running'
        ? { ...task, status, updatedAt: at, ...(status === 'open' ? {} : {}) }
        : task
    ));
  }
  for (const input of change.add || []) {
    next.tasks.push({
      id: createTaskId(),
      ...input,
      status: DEFAULT_TASK_STATUS,
      source: 'reviewer',
      quote: '',
      owner: '',
      createdAt: at
    });
  }
  for (const { id, knowledge, files } of change.setReference || []) {
    next.tasks = next.tasks.map((task) => {
      if (task.id !== id) return task;
      const updated = { ...task, reference: { knowledge, files }, updatedAt: at };
      // 空にしたら欄ごと消します。空の枠を残すと、記録にも実行の文面にも
      // 「参考はある（中身は空）」として現れます。
      if (!knowledge && files.length === 0) delete updated.reference;
      return updated;
    });
  }
  if (change.remove?.length) {
    const removing = new Set(change.remove);
    next.tasks = next.tasks.filter((task) => !removing.has(task.id));
  }
  if (change.clearFocus) next.focus = null;
  return pruneTasks(next);
}

/** 「特にしてほしいこと」。長すぎるものは受け付けません。 */
export function normalizeAutoTaskInstructions(value, source = 'autoTasksInstructions') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${source} は文字列で指定してください: ${JSON.stringify(value)}`);
  const instructions = value.trim();
  if (instructions.length > MAX_AUTO_TASK_INSTRUCTIONS_CHARS) {
    throw new Error(`${source} が長すぎます（${MAX_AUTO_TASK_INSTRUCTIONS_CHARS}文字まで）`);
  }
  return instructions;
}

/**
 * 「対象の人」。書くと、その人がやることだけをタスクとして起こします。
 *
 * 会議の文字起こしからタスクを起こすと、その場にいた全員のやることが並びます。
 * 一覧が長くなるだけでなく、他の人が引き受けた仕事まで「確認待ち」として自分の画面に
 * 積み上がるので、自分の番のものを探す作業がもう1つ増えます。
 *
 * 別名は読点・カンマ・スラッシュで区切って並べられます（「田中, 田中太郎, たなか」）。
 * 文字起こしの話者名は表記が揺れるので、1つに決めさせると取りこぼします。
 */
export function normalizeAutoTaskOwner(value, source = 'autoTasksOwner') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${source} は文字列で指定してください: ${JSON.stringify(value)}`);
  const owner = value.trim();
  if (owner.length > MAX_AUTO_TASK_OWNER_CHARS) {
    throw new Error(`${source} が長すぎます（${MAX_AUTO_TASK_OWNER_CHARS}文字まで）`);
  }
  return owner;
}

/** 「対象の人」を、突き合わせに使う名前の並びへほどきます。 */
export function taskOwnerNames(owner) {
  return String(owner || '')
    .split(/[,、\/／]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * このタスクの担当が「対象の人」かどうか。
 *
 * 担当が書かれていないタスクは通します。文字起こしは担当を言わないまま「これ調べておいて」で
 * 進むことが多く、書かれていないものを落とすと、肝心の「あなたがやること」が消えます。
 * 書かれていて、それが対象の人でないときだけ落とします。
 *
 * 突き合わせは、空白を取り除いた上での部分一致です。「田中さん」「田中（運用）」のような
 * 書かれ方をどれも同じ人として読むためで、完全一致にすると敬称ひとつで外れます。
 */
export function matchesTaskOwner(taskOwner, owner) {
  const names = taskOwnerNames(owner);
  if (names.length === 0) return true;
  const actual = ownerKey(taskOwner);
  if (!actual) return true;
  return names.some((name) => {
    const key = ownerKey(name);
    return key && (actual.includes(key) || key.includes(actual));
  });
}

function ownerKey(value) {
  return String(value || '').replace(/[\s　]+/g, '').toLowerCase();
}

/** 自動化の一覧。配列でもカンマ区切りの文字列でも受け取り、知らない名前は断ります。 */
export function normalizeAutoTaskActions(value, source = 'autoTasksActions') {
  if (value === undefined || value === null) return [...DEFAULT_AUTO_TASK_ACTIONS];
  const entries = Array.isArray(value) ? value : String(value).split(',');
  const actions = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error(`${source} は文字列の配列で指定してください: ${JSON.stringify(entry)}`);
    for (const piece of entry.split(',')) {
      const id = piece.trim();
      if (!id) continue;
      if (!isAutoTaskAction(id)) throw new Error(`${source}: 知らない自動化です: ${id}（使えるもの: ${AUTO_TASK_ACTION_IDS.join(', ')}）`);
      if (!actions.includes(id)) actions.push(id);
    }
  }
  return actions;
}

/** 見守りの間隔（秒）。短すぎる値は、AIへ送る回数が読めなくなるので断ります。 */
export function normalizeAutoTaskInterval(value, source = 'autoTasksInterval') {
  const seconds = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(seconds) || seconds < MIN_AUTO_TASK_INTERVAL_SECONDS || seconds > MAX_AUTO_TASK_INTERVAL_SECONDS) {
    throw new Error(
      `${source} は ${MIN_AUTO_TASK_INTERVAL_SECONDS} から ${MAX_AUTO_TASK_INTERVAL_SECONDS} までの整数（秒）で指定してください: ${value}`
    );
  }
  return seconds;
}

/* ---------------------------------------------------------------- *
 * 何を読ませるか
 * ---------------------------------------------------------------- */

/**
 * 文字起こしかどうか。字幕拡張機能が書いた発言（`captionRecap.js` が読む形）が数件あれば
 * 文字起こしです。`captioned` は「この起動中に字幕が届いたファイル」で、発言の形を見なくても決まります。
 *
 * 文字起こし用のファイル（`transcriptFiles.js`）でなければ、発言の形をしていても資料として
 * 読みます。字幕を書き込めるのがそのファイルだけになった以上、ほかの文書で同じ形が並んでいる
 * のは、資料に会話を引用したときだからです。
 */
export function detectSourceKind(markdown, { captioned = false, transcriptFile = true } = {}) {
  if (!transcriptFile) return 'document';
  if (captioned) return 'transcript';
  return parseCaptionEntries(markdown).length >= CAPTION_ENTRIES_FOR_TRANSCRIPT ? 'transcript' : 'document';
}

/**
 * 今回モデルへ渡す本文を決めます。
 *
 * 前回読んだところまでが変わっていなければ（追記だけなら）、増えた分と、その手前の少しだけを
 * 渡します。文字起こしはこの形で伸びるので、会議のあいだ何度読み直しても、渡す量は増えません。
 * 途中が書き換わっていれば全体を渡し、長すぎれば末尾からの分だけにします。
 *
 * 版（sha256）と長さだけを記録に残すのは、前回の本文そのものを持たなくても
 * 「前回の長さまでを切り取ってハッシュが同じか」で追記かどうかを判定できるからです。
 */
export function sliceTaskSource(markdown, analysis) {
  const whole = String(markdown);
  const revision = hashOf(whole);
  const previousLength = analysis?.length || 0;
  const appended = previousLength > 0
    && whole.length > previousLength
    && hashOf(whole.slice(0, previousLength)) === analysis.revision;
  if (appended) {
    const fresh = whole.slice(previousLength);
    return {
      appended: true,
      recent: whole.slice(Math.max(0, previousLength - TASK_SOURCE_TAIL_CHARS), previousLength),
      text: tail(fresh),
      omitted: Math.max(0, fresh.length - MAX_TASK_SOURCE_CHARS),
      revision,
      length: whole.length
    };
  }
  return {
    appended: false,
    recent: '',
    text: tail(whole),
    omitted: Math.max(0, whole.length - MAX_TASK_SOURCE_CHARS),
    revision,
    length: whole.length
  };
}

/**
 * 見守りが読み直すかどうか。変わっていなければ読みません。追記だけで増え方が小さいときも
 * 待ちます（`MIN_TASK_SOURCE_GROWTH_CHARS`）。ただし前回から `staleAfterMs` 経っていれば、
 * 小さな増え方でも読みます。会議の最後の一言が、いつまでも拾われないのを避けるためです。
 */
export function shouldAnalyze(markdown, analysis, { now = Date.now(), staleAfterMs = Infinity } = {}) {
  const whole = String(markdown);
  if (!whole.trim()) return false;
  if (!analysis) return true;
  const revision = hashOf(whole);
  if (revision === analysis.revision) return false;
  const appended = whole.length > analysis.length && hashOf(whole.slice(0, analysis.length)) === analysis.revision;
  if (!appended) return true;
  if (whole.length - analysis.length >= MIN_TASK_SOURCE_GROWTH_CHARS) return true;
  const analyzedAt = Date.parse(analysis.analyzedAt || '');
  return Number.isFinite(analyzedAt) && now - analyzedAt >= staleAfterMs;
}

/* ---------------------------------------------------------------- *
 * モデルの答えを受け取る
 * ---------------------------------------------------------------- */

/**
 * 抽出の答えを、記録へ重ねます。
 *
 * 新しいタスクは、同じ題名の未着手・確認待ちがあれば足しません（同じ話題を読み直すたびに
 * 増えるのを防ぐためで、完了したものと同じ題名は改めて足します。蒸し返されたのなら、
 * それは新しいタスクです）。既存タスクの状態変更（`updates`）は、整理を任せているときだけ
 * 当てます。今すべきことは、任せているときだけ置き換えます。
 *
 * 「対象の人」（`owner`）を決めているときは、担当が別の人だと書かれたタスクをここで落とします。
 * 頼むのはモデルにも頼んでいます（`prompts/tasks.js`）が、指示だけに任せると、
 * 何かの拍子に混ざった1件がそのまま記録へ残ります。設定は「起こさない」という指定なので、
 * 記録へ入る手前でも同じ線を引きます。
 */
export function applyExtraction(record, answer, source, { organize = true, focus = true, owner = '' } = {}, now = new Date()) {
  const at = now.toISOString();
  const next = { ...record, tasks: [...record.tasks], lastError: null };
  const existingIds = new Set(next.tasks.map((task) => task.id));
  // 重ねないかどうかは、この回の整理を当てる前の一覧で見ます。同じ回に「済んだ」と
  // 「新しく起こす」が同じ題名で来たら、それは同じタスクの言い直しであって新しいタスクではありません。
  const live = new Set(next.tasks
    .filter((task) => ['open', 'running', 'ready'].includes(task.status))
    .map((task) => titleKey(task.title)));

  if (organize) {
    for (const update of answer.updates || []) {
      if (!existingIds.has(update.id)) continue;
      next.tasks = next.tasks.map((task) => (
        task.id === update.id && task.status !== 'running' && task.status !== update.status
          ? { ...task, status: update.status, statusReason: update.reason, updatedAt: at }
          : task
      ));
    }
  }

  for (const task of (answer.tasks || []).slice(0, MAX_NEW_TASKS_PER_RUN)) {
    if (!matchesTaskOwner(task.owner, owner)) continue;
    const key = titleKey(task.title);
    if (live.has(key)) continue;
    live.add(key);
    next.tasks.push({ id: createTaskId(), ...task, status: DEFAULT_TASK_STATUS, source: 'ai', createdAt: at });
  }

  if (focus && answer.focus?.now) {
    next.focus = { now: answer.focus.now, reason: answer.focus.reason, updatedAt: at };
  }
  next.analysis = {
    revision: source.revision,
    length: source.length,
    sourceKind: source.sourceKind,
    analyzedAt: at,
    summary: answer.summary
  };
  return pruneTasks(next);
}

/** 抽出の答えを、受け取れる形に整えます。切り詰めて受け取り、読めないものは落とします。 */
export function readExtractionAnswer(answer) {
  return {
    summary: text(answer?.summary, MAX_SUMMARY_CHARS),
    focus: {
      now: text(answer?.focus?.now, MAX_FOCUS_CHARS),
      reason: text(answer?.focus?.reason, MAX_REASON_CHARS)
    },
    tasks: (Array.isArray(answer?.tasks) ? answer.tasks : [])
      .map((entry) => ({
        title: text(entry?.title, MAX_TASK_TITLE_CHARS),
        detail: text(entry?.detail, MAX_TASK_DETAIL_CHARS),
        kind: isTaskKind(entry?.kind) ? entry.kind : DEFAULT_TASK_KIND,
        priority: isTaskPriority(entry?.priority) ? entry.priority : DEFAULT_TASK_PRIORITY,
        quote: text(entry?.quote, MAX_TASK_QUOTE_CHARS),
        owner: text(entry?.owner, MAX_TASK_OWNER_CHARS)
      }))
      .filter((entry) => entry.title),
    updates: (Array.isArray(answer?.updates) ? answer.updates : [])
      .map((entry) => ({
        id: text(entry?.id, ID_CHARS),
        status: entry?.status,
        reason: text(entry?.reason, MAX_REASON_CHARS)
      }))
      .filter((entry) => entry.id && REVIEWER_TASK_STATUSES.includes(entry.status))
  };
}

/** 実行の答え。本文が長すぎれば末尾を落とし、落としたことを添えます。 */
export function readTaskResult(answer, now = new Date()) {
  const body = typeof answer?.body === 'string' ? answer.body.trim() : '';
  return {
    summary: text(answer?.summary, MAX_SUMMARY_CHARS),
    body: body.slice(0, MAX_TASK_RESULT_CHARS),
    truncated: body.length > MAX_TASK_RESULT_CHARS,
    followUps: stringList(answer?.followUps, MAX_TASK_FOLLOW_UPS, MAX_TASK_TITLE_CHARS),
    questions: stringList(answer?.questions, MAX_TASK_QUESTIONS, MAX_REASON_CHARS),
    completedAt: now.toISOString()
  };
}

/**
 * 実行の結果を記録へ入れます。状態は「確認待ち」です。読んで採るかどうかを決めるのは
 * レビュアーで、結果が生んだ次のタスクは、元のタスクを親として未着手で足します。
 */
export function applyTaskResult(record, taskId, result, now = new Date()) {
  const at = now.toISOString();
  const next = { ...record, tasks: [...record.tasks] };
  const parent = next.tasks.find((task) => task.id === taskId);
  if (!parent) return next;
  next.tasks = next.tasks.map((task) => (
    task.id === taskId ? { ...task, status: 'ready', result, error: undefined, updatedAt: at } : task
  ));
  const live = new Set(next.tasks
    .filter((task) => ['open', 'running', 'ready'].includes(task.status))
    .map((task) => titleKey(task.title)));
  for (const title of result.followUps) {
    if (live.has(titleKey(title))) continue;
    live.add(titleKey(title));
    next.tasks.push({
      id: createTaskId(),
      title,
      detail: `「${parent.title}」の実行から出た次のタスクです。`,
      kind: DEFAULT_TASK_KIND,
      priority: 'later',
      status: DEFAULT_TASK_STATUS,
      source: 'ai',
      quote: '',
      owner: '',
      parentId: taskId,
      createdAt: at
    });
  }
  return pruneTasks(next);
}

/** 実行に失敗したタスク。未着手へ戻し、失敗した理由を残します。次の回でもう一度試せます。 */
export function applyTaskFailure(record, taskId, message, now = new Date()) {
  const at = now.toISOString();
  return {
    ...record,
    tasks: record.tasks.map((task) => (
      task.id === taskId ? { ...task, status: 'open', error: text(message, 600), updatedAt: at } : task
    ))
  };
}

export function markTaskRunning(record, taskId, now = new Date()) {
  const at = now.toISOString();
  return {
    ...record,
    tasks: record.tasks.map((task) => (task.id === taskId ? { ...task, status: 'running', updatedAt: at } : task))
  };
}

/**
 * 次にAIへ実行させるタスク。未着手で、AIが実行できる種類で、その自動化を任せられているもの。
 * 優先度の高い順、同じなら古い順です。
 */
export function runnableTasks(record, actions = DEFAULT_AUTO_TASK_ACTIONS) {
  return record.tasks
    .filter((task) => task.status === 'open' && AUTO_TASK_KIND_IDS.includes(task.kind) && actions.includes(task.kind))
    .sort((a, b) => (
      (TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority])
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    ));
}

/** 画面とレビューMarkdownに出す順。状態は「確認待ち → 未着手 → 実行中 → 完了 → 見送り」。 */
export function sortTasksForDisplay(tasks) {
  const statusOrder = { ready: 0, open: 1, running: 2, done: 3, dismissed: 4 };
  return [...tasks].sort((a, b) => (
    (statusOrder[a.status] - statusOrder[b.status])
    || (TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority])
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  ));
}

export function createTaskId() {
  return `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/* ---------------------------------------------------------------- *
 * 細かいもの
 * ---------------------------------------------------------------- */

/** 上限を超えたら、完了と見送りの古いものから落とします。未着手は落としません。 */
function pruneTasks(record) {
  if (record.tasks.length <= MAX_TASKS_PER_DOCUMENT) return record;
  const finished = record.tasks
    .filter((task) => task.status === 'done' || task.status === 'dismissed')
    .sort((a, b) => String(a.updatedAt || a.createdAt || '').localeCompare(String(b.updatedAt || b.createdAt || '')));
  const dropping = new Set(finished.slice(0, record.tasks.length - MAX_TASKS_PER_DOCUMENT).map((task) => task.id));
  return { ...record, tasks: record.tasks.filter((task) => !dropping.has(task.id)) };
}

function titleKey(title) {
  return String(title).replace(/\s+/g, '').toLowerCase();
}

function tail(value) {
  return value.length > MAX_TASK_SOURCE_CHARS ? value.slice(-MAX_TASK_SOURCE_CHARS) : value;
}

function hashOf(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function stringList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry, maxChars)).filter(Boolean).slice(0, maxItems);
}

function timestamp(value) {
  return typeof value === 'string' ? value.trim().slice(0, TIMESTAMP_CHARS) : '';
}
