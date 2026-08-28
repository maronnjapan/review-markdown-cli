import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import readline from 'node:readline';

/**
 * `codex app-server` との通信そのものです。JSON-RPC を1行1メッセージで標準入出力へ流します。
 *
 * ここが知っているのは「要求を送って応答を待つ」「通知を受け取って渡す」ことだけで、
 * スレッドもターンもモデルも知りません。それらは `codexAppServer.js` の仕事です。
 * 分けてあるのは、レビューの読み方を調整する人が、プロセスの起動や行の切り出しを
 * 読まずに済むようにするためです。
 */

/** 保っておく標準エラー出力の長さ。落ちた理由を添えるためだけに使います。 */
const STDERR_KEEP_CHARS = 8_000;

export class CodexRpc {
  /**
   * @param {object} options
   * @param {string} [options.command] 起動するコマンド。テスト以外で変えることはありません。
   * @param {string} options.runtimeDir Codexの作業ディレクトリ。
   * @param {Function} [options.spawnProcess] テストで差し替えるためのプロセス起動関数。
   * @param {number} options.timeoutMs 1要求あたりの待ち時間。
   * @param {Function} options.onNotification 応答ではない通知（ストリームなど）の受け取り先。
   * @param {Function} options.onFailure プロセスが落ちたときに呼ばれます。
   * @param {Function} options.isIdle 待っている仕事が他に無いか。閉じた後の終了通知を、
   *   失敗として扱わないために使います。
   */
  constructor({
    command = 'codex', runtimeDir, spawnProcess = spawn, timeoutMs,
    onNotification, onFailure, isIdle = () => true
  }) {
    this.command = command;
    this.runtimeDir = runtimeDir;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.onNotification = onNotification;
    this.onFailure = onFailure;
    this.isIdle = isIdle;
    this.process = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.stderr = '';
  }

  get running() {
    return Boolean(this.process?.stdin?.writable);
  }

  /** プロセスを起動して、応答の受け取りを始めます。initialize までは呼び出し側の仕事です。 */
  async spawn() {
    await fs.mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const child = this.spawnProcess(this.command, ['app-server', '--listen', 'stdio://'], {
      cwd: this.runtimeDir,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_KEEP_CHARS);
    });
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(new Error(`Codex App Server stopped (${signal || (code ?? 'unknown')})`));
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
  }

  request(method, params = {}) {
    if (!this.running) return Promise.reject(new Error('Codex App Server is not running'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, { method, resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    if (!this.running) throw new Error('Codex App Server is not running');
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  /** 向こうから来た要求を断ります。ツールも対話も、この経路では受けません。 */
  refuse(message, reason) {
    this.process?.stdin?.write(`${JSON.stringify({
      id: message.id,
      error: { code: -32601, message: reason }
    })}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // method と id の両方があるのは、向こうからの要求です。
    if (message.method && message.id !== undefined) {
      this.onNotification(message, { serverRequest: true });
      return;
    }
    if (message.id !== undefined) {
      this.settle(message);
      return;
    }
    this.onNotification(message, { serverRequest: false });
  }

  settle(message) {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || `Codex request failed: ${pending.method}`));
    else pending.resolve(message.result || {});
  }

  /**
   * プロセスが落ちたときに、待っている要求すべてを同じ理由で失敗させます。
   * 標準エラー出力を添えるのは、「終了しました」だけでは何も直せないからです。
   */
  handleExit(error) {
    // 閉じた後に届く終了通知には、知らせる相手がいません。
    if (!this.process && this.pendingRequests.size === 0 && this.isIdle()) return;
    const detail = this.stderr.trim();
    const failure = new Error(detail ? `${error.message}: ${detail}` : error.message);
    this.process = null;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pendingRequests.clear();
    this.onFailure(failure);
  }

  close() {
    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
  }
}
