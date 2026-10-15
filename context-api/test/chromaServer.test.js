import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromaRunArgs, resolveChromaCli, startChromaServer } from '../src/chromaServer.js';
import { readConfig } from '../src/config.js';
import { createChromaVectorStore } from '../src/vectorStores/chroma.js';

/**
 * npmパッケージ（`chromadb`）からChromaDBを立ち上げる口のテストです。
 *
 * 立ち上げ方・待ち方・止め方は、本物の代わりに「同じ引数を受け取って同じ心拍を返す」小さな
 * スクリプトで確かめます。本物のChromaDBは、`chromadb` パッケージが入っているとき（`npm install`
 * 済み）だけ最後に1回立ち上げ、索引の読み書きが通ることを見ます。
 */

const quiet = { write() {} };

test('chroma run の引数は、CHROMA_URL の待ち受け先と索引の置き場所から組む', () => {
  assert.deepEqual(
    chromaRunArgs({ dataPath: '/var/chroma' }),
    ['run', '--path', '/var/chroma', '--host', '127.0.0.1', '--port', '8000']
  );
  assert.deepEqual(
    chromaRunArgs({ url: 'http://localhost:9000/', dataPath: '/var/chroma' }),
    ['run', '--path', '/var/chroma', '--host', 'localhost', '--port', '9000']
  );
  // この端末の外へは出しません。ChromaDBは認証を持たず、保存した判断が丸ごと読めるからです。
  assert.throws(() => chromaRunArgs({ url: 'http://0.0.0.0:8000', dataPath: '/var/chroma' }), /この端末/);
  assert.throws(() => chromaRunArgs({ url: 'https://127.0.0.1:8000', dataPath: '/var/chroma' }), /http:\/\//);
  assert.throws(() => chromaRunArgs({ url: 'not a url', dataPath: '/var/chroma' }), /URLではありません/);
});

test('chromadb パッケージが無ければ、npm install を案内して断る', async (t) => {
  // 置き場所を探す起点を空のディレクトリにすると、そこから上へ辿っても node_modules/chromadb は無い、という状況になります。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-chromadb-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.throws(() => resolveChromaCli({ from: pathToFileURL(path.join(dir, 'x.js')).href }), /npm install/);
});

test('CHROMA_SERVER=npm は設定として読め、索引の置き場所は正本の隣が既定', () => {
  const config = readConfig({ CHROMA_SERVER: 'npm', CONTEXT_DATA_DIR: '/srv/context' });
  assert.equal(config.chroma.server, 'npm');
  assert.equal(config.chroma.url, 'http://127.0.0.1:8000');
  assert.equal(config.chroma.path, path.resolve('/srv/context', 'chroma'));

  assert.equal(readConfig({}).chroma.server, 'external', '既定は、誰かが立てたものへ繋ぐ');
  assert.equal(readConfig({ CHROMA_PATH: './index', CHROMA_URL: 'http://localhost:9000' }).chroma.path, path.resolve('./index'));
  assert.equal(readConfig({ CHROMA_URL: 'http://localhost:9000' }).chroma.url, 'http://localhost:9000');
  assert.throws(() => readConfig({ CHROMA_SERVER: 'docker' }), /external か npm/);
  // 1ファイルの索引を選んでいるのにChromaDBを立ち上げるのは、設定の食い違いです。起動時に断ります。
  assert.throws(() => readConfig({ CHROMA_SERVER: 'npm', VECTOR_DB: 'local' }), /VECTOR_DB=chroma/);
});

test('ポートは CONTEXT_API_PORT、無ければ PaaS が渡す PORT、それも無ければ 8765', () => {
  assert.equal(readConfig({}).port, 8765);
  assert.equal(readConfig({ PORT: '8080' }).port, 8080);
  assert.equal(readConfig({ PORT: '8080', CONTEXT_API_PORT: '9000' }).port, 9000);
});

test('立ち上げたら心拍が返るまで待ち、止めれば終わる', async (t) => {
  const { cli, dataPath, url } = await fakeChroma(t);
  const logs = [];
  const chroma = await startChromaServer({
    cli, dataPath, url, waitSeconds: 10, output: quiet,
    log: (line) => logs.push(line),
    // 本物と同じく、立ち上がるまでに少し掛かります。心拍が返るまで待ってから返ることを見ます。
    env: { ...process.env, FAKE_DELAY_MS: '400' }
  });
  t.after(() => chroma.stop());

  assert.ok(logs.some((line) => line.includes('立ち上げています')), '立ち上げていることを起動ログに出す');
  assert.ok((await fs.stat(dataPath)).isDirectory(), '索引の置き場所は無ければ作る');
  assert.equal((await fetch(`${url}/api/v2/heartbeat`)).status, 200);

  await chroma.stop();
  await assert.rejects(() => fetch(`${url}/api/v2/heartbeat`), '止めたあとは待ち受けていない');
});

test('心拍が返る前に終わったら、stderr の理由ごと断る', async (t) => {
  // ポートが塞がっているときのChroma（3.5.0）と同じく、理由をstderrに出して終了コード0で終わります。
  const { cli, dataPath, url } = await fakeChroma(t, { script: FAILING_SCRIPT });
  await assert.rejects(
    () => startChromaServer({ cli, dataPath, url, waitSeconds: 10, output: quiet }),
    (error) => {
      assert.match(error.message, /立ち上がる前に終わりました（終了コード 0）/);
      assert.match(error.message, /Address 127\.0\.0\.1:1 is not available/, '終了コードでは分からないので、stderrを添える');
      return true;
    }
  );
});

test('既に待ち受けているものがあれば、立ち上げずに断る', async (t) => {
  const { cli, dataPath, url, port } = await fakeChroma(t);
  const other = http.createServer((request, response) => { response.writeHead(200); response.end('{}'); });
  other.listen(port, '127.0.0.1');
  await new Promise((resolve) => other.once('listening', resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));

  let spawned = false;
  await assert.rejects(
    () => startChromaServer({ cli, dataPath, url, waitSeconds: 10, output: quiet, spawnImpl: () => { spawned = true; } }),
    /既にChromaDBが待ち受けています/
  );
  assert.equal(spawned, false, '先にいたほうが心拍に答えて「立ち上がった」ことになるので、立ち上げる前に断る');
});

test('SIGINT で終わらなければ SIGKILL で止める', async (t) => {
  const { cli, dataPath, url } = await fakeChroma(t);
  const chroma = await startChromaServer({
    cli, dataPath, url, waitSeconds: 10, output: quiet, stopTimeoutMs: 300,
    env: { ...process.env, FAKE_IGNORE_SIGINT: '1' }
  });
  const started = Date.now();
  await chroma.stop();
  assert.ok(Date.now() - started < 5000, '待ち時間を過ぎたら強制終了へ切り替える');
  await assert.rejects(() => fetch(`${url}/api/v2/heartbeat`));
});

test('立ち上がったあとに落ちたら、知らせる', async (t) => {
  const { cli, dataPath, url } = await fakeChroma(t);
  const exits = [];
  const chroma = await startChromaServer({
    cli, dataPath, url, waitSeconds: 10, output: quiet,
    onExit: (info) => exits.push(info),
    env: { ...process.env, FAKE_DIE_AFTER_MS: '300' }
  });
  t.after(() => chroma.stop());
  const deadline = Date.now() + 5000;
  while (exits.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 3);
  assert.match(exits[0].stderr, /boom/, '落ちた理由（stderrの末尾）を添える');

  // こちらから止めたときは知らせません。終了の知らせは「止めていないのに終わった」ときだけです。
  const { cli: cli2, dataPath: dataPath2, url: url2 } = await fakeChroma(t);
  const exits2 = [];
  const chroma2 = await startChromaServer({ cli: cli2, dataPath: dataPath2, url: url2, waitSeconds: 10, output: quiet, onExit: (info) => exits2.push(info) });
  await chroma2.stop();
  assert.equal(exits2.length, 0);
});

const hasChromadb = (() => {
  try {
    resolveChromaCli();
    return true;
  } catch {
    return false;
  }
})();

test(
  '本物のChromaDB（chromadb パッケージ）を立ち上げて、索引の読み書きが通る',
  { skip: hasChromadb ? false : 'chromadb パッケージが入っていません（context-api で npm install すると走ります）', timeout: 120_000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chroma-real-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const url = `http://127.0.0.1:${await freePort()}`;
    const chroma = await startChromaServer({ dataPath: path.join(dir, 'index'), url, waitSeconds: 90, output: quiet });
    t.after(() => chroma.stop());

    const store = createChromaVectorStore({ endpoint: url, collection: 'contexts' });
    await store.ready();
    const unit = (axis) => Array.from({ length: 8 }, (_, index) => (index === axis ? 1 : 0));
    await store.upsert([
      { id: 'c1#0', vector: unit(0), text: 'OIDCを使う', contextId: 'c1', metadata: { source: 'context', scope_key: 'ws:W', scope_path: null } },
      { id: 'p1#0', vector: unit(1), text: 'トークンの有効期限', contextId: 'p1', metadata: { source: 'page', scope_key: 'ws:W' } }
    ]);
    assert.equal(await store.count(), 2);

    const hits = await store.query({ vector: unit(0), limit: 5, scopeKeys: ['ws:W'], sources: ['context'] });
    assert.deepEqual(hits.map((hit) => hit.contextId), ['c1'], '出どころと範囲で絞れる');
    assert.ok(hits[0].score > 0.99, 'コサイン距離を「大きいほど近い」へ直して読む');

    // 入れたものを、入れた形のまま読めます（画面の「索引」が使う口）。ベクトルも返ります。
    const listed = await store.list({ vectors: true });
    assert.equal(listed.total, 2);
    const c1 = listed.chunks.find((chunk) => chunk.id === 'c1#0');
    assert.equal(c1.text, 'OIDCを使う');
    assert.equal(c1.contextId, 'c1');
    assert.equal(c1.metadata.source, 'context');
    assert.deepEqual(c1.vector.map((value) => Math.round(value)), unit(0), 'ベクトルは入れた値のまま');
    const pagesOnly = await store.list({ sources: ['page'] });
    assert.equal(pagesOnly.total, 1, '絞ったときの全体の数も本物から読める');
    assert.deepEqual(pagesOnly.chunks.map((chunk) => chunk.id), ['p1#0']);
    assert.equal((await store.list({ contextId: 'c1' })).chunks.length, 1);

    await store.deleteByContext('c1');
    assert.equal(await store.count(), 1);
  }
);

/* ---------------------------------------------------------------- *
 * ChromaDBの代わり（`chroma run` と同じ引数を受け取り、同じ心拍を返す）
 * ---------------------------------------------------------------- */

const OK_SCRIPT = `
import http from 'node:http';
const args = process.argv.slice(2);
if (args[0] !== 'run' || !args.includes('--path')) {
  console.error('expected: run --path <dir> --host <host> --port <port>, got: ' + args.join(' '));
  process.exit(2);
}
const option = (name) => args[args.indexOf(name) + 1];
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/api/v2/heartbeat' ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end('{}');
});
setTimeout(() => server.listen(Number(option('--port')), option('--host')), Number(process.env.FAKE_DELAY_MS || 0));
process.on('SIGINT', () => {
  if (!process.env.FAKE_IGNORE_SIGINT) process.exit(0);
});
if (process.env.FAKE_DIE_AFTER_MS) {
  setTimeout(() => { console.error('boom'); process.exit(3); }, Number(process.env.FAKE_DIE_AFTER_MS));
}
`;

const FAILING_SCRIPT = `
console.error('Address 127.0.0.1:1 is not available');
process.exit(0);
`;

async function fakeChroma(t, { script = OK_SCRIPT } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chroma-fake-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'fake-chroma.mjs');
  await fs.writeFile(cli, script);
  const port = await freePort();
  return { cli, dataPath: path.join(dir, 'index'), port, url: `http://127.0.0.1:${port}` };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
