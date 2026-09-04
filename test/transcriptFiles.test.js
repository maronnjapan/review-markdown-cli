import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import {
  DEFAULT_TRANSCRIPT_PATTERNS,
  createTranscriptScope,
  transcriptScopeMessage
} from '../src/transcriptFiles.js';

test('文字起こしに使えるのは、既定では会議用のディレクトリと、その名前を付けたファイルだけ', () => {
  const scope = createTranscriptScope();
  assert.deepEqual(scope.patterns, DEFAULT_TRANSCRIPT_PATTERNS);
  assert.equal(scope.isDefault, true);
  assert.equal(scope.matches('meet-captions/2026-09-03-abc-defg-hij.md'), true);
  assert.equal(scope.matches('docs/meet-captions/today.md'), true, '1段の名前はどの階層でも当たる');
  assert.equal(scope.matches('notes/kickoff.transcript.md'), true);
  assert.equal(scope.matches('docs/guide.md'), false, '原稿へは書き込ませない');
  assert.equal(scope.matches('meet-captions-old.md'), false);
});

test('文字起こし用のファイルは設定で決められて、空にすると1件も無くなる', () => {
  const chosen = createTranscriptScope(['docs/meetings/**', '/log.md']);
  assert.equal(chosen.isDefault, false);
  assert.equal(chosen.matches('docs/meetings/2026-09-03.md'), true);
  assert.equal(chosen.matches('docs/other/2026-09-03.md'), false);
  assert.equal(chosen.matches('log.md'), true);
  assert.equal(chosen.matches('sub/log.md'), false, '先頭の / は対象ディレクトリ直下に固定する');

  // 空の一覧は「文字起こしには使わない」という指定です。既定へは戻しません。
  const none = createTranscriptScope([]);
  assert.deepEqual(none.patterns, []);
  assert.equal(none.matches('meet-captions/today.md'), false);
  assert.match(transcriptScopeMessage(none), /設定されていません.*transcriptFiles/s);
});

test('断る理由には、使えるパターンと足し方が入る', () => {
  const message = transcriptScopeMessage(createTranscriptScope(), 'docs/guide.md');
  assert.match(message, /docs\/guide\.md は文字起こし用のファイルではありません/);
  assert.match(message, /meet-captions/);
  assert.match(message, /review-markdown config add transcriptFiles/);
});

test('transcriptFiles は設定ファイルから読める', () => {
  const { config } = normalizeConfig({ transcriptFiles: 'meet-captions, docs/meetings/**' });
  assert.deepEqual(config.transcriptFiles, ['meet-captions', 'docs/meetings/**']);
  assert.throws(() => normalizeConfig({ transcriptFiles: [3] }), /文字列の配列/);
});

test('聞き直しは、文字起こし用でないファイルでは断る（タブは出ても押せば同じ答え）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-scope-'));
  const transcript = [
    '# 定例会議', '', '---', '',
    '**田中** `[10:00:00]`', '今日は再起動手順の確認です。', ''
  ].join('\n');
  await fs.mkdir(path.join(root, 'meet-captions'));
  await fs.writeFile(path.join(root, 'meet-captions', 'today.md'), transcript, 'utf8');
  // 発言の形はしていても、文字起こし用のファイルではない文書。
  await fs.writeFile(path.join(root, 'guide.md'), transcript, 'utf8');

  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async recapWindow() { return { appliedScope: 'all', entries: [{ index: 0 }], leadIn: [], dropped: 0 }; },
    async recapCaptions() { return { summary: '読みました', points: [], actions: [] }; },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'recap-token' });
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
  const headers = { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'recap-token' };

  const allowed = await fetch(`${baseUrl}/api/ai/recap-window?path=meet-captions/today.md&scope=all`, { headers });
  assert.equal(allowed.status, 200);

  const refused = await fetch(`${baseUrl}/api/ai/recap-window?path=guide.md&scope=all`, { headers });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /文字起こし用のファイルではありません/);

  // 聞くほうも同じ線で断ります。片方だけ絞ると、押せるのに読めないタブが残ります。
  const streamed = await fetch(`${baseUrl}/api/ai/recap`, {
    method: 'POST', headers, body: JSON.stringify({ path: 'guide.md', scope: 'all' })
  });
  const events = (await streamed.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error, /文字起こし用のファイルではありません/);

  // 画面は文書ごとの印で「文字起こし」タブの出し方を決めます。
  const opened = await fetch(`${baseUrl}/api/file?path=guide.md`).then((response) => response.json());
  assert.equal(opened.transcript, false);
  assert.deepEqual(opened.transcriptFiles, ['meet-captions', '*.transcript.md']);
});
