/**
 * どのVector DBを索引に使うかの表です。
 *
 * 既定はChromaDBで、`docker compose up` が一緒に立ち上げます。`VECTOR_DB=local` に
 * すると、Dockerを使わずに1ファイルだけで試せます（テストもこちらを使います）。
 *
 * 増やすときはここへ1行足します。CLIはどれが動いているかを知りません。知る必要が
 * 無いようにするために、このサービスをCLIから切り離してあります（仕様3.2）。
 */

import { createChromaVectorStore } from './chroma.js';
import { createLocalVectorStore } from './local.js';

const STORES = {
  chroma: {
    summary: 'ChromaDB（既定。docker compose up が一緒に立ち上げます）',
    create: (options) => createChromaVectorStore(options)
  },
  local: {
    summary: 'ローカルのJSONファイル（Dockerを使わずに試すとき、およびテスト用）',
    create: (options) => createLocalVectorStore(options)
  }
};

export const VECTOR_STORES = Object.keys(STORES);

export const VECTOR_STORE_HELP = VECTOR_STORES
  .map((id) => `    ${id.padEnd(10)}${STORES[id].summary}`)
  .join('\n');

export function createVectorStore({ kind = 'chroma', ...options } = {}) {
  const entry = STORES[kind];
  if (!entry) throw new Error(`使えないVector DBです: ${kind}（使えるもの: ${VECTOR_STORES.join(', ')}）`);
  return entry.create(options);
}
