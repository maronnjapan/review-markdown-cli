import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_TASK_RUNS_PER_TICK, TASK_SOURCE_STALE_TICKS } from './aiLimits.js';
import {
  applyExtraction,
  applyTaskFailure,
  applyTaskResult,
  listWatchedFiles,
  markTaskRunning,
  readTasks,
  runnableTasks,
  shouldAnalyze,
  updateTasks
} from './autoTasks.js';
import { isTextDocumentPath } from './links.js';

/**
 * 自動タスクの実行係です。一定間隔で見守っている文書を読み直し、変わっていればタスクを
 * 起こし、任せられたものを実行します。
 *
 * ── 何を見守るか ───────────────────────────────────────
 * 2種類あります。画面で「この文書を見守る」を付けた文書（記録の `watch`）と、この起動中に
 * 字幕が届いた文書（`noteActivity`）です。後者を自動で入れるのは、会議中に「見守る」を
 * 押しに行く手間を無くすためで、字幕が止まってから一定時間で外します。
 *
 * ── いつAIへ送るか ─────────────────────────────────────
 * 変わっていなければ送りません。追記だけで増え方が小さいときも待ちます
 * （`autoTasks.js` の `shouldAnalyze`）。見守りの間隔は設定で、毎回の見守りで読み直す
 * ので、画面の「設定」で切った直後の回から何も送らなくなります。
 *
 * ── 1度に1つ ─────────────────────────────────────────
 * AIへの依頼は1本の列に並べます（`enqueue`）。画面の「タスクを整理する」と裏の見守りが
 * 同じ文書へ同時に走ると、同じ増えた分から同じタスクが2度起こされるからです。
 *
 * ── 失敗しても止まらない ─────────────────────────────────
 * 1つの文書で失敗しても、他の文書の見守りは続けます。失敗は記録の `lastError` と
 * ターミナルのログに残し、次の回でもう一度試します。
 */

/** 字幕が届いたファイルを見守り続ける時間。これを過ぎて何も届かなければ外します。 */
const ACTIVITY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {string} options.rootDir レビュー対象ディレクトリの絶対パス。
 * @param {object} options.aiService `extractTasks` と `performTask` を持つもの。
 * @param {object} options.settings `autoTasks` を返すもの（`settings.js` の `createSettings`）。
 * @param {object} [options.transcripts] 文字起こしに使える範囲（`transcriptFiles.js`）。
 *   文字起こしとして読むかどうかだけに使います。見守る対象を絞るのには使いません。
 * @param {Function} [options.log] ターミナルへの1行。裏で何をしたかは、画面を見ていない人にも見せます。
 * @param {Function} [options.now] 現在時刻（ミリ秒）。テストで差し替えます。
 * @param {Function} [options.setTimer] / [options.clearTimer] タイマー。テストで差し替えます。
 */
export function createAutoTaskRunner({
  rootDir,
  aiService,
  settings,
  transcripts = { matches: () => true },
  log = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  /** 字幕が届いたファイル → 最後に届いた時刻。 */
  const activity = new Map();
  /** いまAIに読ませている文書。同じ文書を重ねて走らせないための印です。 */
  const running = new Set();
  let timer = null;
  let stopped = true;
  let lastTickAt = null;
  let nextTickAt = null;
  let queue = Promise.resolve();

  function start() {
    stopped = false;
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    nextTickAt = null;
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    const delay = intervalMs();
    nextTickAt = now() + delay;
    timer = setTimer(() => {
      timer = null;
      tick()
        .catch((error) => log(`[自動タスク] 見守りに失敗しました: ${error.message}`))
        .finally(schedule);
    }, delay);
    // 見守りのタイマーがプロセスを生かし続けないようにします。サーバーが閉じたら一緒に終わります。
    timer?.unref?.();
  }

  function intervalMs() {
    return settings.autoTasks.intervalSeconds * 1000;
  }

  /** 字幕が届いた。次の見守りからこの文書も読み直します。 */
  function noteActivity(relativeFile) {
    activity.set(relativeFile, now());
  }

  async function watchedFiles() {
    const files = new Set(await listWatchedFiles(rootDir));
    for (const [file, at] of activity) {
      if (now() - at > ACTIVITY_TTL_MS) activity.delete(file);
      else files.add(file);
    }
    return [...files].filter(isTextDocumentPath).sort((a, b) => a.localeCompare(b));
  }

  /**
   * 見守りの1回。有効でなければ何もしません（有効かどうかは毎回読み直します）。
   * @returns {Promise<{ran: string[]}>} 今回AIへ送った文書。
   */
  async function tick() {
    lastTickAt = now();
    if (!settings.autoTasks.enabled) return { ran: [] };
    const ran = [];
    for (const file of await watchedFiles()) {
      if (running.has(file)) continue;
      try {
        const result = await analyze(file);
        if (!result.skipped) ran.push(file);
      } catch (error) {
        // 1つの文書の失敗で、他の文書の見守りを止めません。理由は記録とログに残っています。
        if (error?.code === 'ENOENT') activity.delete(file);
      }
    }
    return { ran };
  }

  /**
   * 1つの文書を読み直し、変わっていればタスクを起こし、任せられたものを実行します。
   *
   * @param {string} relativeFile
   * @param {object} [options]
   * @param {boolean} [options.force] 変わっていなくても読み直す（画面の「タスクを整理する」）。
   * @param {AbortSignal} [options.signal] 中断の合図。画面からの実行だけが渡します。
   * @param {Function} [options.onDelta] 届いた差分の渡し先。
   * @param {Function} [options.onPhase] いま何をしているか（`extracting` / `performing:<題名>`）。
   */
  function analyze(relativeFile, { force = false, signal, onDelta, onPhase = () => {} } = {}) {
    return enqueue(async () => {
      const markdown = await fs.readFile(path.join(rootDir, relativeFile), 'utf8');
      let record = await readTasks(rootDir, relativeFile);
      const staleAfterMs = intervalMs() * TASK_SOURCE_STALE_TICKS;
      if (!force && !shouldAnalyze(markdown, record.analysis, { now: now(), staleAfterMs })) {
        return { skipped: true, record, added: 0, performed: 0 };
      }
      if (!markdown.trim()) throw new Error('タスクを起こせる本文がありません');

      const options = settings.autoTasks;
      running.add(relativeFile);
      try {
        onPhase('extracting');
        const { answer, source } = await aiService.extractTasks(relativeFile, {
          record,
          actions: options.actions,
          instructions: options.instructions,
          owner: options.owner,
          captioned: activity.has(relativeFile),
          transcriptFile: transcripts.matches(relativeFile)
        }, { signal, onDelta });
        const before = record.tasks.length;
        record = await updateTasks(rootDir, relativeFile, (current) => applyExtraction(current, answer, source, {
          organize: options.actions.includes('organize'),
          focus: options.actions.includes('focus'),
          owner: options.owner
        }, new Date(now())));
        const added = Math.max(0, record.tasks.length - before);
        log(`[自動タスク] ${relativeFile}: タスクを${added}件起こしました${answer.updates.length ? `（${answer.updates.length}件を整理）` : ''}`);

        let performed = 0;
        for (const task of runnableTasks(record, options.actions).slice(0, MAX_TASK_RUNS_PER_TICK)) {
          if (signal?.aborted) break;
          onPhase(`performing:${task.title}`);
          record = await performOne(relativeFile, task.id, { signal, onDelta, instructions: options.instructions });
          performed += 1;
        }
        return { skipped: false, record, added, performed };
      } catch (error) {
        if (error?.name !== 'AbortError') {
          await updateTasks(rootDir, relativeFile, (current) => ({
            ...current,
            lastError: { message: error.message, at: new Date(now()).toISOString() }
          })).catch(() => {});
          log(`[自動タスク] ${relativeFile}: 失敗しました: ${error.message}`);
        }
        throw error;
      } finally {
        running.delete(relativeFile);
      }
    });
  }

  /**
   * タスクを1つ実行します。失敗しても投げません（中断だけは投げます）。
   * 失敗は未着手へ戻して理由を残すので、次の見守りでもう一度試せます。
   */
  async function performOne(relativeFile, taskId, { signal, onDelta, instructions } = {}) {
    let record = await updateTasks(rootDir, relativeFile, (current) => markTaskRunning(current, taskId, new Date(now())));
    const task = record.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error('タスクが見つかりません');
    try {
      const result = await aiService.performTask(relativeFile, task, { instructions }, { signal, onDelta });
      record = await updateTasks(rootDir, relativeFile, (current) => applyTaskResult(current, taskId, result, new Date(now())));
      log(`[自動タスク] ${relativeFile}: 「${task.title}」を実行しました（確認待ち）`);
      return record;
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      record = await updateTasks(rootDir, relativeFile, (current) => (
        applyTaskFailure(current, taskId, aborted ? '' : error.message, new Date(now()))
      ));
      if (aborted) throw error;
      log(`[自動タスク] ${relativeFile}: 「${task.title}」を実行できませんでした: ${error.message}`);
      return record;
    }
  }

  /** 画面の「タスクを整理する」。変わっていなくても読み直します。 */
  async function runNow(relativeFile, options = {}) {
    const { record } = await analyze(relativeFile, { ...options, force: true });
    return record;
  }

  /**
   * 画面の「実行」。種類は問いません。人がやる種類のタスクでも、頼まれれば段取りを書きます。
   * 実行できるのは未着手と確認待ちだけです。実行中のものを重ねて走らせません。
   */
  function runTask(relativeFile, taskId, { signal, onDelta } = {}) {
    return enqueue(async () => {
      const record = await readTasks(rootDir, relativeFile);
      const task = record.tasks.find((entry) => entry.id === taskId);
      if (!task) throw new Error('タスクが見つかりません');
      if (!['open', 'ready'].includes(task.status)) throw new Error('未着手か確認待ちのタスクだけを実行できます');
      running.add(relativeFile);
      try {
        return await performOne(relativeFile, taskId, { signal, onDelta, instructions: settings.autoTasks.instructions });
      } finally {
        running.delete(relativeFile);
      }
    });
  }

  /** 画面へ出す、この文書についての見守りの状態。 */
  function status(relativeFile, record = null) {
    const { enabled, intervalSeconds, actions, owner } = settings.autoTasks;
    return {
      enabled,
      intervalSeconds,
      actions: [...actions],
      // 誰のタスクを起こしているのかは、一覧を読む前に分かる必要があります。絞っていることを
      // 画面に出さないと、他の人のタスクが「起こされなかった」のか「起こせなかった」のかを
      // 見分けられません。
      owner,
      captioned: activity.has(relativeFile),
      watching: enabled && (activity.has(relativeFile) || record?.watch === true),
      running: running.has(relativeFile),
      lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
      nextTickAt: enabled && nextTickAt ? new Date(nextTickAt).toISOString() : null
    };
  }

  /** AIへの依頼を1本の列に並べます。前の依頼が失敗していても、次は走ります。 */
  function enqueue(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  }

  return { start, stop, tick, analyze, runNow, runTask, noteActivity, status, watchedFiles };
}
