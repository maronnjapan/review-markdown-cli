import { existsSync, statSync } from 'node:fs';
import { CONFIG_FILE_NAME, parsePort } from './config.js';
import { normalizePatterns } from './pathFilter.js';

export const USAGE = `Usage: review-markdown [targetDir] [options]
       review-markdown config <command> [options]

Options:
  -p, --port <number>   ローカルサーバーのポート番号（既定: 3000）
      --include <glob>  レビュー対象に含めるパス。複数指定・カンマ区切り可
      --exclude <glob>  レビュー対象から外すパス。複数指定・カンマ区切り可
      --config <file>   使用する設定ファイルを指定する
      --no-config       設定ファイルを読み込まない
      --no-open         ブラウザの自動起動をスキップする
  -h, --help            このヘルプを表示する

Glob:
  *   スラッシュ以外の0文字以上     例: docs/*.md
  **  ディレクトリをまたぐ任意の階層 例: **/draft-*.md
  ?   任意の1文字                   例: chapter-?.md
  {}  いずれかに一致                例: {docs,notes}/**

  ディレクトリに一致するパターンは、その配下すべてに一致します（例: --exclude drafts）。
  スラッシュを含まないパターンはどの階層にも一致します（例: --exclude node_modules）。
  先頭に / を付けると対象ディレクトリ直下だけに一致します（例: --exclude /drafts）。
  --include を指定した場合は、いずれかに一致するファイルだけがレビュー対象になります。
  --exclude は --include より優先されます。

Config:
  ${CONFIG_FILE_NAME}（対象ディレクトリから親へ遡って探索）とユーザー全体の設定ファイルを
  読み込み、そこに書いた include / exclude / port / open を既定値として使います。
  コマンドラインの指定が常に優先され、include / exclude は設定ファイルの内容と合成します。

    review-markdown config add exclude 'drafts/**'   # 設定ファイルに除外パターンを追加
    review-markdown config list                      # 適用中の設定を表示

  詳しくは review-markdown config --help を参照してください。`;

const VALUE_FLAGS = new Map([
  ['--port', 'port'],
  ['-p', 'port'],
  ['--include', 'include'],
  ['--exclude', 'exclude'],
  ['--config', 'configPath']
]);

/**
 * Parses argv without touching process state so it stays unit testable.
 * Throws an Error carrying a user-facing message for anything malformed.
 */
export function parseArgs(argv, env = {}) {
  const options = {
    targetDir: '.',
    port: env.PORT ? parsePort(env.PORT, 'PORT') : 3000,
    // Remembers who set the value so the config file only fills in what the
    // command line and the environment left alone.
    portSource: env.PORT ? 'env' : 'default',
    open: true,
    openSource: 'default',
    include: [],
    exclude: [],
    configPath: undefined,
    useConfig: true,
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
      if (key === 'port') {
        options.port = parsePort(value, flag);
        options.portSource = 'flag';
      } else if (key === 'configPath') {
        options.configPath = value;
      } else {
        options[key].push(value);
      }
    } else if (flag === '--no-open') {
      options.open = false;
      options.openSource = 'flag';
    } else if (flag === '--no-config') {
      options.useConfig = false;
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
