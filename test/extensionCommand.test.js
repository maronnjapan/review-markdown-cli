import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { extensionDir, runExtensionCommand } from '../src/extensionCommand.js';

test('拡張機能フォルダは同梱されていて、manifestを持っている', async () => {
  const directory = extensionDir();
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.name, /Meet Captions Memo/);
  // ポップアップは連携コードを読むので、その実装も一緒に入っている必要があります。
  await fs.access(path.join(directory, 'pairing.js'));
});

test('review-markdown extension は読み込ませ方まで出す', () => {
  const result = runExtensionCommand([]);
  assert.equal(result.exitCode, 0);
  const output = result.stdout.join('\n');
  assert.ok(output.includes(extensionDir()), 'フォルダのパスが出る');
  assert.match(output, /chrome:\/\/extensions/);
  assert.match(output, /連携コード/);
});

test('--path はパスだけを出すので、そのまま別のコマンドへ渡せる', () => {
  assert.deepEqual(runExtensionCommand(['--path']), {
    stdout: [extensionDir()],
    stderr: [],
    exitCode: 0
  });
});

test('知らないオプションは、使い方を添えて断る', () => {
  const result = runExtensionCommand(['--nope']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.join('\n'), /unknown option: --nope/);
});
