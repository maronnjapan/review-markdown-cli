/**
 * `review-markdown context ...` — Context APIを立ち上げるサブコマンドです。
 *
 * CLIとは別のプロセスで動かします（仕様3.4）。別プロセスにしているのは、Contextを
 * 扱う都合（Vector DBの選択、埋め込みの選択、索引の作り直し）を、原稿を読むための
 * アプリから切り離すためです。片方を止めても、もう片方は動き続けます。
 *
 * 引数の読み取りだけを `parseContextArgs` に分け、実際に待ち受けるのは
 * `startContextServer` にしてあります。読み取りは副作用を持たないのでそのまま
 * テストできます（`src/configCommand.js` と同じ分け方です）。
 */

import { splitFlag, takeValue } from '../argv.js';
import { EMBEDDING_PROVIDERS } from './embedding.js';
import { defaultContextDataDir } from './paths.js';
import { DEFAULT_CONTEXT_PORT, createContextApi } from './server.js';
import { VECTOR_STORES, VECTOR_STORE_HELP } from './vectorStores/index.js';

export const CONTEXT_USAGE = `Usage: review-markdown context start [options]
       review-markdown context status [--endpoint <url>]

保存した判断（Context）を預かるサービスです。CLIとは別のプロセスで動かします。
CLIからは設定ファイルの contextEndpoint で繋ぎます。

Commands:
  start             Context APIを起動する
  status            起動しているContext APIの状態を表示する

Options:
  -p, --port <number>     待ち受けるポート（既定: ${DEFAULT_CONTEXT_PORT}）
      --data-dir <path>   Contextの保存先（既定: ${defaultContextDataDir()}）
      --embedding <name>  埋め込みの選択（${EMBEDDING_PROVIDERS.join(' / ')}。既定: local）
      --embedding-model <name>
                          埋め込みのモデル名（ollama / openai のとき）
      --embedding-endpoint <url>
                          埋め込みサービスのURL（ollama / openai のとき）
      --vector-db <name>  索引の置き場所（${VECTOR_STORES.join(' / ')}。既定: local）
      --chroma-url <url>  ChromaDBのURL（--vector-db chroma のとき。既定: http://127.0.0.1:8000）
      --token <token>     Authorization: Bearer <token> を求める（既定: 認証なし）
      --endpoint <url>    status が見に行くURL（既定: http://127.0.0.1:${DEFAULT_CONTEXT_PORT}）
  -h, --help              このヘルプを表示する

Vector DB:
${VECTOR_STORE_HELP}

Embedding:
    local     このプロセスの中で計算します（既定。追加のインストールもAPIキーも要りません）
    ollama    ローカルのOllamaへ投げます（--embedding-model nomic-embed-text など）
    openai    OpenAI互換のAPIへ投げます（OPENAI_API_KEY が要ります。本文が外のサービスへ渡ります）

このサービスは 127.0.0.1 にだけBindします。認証は既定では行いません（個人利用かつ
localhost通信のみを想定しているためです）。他の端末から使う構成にはしないでください。

Examples:
  review-markdown context start
  review-markdown context start --port 8765 --vector-db chroma
  review-markdown context start --embedding ollama --embedding-model nomic-embed-text
  review-markdown context status`;

const COMMANDS = new Set(['start', 'status']);

/** 引数を読むだけです。ファイルにもネットワークにも触りません。 */
export function parseContextArgs(argv = []) {
  const parsed = {
    command: undefined,
    port: DEFAULT_CONTEXT_PORT,
    dataDir: undefined,
    embedding: { provider: 'local' },
    vectorStore: { kind: 'local' },
    token: undefined,
    endpoint: undefined,
    help: false
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = splitFlag(argv[index]);
    if (flag === '--help' || flag === '-h') {
      parsed.help = true;
      return parsed;
    }
    if (flag === '--port' || flag === '-p') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.port = parsePort(value);
    } else if (flag === '--data-dir') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.dataDir = value;
    } else if (flag === '--embedding') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      if (!EMBEDDING_PROVIDERS.includes(value)) {
        throw new Error(`unknown embedding: ${value}（使えるもの: ${EMBEDDING_PROVIDERS.join(', ')}）`);
      }
      parsed.embedding.provider = value;
    } else if (flag === '--embedding-model') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.embedding.model = value;
    } else if (flag === '--embedding-endpoint') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.embedding.endpoint = value;
    } else if (flag === '--vector-db') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      if (!VECTOR_STORES.includes(value)) {
        throw new Error(`unknown vector db: ${value}（使えるもの: ${VECTOR_STORES.join(', ')}）`);
      }
      parsed.vectorStore.kind = value;
    } else if (flag === '--chroma-url') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.vectorStore.endpoint = value;
    } else if (flag === '--token') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.token = value;
    } else if (flag === '--endpoint') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.endpoint = value;
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown option: ${flag}`);
    } else {
      positionals.push(argv[index]);
    }
  }

  const [command, ...rest] = positionals;
  if (!command) {
    parsed.help = true;
    return parsed;
  }
  if (!COMMANDS.has(command)) {
    throw new Error(`unknown context command: ${command}（使えるコマンド: ${[...COMMANDS].join(', ')}）`);
  }
  if (rest.length) throw new Error(`unexpected argument: ${rest[0]}`);
  parsed.command = command;
  return parsed;
}

/**
 * Context APIを立ち上げます。待ち受け始めたところで返るので、止めるのは呼んだ側です。
 * @returns {Promise<{server: import('node:http').Server, port: number, api: object, lines: string[]}>}
 */
export async function startContextServer(options = {}) {
  const dataDir = options.dataDir || defaultContextDataDir();
  const api = createContextApi({ ...options, dataDir });
  // 待ち受ける前に索引まで確かめます。繋がらないまま受け付けると、最初の保存で
  // 初めて失敗し、その時点ではもう「保存できたつもり」のユーザーがいます。
  const { reindexed } = await api.store.ready();
  const server = api.listen(options.port ?? DEFAULT_CONTEXT_PORT);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  return {
    server,
    port,
    api,
    lines: [
      `Context API is serving http://127.0.0.1:${port}`,
      `  data: ${dataDir}`,
      `  embedding: ${api.store.embedder.label}`,
      `  vector db: ${api.store.vectorStore.label}`,
      ...(options.token ? ['  auth: Authorization: Bearer <token>'] : []),
      ...(reindexed ? [`  埋め込みが変わったので、保存済みの${reindexed}件を作り直しました`] : []),
      `  CLIから使うには: review-markdown config set contextEndpoint http://127.0.0.1:${port} --global`
    ]
  };
}

/** `context status`。起動しているContext APIへ `/health` を1回投げます。 */
export async function checkContextServer({ endpoint, token, fetchImpl = fetch } = {}) {
  const base = String(endpoint || `http://127.0.0.1:${DEFAULT_CONTEXT_PORT}`).replace(/\/+$/, '');
  try {
    const response = await fetchImpl(`${base}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      return { stdout: [], stderr: [`Context API はエラーを返しました（HTTP ${response.status}）: ${base}`], exitCode: 1 };
    }
    const body = await response.json();
    return {
      stdout: [
        `Context API: ${base}`,
        `  embedding: ${body.embedding?.label || body.embedding?.id || '不明'}`,
        `  vector db: ${body.vector_store?.label || body.vector_store?.id || '不明'}`
      ],
      stderr: [],
      exitCode: 0
    };
  } catch (error) {
    return {
      stdout: [],
      stderr: [
        `Context API へ接続できません: ${base}（${error.message}）`,
        '  review-markdown context start で起動してください'
      ],
      exitCode: 1
    };
  }
}

function parsePort(value) {
  const port = Number(String(value).trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535: ${value}`);
  }
  return port;
}
