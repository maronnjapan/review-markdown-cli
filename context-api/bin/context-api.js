#!/usr/bin/env node
/**
 * Context API の起動口です。
 *
 * 設定は環境変数から読みます（`src/config.js`）。既定の動かし方は
 * `docker compose up` で、ChromaDB と一緒に立ち上がります。
 * Docker を使わないときは `CHROMA_SERVER=npm` で、npm パッケージ（`chromadb`）に同梱された
 * ChromaDB をこのプロセスが立ち上げ、終了時に止めます（`src/chromaServer.js`）。
 */
import { startChromaServer } from '../src/chromaServer.js';
import { readConfig } from '../src/config.js';
import { createContextApi } from '../src/server.js';

const config = readConfig();
const api = createContextApi(config);

let server = null;
let shuttingDown = false;

/** 受け付けを閉じ、自分で立ち上げた ChromaDB があれば止めてから終わります。 */
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (chroma) await chroma.stop();
  process.exit(code);
}

// 索引を自分で立ち上げる場合（CHROMA_SERVER=npm）。繋ぐ先は CHROMA_URL と同じです。
let chroma = null;
if (config.chroma.server === 'npm') {
  try {
    chroma = await startChromaServer({
      url: config.chroma.url,
      dataPath: config.chroma.path,
      waitSeconds: config.waitForVectorDbSeconds,
      log: (line) => console.log(line),
      onExit: ({ code, signal }) => {
        // 索引が無いまま受け付けても、保存は全部 503 です。黙って動き続けるより、止まって気付かせます。
        const reason = code === null ? `シグナル ${signal}` : `終了コード ${code}`;
        console.error(`Error: ChromaDB が終了しました（${reason}）。索引なしでは続けられないので止めます。`);
        shutdown(1);
      }
    });
  } catch (error) {
    console.error(`Error: ChromaDB を立ち上げられませんでした: ${error.message}`);
    console.error('  context-api で npm install を済ませているか、CHROMA_URL のポートが空いているかを確かめてください。');
    process.exit(1);
  }
}

// 待ち受ける前に、索引まで繋がることを確かめます。繋がらないまま受け付けると、
// 最初の保存で初めて失敗し、そのときにはもう「保存できたつもり」のユーザーがいます。
let ready;
try {
  ready = await api.ready({
    waitSeconds: config.waitForVectorDbSeconds,
    onWait: (line) => console.log(line)
  });
} catch (error) {
  console.error(`Error: 索引へ繋がりませんでした: ${error.message}`);
  console.error('  docker compose up -d で ChromaDB ごと立ち上がります。');
  console.error('  Docker を使わないときは CHROMA_SERVER=npm で、npm パッケージの ChromaDB をこのプロセスが立ち上げます（npm install が要ります）。');
  console.error('  索引を1ファイルで済ませるときは VECTOR_DB=local を付けてください。');
  await shutdown(1);
}

server = api.listen(config.port, { host: config.host });
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
}).catch(async (error) => {
  console.error(`Error: ${config.host}:${config.port} で待ち受けられませんでした: ${error.message}`);
  await shutdown(1);
});

const port = server.address().port;
const shownHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
console.log(`Context API is serving http://${config.host}:${port}`);
console.log(`  data: ${config.dataDir}`);
console.log(`  embedding: ${api.store.embedder.label}`);
console.log(`  vector db: ${api.store.vectorStore.label}`);
if (chroma) console.log(`  chroma: npm パッケージから立ち上げました（索引: ${chroma.dataPath}）`);
console.log(`  answer: ${api.chatModel ? api.chatModel.label : '生成しない（CHAT_PROVIDER 未設定。検索だけ使えます）'}`);
if (config.token) console.log('  auth: Authorization: Bearer <CONTEXT_API_TOKEN>');
if (!config.token && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  // 端末の外へ置く（デプロイする）ときの付け忘れを、起動ログで気付かせます。docker compose は
  // 公開ポートを 127.0.0.1 へ縛っているので、そこでは見えても構いません。
  console.log('  注意: この端末の外からも届く設定（CONTEXT_API_HOST）ですが、CONTEXT_API_TOKEN がありません。docker compose のように公開ポートを 127.0.0.1 へ縛っていないなら、設定してください');
}
if (ready.reindexed) console.log(`  埋め込みか索引の形が変わったので、保存済みの${ready.reindexed}件（判断${ready.contexts}件、ページ${ready.pages}件）を作り直しました`);
if (config.ui) console.log(`  画面（ページと検索）: http://${shownHost}:${port}/`);
console.log(`  MCP（Claude Code など）: claude mcp add --transport http knowledge http://${shownHost}:${port}/mcp`);
console.log(`  CLIから使うには: review-markdown config set contextEndpoint http://${shownHost}:${port} --global`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
