import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { extensionDir } from '../src/extensionCommand.js';

const SYNC_SETTINGS_KEY = 'meetCaptionsMemo_liveSync';

test('字幕の追記通信はbackground service workerからlocalhostへ送る', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir(), 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'background.js');

  const worker = await loadWorker({ servers: { 'http://localhost:3210': { token: 'captions-token' } } });

  const result = await worker.send({
    type: 'APPEND_LIVE_CAPTION',
    serverUrl: 'http://localhost:3210',
    token: 'captions-token',
    body: { path: 'meeting.md', speaker: 'A', text: 'hello' }
  });

  assert.equal(result.ok, true);
  assert.equal(worker.requests[0].url, 'http://localhost:3210/api/live-captions/append');
  assert.equal(worker.requests[0].options.headers['X-Review-Markdown-Live-Captions-Token'], 'captions-token');
  assert.equal(JSON.parse(worker.requests[0].options.body).text, 'hello');
});

test('background service workerはlocalhost以外へ字幕を送らない', async () => {
  const worker = await loadWorker();

  const result = await worker.send({
    type: 'APPEND_LIVE_CAPTION', serverUrl: 'https://example.com', token: 'x', body: { text: 'secret' }
  });
  assert.equal(result.ok, false);
  assert.equal(worker.requests.length, 0, '行き先が読めない設定では、探し直しもせず一切通信しない');
});

/**
 * 連携コードは起動のたびに変わります。人が貼って運ぶ限り「貼り直し忘れた回だけ記録が
 * 残らない」が必ず起きるので、拡張機能の側が探して取りに行きます。
 */
test('動いているreview-markdownを見つけて、連携設定を自分で埋める', async () => {
  const worker = await loadWorker({
    servers: { 'http://127.0.0.1:3001': { token: 'found-token', rootDir: 'book' } }
  });

  const found = await worker.send({ type: 'REQUEST_PAIRING' });

  assert.equal(found.ok, true);
  assert.equal(found.serverUrl, 'http://127.0.0.1:3001');
  assert.deepEqual({ ...worker.stored[SYNC_SETTINGS_KEY] }, {
    enabled: true,
    serverUrl: 'http://127.0.0.1:3001',
    token: 'found-token',
    path: '',
    autoPath: true
  }, '貼らずに繋がり、書き込み先は会議ごとの既定になる');
});

test('開いているreview-markdownのタブがあれば、既定のポートを探さずにそこへ繋ぐ', async () => {
  const worker = await loadWorker({
    servers: { 'http://localhost:8123': { token: 'tab-token' } },
    tabs: [{ url: 'http://localhost:8123/?file=guide.md' }]
  });

  const found = await worker.send({ type: 'REQUEST_PAIRING' });

  assert.equal(found.serverUrl, 'http://localhost:8123', '既定と違うポートでも、開いていれば見つかる');
  assert.deepEqual(
    worker.requests.map(({ url }) => url),
    ['http://localhost:8123/api/live-captions/pairing'],
    '当たりが分かっているときは、他のポートを叩かない'
  );
});

test('名乗ったURLが叩いた先と違う相手は、連携先にしない', async () => {
  const worker = await loadWorker({
    servers: { 'http://127.0.0.1:3000': { token: 'liar-token', serverUrl: 'http://127.0.0.1:9999' } }
  });

  const found = await worker.send({ type: 'REQUEST_PAIRING' });

  assert.equal(found.ok, false);
  assert.equal(worker.stored[SYNC_SETTINGS_KEY], undefined, '身元の合わない相手へ原稿を送り始めない');
});

test('自分で連携を切った人の設定は、探し当てても戻さない', async () => {
  const worker = await loadWorker({
    servers: { 'http://127.0.0.1:3000': { token: 'found-token' } },
    storage: {
      [SYNC_SETTINGS_KEY]: { enabled: false, enabledByUser: true, path: 'meet-captions/today.md', autoPath: false }
    }
  });

  const found = await worker.send({ type: 'REQUEST_PAIRING' });

  assert.equal(found.ok, true);
  const sync = worker.stored[SYNC_SETTINGS_KEY];
  assert.equal(sync.enabled, false, '切った設定が復活するのは、直したつもりのものが直っていないのと同じ');
  assert.equal(sync.token, 'found-token', 'トークンは新しくしておく（有効にした瞬間から送れる）');
  assert.equal(sync.path, 'meet-captions/today.md', '選んだ書き込み先はそのまま残す');
  assert.equal(sync.autoPath, false);
});

test('自動で探すのを切っていたら、localhostを一切叩かない', async () => {
  const worker = await loadWorker({
    servers: { 'http://127.0.0.1:3000': { token: 'found-token' } },
    storage: { [SYNC_SETTINGS_KEY]: { autoPair: false } }
  });

  const found = await worker.send({ type: 'REQUEST_PAIRING' });

  assert.equal(found.ok, false);
  assert.equal(found.reason, 'off');
  assert.equal(worker.requests.length, 0);
});

/**
 * 会議の途中でreview-markdownを立ち上げ直すと、トークンもポートも変わります。
 * 気づいて貼り直すまでの発言が丸ごと落ちるので、断られた1行はその場で繋ぎ直して送り直します。
 */
test('トークンが古くて断られたら、繋ぎ直してその1行から送り直す', async () => {
  const worker = await loadWorker({
    servers: { 'http://127.0.0.1:3002': { token: 'new-token' } }
  });

  const result = await worker.send({
    type: 'APPEND_LIVE_CAPTION',
    serverUrl: 'http://localhost:3000',
    token: 'old-token',
    body: { path: 'meet-captions/today.md', speaker: 'A', text: '聞き逃せない発言' }
  });

  assert.equal(result.ok, true, '立ち上げ直しに気づくまでの発言を落とさない');
  assert.equal(result.repaired, true);
  const appends = worker.requests.filter(({ url }) => url.endsWith('/append'));
  assert.equal(appends.length, 2, '同じ1行を、新しい連携先へ送り直す');
  assert.equal(appends[1].url, 'http://127.0.0.1:3002/api/live-captions/append');
  assert.equal(appends[1].options.headers['X-Review-Markdown-Live-Captions-Token'], 'new-token');
  assert.equal(JSON.parse(appends[1].options.body).text, '聞き逃せない発言');
});

/* ---------------------------------------------------------------- *
 * 差し替え口
 * ---------------------------------------------------------------- */

/**
 * service workerを本物のまま動かします。差し替えるのはchrome APIとfetchだけです。
 *
 * @param {object} [options]
 * @param {object} [options.servers] 動いているlocalhost。`{ [origin]: { token, rootDir, serverUrl } }`
 * @param {object} [options.storage] chrome.storage.local の初期値。
 * @param {object[]} [options.tabs] 開いているlocalhostのタブ。
 */
async function loadWorker({ servers = {}, storage = {}, tabs = [] } = {}) {
  const stored = { ...storage };
  const requests = [];
  let onMessage;

  const sandbox = {
    URL,
    Set,
    JSON,
    AbortSignal,
    console,
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { onMessage = fn; } },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} }
      },
      storage: {
        local: {
          async get(key) {
            return key in stored ? { [key]: stored[key] } : {};
          },
          async set(values) {
            Object.assign(stored, values);
          }
        }
      },
      tabs: { async query() { return tabs; } }
    },
    async fetch(url, options = {}) {
      requests.push({ url, options });
      return respond(String(url), options, servers);
    }
  };
  vm.runInNewContext(await fs.readFile(path.join(extensionDir(), 'background.js'), 'utf8'), sandbox);

  return {
    stored,
    requests,
    send: (message) => new Promise((resolve) => {
      assert.equal(onMessage(message, {}, resolve), true, '非同期応答の通信路を維持する');
    })
  };
}

/** 動いているlocalhostのふりをします。動いていないポートは、繋がらなかったことにします。 */
function respond(url, options, servers) {
  const origin = url.slice(0, url.indexOf('/api/'));
  const server = servers[origin];
  if (!server) throw new Error('connection refused');

  if (url.endsWith('/api/live-captions/pairing')) {
    return jsonResponse({
      ok: true,
      serverUrl: server.serverUrl || origin,
      token: server.token,
      rootDir: server.rootDir || 'book',
      transcriptFiles: server.transcriptFiles || ['meet-captions', '*.transcript.md']
    });
  }
  const sent = options.headers?.['X-Review-Markdown-Live-Captions-Token'];
  if (sent !== server.token) return { ok: false, status: 403, async json() { return {}; } };
  return jsonResponse({ ok: true });
}

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return body; } };
}
