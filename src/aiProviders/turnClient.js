import crypto from 'node:crypto';
import { PURPOSES, baseInstructions, developerInstructions } from '../prompts/codexRole.js';

/**
 * Codex以外のAIを、Codexと同じ形で扱うための土台です。
 *
 * `AiService` が相手に求めるのは6つだけです。起動して、スレッドを開いて、1ターン投げて、
 * 答えを受け取って、スレッドを畳んで、閉じる。Codexはこれをサーバー側の状態として持って
 * いますが、APIを1回叩くだけのAIは何も覚えていません。そこで、やり取りの記録をこちら側で
 * 持ち、毎ターン最初から渡し直します。外から見た振る舞いは `codexAppServer.js` と同じです。
 *
 * 継ぎ足すのは `complete()` だけです。渡されたやり取りを1回投げて、本文を返してください。
 * スレッドの管理も、用途ごとのモデル選びも、中断も、ここが引き受けます。
 */

/**
 * 覚えておくスレッドの数。超えたぶんは古い順に捨てます。
 *
 * 翻訳もレビューも使い捨てのスレッドを開くので、放っておくと1セッションのあいだ増え続け
 * ます。捨てられたスレッドで続きを聞かれたら、開き直して1回目としてやり直すだけなので
 * （`AiService.openConversationThread`）、失うのは会話の続きだけです。
 */
const MAX_THREADS = 50;

export class TurnClient {
  /**
   * @param {object} options
   * @param {string} options.provider 設定ファイルの `aiProvider` に書く名前。
   * @param {object} options.defaults 用途ごとの既定 `{ assistant: {model, effort}, review: {…} }`。
   * @param {object} [options.models] 設定ファイル由来の指定。書いてある用途だけ既定を上書きします。
   */
  constructor({ provider, defaults, models = {} }) {
    this.provider = provider;
    this.profiles = resolveProfiles(provider, defaults, models);
    /** スレッドID -> `{ purpose, messages }`。使うたびに入れ直すので、末尾ほど新しくなります。 */
    this.threads = new Map();
    /** 返事を作っている最中のスレッド。同じスレッドへ二重に投げないための印です。 */
    this.running = new Set();
    this.startPromise = null;
  }

  get model() {
    return this.profiles.assistant.model;
  }

  get effort() {
    return this.profiles.assistant.effort;
  }

  get reviewModel() {
    return this.profiles.review.model;
  }

  get reviewEffort() {
    return this.profiles.review.effort;
  }

  /** 用途に対応するモデルと推論強度。知らない用途は速い方で読みます。 */
  profileFor(purpose) {
    return this.profiles[purpose] || this.profiles.assistant;
  }

  /**
   * 接続の用意。`connect()` を一度だけ呼び、失敗したら次の呼び出しでやり直します。
   * 鍵を入れ直したら次の操作から通る、という直し方ができるようにするためです。
   */
  async start() {
    if (!this.startPromise) {
      this.startPromise = Promise.resolve(this.connect()).catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    return this.startPromise;
  }

  /** 相手側の用意。SDKの読み込みなど、1度で済むものだけを書きます。 */
  async connect() {}

  /**
   * スレッドID。会話のIDは端末に保存され、アプリを立ち上げ直しても残ります。連番にすると、
   * 立ち上げ直したあとに別の用途で開いたスレッドが同じIDを取り、保存済みの会話がそちらへ
   * 繋がってしまいます。そこで、二度と同じものが出ないIDを使います。
   */
  async createThread({ purpose = 'assistant' } = {}) {
    await this.start();
    const threadId = `${this.provider}-${crypto.randomUUID()}`;
    this.remember(threadId, { purpose, messages: [] });
    return threadId;
  }

  /**
   * 覚えているスレッドだけ再開できます。捨てたスレッドは投げて知らせます。
   * 黙って新しいスレッドを返すと、前のやり取りを覚えている前提で続きが飛んできます。
   */
  async resumeThread(threadId) {
    await this.start();
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`会話の記録が残っていません: ${threadId}`);
    this.remember(threadId, thread);
    return threadId;
  }

  async deleteThread(threadId) {
    this.threads.delete(threadId);
  }

  /**
   * 1ターン投げて、答えを受け取ります。
   *
   * 質問と答えはスレッドへ足していきます。次のターンでは、それをまとめて渡し直すので、
   * 相手が何も覚えていなくても会話が続きます。答えを受け取れなかったターンは足しません。
   */
  async runTurn({ threadId, prompt, outputSchema, onDelta = () => {}, signal } = {}) {
    await this.start();
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`会話の記録が残っていません: ${threadId}`);
    if (this.running.has(threadId)) throw new Error('この会話では既に回答を生成中です');

    this.running.add(threadId);
    try {
      if (signal?.aborted) throw abortError();
      const messages = [...thread.messages, { role: 'user', content: prompt }];
      const text = await this.complete({
        system: systemPrompt(thread.purpose),
        messages,
        profile: this.profileFor(thread.purpose),
        outputSchema: outputSchema || null,
        onDelta,
        signal
      });
      // 空の答えはやり取りへ足しません。足すと、次のターンで中身の無い発言を渡し直すことに
      // なり、それを受け付けないAIではその会話が二度と続かなくなります。
      if (text) {
        thread.messages = [...messages, { role: 'assistant', content: text }];
        this.remember(threadId, thread);
      }
      return { text };
    } catch (error) {
      throw signal?.aborted ? abortError() : error;
    } finally {
      this.running.delete(threadId);
    }
  }

  /**
   * 1ターン分の問い合わせ。継いだ側が実装します。
   *
   * @param {object} turn
   * @param {string} turn.system モデルに与える立場。用途ごとに変わります。
   * @param {Array<{role: 'user'|'assistant', content: string}>} turn.messages 最初からのやり取り。
   * @param {{model: string, effort: string|undefined}} turn.profile 使うモデルと推論強度。
   * @param {object|null} turn.outputSchema 答えを縛るJSONスキーマ。無いときは null。
   * @param {Function} turn.onDelta 届いた差分の渡し先。画面へ流すために使います。
   * @param {AbortSignal} [turn.signal] 中断の合図。
   * @returns {Promise<string>} 答えの本文。
   */
  async complete() {
    throw new Error(`${this.provider} は1ターンの問い合わせを実装していません`);
  }

  async close() {
    this.threads.clear();
    this.running.clear();
    this.startPromise = null;
  }

  /** 使ったスレッドを末尾へ入れ直し、あふれたぶんを古い順に捨てます。 */
  remember(threadId, thread) {
    this.threads.delete(threadId);
    this.threads.set(threadId, thread);
    for (const id of this.threads.keys()) {
      if (this.threads.size <= MAX_THREADS) break;
      if (!this.running.has(id)) this.threads.delete(id);
    }
  }
}

/** モデルへ渡す立場。Codexへ渡しているものと同じ文面を、systemプロンプトとして渡します。 */
export function systemPrompt(purpose = 'assistant') {
  return `${baseInstructions(purpose)}\n\n${developerInstructions(purpose)}`;
}

/**
 * 用途ごとのモデルと推論強度。設定ファイルに書いた用途だけ、既定から差し替えます。
 *
 * モデルを名指しできないAIは既定を持てないので、その用途は設定が要ります。
 * 黙って別のモデルへ落とさないのは `codexProfiles.js` と同じです。
 */
export function resolveProfiles(provider, defaults = {}, overrides = {}) {
  const profiles = {};
  for (const purpose of PURPOSES) {
    const override = overrides[purpose] || {};
    const model = override.model || defaults[purpose]?.model;
    if (!model) {
      throw new Error(
        `${provider} で使うモデルが決まっていません。設定ファイルの `
        + `${purpose === 'review' ? 'aiReviewModel' : 'aiModel'} にモデル名を書いてください`
      );
    }
    profiles[purpose] = { model, effort: override.effort || defaults[purpose]?.effort };
  }
  return profiles;
}

export function abortError() {
  return Object.assign(new Error('生成を中止しました'), { name: 'AbortError' });
}

/**
 * 使いたいパッケージを、必要になったときだけ読み込みます。
 *
 * どのAIを使うかは設定次第なので、選ばなかったAIのSDKまで入れさせません。
 * 入っていないときは、何を入れればよいかまで書いて止めます。
 */
export async function loadOptional(specifier, packageName) {
  try {
    return await import(specifier);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error(`${packageName} が見つかりません。\`npm install ${packageName}\` を実行してください`);
  }
}
