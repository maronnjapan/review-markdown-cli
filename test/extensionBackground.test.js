import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { extensionDir } from '../src/extensionCommand.js';

test('字幕の追記通信はbackground service workerからlocalhostへ送る', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir(), 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'background.js');

  let listener;
  const requests = [];
  const sandbox = {
    URL,
    Set,
    JSON,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    }
  };
  vm.runInNewContext(await fs.readFile(path.join(extensionDir(), 'background.js'), 'utf8'), sandbox);

  const result = await sendMessage(listener, {
    type: 'APPEND_LIVE_CAPTION',
    serverUrl: 'http://localhost:3210',
    token: 'captions-token',
    body: { path: 'meeting.md', speaker: 'A', text: 'hello' }
  });

  assert.equal(result.ok, true);
  assert.equal(requests[0].url, 'http://localhost:3210/api/live-captions/append');
  assert.equal(requests[0].options.headers['X-Review-Markdown-Live-Captions-Token'], 'captions-token');
  assert.equal(JSON.parse(requests[0].options.body).text, 'hello');
});

test('background service workerはlocalhost以外へ字幕を送らない', async () => {
  let listener;
  let fetched = false;
  const sandbox = {
    URL,
    Set,
    JSON,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    async fetch() { fetched = true; }
  };
  vm.runInNewContext(await fs.readFile(path.join(extensionDir(), 'background.js'), 'utf8'), sandbox);

  const result = await sendMessage(listener, {
    type: 'APPEND_LIVE_CAPTION', serverUrl: 'https://example.com', token: 'x', body: { text: 'secret' }
  });
  assert.equal(result.ok, false);
  assert.equal(fetched, false);
});

function sendMessage(listener, message) {
  return new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true, '非同期応答の通信路を維持する');
  });
}
