/**
 * `review-markdown config ...` — 設定ファイルをコマンドから読み書きするサブコマンド。
 *
 * 実行結果は文字列の配列として返し、標準出力への書き出しは呼び出し側に任せる。
 * ファイル操作以外は副作用を持たないので、そのままテストできる。
 */

import { splitFlag, takeValue } from './argv.js';
import {
  CONFIG_FILE_NAME,
  CONFIG_KEYS,
  CONFIG_KEY_HELP,
  LIST_KEYS,
  TEXT_KEYS,
  defaultProjectConfigPath,
  findProjectConfigPath,
  globalConfigPath,
  loadConfig,
  normalizeConfigValue,
  normalizePatternList,
  readConfigFile,
  sortConfig,
  writeConfigFile
} from './config.js';

export const CONFIG_USAGE = `Usage: review-markdown config <command> [options]

Commands:
  init                     設定ファイルを作成する（既にある場合はそのパスを表示）
  path                     読み込まれる設定ファイルのパスを表示する
  list                     適用される設定内容を表示する
  get <key>                設定値を表示する
  set <key> <value...>     設定値を置き換える
  add <key> <value...>     一覧に値を追加する（include / exclude）
  remove <key> <value...>  一覧から値を削除する
  unset <key>              設定値を削除する

Keys:
${CONFIG_KEY_HELP}

Options:
  -C, --dir <path>  対象ディレクトリ（既定: カレントディレクトリ）
  -g, --global      ユーザー全体の設定ファイル（~/.config/review-markdown/config.json など）を操作する
      --json        list / get の結果をJSONで出力する
  -h, --help        このヘルプを表示する

Examples:
  review-markdown config add exclude 'drafts/**' '**/*.wip.md'
  review-markdown config add exclude node_modules   # どの階層の node_modules も無視する
  review-markdown config set port 4000
  review-markdown config set aiContext '入門者向けの技術書。読者はJavaScriptの基礎を知っている。'
  review-markdown config list

パターンは対象ディレクトリからの相対パスに対して照合し、* ** ? {a,b} のワイルドカードによる
部分一致を使えます。ディレクトリに一致したパターンは、その配下すべてに一致します。
スラッシュを含まないパターンはどの階層にも一致し、先頭に / を付けると直下だけに一致します。
設定ファイル名は ${CONFIG_FILE_NAME} です。

aiContext は翻訳・AIチャット・指摘の配置で AI に渡す読み取りコンテキストです。
ここに書いた前提はディレクトリ配下のすべての文書に効きます。
文書ごとの前提はブラウザのAIパネルから書けて、両方まとめて AI へ渡します。

aiModel / aiReviewModel を書かなければ、Codexが持っているモデルから自動で選びます
（速いモデルを翻訳とチャットへ、深く読むモデルをレビューへ）。名指ししたモデルが
Codexに無いときは、黙って別のモデルへ落とさずに起動を止めます。

  review-markdown config set aiReviewModel gpt-5.6-codex --global
  review-markdown config set aiReviewEffort high --global`;

const COMMANDS = new Set(['init', 'path', 'list', 'get', 'set', 'add', 'remove', 'unset']);

/** Parses the argv that follows `config`, without touching the filesystem. */
export function parseConfigArgs(argv) {
  const parsed = { command: undefined, key: undefined, values: [], dir: '.', global: false, json: false, help: false };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = splitFlag(argv[index]);

    if (flag === '--help' || flag === '-h') {
      parsed.help = true;
      return parsed;
    }
    if (flag === '--global' || flag === '-g') {
      parsed.global = true;
    } else if (flag === '--json') {
      parsed.json = true;
    } else if (flag === '--dir' || flag === '-C') {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      parsed.dir = value;
    } else if (flag.startsWith('-') && flag !== '-') {
      throw new Error(`unknown option: ${flag}`);
    } else {
      positionals.push(argv[index]);
    }
  }

  const [command, key, ...values] = positionals;
  if (!command) {
    parsed.help = true;
    return parsed;
  }
  if (!COMMANDS.has(command)) {
    throw new Error(`unknown config command: ${command}（使えるコマンド: ${[...COMMANDS].join(', ')}）`);
  }

  parsed.command = command;
  parsed.key = key;
  parsed.values = values;
  assertArity(parsed);
  return parsed;
}

/**
 * Runs one `config` subcommand.
 * @returns {Promise<{exitCode: number, stdout: string[], stderr: string[]}>}
 */
export async function runConfigCommand(parsed, { env = process.env, platform = process.platform } = {}) {
  if (parsed.help) return { exitCode: 0, stdout: [CONFIG_USAGE], stderr: [] };

  const targetPath = parsed.global
    ? globalConfigPath(env, platform)
    : (await findProjectConfigPath(parsed.dir)) || defaultProjectConfigPath(parsed.dir);

  switch (parsed.command) {
    case 'path':
      return output([targetPath]);
    case 'init':
      return runInit(targetPath);
    case 'list':
      return runList(parsed, { env, platform, targetPath });
    case 'get':
      return runGet(parsed, targetPath);
    case 'set':
    case 'add':
    case 'remove':
    case 'unset':
      return runEdit(parsed, targetPath);
    default:
      return { exitCode: 1, stdout: [], stderr: [`unknown config command: ${parsed.command}`] };
  }
}

async function runInit(targetPath) {
  const existing = await readConfigFile(targetPath);
  if (existing.exists) return output([`設定ファイルは既にあります: ${targetPath}`]);
  await writeConfigFile(targetPath, { exclude: [] });
  return output([`設定ファイルを作成しました: ${targetPath}`, '', '  review-markdown config add exclude \'drafts/**\'']);
}

async function runList(parsed, { env, platform, targetPath }) {
  const loaded = parsed.global
    ? { config: (await readConfigFile(targetPath)).config, sources: [targetPath], warnings: [] }
    : await loadConfig({ targetDir: parsed.dir, env, platform });

  if (parsed.json) return output([JSON.stringify(sortConfig(loaded.config), null, 2)], loaded.warnings);

  const lines = [`設定ファイル: ${loaded.sources.length ? loaded.sources.join(', ') : `(未作成) ${targetPath}`}`];
  for (const key of CONFIG_KEYS) {
    const value = loaded.config[key];
    if (value === undefined) {
      lines.push(`${key}: (未設定)`);
    } else if (LIST_KEYS.includes(key)) {
      lines.push(`${key}:${value.length ? '' : ' (なし)'}`, ...value.map((entry) => `  - ${entry}`));
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return output(lines, loaded.warnings);
}

async function runGet(parsed, targetPath) {
  assertKnownKey(parsed.key);
  const { config, warnings } = await readConfigFile(targetPath);
  const value = config[parsed.key];
  if (parsed.json) return output([JSON.stringify(value ?? null, null, 2)], warnings);
  if (value === undefined) return output(['(未設定)'], warnings);
  return output(LIST_KEYS.includes(parsed.key) ? value.map(String) : [String(value)], warnings);
}

async function runEdit(parsed, targetPath) {
  assertKnownKey(parsed.key);
  const existing = await readConfigFile(targetPath);
  const config = { ...existing.config };
  const isList = LIST_KEYS.includes(parsed.key);

  if (parsed.command === 'unset') {
    delete config[parsed.key];
  } else if (parsed.command === 'set') {
    config[parsed.key] = normalizeConfigValue(parsed.key, setValue(parsed, isList), targetPath);
  } else if (isList) {
    const current = config[parsed.key] || [];
    const requested = normalizePatternList(parsed.values, `${targetPath}: ${parsed.key}`);
    config[parsed.key] = parsed.command === 'add'
      ? [...new Set([...current, ...requested])]
      : current.filter((entry) => !requested.includes(entry));
  } else {
    throw new Error(`${parsed.key} は一覧ではないので ${parsed.command} は使えません。set / unset を使ってください`);
  }

  const written = await writeConfigFile(targetPath, config);
  const value = written[parsed.key];
  const shown = value === undefined ? '(未設定)' : isList ? `[${value.join(', ')}]` : String(value);
  return output([`${targetPath} を更新しました`, `${parsed.key}: ${shown}`], existing.warnings);
}

/** Free text keeps every word it was given; other scalars take one value. */
function setValue(parsed, isList) {
  if (isList) return parsed.values;
  return TEXT_KEYS.includes(parsed.key) ? parsed.values.join(' ') : parsed.values[0];
}

function assertArity(parsed) {
  const { command, key, values } = parsed;
  if (['init', 'path', 'list'].includes(command)) {
    if (key !== undefined) throw new Error(`config ${command} は引数を取りません: ${key}`);
    return;
  }
  if (!key) throw new Error(`config ${command} には設定キーが必要です（${CONFIG_KEYS.join(', ')}）`);
  if (['get', 'unset'].includes(command) && values.length) {
    throw new Error(`config ${command} は値を取りません: ${values.join(' ')}`);
  }
  if (['set', 'add', 'remove'].includes(command) && values.length === 0) {
    throw new Error(`config ${command} ${key} には値が必要です`);
  }
}

function assertKnownKey(key) {
  if (!CONFIG_KEYS.includes(key)) {
    throw new Error(`unknown config key: ${key}（使えるキー: ${CONFIG_KEYS.join(', ')}）`);
  }
}

function output(stdout, warnings = []) {
  return { exitCode: 0, stdout, stderr: warnings };
}
