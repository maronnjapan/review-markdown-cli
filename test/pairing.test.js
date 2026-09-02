import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { extensionDir } from '../src/extensionCommand.js';
import { decodePairingCode, encodePairingCode, normalizeServerUrl } from '../src/pairing.js';

test('連携コードはURLとトークンを1本にまとめ、そのまま元へ戻せる', () => {
  const code = encodePairingCode({ url: 'http://localhost:3000', token: 'abc123' });
  assert.match(code, /^rmc1\./);
  assert.deepEqual(decodePairingCode(code), { url: 'http://localhost:3000', token: 'abc123' });
});

test('連携コードは末尾のスラッシュとまわりの空白を落として持つ', () => {
  const code = encodePairingCode({ url: 'http://127.0.0.1:3000/', token: 'abc123' });
  assert.deepEqual(decodePairingCode(`  ${code}  `), { url: 'http://127.0.0.1:3000', token: 'abc123' });
});

test('localhost以外へ向いたコードは作れないし、読めない', () => {
  assert.throws(
    () => encodePairingCode({ url: 'https://meet.google.com', token: 'abc123' }),
    /連携コードにできないURLです/
  );
  // 手で組み立てた（= このCLIが出していない）コードも、行き先で断ります。中身は読める
  // ので、貼った人には行き先が見えません。見えないものを信じさせないための関門です。
  const forged = `rmc1.${Buffer.from(JSON.stringify({ u: 'https://evil.example', t: 'x' })).toString('base64url')}`;
  assert.throws(() => decodePairingCode(forged), /URLかトークンが入っていません/);
});

test('読めないコードは、なぜ読めないかを言って断る', () => {
  assert.throws(() => decodePairingCode(''), /連携コードが空です/);
  assert.throws(() => decodePairingCode('live-captions-token'), /形式が違います/);
  assert.throws(() => decodePairingCode('rmc1.!!!not-base64!!!'), /壊れています/);
  assert.throws(() => decodePairingCode(`rmc1.${'a'.repeat(5000)}`), /長すぎます/);
});

test('normalizeServerUrl はローカルの http/https だけを、スキームとホストの形で返す', () => {
  assert.equal(normalizeServerUrl('http://localhost:3000/some/path'), 'http://localhost:3000');
  assert.equal(normalizeServerUrl('https://127.0.0.1:8443'), 'https://127.0.0.1:8443');
  assert.equal(normalizeServerUrl('file:///etc/passwd'), '');
  assert.equal(normalizeServerUrl('http://example.com'), '');
  assert.equal(normalizeServerUrl('not a url'), '');
  assert.equal(normalizeServerUrl(undefined), '');
});


/**
 * 連携コードは、CLIと拡張機能の2か所に実装があります（拡張機能はビルド無しで読み込ませる
 * ので、Nodeのモジュールを共有できません）。片方だけ直すと、貼っても繋がらない状態に
 * 黙って落ちます。同じリポジトリに入れた意味を守るために、ここで突き合わせます。
 */
test('拡張機能側の実装は、CLI側と同じコードを読み書きする', async () => {
  const source = await fs.readFile(path.join(extensionDir(), 'pairing.js'), 'utf8');
  const sandbox = { self: {}, atob, btoa, TextEncoder, TextDecoder, URL };
  vm.runInNewContext(source, sandbox);
  const extension = sandbox.self.MeetCaptionsPairing;

  const fromCli = encodePairingCode({ url: 'http://localhost:3000', token: 'shared-token' });
  const fromExtension = extension.encodePairingCode({ url: 'http://localhost:3000', token: 'shared-token' });
  assert.equal(fromExtension, fromCli, '同じ入力からは同じコードが出る');
  // 別のrealmで作った物を比べるので、形ではなく中身で見ます（deepStrictEqualは原型の
  // 違いで落ちます）。確かめたいのは、どちらのコードもどちらの実装で読めることです。
  const readByExtension = extension.decodePairingCode(fromCli);
  const readByCli = decodePairingCode(fromExtension);
  assert.equal(readByExtension.url, readByCli.url);
  assert.equal(readByExtension.token, readByCli.token);
  assert.equal(readByCli.token, 'shared-token');

  assert.equal(extension.normalizeServerUrl('http://example.com'), '', '行き先の絞り込みも揃っている');
  assert.throws(() => extension.decodePairingCode('rmc0.abc'), /形式が違います/);
});
