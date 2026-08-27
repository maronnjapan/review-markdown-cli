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
import { normalizePatterns } from './pathFilter.js';

export const CONFIG_FILE_NAME = '.review-markdown.json';

export const LIST_KEYS = ['include', 'exclude'];
/** Free text, so `config set` joins the words it was given instead of taking the first. */
export const TEXT_KEYS = ['aiContext'];
export const SCALAR_KEYS = ['port', 'open', ...TEXT_KEYS];
export const CONFIG_KEYS = [...LIST_KEYS, ...SCALAR_KEYS];

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
 */
export async function readConfigFile(filePath) {
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

  const { config, warnings } = normalizeConfig(parsed, filePath);
  return { path: filePath, exists: true, config, warnings };
}

export async function writeConfigFile(filePath, config) {
  const { config: normalized } = normalizeConfig(config, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(sortConfig(normalized), null, 2)}\n`, 'utf8');
  return normalized;
}

/** Validates one config object. Unknown keys are reported as warnings, not errors. */
export function normalizeConfig(raw, source = 'config') {
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
    config[key] = normalizeConfigValue(key, raw[key], source);
  }
  return { config, warnings };
}

/** Coerces one value into the type its key expects, throwing on anything else. */
export function normalizeConfigValue(key, value, source = 'config') {
  if (LIST_KEYS.includes(key)) return normalizePatternList(value, `${source}: ${key}`);
  if (key === 'port') return parsePort(value, `${source}: port`);
  if (key === 'open') return parseBoolean(value, `${source}: open`);
  if (key === 'aiContext') return normalizeAiContext(value, `${source}: aiContext`);
  throw new Error(`${source}: 不明な設定キーです: ${key}（使えるキー: ${CONFIG_KEYS.join(', ')}）`);
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

  const projectPath = await findProjectConfigPath(targetDir);
  if (projectPath && path.resolve(projectPath) !== path.resolve(globalFile.path)) {
    files.push(await readConfigFile(projectPath));
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
  return {
    ...options,
    include: dedupe([...(config.include || []), ...options.include]),
    exclude: dedupe([...(config.exclude || []), ...options.exclude]),
    port: usePort ? config.port : options.port,
    open: useOpen ? config.open : options.open,
    aiContext: options.aiContext ?? config.aiContext ?? ''
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
