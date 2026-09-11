/**
 * `review-markdown context status` — 保存した判断の預け先へ、繋がるかどうかを聞きます。
 *
 * ── CLIに `start` が無い理由 ───────────────────────────────
 * 預け先（Context API）は、このCLIとは別のサービスです（`context-api/`）。索引に
 * ChromaDBを立て、埋め込みを選び、コンテナで動かすところまでがあちらの都合で、
 * 原稿を読むためのCLIがその起動を引き受けると、片方の都合がもう片方へ流れ込みます。
 * CLIがすることは、設定されたURLを叩くことだけです。
 *
 * 立ち上げるのは `context-api/` で `docker compose up -d` です。このコマンドは、
 * 「設定したURLで、いま動いているか」だけを答えます。画面を開く前に確かめられると、
 * 保存できない理由がCLI側なのか預け先なのかで迷わずに済みます。
 */

import { splitFlag, takeValue } from './argv.js';

/** Context APIの既定のポート。`context-api/src/config.js` の `DEFAULT_PORT` と揃えます。 */
export const DEFAULT_CONTEXT_PORT = 8765;

export const DEFAULT_CONTEXT_ENDPOINT = `http://127.0.0.1:${DEFAULT_CONTEXT_PORT}`;

export const CONTEXT_USAGE = `Usage: review-markdown context status [--endpoint <url>] [--token <token>]

保存した判断の預け先（Context API）へ繋がるかどうかを確かめます。

Options:
      --endpoint <url>  確かめる先（既定: 設定ファイルの contextEndpoint、無ければ ${DEFAULT_CONTEXT_ENDPOINT}）
      --token <token>   Authorization: Bearer で送るトークン（既定: 設定ファイルの contextToken）
  -h, --help            このヘルプを表示する

預け先はこのCLIとは別のサービスです。立ち上げるのは context-api/ で行います。

  cd context-api && docker compose up -d
  review-markdown config set contextEndpoint ${DEFAULT_CONTEXT_ENDPOINT} --global

止まっているあいだは、判断の保存と検索だけが使えません。
ファイルの閲覧・編集・コメント・一般的なAI質問は、これまでどおり使えます。`;

/** 引数を読むだけです。ネットワークには触りません。 */
export function parseContextArgs(argv = []) {
  const parsed = { command: undefined, endpoint: undefined, token: undefined, help: false };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = splitFlag(argv[index]);
    if (flag === '--help' || flag === '-h') {
      parsed.help = true;
      return parsed;
    }
    if (flag === '--endpoint' || flag === '--token') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed[flag.slice(2)] = value;
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
  if (command !== 'status') {
    throw new Error(`unknown context command: ${command}（使えるコマンド: status）`
      + '（起動は context-api/ の docker compose up -d です）');
  }
  if (rest.length) throw new Error(`unexpected argument: ${rest[0]}`);
  parsed.command = command;
  return parsed;
}

/**
 * 預け先へ `/health` を1回投げます。
 * @returns {{stdout: string[], stderr: string[], exitCode: number}}
 */
export async function checkContextServer({ endpoint, token, fetchImpl = fetch } = {}) {
  if (!endpoint) {
    return {
      stdout: [],
      stderr: [
        '預け先が設定されていません。',
        `  review-markdown config set contextEndpoint ${DEFAULT_CONTEXT_ENDPOINT} --global`
      ],
      exitCode: 1
    };
  }
  const base = String(endpoint).replace(/\/+$/, '');
  try {
    const response = await fetchImpl(`${base}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      return {
        stdout: [],
        stderr: [
          `Context API はエラーを返しました（HTTP ${response.status}）: ${base}`,
          ...(response.status === 401 ? ['  review-markdown config set contextToken <token> --global で合わせてください'] : [])
        ],
        exitCode: 1
      };
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
        '  cd context-api && docker compose up -d で立ち上げてください'
      ],
      exitCode: 1
    };
  }
}
