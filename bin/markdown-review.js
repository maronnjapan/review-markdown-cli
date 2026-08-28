#!/usr/bin/env node
import { assertTargetDirectory, parseArgs, USAGE } from '../src/cli.js';
import { applyConfigToOptions, loadConfig } from '../src/config.js';
import { CONFIG_USAGE, parseConfigArgs, runConfigCommand } from '../src/configCommand.js';
import { createServer, listenOnAvailablePort } from '../src/server.js';

const argv = process.argv.slice(2);
// `config` is only a subcommand when written exactly like that; a directory of
// the same name can still be reviewed with `review-markdown ./config`.
if (argv[0] === 'config') await runConfig(argv.slice(1));

const options = await readOptions();
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const { app, rootDir, filter } = createServer(options.targetDir, options);
const { server, port } = await startServer();
const url = `http://localhost:${port}`;

console.log(`Markdown Review is serving ${rootDir}`);
if (options.configSources?.length) console.log(`  config: ${options.configSources.join(', ')}`);
if (filter.include.length) console.log(`  include: ${filter.include.join(', ')}`);
if (filter.exclude.length) console.log(`  exclude: ${filter.exclude.join(', ')}`);
if (options.aiContext) console.log(`  ai context: ${summarize(options.aiContext)}`);
// モデルを名指ししたときだけ出します。自動で選んだモデルは /api/ai/status が画面へ出します。
for (const [label, value] of aiModelLines(options)) console.log(`  ${label}: ${value}`);
if (port !== options.port) {
  console.log(`Port ${options.port} is already in use; using ${port} instead.`);
}
console.log(`Open ${url}`);
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
    const result = await runConfigCommand(parseConfigArgs(configArgv));
    for (const line of result.stderr) console.error(line);
    for (const line of result.stdout) console.log(line);
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(`\n${CONFIG_USAGE}`);
    return process.exit(1);
  }
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
    return { ...applyConfigToOptions(parsed, loaded.config), configSources: loaded.sources };
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(`\n${USAGE}`);
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
function aiModelLines({ aiModels = {} }) {
  return [
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
