#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { createServer } from '../src/server.js';

const args = process.argv.slice(2);
let targetDir = '.';
let port = Number(process.env.PORT || 3000);
let shouldOpen = true;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    printUsage();
    process.exit(0);
  }
  if (arg === '--port' || arg === '-p') {
    port = Number(args[i + 1]);
    i += 1;
  } else if (arg === '--no-open') {
    shouldOpen = false;
  } else if (!arg.startsWith('-')) {
    targetDir = arg;
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Error: --port must be an integer between 1 and 65535.');
  process.exit(1);
}

if (!existsSync(targetDir)) {
  console.error(`Error: target directory not found: ${targetDir}`);
  process.exit(1);
}

if (!statSync(targetDir).isDirectory()) {
  console.error(`Error: target must be a directory: ${targetDir}`);
  process.exit(1);
}

const { app, rootDir } = createServer(targetDir);
const server = app.listen(port, () => {
  const url = `http://localhost:${port}`;
  console.log(`Markdown Review is serving ${rootDir}`);
  console.log(`Open ${url}`);
  if (shouldOpen) {
    openBrowser(url);
  }
});

server.on('error', (error) => {
  console.error(`Error: failed to start server on port ${port}: ${error.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

function printUsage() {
  console.log('Usage: review-markdown [targetDir] [--port 3000] [--no-open]');
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
