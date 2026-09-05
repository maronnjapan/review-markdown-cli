import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendCaptionEntry, normalizeCaptionEntry } from '../src/liveCaptions.js';
import { createServer } from '../src/server.js';
import { decodePairingCode } from '../src/pairing.js';

test('normalizeCaptionEntry requires a speaker and text', () => {
  assert.throws(() => normalizeCaptionEntry({ speaker: '', text: 'hello' }), /speaker and text/);
  assert.throws(() => normalizeCaptionEntry({ speaker: 'A', text: '' }), /speaker and text/);
  const entry = normalizeCaptionEntry({ speaker: ' A ', text: ' hello ', time: '10:00:00' });
  assert.equal(entry.speaker, 'A');
  assert.equal(entry.text, 'hello');
  assert.equal(entry.time, '10:00:00');
});

test('appendCaptionEntry creates the file with a header on the first line', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-captions-'));
  const entry = normalizeCaptionEntry({
    speaker: '田中', text: 'よろしくお願いします', time: '10:00:00', title: '定例会議', meetingCode: 'abc-defg-hij'
  });

  const first = await appendCaptionEntry(root, 'meeting.md', entry);
  assert.equal(first.created, true);
  assert.equal(first.skipped, false);

  const contents = await fs.readFile(path.join(root, 'meeting.md'), 'utf8');
  assert.match(contents, /^# 定例会議/);
  assert.match(contents, /会議コード: abc-defg-hij/);
  assert.match(contents, /\*\*田中\*\* `\[10:00:00\]`\nよろしくお願いします/);
});

test('appendCaptionEntry appends to an existing file without rewriting the header', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-captions-'));
  const first = normalizeCaptionEntry({ speaker: '田中', text: '最初の発言', time: '10:00:00' });
  const second = normalizeCaptionEntry({ speaker: '鈴木', text: '次の発言', time: '10:00:05' });

  const firstResult = await appendCaptionEntry(root, 'meeting.md', first);
  const secondResult = await appendCaptionEntry(root, 'meeting.md', second);
  assert.equal(firstResult.created, true);
  assert.equal(secondResult.created, false);

  const contents = await fs.readFile(path.join(root, 'meeting.md'), 'utf8');
  assert.match(contents, /最初の発言[\s\S]*次の発言/);
});

test('appendCaptionEntry skips an exact repeat of the last line sent for a file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-captions-'));
  const entry = normalizeCaptionEntry({ speaker: '田中', text: '同じ発言', time: '10:00:00' });

  await appendCaptionEntry(root, 'meeting.md', entry);
  const before = await fs.readFile(path.join(root, 'meeting.md'), 'utf8');
  const repeat = await appendCaptionEntry(root, 'meeting.md', entry);
  const after = await fs.readFile(path.join(root, 'meeting.md'), 'utf8');

  assert.equal(repeat.skipped, true);
  assert.equal(before, after, '再送された同じ発言は追記しない');
});

test('POST /api/live-captions/append requires the live captions token and a chrome-extension origin gets CORS headers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-captions-route-'));
  const aiService = { async status() { return { available: false }; }, close() {} };
  const { app } = createServer(root, { aiService, aiToken: 'ai-token', liveCaptionsToken: 'captions-token' });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

  const missingToken = await fetch(`${baseUrl}/api/live-captions/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'meeting.md', speaker: 'A', text: 'hi' })
  });
  assert.equal(missingToken.status, 403);

  const preflight = await fetch(`${baseUrl}/api/live-captions/append`, {
    method: 'OPTIONS',
    headers: { Origin: extensionOrigin }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin);

  const created = await fetch(`${baseUrl}/api/live-captions/append`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: extensionOrigin,
      'X-Review-Markdown-Live-Captions-Token': 'captions-token'
    },
    body: JSON.stringify({ path: 'meet-captions/meeting.md', speaker: 'A', text: 'hi', time: '10:00:00' })
  });
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('access-control-allow-origin'), extensionOrigin);
  const createdBody = await created.json();
  assert.deepEqual(createdBody, { ok: true, path: 'meet-captions/meeting.md', created: true, skipped: false });

  const opened = await fetch(`${baseUrl}/api/file?path=meet-captions/meeting.md`).then((response) => response.json());
  assert.match(opened.markdown, /\*\*A\*\* `\[10:00:00\]`\nhi/);
  assert.equal(opened.transcript, true, '文字起こし用のファイルであることは、画面にも返す');

  // 文字起こし用でないファイルへは書き込めません。断る理由と、足し方まで返します。
  const outside = await fetch(`${baseUrl}/api/live-captions/append`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: extensionOrigin,
      'X-Review-Markdown-Live-Captions-Token': 'captions-token'
    },
    body: JSON.stringify({ path: 'guide.md', speaker: 'A', text: 'hi', time: '10:00:00' })
  });
  assert.equal(outside.status, 400);
  assert.match((await outside.json()).error, /meet-captions.+transcriptFiles/s);
  assert.equal(await exists(path.join(root, 'guide.md')), false, '断ったファイルは作らない');
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('GET /api/live-captions/token is only reachable from the app itself', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-captions-token-'));
  const aiService = { async status() { return { available: false }; }, close() {} };
  const { app } = createServer(root, { aiService, aiToken: 'ai-token', liveCaptionsToken: 'captions-token' });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const sameOrigin = await fetch(`${baseUrl}/api/live-captions/token`, {
    headers: { Origin: baseUrl }
  });
  assert.equal(sameOrigin.status, 200);
  const info = await sameOrigin.json();
  assert.equal(info.token, 'captions-token');
  assert.equal(info.header, 'x-review-markdown-live-captions-token');
  assert.equal(info.endpoint, '/api/live-captions/append');
  assert.equal(info.serverUrl, `http://127.0.0.1:${server.address().port}`);
  assert.deepEqual(
    decodePairingCode(info.pairingCode),
    { url: info.serverUrl, token: 'captions-token' },
    '連携コード1本にURLとトークンが入っているので、運ぶものが1つで済む'
  );
  assert.match(info.extensionDir, /extension$/, '読み込ませるフォルダも画面から辿れる');

  const otherOrigin = await fetch(`${baseUrl}/api/live-captions/token`, {
    headers: { Origin: 'https://meet.google.com' }
  });
  assert.equal(otherOrigin.status, 403);
});

/**
 * 連携コードは起動のたびに変わります。人が貼って運ぶ限り、貼り直しを忘れた回だけ記録が
 * 残りません。拡張機能が自分で取りに来られる窓口を用意して、忘れる場所を無くします。
 */
test('拡張機能は、連携コードを自分で取りに来られる', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-captions-pairing-'));
  const aiService = { async status() { return { available: false }; }, close() {} };
  const { app } = createServer(root, { aiService, aiToken: 'ai-token', liveCaptionsToken: 'captions-token' });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

  // トークンを持っていないから取りに来ます。ここで持っていることを求めたら、鶏と卵になります。
  const response = await fetch(`${baseUrl}/api/live-captions/pairing`, {
    headers: { Origin: extensionOrigin }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), extensionOrigin);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const info = await response.json();
  assert.equal(info.serverUrl, baseUrl);
  assert.equal(info.token, 'captions-token', '拡張機能が使うのはトークン');
  assert.equal(info.rootDir, path.basename(root), 'どこへ書き込むことになるかも一緒に返す');
  assert.deepEqual(info.transcriptFiles, ['meet-captions', '*.transcript.md']);
  assert.deepEqual(
    decodePairingCode(info.pairingCode),
    { url: baseUrl, token: 'captions-token' },
    '貼り付けで繋ぐ道も残す（自動で見つからないとき用）'
  );

  // 普通のWebページからは読めません（ブラウザのCORSに加えて、ここでも断ります）。
  const fromWebPage = await fetch(`${baseUrl}/api/live-captions/pairing`, {
    headers: { Origin: 'https://meet.google.com' }
  });
  assert.equal(fromWebPage.status, 403);
});

test('拡張機能は、書き込まずに繋がりを確かめられるし、書き込み先の候補も引ける', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-captions-ping-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');
  await fs.mkdir(path.join(root, 'meet-captions'));
  await fs.writeFile(path.join(root, 'meet-captions', 'today.md'), '# Today\n', 'utf8');
  await fs.writeFile(path.join(root, 'kickoff.transcript.md'), '# Kickoff\n', 'utf8');
  const aiService = { async status() { return { available: false }; }, close() {} };
  const { app } = createServer(root, { aiService, aiToken: 'ai-token', liveCaptionsToken: 'captions-token' });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const withToken = { Origin: extensionOrigin, 'X-Review-Markdown-Live-Captions-Token': 'captions-token' };

  assert.equal((await fetch(`${baseUrl}/api/live-captions/ping`)).status, 403, 'トークン無しは断る');

  const ping = await fetch(`${baseUrl}/api/live-captions/ping`, { headers: withToken });
  assert.equal(ping.status, 200);
  assert.equal(ping.headers.get('access-control-allow-origin'), extensionOrigin);
  const pinged = await ping.json();
  assert.equal(pinged.rootDir, path.basename(root), 'どこへ書くのかを保存前に見せる');
  assert.deepEqual(pinged.transcriptFiles, ['meet-captions', '*.transcript.md'], 'どこへ書けるのかも保存前に見せる');

  const targets = await fetch(`${baseUrl}/api/live-captions/targets`, { headers: withToken });
  assert.equal(targets.status, 200);
  const listed = await targets.json();
  assert.deepEqual(
    listed.files,
    ['kickoff.transcript.md', 'meet-captions/today.md'],
    '候補に出すのは、字幕を書き込めるファイルだけ'
  );
  assert.deepEqual(listed.transcriptFiles, ['meet-captions', '*.transcript.md']);

  // 確かめただけでファイルが増えないこと。増えるなら、確かめる前に書き込んでいます。
  assert.deepEqual((await fs.readdir(root)).sort(), ['guide.md', 'kickoff.transcript.md', 'meet-captions']);

  const preflight = await fetch(`${baseUrl}/api/live-captions/targets`, {
    method: 'OPTIONS',
    headers: { Origin: extensionOrigin }
  });
  assert.equal(preflight.status, 204, '足したエンドポイントにもプリフライトが通る');
  assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);
});
