#!/usr/bin/env node
import { assertTargetDirectory, parseArgs, USAGE } from '../src/cli.js';
import { createServer } from '../src/server.js';

const options = readOptions();
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const { app, rootDir, filter } = createServer(options.targetDir, options);
const server = app.listen(options.port, () => {
  const url = `http://localhost:${options.port}`;
  console.log(`Markdown Review is serving ${rootDir}`);
  if (filter.include.length) console.log(`  include: ${filter.include.join(', ')}`);
  if (filter.exclude.length) console.log(`  exclude: ${filter.exclude.join(', ')}`);
  console.log(`Open ${url}`);
  if (options.open) openBrowser(url);
});

server.on('error', (error) => {
  console.error(`Error: failed to start server on port ${options.port}: ${error.message}`);
  process.exit(1);
});

let isShuttingDown = false;
const forceExitAfterMs = 500;

process.on('SIGINT', shutdown);

function readOptions() {
  try {
    const parsed = parseArgs(process.argv.slice(2), process.env);
    if (!parsed.help) assertTargetDirectory(parsed.targetDir);
    return parsed;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(`\n${USAGE}`);
    return process.exit(1);
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
