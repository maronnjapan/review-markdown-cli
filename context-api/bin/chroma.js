#!/usr/bin/env node
/**
 * ChromaDBだけを、npmパッケージ（`chromadb`）から立ち上げます（`npm run chroma`）。
 *
 * `npm start` は `CHROMA_SERVER=npm` で自分でChromaDBを立ち上げられるので、普段はこちらは
 * 要りません。索引だけを先に立てておきたいとき（Context APIを何度も立ち上げ直す、
 * 別のツールからも同じChromaDBを覗く）のための口です。
 *
 * 設定は `npm start` と同じ環境変数から読みます（`src/config.js`）。待ち受け先は `CHROMA_URL`、
 * 索引の置き場所は `CHROMA_PATH`（既定は `CONTEXT_DATA_DIR` の下の `chroma/`）です。
 * 同じ変数を見るので、ここで立てたものへ `npm start` は既定のまま繋がります。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromaRunArgs, resolveChromaCli } from '../src/chromaServer.js';
import { readConfig } from '../src/config.js';

const config = readConfig();
let cli;
let args;
try {
  cli = resolveChromaCli();
  args = chromaRunArgs({ url: config.chroma.url, dataPath: config.chroma.path });
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

fs.mkdirSync(config.chroma.path, { recursive: true });
console.log(`ChromaDB ${cli.version}（npmパッケージ chromadb）を立ち上げます`);
console.log(`  url: ${config.chroma.url}`);
console.log(`  索引: ${config.chroma.path}`);
console.log('  Context API からは、このまま npm start で繋がります（CHROMA_URL が同じなので）');

// 画面にそのまま出します。既定の RUST_LOG=info は要求のたびにログが出るので warn にします
// （ログを見たいときは RUST_LOG=info を付けてください）。
const child = spawn(process.execPath, [cli.cli, ...args], {
  stdio: 'inherit',
  env: { RUST_LOG: 'warn', ...process.env }
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// SIGTERMではChromaが終わらない（`src/chromaServer.js`）ので、どちらもSIGINTに直して渡します。
// `npm run chroma` 越しにSIGTERMを送ると、npmだけが終わってこのプロセスには届きません（npmの振る舞い）。
// 止めるのはCtrl-C（端末がプロセスの組ごとSIGINTを送る）か、このプロセスへ直接の `kill` です。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill('SIGINT'));
}
