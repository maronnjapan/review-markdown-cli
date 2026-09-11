/**
 * どのVector DBを索引に使うかの表です。
 *
 * `AiService` が走らせるAIを選ぶのと同じ形にしてあります（`src/aiProviders/index.js`）。
 * 増やすときはここへ1行足します。CLIはどれが動いているかを知りません。知る必要が
 * 無いようにするために、Context APIをCLIから切り離してあります（仕様3.2）。
 */

import { createChromaVectorStore } from './chroma.js';
import { createLocalVectorStore } from './local.js';

const STORES = {
  local: {
    summary: 'ローカルのJSONファイル（既定。追加のインストールは要りません）',
    create: (options) => createLocalVectorStore(options)
  },
  chroma: {
    summary: 'ChromaDB（`chroma run` などで別途起動しておく必要があります）',
    create: (options) => createChromaVectorStore(options)
  }
};

export const VECTOR_STORES = Object.keys(STORES);

export const VECTOR_STORE_HELP = VECTOR_STORES
  .map((id) => `    ${id.padEnd(10)}${STORES[id].summary}`)
  .join('\n');

export function createVectorStore({ kind = 'local', ...options } = {}) {
  const entry = STORES[kind];
  if (!entry) throw new Error(`使えないVector DBです: ${kind}（使えるもの: ${VECTOR_STORES.join(', ')}）`);
  return entry.create(options);
}
