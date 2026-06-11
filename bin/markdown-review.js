#!/usr/bin/env node
import { createServer } from '../src/server.js';

const args = process.argv.slice(2);
let targetDir = '.';
let port = Number(process.env.PORT || 3000);
let shouldOpen = true;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--port' || arg === '-p') {
    port = Number(args[i + 1]);
    i += 1;
  } else if (arg === '--no-open') {
    shouldOpen = false;
  } else if (!arg.startsWith('-')) {
    targetDir = arg;
  }
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

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

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
