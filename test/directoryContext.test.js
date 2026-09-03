import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_AI_CONTEXT_CHARS } from '../src/aiLimits.js';
import { aiContextBlock, resolveAiContext } from '../src/aiContext.js';
import {
  DIRECTORY_CONTEXT_PATH,
  directoryContextPathFor,
  readDirectoryContext,
  writeDirectoryContext
} from '../src/directoryContext.js';

test('the directory wide context is saved next to the reviews and read back', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));

  assert.equal(await readDirectoryContext(root), '', '書く前は未設定');

  await writeDirectoryContext(root, '  この本は入門者向け。読者はJavaScriptの基礎を知っている。  ');
  assert.equal(await readDirectoryContext(root), 'この本は入門者向け。読者はJavaScriptの基礎を知っている。');

  const saved = JSON.parse(await fs.readFile(directoryContextPathFor(root), 'utf8'));
  assert.equal(saved.aiContext, 'この本は入門者向け。読者はJavaScriptの基礎を知っている。');
  assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(path.relative(root, directoryContextPathFor(root)).split(path.sep).join('/'), DIRECTORY_CONTEXT_PATH);
});

test('clearing the directory wide context drops the key instead of saving an empty premise', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  await writeDirectoryContext(root, 'この本は入門者向け。');
  await writeDirectoryContext(root, '   ');

  assert.equal(await readDirectoryContext(root), '');
  const saved = JSON.parse(await fs.readFile(directoryContextPathFor(root), 'utf8'));
  assert.equal('aiContext' in saved, false, '消した前提はキーごと残さない');
});

test('a directory wide context that is too long is refused instead of truncated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  await assert.rejects(
    () => writeDirectoryContext(root, 'あ'.repeat(MAX_AI_CONTEXT_CHARS + 1)),
    /ディレクトリ全体の読み取りコンテキスト が長すぎます/
  );
  assert.equal(await readDirectoryContext(root), '', '断った前提は書かない');
});

/**
 * 手で書き換えた1文字で、そのディレクトリの文書がまとめて開けなくなるのは困ります。
 * 読むときは投げずに「未設定」として通します（`contextNotes.js` と同じ考え方です）。
 */
test('a broken context file reads as unset instead of throwing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  const filePath = directoryContextPathFor(root);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '{ this is not json', 'utf8');
  assert.equal(await readDirectoryContext(root), '');

  await fs.writeFile(filePath, JSON.stringify({ aiContext: 42 }), 'utf8');
  assert.equal(await readDirectoryContext(root), '');
});

/**
 * 設定ファイルの前提と画面で書いた前提は、決める場所が違うだけで効く範囲は同じです。
 * モデルへは1つの枠にまとめて渡し、文書ごとの前提とは枠を分けたままにします。
 */
test('both directory wide premises reach the model in one project block', () => {
  const block = aiContextBlock(resolveAiContext({
    project: '設定ファイルで決めた前提。',
    directory: '画面で書いたディレクトリ全体の前提。',
    document: 'この文書だけの前提。'
  }));
  assert.match(block, /<project>\n設定ファイルで決めた前提。\n\n画面で書いたディレクトリ全体の前提。\n<\/project>/);
  assert.match(block, /<document>\nこの文書だけの前提。\n<\/document>/);
});

/** 前提が変われば翻訳キャッシュの鍵も変わります。ディレクトリ全体の前提も同じ扱いです。 */
test('the directory wide context takes part in the context revision', () => {
  const without = resolveAiContext({ document: 'この文書だけの前提。' });
  const with_ = resolveAiContext({ directory: 'ディレクトリ全体の前提。', document: 'この文書だけの前提。' });
  assert.notEqual(with_.revision, without.revision);
  assert.equal(resolveAiContext({}).revision, '', '何も設定していなければ空のまま');
});
