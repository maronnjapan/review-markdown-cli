import { existsSync, statSync } from 'node:fs';
import { normalizePatterns } from './pathFilter.js';

export const USAGE = `Usage: review-markdown [targetDir] [options]

Options:
  -p, --port <number>   ローカルサーバーのポート番号（既定: 3000）
      --include <glob>  レビュー対象に含めるパス。複数指定・カンマ区切り可
      --exclude <glob>  レビュー対象から外すパス。複数指定・カンマ区切り可
      --no-open         ブラウザの自動起動をスキップする
  -h, --help            このヘルプを表示する

Glob:
  *   スラッシュ以外の0文字以上     例: docs/*.md
  **  ディレクトリをまたぐ任意の階層 例: **/draft-*.md
  ?   任意の1文字                   例: chapter-?.md
  {}  いずれかに一致                例: {docs,notes}/**

  ディレクトリに一致するパターンは、その配下すべてに一致します（例: --exclude drafts）。
  --include を指定した場合は、いずれかに一致するファイルだけがレビュー対象になります。
  --exclude は --include より優先されます。`;

const VALUE_FLAGS = new Map([
  ['--port', 'port'],
  ['-p', 'port'],
  ['--include', 'include'],
  ['--exclude', 'exclude']
]);

/**
 * Parses argv without touching process state so it stays unit testable.
 * Throws an Error carrying a user-facing message for anything malformed.
 */
export function parseArgs(argv, env = {}) {
  const options = {
    targetDir: '.',
    port: env.PORT ? parsePort(env.PORT, 'PORT') : 3000,
    open: true,
    include: [],
    exclude: [],
    help: false
  };
  let targetDirSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = splitFlag(argv[index]);

    if (flag === '--help' || flag === '-h') {
      options.help = true;
      return options;
    }

    if (VALUE_FLAGS.has(flag)) {
      const value = inlineValue ?? argv[index + 1];
      if (inlineValue === undefined) index += 1;
      if (value === undefined || (inlineValue === undefined && value.startsWith('-'))) {
        throw new Error(`${flag} requires a value`);
      }
      const key = VALUE_FLAGS.get(flag);
      if (key === 'port') options.port = parsePort(value, flag);
      else options[key].push(value);
    } else if (flag === '--no-open') {
      options.open = false;
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown option: ${flag}`);
    } else if (targetDirSeen) {
      throw new Error(`target directory is already set to "${options.targetDir}": ${flag}`);
    } else {
      options.targetDir = flag;
      targetDirSeen = true;
    }
  }

  options.include = normalizePatterns(options.include);
  options.exclude = normalizePatterns(options.exclude);
  return options;
}

export function assertTargetDirectory(targetDir) {
  if (!existsSync(targetDir)) throw new Error(`target directory not found: ${targetDir}`);
  if (!statSync(targetDir).isDirectory()) throw new Error(`target must be a directory: ${targetDir}`);
}

function splitFlag(arg) {
  if (!arg.startsWith('--') || !arg.includes('=')) return [arg, undefined];
  const separator = arg.indexOf('=');
  return [arg.slice(0, separator), arg.slice(separator + 1)];
}

function parsePort(value, source) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be an integer between 1 and 65535: ${value}`);
  }
  return port;
}
