#!/usr/bin/env node
import { DEFAULT_AI_PROVIDER } from '../src/aiProviders/index.js';
import { assertTargetDirectory, parseArgs, USAGE } from '../src/cli.js';
import { applyConfigToOptions, loadConfig } from '../src/config.js';
import { CONFIG_USAGE, parseConfigArgs, runConfigCommand } from '../src/configCommand.js';
import { extensionDir, runExtensionCommand } from '../src/extensionCommand.js';
import { encodePairingCode } from '../src/pairing.js';
import { DEFAULT_AUTO_TASK_ACTIONS, DEFAULT_AUTO_TASK_INTERVAL_SECONDS } from '../src/autoTaskVocabulary.js';
import { createServer, listenOnAvailablePort } from '../src/server.js';
import { createSettingsFile } from '../src/settings.js';

const argv = process.argv.slice(2);
// `config` is only a subcommand when written exactly like that; a directory of
// the same name can still be reviewed with `review-markdown ./config`.
if (argv[0] === 'config') await runConfig(argv.slice(1));
// 同じ書き方の約束で `extension` も受けます。拡張機能のフォルダは入れ方によって場所が
// 変わるので、読み込ませる前にパスを引ける口が要ります。
if (argv[0] === 'extension') runSubcommand(runExtensionCommand(argv.slice(1)));

const options = await readOptions();
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const { app, rootDir, filter, liveCaptionsToken, transcripts } = buildServer();
const { server, port } = await startServer();
const url = `http://localhost:${port}`;

console.log(`Markdown / PDF Review is serving ${rootDir}`);
if (options.configSources?.length) console.log(`  config: ${options.configSources.join(', ')}`);
if (filter.include.length) console.log(`  include: ${filter.include.join(', ')}`);
if (filter.exclude.length) console.log(`  exclude: ${filter.exclude.join(', ')}`);
if (options.aiContext) console.log(`  ai context: ${summarize(options.aiContext)}`);
if (options.manager) console.log('  manager: enabled');
if (options.translation) console.log('  translation: enabled');
// 裏でAIを動かし続ける機能なので、どの間隔で何を任せているかまで起動時に見せます。
if (options.autoTasks) console.log(`  auto tasks: enabled (${autoTasksSummary(options)})`);
// モデルを名指ししたときだけ出します。自動で選んだモデルは /api/ai/status が画面へ出します。
for (const [label, value] of aiModelLines(options)) console.log(`  ${label}: ${value}`);
if (port !== options.port) {
  console.log(`Port ${options.port} is already in use; using ${port} instead.`);
}
console.log(`Open ${url}`);
// 拡張機能へ渡すのはこの1本だけです。URLとトークンを別々に運ばせると、片方だけ古い
// まま繋ごうとして「連携エラー」になり、どちらを直せばよいかが画面から分かりません。
console.log('Meet Captions Memo（Google Meetの字幕をこのCLIへ流し込むChrome拡張機能）');
console.log(`  連携コード: ${encodePairingCode({ url, token: liveCaptionsToken })}`);
// 書き込み先を決めるのは拡張機能の側なので、書ける場所は起動のたびに出しておきます。
console.log(`  文字起こし用ファイル: ${transcripts.patterns.join(', ') || '（設定されていません）'}`
  + `${transcripts.isDefault ? '（既定。transcriptFiles で変えられます）' : ''}`);
console.log(`  拡張機能フォルダ: ${extensionDir()}`);
console.log('  読み込ませ方は review-markdown extension、画面からは右上の「Meet連携」で出せます');
if (options.open) openBrowser(url);

server.on('error', (error) => {
  console.error(`Error: server failed on port ${port}: ${error.message}`);
  process.exit(1);
});

let isShuttingDown = false;
const forceExitAfterMs = 500;

process.on('SIGINT', shutdown);

async function runConfig(configArgv) {
  try {
    runSubcommand(await runConfigCommand(parseConfigArgs(configArgv)));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(`\n${CONFIG_USAGE}`);
    return process.exit(1);
  }
}

/** サブコマンドの結果を出して終わります。どのサブコマンドも同じ形で答えます。 */
function runSubcommand({ stdout, stderr, exitCode }) {
  for (const line of stderr) console.error(line);
  for (const line of stdout) console.log(line);
  process.exit(exitCode);
}

async function readOptions() {
  try {
    const parsed = parseArgs(argv, process.env);
    if (parsed.help) return parsed;
    assertTargetDirectory(parsed.targetDir);

    const loaded = await loadConfig({
      targetDir: parsed.targetDir,
      configPath: parsed.configPath,
      useConfig: parsed.useConfig
    });
    for (const warning of loaded.warnings) console.warn(`Warning: ${warning}`);
    return {
      ...applyConfigToOptions(parsed, loaded.config),
      configSources: loaded.sources,
      settingsFile: settingsFileFor(parsed)
    };
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(`\n${USAGE}`);
    return process.exit(1);
  }
}

/**
 * 画面から変えた設定の保存先。`config set --global` と同じユーザー全体の設定ファイル
 * （`--config` で名指ししたときはそのファイル）です。`--no-config` を付けた起動は、
 * 設定ファイルを読まないと言われているので書きもしません。変更は今回の起動限りになります。
 */
function settingsFileFor(parsed) {
  if (!parsed.useConfig) return null;
  return createSettingsFile({
    configPath: parsed.configPath ?? process.env.REVIEW_MARKDOWN_CONFIG,
    targetDir: parsed.targetDir,
    // 今回の起動でコマンドラインが決めたものは、保存しても次の起動まで残りません。
    // 画面で「保存したのに戻る」と見えないよう、保存のたびに知らせます。
    fixedByCommandLine: [
      ...(parsed.translationSource === 'flag' ? ['translation'] : []),
      ...(parsed.autoTasksSource === 'flag' ? ['autoTasks'] : [])
    ]
  });
}

/**
 * 設定の食い違いは、ここで止めます。走らせるAIやモデルが決まらないまま起動すると、
 * レビューを頼んだときになって初めて失敗するので、設定を直す前に一度使わせてしまいます。
 */
function buildServer() {
  try {
    return createServer(options.targetDir, options);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return process.exit(1);
  }
}

async function startServer() {
  try {
    return await listenOnAvailablePort(app, options.port);
  } catch (error) {
    console.error(`Error: failed to start server: ${error.message}`);
    process.exit(1);
  }
}

function shutdown() {
  if (isShuttingDown) {
    process.exit(0);
  }
  isShuttingDown = true;

  const forceExitTimer = setTimeout(() => process.exit(0), forceExitAfterMs);
  forceExitTimer.unref();

  server.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
  server.closeAllConnections();
}

/**
 * 設定ファイルでモデルや推論強度を固定したとき、それが効いていることを起動時に見せます。
 * 設定していないものは自動で選ぶので、何も出しません（画面のAIパネルが実際の値を出します）。
 */
function aiModelLines({ aiProvider, aiModelProvider, aiModels = {} }) {
  return [
    // 既定のままなら出しません。Codex以外を選んだときだけ、どこへ原稿が行くかを見せます。
    ...(aiProvider && aiProvider !== DEFAULT_AI_PROVIDER ? [['ai provider', aiProvider]] : []),
    ...(aiModelProvider ? [['ai model provider', aiModelProvider]] : []),
    ...profileLines('ai model', aiModels.assistant),
    ...profileLines('ai review model', aiModels.review)
  ];
}

/**
 * モデルと推論強度は別々に設定できるので、別々の行にします。
 * 1行にまとめると、推論強度だけを設定したときにモデル名の場所へ強度が出てしまいます。
 */
function profileLines(label, { model, effort } = {}) {
  return [
    ...(model ? [[label, model]] : []),
    ...(effort ? [[`${label.replace(' model', '')} effort`, effort]] : [])
  ];
}

/** 自動タスクの決め事を1行に。見守りの間隔と、任せている自動化の一覧です。 */
function autoTasksSummary({ autoTasksInterval, autoTasksActions }) {
  const interval = autoTasksInterval ?? DEFAULT_AUTO_TASK_INTERVAL_SECONDS;
  const actions = autoTasksActions ?? DEFAULT_AUTO_TASK_ACTIONS;
  return `every ${interval}s; ${actions.length ? actions.join(', ') : 'extract only'}`;
}

/** One line for the startup banner; the whole text still goes to the AI. */
function summarize(text) {
  const firstLine = text.split('\n')[0].trim();
  const rest = text.includes('\n') || firstLine.length > 60;
  return rest ? `${firstLine.slice(0, 60)}…` : firstLine;
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  import('node:child_process').then(({ exec }) => {
    exec(`${command} ${JSON.stringify(url)}`, (error) => {
      if (error) {
        console.log('ブラウザの自動起動に失敗しました。上記URLを手動で開いてください。');
      }
    });
  });
}
