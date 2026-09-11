#!/usr/bin/env node
/**
 * Context API の起動口です。
 *
 * 設定は環境変数から読みます（`src/config.js`）。既定の動かし方は
 * `docker compose up` で、ChromaDB と一緒に立ち上がります。
 */
import { readConfig } from '../src/config.js';
import { createContextApi } from '../src/server.js';

const config = readConfig();
const api = createContextApi(config);

// 待ち受ける前に、索引まで繋がることを確かめます。繋がらないまま受け付けると、
// 最初の保存で初めて失敗し、そのときにはもう「保存できたつもり」のユーザーがいます。
let ready;
try {
  ready = await api.store.ready({
    waitSeconds: config.waitForVectorDbSeconds,
    onWait: (line) => console.log(line)
  });
} catch (error) {
  console.error(`Error: 索引へ繋がりませんでした: ${error.message}`);
  console.error('  docker compose up -d で ChromaDB ごと立ち上がります。');
  console.error('  Dockerを使わずに試すときは VECTOR_DB=local を付けてください。');
  process.exit(1);
}

const server = api.listen(config.port, { host: config.host });
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});

const port = server.address().port;
console.log(`Context API is serving http://${config.host}:${port}`);
console.log(`  data: ${config.dataDir}`);
console.log(`  embedding: ${api.store.embedder.label}`);
console.log(`  vector db: ${api.store.vectorStore.label}`);
if (config.token) console.log('  auth: Authorization: Bearer <CONTEXT_API_TOKEN>');
if (ready.reindexed) console.log(`  埋め込みが変わったので、保存済みの${ready.reindexed}件を作り直しました`);
console.log(`  CLIから使うには: review-markdown config set contextEndpoint http://127.0.0.1:${port} --global`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
