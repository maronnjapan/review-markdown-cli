import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendCaptionEntry, normalizeCaptionEntry } from '../src/liveCaptions.js';
import { createServer } from '../src/server.js';

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
    body: JSON.stringify({ path: 'meeting.md', speaker: 'A', text: 'hi', time: '10:00:00' })
  });
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('access-control-allow-origin'), extensionOrigin);
  const createdBody = await created.json();
  assert.deepEqual(createdBody, { ok: true, path: 'meeting.md', created: true, skipped: false });

  const opened = await fetch(`${baseUrl}/api/file?path=meeting.md`).then((response) => response.json());
  assert.match(opened.markdown, /\*\*A\*\* `\[10:00:00\]`\nhi/);
});

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
  assert.deepEqual(await sameOrigin.json(), {
    token: 'captions-token',
    header: 'x-review-markdown-live-captions-token',
    endpoint: '/api/live-captions/append'
  });

  const otherOrigin = await fetch(`${baseUrl}/api/live-captions/token`, {
    headers: { Origin: 'https://meet.google.com' }
  });
  assert.equal(otherOrigin.status, 403);
});
