/**
 * ChromaDBを、npmパッケージ（`chromadb`）から立ち上げる口です。
 *
 * ── Dockerなしで既定の索引を使えるようにする理由 ──────────────
 * 既定の索引はChromaDBで、これまでは `docker compose up` が一緒に立ち上げていました。
 * Dockerを入れていない端末では、索引を1ファイルの `local` に替えるしかなく、既定と違う
 * 索引で試すことになります。`chromadb` のnpmパッケージはChroma本体（Rust製のサーバ）を
 * 同梱していて、`chroma run` で動かせます。`npm install` だけで既定の索引が揃うので、
 * ここから子プロセスとして立ち上げます（`CHROMA_SERVER=npm`）。
 *
 * ── 子プロセスにする理由 ────────────────────────────────
 * パッケージのサーバは同じNodeのプロセスの中でも動かせますが、戻ってこない呼び出しで、
 * 止める手段が `process.exit` しかありません。別のプロセスにしておけば、このサービスの
 * 終了時に止められ、先に落ちたときにも「索引が落ちた」と分かります。
 *
 * ── 止め方 ──────────────────────────────────────────
 * SIGINTで止めます。SIGTERMだと、Chromaは「shutting down」と言ったまま終わりません
 * （3.5.0で確認）。SIGINTでも数秒待って終わらなければSIGKILLを送ります。書き込みは
 * 要求ごとにSQLiteへ入っているので、強制終了で失われるものはありません。
 *
 * ── 失敗の読み方 ──────────────────────────────────────
 * ポートが塞がっていても終了コードは0です（3.5.0で確認）。理由はstderrに出るので、
 * 「心拍が返る前に終わった」ことと、stderrの末尾で失敗を伝えます。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DEFAULT_ENDPOINT } from './vectorStores/chroma.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const HEARTBEAT_TIMEOUT_MS = 2_000;
const STDERR_TAIL_LINES = 20;

/**
 * `chromadb` パッケージに同梱されたCLI（`chroma`）の場所と版。
 *
 * `chromadb/package.json` は `exports` で閉じていて直接は引けないので、本体の置き場所から
 * パッケージの根（`package.json` の `name` が `chromadb` のディレクトリ）まで遡ります。
 */
export function resolveChromaCli({ from = import.meta.url } = {}) {
  const require = createRequire(from);
  let entry;
  try {
    entry = require.resolve('chromadb');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error('chromadb パッケージが入っていません。context-api で npm install を実行してください');
  }
  let dir = path.dirname(entry);
  while (true) {
    const manifestPath = path.join(dir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === 'chromadb') {
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.chroma;
        if (!bin) throw new Error(`chromadb ${manifest.version} にはCLIが同梱されていません。3.0.0以上を入れてください`);
        return { cli: path.join(dir, bin), version: manifest.version };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`chromadb パッケージの package.json が見つかりません: ${entry}`);
    dir = parent;
  }
}

/**
 * `chroma run` に渡す引数。
 *
 * 待ち受け先は `CHROMA_URL` から取ります。繋ぐ先と立てる先を別々に書かせると、片方だけ
 * 変えたときに「立ち上がったのに繋がらない」ができるからです。
 * この端末の外へは出しません。ChromaDBは認証を持たず、保存した判断が丸ごと読めるからです
 * （`docker-compose.yml` でもホストへ公開していません）。
 *
 * @param {object} options
 * @param {string} options.dataPath 索引の置き場所。
 * @param {string} [options.url] 待ち受け先。既定は `http://127.0.0.1:8000`。
 */
export function chromaRunArgs({ url = DEFAULT_ENDPOINT, dataPath }) {
  if (!dataPath) throw new Error('ChromaDBの索引の置き場所（CHROMA_PATH）が要ります');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`CHROMA_URL がURLではありません: ${url}`);
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(`CHROMA_SERVER=npm のときの CHROMA_URL は http:// で始めてください（TLSは持ちません）: ${url}`);
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`CHROMA_SERVER=npm で立ち上げるChromaDBは、この端末（127.0.0.1 か localhost）にだけ待ち受けさせてください: ${url}`);
  }
  return ['run', '--path', dataPath, '--host', host, '--port', parsed.port || '80'];
}

/**
 * ChromaDBを子プロセスとして立ち上げ、心拍が返るまで待ちます。
 *
 * @param {object} options
 * @param {string} options.dataPath 索引の置き場所。無ければ作ります。
 * @param {string} [options.url] 待ち受け先。既定は `http://127.0.0.1:8000`。
 * @param {string} [options.cli] `chroma` CLIの場所。既定は `chromadb` パッケージから探します。
 * @param {number} [options.waitSeconds] 心拍が返るまで何秒待つか。
 * @param {Function} [options.log] 立ち上げていることを伝える先（起動ログ）。
 * @param {Function} [options.onExit] 立ち上がったあとに、止めていないのに終わったときの知らせ。
 * @param {object} [options.env] 子プロセスの環境変数。`RUST_LOG` が無ければ `warn` にします
 *   （既定のinfoだと要求のたびにログが出るため）。
 * @param {{ write: Function }} [options.output] 立ち上がったあとのstderr（と、`RUST_LOG` を付けたときのstdout）を流す先。
 * @param {number} [options.stopTimeoutMs] SIGINTで終わらないときに、SIGKILLへ切り替えるまでの時間。
 * @returns {Promise<{ url: string, cli: string, dataPath: string, pid: number, stop: () => Promise<void> }>}
 */
export async function startChromaServer({
  dataPath,
  url = DEFAULT_ENDPOINT,
  cli,
  waitSeconds = 30,
  log = () => {},
  onExit = () => {},
  env = process.env,
  output = process.stderr,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  fetchImpl = fetch,
  spawnImpl = spawn
}) {
  const args = chromaRunArgs({ url, dataPath });
  const cliPath = cli || resolveChromaCli().cli;
  const heartbeat = `${String(url).replace(/\/+$/, '')}/api/v2/heartbeat`;

  // 先に何かが待ち受けていたら、立ち上げません。立ち上げてから心拍を聞くと、先にいたほうが
  // 答えて「立ち上がった」ことになり、こちらの子プロセスはポートを取れずに黙って終わります。
  if (await heartbeatOk(fetchImpl, heartbeat)) {
    throw new Error(`${url} には既にChromaDBが待ち受けています。それを使うなら CHROMA_SERVER=external に、立て直すなら先に止めてください`);
  }

  fs.mkdirSync(dataPath, { recursive: true });
  log(`ChromaDBをnpmパッケージから立ち上げています（${url}、索引: ${dataPath}）`);

  const child = spawnImpl(process.execPath, [cliPath, ...args], {
    env: { RUST_LOG: 'warn', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const state = { exited: null, ready: false, stopping: false };
  const stderrTail = [];
  // 親が `process.exit` で終わるときの保険。止め忘れると、ポートを握ったまま残ります。
  const killOnParentExit = () => {
    if (!state.exited) child.kill('SIGINT');
  };
  process.once('exit', killOnParentExit);

  child.stdout.on('data', (chunk) => {
    // 既定（warn）では、起動時の案内（ロゴと接続先）しか出ません。ログを見たい人は
    // `RUST_LOG` を付けるので、そのときだけ流します。
    if (env.RUST_LOG) output.write(prefixLines(chunk));
  });
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
    if (state.ready) output.write(prefixLines(chunk));
  });
  const exited = new Promise((resolve) => {
    const finish = (code, signal) => {
      if (state.exited) return;
      state.exited = { code, signal };
      process.off('exit', killOnParentExit);
      if (state.ready && !state.stopping) onExit({ code, signal, stderr: stderrTail.join('\n') });
      resolve();
    };
    child.once('exit', finish);
    child.once('error', (error) => {
      stderrTail.push(error.message);
      finish(null, null);
    });
  });

  async function stop() {
    if (state.exited) return;
    state.stopping = true;
    child.kill('SIGINT');
    await Promise.race([exited, delay(stopTimeoutMs, { unref: true })]);
    if (!state.exited) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  const deadline = Date.now() + waitSeconds * 1000;
  while (true) {
    if (state.exited) {
      const reason = stderrTail.length ? `\n  ${stderrTail.join('\n  ')}` : '';
      throw new Error(`ChromaDBが立ち上がる前に終わりました（${describeExit(state.exited)}）${reason}`);
    }
    if (await heartbeatOk(fetchImpl, heartbeat)) break;
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(`ChromaDBが${waitSeconds}秒待っても心拍を返しませんでした: ${url}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  state.ready = true;

  return { url, cli: cliPath, dataPath, pid: child.pid, stop };
}

async function heartbeatOk(fetchImpl, heartbeat) {
  try {
    const response = await fetchImpl(heartbeat, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

function describeExit({ code, signal }) {
  return code === null ? `シグナル ${signal || '不明'}` : `終了コード ${code}`;
}

function prefixLines(chunk) {
  return String(chunk)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => `  [chroma] ${line}\n`)
    .join('');
}

function delay(ms, { unref = false } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) timer.unref();
  });
}
