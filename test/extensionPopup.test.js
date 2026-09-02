import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extensionDir } from '../src/extensionCommand.js';
import { encodePairingCode } from '../src/pairing.js';

const SYNC_SETTINGS_KEY = 'meetCaptionsMemo_liveSync';

/**
 * ポップアップは、CLIと繋ぐ手順そのものです。ここが壊れると、CLI側がいくら正しくても
 * 繋がりません。拡張機能はブラウザでしか動かないので、jsdomの上で本物のHTMLとスクリプトを
 * そのまま動かして確かめます。
 */
test('連携コードを貼ると接続先が出て、確認してから保存できる', async () => {
  const code = encodePairingCode({ url: 'http://localhost:3210', token: 'captions-token' });
  const { document, stored, requests } = await openPopup();

  const codeInput = document.getElementById('syncCode');
  codeInput.value = code;
  codeInput.dispatchEvent(new document.defaultView.Event('input'));
  assert.equal(
    document.getElementById('syncPairing').textContent,
    '接続先: http://localhost:3210',
    '貼ったコードが何を指しているかを、繋ぐ前に見せる'
  );

  document.getElementById('syncTest').click();
  await waitFor(() => document.getElementById('syncStatus').dataset.state === 'ok');
  assert.match(document.getElementById('syncStatus').textContent, /繋がりました: book に書き込みます/);
  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    ['/api/live-captions/ping', '/api/live-captions/targets'],
    '確認は書き込まない窓口だけを叩く'
  );
  assert.equal(requests[0].headers['X-Review-Markdown-Live-Captions-Token'], 'captions-token');
  assert.deepEqual(
    [...document.querySelectorAll('#syncPathOptions option')].map((option) => option.value),
    ['guide.md', 'notes/today.md'],
    '書き込み先の候補が出るので、パスを手で打たなくてよい'
  );

  document.getElementById('syncEnabled').checked = true;
  document.getElementById('syncPath').value = 'notes/today.md';
  document.getElementById('syncForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
  await waitFor(() => stored[SYNC_SETTINGS_KEY]);

  // ブラウザ側のrealmで作られた物なので、こちらへ写してから比べます。
  assert.deepEqual({ ...stored[SYNC_SETTINGS_KEY] }, {
    enabled: true,
    serverUrl: 'http://localhost:3210',
    token: 'captions-token',
    path: 'notes/today.md',
    autoPath: false
  }, 'コード1本から、URLとトークンがほどけて保存される');
});

test('読めないコードのまま有効にしようとしたら、保存せずに理由を出す', async () => {
  const { document, stored } = await openPopup();

  document.getElementById('syncEnabled').checked = true;
  document.getElementById('syncCode').value = 'live-captions-token';
  document.getElementById('syncForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
  await waitFor(() => document.getElementById('syncStatus').dataset.state === 'error');

  assert.match(document.getElementById('syncStatus').textContent, /形式が違います/);
  assert.equal(stored[SYNC_SETTINGS_KEY], undefined, '繋がらないと分かっている設定は書き込まない');
});

test('保存済みの設定は、貼ったコードの形に戻して見せる', async () => {
  const code = encodePairingCode({ url: 'http://127.0.0.1:3000', token: 'saved-token' });
  const { document } = await openPopup({
    [SYNC_SETTINGS_KEY]: {
      enabled: true,
      serverUrl: 'http://127.0.0.1:3000',
      token: 'saved-token',
      path: '',
      autoPath: true
    }
  });

  assert.equal(document.getElementById('syncCode').value, code, '立ち上げ直したあと、貼り直したかを見分けられる');
  assert.equal(document.getElementById('syncEnabled').checked, true);
  assert.equal(document.getElementById('syncAutoPath').checked, true);
  assert.equal(
    document.getElementById('syncPathField').hidden,
    true,
    '自動で作るときは、使われないパス欄を出さない'
  );
});

test('初回は会議ごとのファイルを選び、空の手動パスでは連携を開始しない', async () => {
  const code = encodePairingCode({ url: 'http://localhost:3210', token: 'captions-token' });
  const { document, stored } = await openPopup();

  assert.equal(document.getElementById('syncAutoPath').checked, true,
    '書き込み先が空になる初期状態を作らない');

  document.getElementById('syncCode').value = code;
  document.getElementById('syncEnabled').checked = true;
  document.getElementById('syncAutoPath').checked = false;
  document.getElementById('syncAutoPath').dispatchEvent(new document.defaultView.Event('change'));
  document.getElementById('syncForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
  await waitFor(() => document.getElementById('syncStatus').dataset.state === 'error');

  assert.match(document.getElementById('syncStatus').textContent, /書き込み先ファイル/);
  assert.equal(stored[SYNC_SETTINGS_KEY], undefined, '送信不能な設定を連携中として保存しない');
});

/* ---------------------------------------------------------------- *
 * 差し替え口
 * ---------------------------------------------------------------- */

/** ポップアップを、本物のHTMLとスクリプトのまま開きます。chrome APIとfetchだけを差し替えます。 */
async function openPopup(initialStorage = {}) {
  const directory = extensionDir();
  const html = await fs.readFile(path.join(directory, 'popup.html'), 'utf8');
  const stored = { ...initialStorage };
  const requests = [];

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://test/popup.html' });
  const { window } = dom;

  window.chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const names = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(names.filter((key) => key in stored).map((key) => [key, stored[key]])));
        },
        set(values, callback) {
          Object.assign(stored, values);
          callback?.();
        },
        remove(keys, callback) {
          for (const key of [].concat(keys)) delete stored[key];
          callback?.();
        }
      }
    },
    // メモ一覧とMeetタブの状態は、この確認の対象ではありません。空で答えます。
    tabs: { query: (_query, callback) => callback([]), sendMessage: () => {} },
    runtime: { lastError: null },
    downloads: { download: () => {} }
  };
  window.fetch = async (url, options = {}) => {
    requests.push({ url, headers: options.headers || {} });
    if (String(url).endsWith('/api/live-captions/ping')) return jsonResponse({ ok: true, rootDir: 'book' });
    if (String(url).endsWith('/api/live-captions/targets')) {
      return jsonResponse({ rootDir: 'book', files: ['guide.md', 'notes/today.md'] });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  for (const file of ['pairing.js', 'popup.js']) {
    window.eval(await fs.readFile(path.join(directory, file), 'utf8'));
  }
  await waitFor(() => window.document.getElementById('syncPairing').textContent !== '');
  return { document: window.document, window, stored, requests };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the popup to settle');
}
