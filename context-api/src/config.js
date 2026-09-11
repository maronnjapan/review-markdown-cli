/**
 * このサービスの設定です。環境変数から読みます。
 *
 * コマンドラインの引数ではなく環境変数にしたのは、既定の動かし方がDocker Composeだからです
 * （`docker-compose.yml`）。Composeの中でフラグを組み立てると、設定が
 * `docker-compose.yml` と `Dockerfile` の2か所に散ります。
 *
 * ── Bindするアドレスを設定にした理由 ────────────────────────
 * 素で動かすときは `127.0.0.1` です。認証を持たないサービスなので、同じネットワークの
 * 他の端末から見えてはいけません。コンテナの中だけは `0.0.0.0` にします。コンテナの
 * `127.0.0.1` はコンテナ自身を指すので、そのままだとホストから届かないからです。
 * 代わりに、ホストへ公開するポートのほうを `127.0.0.1:8765:8765` と縛ります。
 * 外から見える範囲は、どちらの動かし方でも同じ「この端末だけ」です。
 */

import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8765;

/** Contextの正本（`contexts.json`）の置き場所。Dockerではボリュームを当てます。 */
export function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.CONTEXT_DATA_DIR) return path.resolve(env.CONTEXT_DATA_DIR);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'review-markdown', 'context');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'review-markdown', 'context');
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'review-markdown', 'context');
}

/**
 * 環境変数から、サービスの設定を組み立てます。
 * 知らない値は、使えるものを並べて断ります。起動時に断らないと、最初の保存で初めて
 * 失敗し、そのときにはもう「保存できたつもり」のユーザーがいます。
 */
export function readConfig(env = process.env) {
  return {
    port: parsePort(env.CONTEXT_API_PORT),
    host: env.CONTEXT_API_HOST || '127.0.0.1',
    token: env.CONTEXT_API_TOKEN || null,
    dataDir: defaultDataDir(env),
    embedding: {
      provider: env.EMBEDDING_PROVIDER || 'local',
      ...(env.EMBEDDING_MODEL ? { model: env.EMBEDDING_MODEL } : {}),
      ...(env.EMBEDDING_ENDPOINT ? { endpoint: env.EMBEDDING_ENDPOINT } : {}),
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {})
    },
    vectorStore: {
      kind: env.VECTOR_DB || 'chroma',
      ...(env.CHROMA_URL ? { endpoint: env.CHROMA_URL } : {}),
      ...(env.CHROMA_COLLECTION ? { collection: env.CHROMA_COLLECTION } : {}),
      ...(env.CHROMA_TENANT ? { tenant: env.CHROMA_TENANT } : {}),
      ...(env.CHROMA_DATABASE ? { database: env.CHROMA_DATABASE } : {})
    },
    // ChromaDBはこのサービスより遅く立ち上がることがあります。何秒まで待つか。
    waitForVectorDbSeconds: parseSeconds(env.VECTOR_DB_WAIT_SECONDS, 30)
  };
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(String(value).trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CONTEXT_API_PORT は0から65535の整数で指定してください: ${value}`);
  }
  return port;
}

function parseSeconds(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const seconds = Number(String(value).trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`VECTOR_DB_WAIT_SECONDS は0以上の数で指定してください: ${value}`);
  }
  return seconds;
}
