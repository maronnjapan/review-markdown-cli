import { DEFAULT_TIMEOUT_MS, MODEL_LIST_QUERY, selectProfiles } from './codexProfiles.js';
import { CodexRpc } from './codexRpc.js';
import { baseInstructions, developerInstructions } from './prompts/codexRole.js';

/**
 * Codexのスレッドとターンを扱います。読み取り専用に閉じ込めたうえで、
 * 1ターン投げて答えを受け取るところまでが仕事です。
 *
 * 通信そのものは `codexRpc.js`、どのモデルで読ませるかは `codexProfiles.js`、
 * モデルに与える立場は `prompts/codexRole.js` にあります。
 *
 * ── 緩めてはいけないもの ────────────────────────────────────
 * 下の2つの方針と `SAFE_ITEM_TYPES` は調整つまみではありません。このアプリがCodexへ
 * 許しているのは「読んで答える」ことだけで、ツールの実行もネットワークも許していません。
 * モデルがそれ以外を始めたら、ターンごと失敗させて中断します。
 */

/** スレッドを開くときの方針。承認を求めない代わりに、できることを読み取りだけにします。 */
const THREAD_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'read-only',
  personality: 'none'
};

/** ターンを回すときの方針。ファイルは読み取りのみ、ネットワークは遮断します。 */
const TURN_POLICY = {
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'readOnly', networkAccess: false },
  summary: 'none',
  personality: 'none'
};

/** モデルが出してよいものの一覧。ここに無い種類が出たら、そのターンは失敗にします。 */
const SAFE_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan']);

const CLIENT_INFO = { name: 'review_markdown', title: 'Markdown Review', version: '0.1.0' };
const SERVICE_NAME = 'review_markdown';

/**
 * Codexが返した失敗を、レビュアーが次に何をすればよいか分かる日本語にします。
 * 上から順に当てて、最初に一致したものを使います。
 */
const ERROR_HINTS = [
  [/not found|ENOENT/i, 'Codexコマンドが見つかりません'],
  [/unauthorized|login|authentication/i, 'Codexへログインしてください'],
  [/usageLimit|usage limit/i, 'Codexの利用上限に達しました']
];

export class CodexAppServer {
  /**
   * @param {object} options
   * @param {string} options.runtimeDir Codexの作業ディレクトリ。
   * @param {object} [options.models] 用途ごとのモデル指定。設定ファイル由来の
   *   `{ assistant: { model, effort }, review: { model, effort } }`。省略すれば自動で選びます。
   */
  constructor({ command = 'codex', runtimeDir, spawnProcess, models = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    /** 設定ファイルの `aiProvider` に書く名前。画面と起動ログはこれで相手を呼びます。 */
    this.provider = 'codex';
    this.modelOverrides = models;
    this.startPromise = null;
    this.started = false;
    this.turns = new Map();
    this.loadedThreads = new Set();
    /** スレッドごとの用途。ターンを開始するとき、同じ用途のモデルへ戻すために持ちます。 */
    this.threadPurposes = new Map();
    /**
     * 用途ごとに読み方が違うので、モデルも分けます。model / effort は速い方で、
     * status() が画面へ報告するのもこれです。
     */
    this.profiles = null;

    this.rpc = new CodexRpc({
      command,
      runtimeDir,
      spawnProcess,
      timeoutMs,
      onNotification: (message, { serverRequest }) => (
        serverRequest ? this.rejectServerRequest(message) : this.handleNotification(message)
      ),
      onFailure: (failure) => this.failEverything(failure),
      isIdle: () => this.turns.size === 0
    });
  }

  get runtimeDir() {
    return this.rpc.runtimeDir;
  }

  get model() {
    return this.profiles?.assistant.model ?? null;
  }

  get effort() {
    return this.profiles?.assistant.effort ?? null;
  }

  get reviewModel() {
    return this.profiles?.review.model ?? null;
  }

  get reviewEffort() {
    return this.profiles?.review.effort ?? null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.started) return;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
      this.started = true;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    await this.rpc.spawn();
    try {
      await this.rpc.request('initialize', { clientInfo: CLIENT_INFO });
      this.rpc.notify('initialized', {});
      const response = await this.rpc.request('model/list', MODEL_LIST_QUERY);
      this.profiles = selectProfiles(response.data, this.modelOverrides);
    } catch (error) {
      // 起動しきれなかったプロセスは残しません。残すと、次に start() を呼んだときに
      // 「モデルを選べていないのに起動済み」の状態から続けることになります。
      this.rpc.close();
      throw error;
    }
  }

  /** 用途に対応するモデルと推論強度。知らない用途は速い方で読みます。 */
  profileFor(purpose) {
    return this.profiles?.[purpose] || this.profiles?.assistant || {};
  }

  /**
   * `purpose` は何を読ませるスレッドかです。モデルと、モデルへ渡す立場の説明が
   * これで決まります。既定は翻訳・チャットの 'assistant'、レビューは 'review'。
   */
  async createThread({ ephemeral = false, purpose = 'assistant' } = {}) {
    await this.start();
    const result = await this.rpc.request('thread/start', {
      ...THREAD_POLICY,
      model: this.profileFor(purpose).model,
      cwd: this.runtimeDir,
      ephemeral,
      serviceName: SERVICE_NAME,
      baseInstructions: baseInstructions(purpose),
      developerInstructions: developerInstructions(purpose)
    });
    const threadId = result.thread?.id;
    if (!threadId) throw new Error('Codexスレッドを開始できませんでした');
    this.loadedThreads.add(threadId);
    this.threadPurposes.set(threadId, purpose);
    return threadId;
  }

  async resumeThread(threadId) {
    await this.start();
    if (this.loadedThreads.has(threadId)) return threadId;
    const result = await this.rpc.request('thread/resume', {
      ...THREAD_POLICY,
      threadId,
      cwd: this.runtimeDir,
      baseInstructions: baseInstructions(),
      developerInstructions: developerInstructions()
    });
    const resumedId = result.thread?.id;
    if (!resumedId) throw new Error('Codexスレッドを再開できませんでした');
    this.loadedThreads.add(resumedId);
    // 再開できるのは保存する会話だけなので、用途はチャットです。
    this.threadPurposes.set(resumedId, 'assistant');
    return resumedId;
  }

  async deleteThread(threadId) {
    if (!threadId) return;
    await this.start();
    try {
      await this.rpc.request('thread/delete', { threadId });
    } finally {
      this.loadedThreads.delete(threadId);
      this.threadPurposes.delete(threadId);
    }
  }

  async runTurn({ threadId, prompt, outputSchema, onDelta = () => {}, signal } = {}) {
    await this.start();
    if (this.turns.has(threadId)) throw new Error('この会話では既に回答を生成中です');

    const collector = createCollector(threadId, onDelta);
    this.turns.set(threadId, collector);

    const abort = () => {
      collector.aborted = true;
      if (collector.turnId) this.interrupt(threadId, collector.turnId).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      if (signal?.aborted) throw abortError();
      // スレッドを開いたときの用途でターンも回します。1つのスレッドの途中で
      // モデルが入れ替わると、前のターンの読みを引き継げなくなるからです。
      const { model, effort } = this.profileFor(this.threadPurposes.get(threadId));
      const result = await this.rpc.request('turn/start', {
        ...TURN_POLICY,
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: this.runtimeDir,
        model,
        effort,
        outputSchema: outputSchema || undefined
      });
      collector.turnId = result.turn?.id;
      if (!collector.turnId) throw new Error('Codexターンを開始できませんでした');
      if (collector.aborted) await this.interrupt(threadId, collector.turnId);
      return await collector.done;
    } catch (error) {
      if (this.turns.get(threadId) === collector) this.turns.delete(threadId);
      throw signal?.aborted ? abortError() : error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async interrupt(threadId, turnId) {
    await this.rpc.request('turn/interrupt', { threadId, turnId });
  }

  handleNotification(message) {
    const params = message.params || {};
    const collector = this.turns.get(params.threadId);
    if (!collector) return;

    if (message.method === 'item/started' || message.method === 'item/completed') {
      this.assertSafeItem(collector, params.item?.type);
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      collector.text += params.delta || '';
      collector.onDelta(params.delta || '');
      return;
    }
    if (message.method === 'turn/completed') this.completeTurn(collector, params.turn);
  }

  /** モデルがツールを使い始めたら、そのターンごと失敗させて中断します。 */
  assertSafeItem(collector, itemType) {
    if (!itemType || SAFE_ITEM_TYPES.has(itemType)) return;
    this.failTurn(collector, new Error(`Codexのツール実行を拒否しました: ${itemType}`));
    if (collector.turnId) this.interrupt(collector.threadId, collector.turnId).catch(() => {});
  }

  completeTurn(collector, turn) {
    this.turns.delete(collector.threadId);
    const status = turn?.status;
    if (collector.aborted || status === 'interrupted') {
      collector.reject(abortError());
      return;
    }
    if (status !== 'completed') {
      collector.reject(new Error(turn?.error?.message || `Codex turn failed: ${status || 'unknown'}`));
      return;
    }
    // 締めのメッセージがあればそれを、途中経過しか無ければ集めた分を答えにします。
    const finalMessage = [...(turn?.items || [])].reverse()
      .find((item) => item.type === 'agentMessage')?.text;
    collector.resolve({ text: finalMessage || collector.text, turnId: turn.id });
  }

  rejectServerRequest(message) {
    this.rpc.refuse(message, 'Tools and interactive requests are disabled');
    const collector = this.turns.get(message.params?.threadId);
    if (collector) this.failTurn(collector, new Error('Codexのツール要求を拒否しました'));
  }

  failTurn(collector, error) {
    if (this.turns.get(collector.threadId) !== collector) return;
    this.turns.delete(collector.threadId);
    collector.reject(error);
  }

  /** プロセスが落ちたら、待っているターンをすべて同じ理由で失敗させます。 */
  failEverything(failure) {
    this.started = false;
    this.loadedThreads.clear();
    this.threadPurposes.clear();
    for (const collector of this.turns.values()) collector.reject(failure);
    this.turns.clear();
  }

  async close() {
    this.started = false;
    this.rpc.close();
  }

  describeError(error) {
    const message = String(error?.message || error);
    return ERROR_HINTS.find(([pattern]) => pattern.test(message))?.[1] || message;
  }
}

/** 1ターン分の受け皿。届いた差分を貯めながら、完了か失敗を待ちます。 */
function createCollector(threadId, onDelta) {
  let resolve;
  let reject;
  const done = new Promise((onDone, onFail) => {
    resolve = onDone;
    reject = onFail;
  });
  return { threadId, turnId: null, text: '', aborted: false, onDelta, done, resolve, reject };
}

function abortError() {
  return Object.assign(new Error('生成を中止しました'), { name: 'AbortError' });
}
