/**
 * Configuration file support for the `review-markdown` CLI.
 *
 * Two files can contribute settings:
 *   - global : ユーザー全体の設定（`~/.config/review-markdown/config.json` 等）
 *   - project: 対象ディレクトリから親へ遡って最初に見つかる `.review-markdown.json`
 *
 * Project settings win over global ones, and CLI flags win over both. List
 * values (`include` / `exclude`) are merged instead of replaced, so a project
 * can add to the patterns a user always wants ignored.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeAiContext } from './aiContext.js';
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER, unknownProviderMessage } from './aiProviders/index.js';
import { normalizePatterns } from './pathFilter.js';

export const CONFIG_FILE_NAME = '.review-markdown.json';

/**
 * 書ける設定キーの一覧です。1キー1行で、種類・値の読み方・`config` の説明文を持ちます。
 *
 * `kind` は3つ。
 *   list  : 値の並び。設定ファイル同士では連結します（例: exclude）。
 *   text  : 自由な文章。`config set` は与えられた語をすべてつなぎます。
 *   scalar: 値1つ。`config set` は先頭の語だけを取ります。
 *
 * `scope: 'user'` を付けたキーは、探索で見つけたプロジェクト設定からは読みません。
 * レビュー対象のリポジトリが自前の `.review-markdown.json` を同梱していることがあり、
 * 原稿を開いただけで原稿の送り先が変わってしまうからです。どのAIへ原稿を渡すかは、
 * その端末の持ち主が決めることなので、ユーザー全体の設定（`--global`）か、
 * コマンドラインで名指しした `--config` からだけ受け取ります。
 *
 * モデルの実行コマンドは、意図してここに置いていません。そこから起動する実行ファイルを
 * 選ばせると、原稿を開いただけで任意のコマンドが走ることになるからです。
 */
const CONFIG_KEY_SPECS = {
  include: {
    kind: 'list',
    parse: (value, source) => normalizePatternList(value, source),
    help: 'レビュー対象に含めるパスのパターン（一覧）'
  },
  exclude: {
    kind: 'list',
    parse: (value, source) => normalizePatternList(value, source),
    help: 'レビュー対象から外すパスのパターン（一覧）'
  },
  port: {
    kind: 'scalar',
    parse: (value, source) => parsePort(value, source),
    help: 'ローカルサーバーのポート番号'
  },
  open: {
    kind: 'scalar',
    parse: (value, source) => parseBoolean(value, source),
    help: '起動時にブラウザを開くかどうか（true / false）'
  },
  manager: {
    kind: 'scalar',
    parse: (value, source) => parseBoolean(value, source),
    help: '資料の管理者を有効にするかどうか（既定: false）'
  },
  translation: {
    kind: 'scalar',
    parse: (value, source) => parseBoolean(value, source),
    help: '翻訳機能を有効にするかどうか（既定: false）'
  },
  aiContext: {
    kind: 'text',
    parse: (value, source) => normalizeAiContext(value, source),
    help: 'AIがこのディレクトリの原稿を読むときの前提（文章）'
  },
  aiProvider: {
    kind: 'scalar',
    scope: 'user',
    parse: (value, source) => parseProvider(value, source),
    help: `どのAIで走らせるか（${AI_PROVIDERS.join(' / ')}。既定: ${DEFAULT_AI_PROVIDER}）`
  },
  aiModelProvider: {
    kind: 'scalar',
    scope: 'user',
    parse: (value, source) => parseIdentifier(value, source),
    help: 'aiProvider が langchain のときのプロバイダ名（anthropic / openai / ollama など）'
  },
  aiModel: {
    kind: 'scalar',
    parse: (value, source) => parseIdentifier(value, source),
    help: '翻訳・AIチャット・指摘の配置に使うモデル（既定: そのAIの速い方）'
  },
  aiEffort: {
    kind: 'scalar',
    parse: (value, source) => parseIdentifier(value, source),
    help: '同上の推論強度（none / low / medium / high など、モデルが対応するもの）'
  },
  aiReviewModel: {
    kind: 'scalar',
    parse: (value, source) => parseIdentifier(value, source),
    help: 'AIレビューと読み手ペルソナに使うモデル（既定: そのAIの深く読む方）'
  },
  aiReviewEffort: {
    kind: 'scalar',
    parse: (value, source) => parseIdentifier(value, source),
    help: '同上の推論強度。費用と待ち時間が一番大きく変わるつまみ'
  }
};

export const CONFIG_KEYS = Object.keys(CONFIG_KEY_SPECS);
export const LIST_KEYS = keysOfKind('list');
/** Free text, so `config set` joins the words it was given instead of taking the first. */
export const TEXT_KEYS = keysOfKind('text');
/** レビュー対象のリポジトリからは受け取らないキー。理由は `CONFIG_KEY_SPECS` の説明。 */
export const USER_SCOPED_KEYS = CONFIG_KEYS.filter((key) => CONFIG_KEY_SPECS[key].scope === 'user');

/** `config --help` の Keys 節。表から作るので、キーを足しても説明を書き忘れません。 */
export const CONFIG_KEY_HELP = CONFIG_KEYS.map((key) => (
  `  ${key.padEnd(17)}${CONFIG_KEY_SPECS[key].help}`
)).join('\n');

/** 用途ごとのモデル指定。設定していない用途は、選んだAIの既定から選びます。 */
export function aiModelsFromConfig(config = {}) {
  return {
    assistant: { model: config.aiModel, effort: config.aiEffort },
    review: { model: config.aiReviewModel, effort: config.aiReviewEffort }
  };
}

function keysOfKind(kind) {
  return CONFIG_KEYS.filter((key) => CONFIG_KEY_SPECS[key].kind === kind);
}

/** Path of the user wide config file. `REVIEW_MARKDOWN_CONFIG_HOME` overrides the directory. */
export function globalConfigPath(env = process.env, platform = process.platform) {
  if (env.REVIEW_MARKDOWN_CONFIG_HOME) {
    return path.join(path.resolve(env.REVIEW_MARKDOWN_CONFIG_HOME), 'config.json');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'review-markdown', 'config.json');
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'review-markdown', 'config.json');
}

/**
 * Walks up from `startDir` looking for `.review-markdown.json`.
 * Returns null when no directory up to the filesystem root has one.
 */
export async function findProjectConfigPath(startDir = '.') {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, CONFIG_FILE_NAME);
    if (await isFile(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/** Where `config` writes when the project has no config file yet. */
export function defaultProjectConfigPath(dir = '.') {
  return path.join(path.resolve(dir), CONFIG_FILE_NAME);
}

/**
 * Reads and validates one config file.
 * Returns `{ exists: false }` when the file is absent, so a missing config is
 * never an error; anything unreadable or malformed throws instead.
 *
 * @param {object} [options]
 * @param {boolean} [options.userScoped] false にすると、端末の持ち主だけが決められるキーを
 *   読み飛ばして警告にします。探索で見つけたプロジェクト設定はこちらで読みます。
 */
export async function readConfigFile(filePath, { userScoped = true } = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { path: filePath, exists: false, config: {}, warnings: [] };
    throw new Error(`設定ファイルを読み込めませんでした: ${filePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`設定ファイルがJSONとして読めません: ${filePath}: ${error.message}`);
  }

  const { config, warnings } = normalizeConfig(parsed, filePath, { userScoped });
  return { path: filePath, exists: true, config, warnings };
}

export async function writeConfigFile(filePath, config) {
  const { config: normalized } = normalizeConfig(config, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(sortConfig(normalized), null, 2)}\n`, 'utf8');
  return normalized;
}

/**
 * Validates one config object. Unknown keys are reported as warnings, not errors.
 * `userScoped: false` does the same for the keys only the person at the keyboard
 * may set: 値を見ずに読み飛ばして、警告にします。
 */
export function normalizeConfig(raw, source = 'config', { userScoped = true } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: 設定はJSONオブジェクトで書いてください`);
  }

  const config = {};
  const warnings = [];
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) continue;
    if (!CONFIG_KEYS.includes(key)) {
      warnings.push(`${source}: 不明な設定キーを無視しました: ${key}`);
      continue;
    }
    // 読まないと決めたキーは、中身も見ません。レビュー対象のリポジトリが書いた値のせいで
    // 起動できなくなるのは、そのリポジトリに起動を止めさせているのと同じだからです。
    if (!userScoped && USER_SCOPED_KEYS.includes(key)) {
      warnings.push(
        `${source}: ${key} はプロジェクト設定では無視します`
        + `（ユーザー全体の設定に \`review-markdown config set ${key} … --global\` で書いてください）`
      );
      continue;
    }
    config[key] = normalizeConfigValue(key, raw[key], source);
  }
  return { config, warnings };
}

/** Coerces one value into the type its key expects, throwing on anything else. */
export function normalizeConfigValue(key, value, source = 'config') {
  const spec = CONFIG_KEY_SPECS[key];
  if (!spec) throw new Error(`${source}: 不明な設定キーです: ${key}（使えるキー: ${CONFIG_KEYS.join(', ')}）`);
  return spec.parse(value, `${source}: ${key}`);
}

/** どのAIで走らせるか。知らない名前は、使えるものを並べて断ります。 */
export function parseProvider(value, source = 'aiProvider') {
  const provider = parseIdentifier(value, source);
  if (!AI_PROVIDERS.includes(provider)) throw new Error(`${source}: ${unknownProviderMessage(provider)}`);
  return provider;
}

/** モデル名や推論強度のような、空白を含まない1語の設定値。 */
export function parseIdentifier(value, source = 'value') {
  if (typeof value !== 'string') throw new Error(`${source} は文字列で指定してください: ${JSON.stringify(value)}`);
  const text = value.trim();
  if (!text) throw new Error(`${source} に空の値は指定できません`);
  if (/\s/.test(text)) throw new Error(`${source} に空白は含められません: ${value}`);
  return text;
}

export function normalizePatternList(value, source = 'patterns') {
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (typeof entry !== 'string') throw new Error(`${source} は文字列の配列で指定してください: ${JSON.stringify(entry)}`);
  }
  return normalizePatterns(values);
}

export function parsePort(value, source = 'port') {
  const port = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be an integer between 1 and 65535: ${value}`);
  }
  return port;
}

export function parseBoolean(value, source = 'value') {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  throw new Error(`${source} must be true or false: ${value}`);
}

/** Later configs win for scalars; list values are concatenated in order. */
export function mergeConfigs(...configs) {
  const merged = {};
  for (const config of configs) {
    if (!config) continue;
    for (const key of CONFIG_KEYS) {
      if (config[key] === undefined) continue;
      merged[key] = LIST_KEYS.includes(key) ? dedupe([...(merged[key] || []), ...config[key]]) : config[key];
    }
  }
  return merged;
}

/**
 * Collects the config that applies to a review session.
 *
 * @param {object} params
 * @param {string} [params.targetDir] directory being reviewed; the project config search starts here.
 * @param {string} [params.configPath] explicit config file (`--config`), replacing the search entirely.
 * @param {boolean} [params.useConfig] false for `--no-config`.
 */
export async function loadConfig({
  targetDir = '.',
  configPath,
  useConfig = true,
  env = process.env,
  platform = process.platform
} = {}) {
  if (!useConfig) return { config: {}, sources: [], warnings: [] };

  const explicitPath = configPath ?? env.REVIEW_MARKDOWN_CONFIG;
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    const file = await readConfigFile(resolved);
    if (!file.exists) throw new Error(`設定ファイルが見つかりません: ${resolved}`);
    return { config: file.config, sources: [resolved], warnings: file.warnings };
  }

  const files = [];
  const globalFile = await readConfigFile(globalConfigPath(env, platform));
  if (globalFile.exists) files.push(globalFile);

  // 探索で見つけたファイルは、レビュー対象のリポジトリが同梱していることがあります。
  // 原稿の送り先を決めるキーだけは、ここからは受け取りません（`CONFIG_KEY_SPECS` の説明）。
  const projectPath = await findProjectConfigPath(targetDir);
  if (projectPath && path.resolve(projectPath) !== path.resolve(globalFile.path)) {
    files.push(await readConfigFile(projectPath, { userScoped: false }));
  }

  return {
    config: mergeConfigs(...files.map((file) => file.config)),
    sources: files.map((file) => file.path),
    warnings: files.flatMap((file) => file.warnings)
  };
}

/**
 * Folds config values into parsed CLI options. Flags and `PORT` win over the
 * config file; `include` / `exclude` are merged so both sources apply.
 */
export function applyConfigToOptions(options, config = {}) {
  const usePort = options.portSource === 'default' && config.port !== undefined;
  const useOpen = options.openSource === 'default' && config.open !== undefined;
  const useManager = options.managerSource === 'default' && config.manager !== undefined;
  const useTranslation = options.translationSource === 'default' && config.translation !== undefined;
  return {
    ...options,
    include: dedupe([...(config.include || []), ...options.include]),
    exclude: dedupe([...(config.exclude || []), ...options.exclude]),
    port: usePort ? config.port : options.port,
    open: useOpen ? config.open : options.open,
    manager: useManager ? config.manager : options.manager,
    translation: useTranslation ? config.translation : options.translation,
    aiContext: options.aiContext ?? config.aiContext ?? '',
    // AIの選択とモデルの指定はコマンドラインに口を持たないので、設定ファイルの値が
    // そのまま届きます。どれも未設定なら、既定のAIをその既定のモデルで走らせます。
    aiProvider: config.aiProvider ?? DEFAULT_AI_PROVIDER,
    aiModelProvider: config.aiModelProvider,
    aiModels: aiModelsFromConfig(config)
  };
}

export function sortConfig(config) {
  const sorted = {};
  for (const key of CONFIG_KEYS) {
    if (config[key] !== undefined) sorted[key] = config[key];
  }
  return sorted;
}

function dedupe(values) {
  return [...new Set(values)];
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}
