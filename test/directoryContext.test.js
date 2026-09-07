import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_AI_CONTEXT_CHARS, MAX_CONTEXT_NOTES } from '../src/aiLimits.js';
import { aiContextBlock, resolveAiContext } from '../src/aiContext.js';
import {
  DIRECTORY_CONTEXT_PATH,
  directoryContextPathFor,
  readDirectoryPremise,
  writeDirectoryPremise
} from '../src/directoryContext.js';

test('the directory wide context is saved next to the reviews and read back', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));

  assert.deepEqual(await readDirectoryPremise(root), { aiContext: '', contextNotes: [] }, '書く前は未設定');

  await writeDirectoryPremise(root, {
    aiContext: '  この本は入門者向け。読者はJavaScriptの基礎を知っている。  '
  });
  assert.equal(
    (await readDirectoryPremise(root)).aiContext,
    'この本は入門者向け。読者はJavaScriptの基礎を知っている。'
  );

  const saved = JSON.parse(await fs.readFile(directoryContextPathFor(root), 'utf8'));
  assert.equal(saved.aiContext, 'この本は入門者向け。読者はJavaScriptの基礎を知っている。');
  assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(path.relative(root, directoryContextPathFor(root)).split(path.sep).join('/'), DIRECTORY_CONTEXT_PATH);
});

test('clearing the directory wide context drops the key instead of saving an empty premise', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  await writeDirectoryPremise(root, { aiContext: 'この本は入門者向け。' });
  await writeDirectoryPremise(root, { aiContext: '   ' });

  assert.equal((await readDirectoryPremise(root)).aiContext, '');
  const saved = JSON.parse(await fs.readFile(directoryContextPathFor(root), 'utf8'));
  assert.equal('aiContext' in saved, false, '消した前提はキーごと残さない');
});

test('a directory wide context that is too long is refused instead of truncated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  await assert.rejects(
    () => writeDirectoryPremise(root, { aiContext: 'あ'.repeat(MAX_AI_CONTEXT_CHARS + 1) }),
    /ディレクトリ全体の読み取りコンテキスト が長すぎます/
  );
  assert.equal((await readDirectoryPremise(root)).aiContext, '', '断った前提は書かない');
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
  assert.deepEqual(await readDirectoryPremise(root), { aiContext: '', contextNotes: [] });

  await fs.writeFile(filePath, JSON.stringify({ aiContext: 42, contextNotes: 'メモ' }), 'utf8');
  assert.deepEqual(await readDirectoryPremise(root), { aiContext: '', contextNotes: [] });
});

/**
 * 「用語は原著の訳語に合わせる」のような制約は、章の数だけ残すものではありません。
 * メモにも読み取りコンテキストと同じ範囲を持たせて、1か所へ残せるようにしてあります。
 */
test('context notes can be recorded for the whole directory, next to the directory wide context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  await writeDirectoryPremise(root, {
    contextNotes: [{ id: 'note-1', kind: 'constraint', body: '  用語は原著の訳語に合わせる  ' }]
  });

  const premise = await readDirectoryPremise(root);
  assert.deepEqual(premise.contextNotes.map(({ id, kind, body }) => ({ id, kind, body })), [
    { id: 'note-1', kind: 'constraint', body: '用語は原著の訳語に合わせる' }
  ]);

  const saved = JSON.parse(await fs.readFile(directoryContextPathFor(root), 'utf8'));
  assert.equal(saved.contextNotes.length, 1, 'メモも読み取りコンテキストと同じファイルへ入る');
});

/**
 * 画面を閉じるときのビーコンは、書き換わった項目だけを送ります。まるごと置き換える
 * 書き方にすると、読み取りコンテキストだけを直した保存でメモが黙って消えます。
 */
test('saving one half of the directory premise keeps the other half', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  await writeDirectoryPremise(root, {
    aiContext: 'この本は入門者向け。',
    contextNotes: [{ id: 'note-1', kind: 'constraint', body: '用語は原著の訳語に合わせる' }]
  });

  await writeDirectoryPremise(root, { aiContext: 'この本は入門者向け。図は差し替え済み。' });
  const afterContext = await readDirectoryPremise(root);
  assert.equal(afterContext.aiContext, 'この本は入門者向け。図は差し替え済み。');
  assert.equal(afterContext.contextNotes.length, 1, '送らなかったメモは据え置く');

  await writeDirectoryPremise(root, { contextNotes: [] });
  const afterNotes = await readDirectoryPremise(root);
  assert.equal(afterNotes.aiContext, 'この本は入門者向け。図は差し替え済み。', '送らなかった前提は据え置く');
  assert.deepEqual(afterNotes.contextNotes, [], '空の配列は「最後の1件を消した」');
  const saved = JSON.parse(await fs.readFile(directoryContextPathFor(root), 'utf8'));
  assert.equal('contextNotes' in saved, false, '消したメモはキーごと残さない');
});

test('too many directory wide notes are refused instead of dropped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-directory-context-'));
  const tooMany = Array.from({ length: MAX_CONTEXT_NOTES + 1 }, (_, index) => ({ body: `メモ${index}` }));
  await assert.rejects(
    () => writeDirectoryPremise(root, { contextNotes: tooMany }),
    new RegExp(`ディレクトリ全体のコンテキストメモは${MAX_CONTEXT_NOTES}件までです`)
  );
  assert.deepEqual((await readDirectoryPremise(root)).contextNotes, [], '断ったメモは書かない');
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

/**
 * メモは2つの範囲を1本に束ねて渡します。読み方は範囲で変わらないので、枠を分けても
 * 同じ指示を2回読ませるだけだからです。範囲は印で分かるようにし、後のメモほど強い、
 * という並びの約束に合わせてディレクトリ全体のぶんを先に置きます。
 */
test('directory wide notes reach the model in the same block, marked and ranked below the document ones', () => {
  const block = aiContextBlock(resolveAiContext({
    directoryNotes: [{ id: 'note-d', kind: 'constraint', body: '用語は原著の訳語に合わせる' }],
    notes: [{ id: 'note-1', kind: 'decision', body: '並び順は変えない' }]
  }));

  const entries = JSON.parse(block.match(/<context_notes>(.*)<\/context_notes>/)[1]);
  assert.deepEqual(entries.map(({ n, scope, note }) => ({ n, scope, note })), [
    { n: 1, scope: 'directory', note: '用語は原著の訳語に合わせる' },
    { n: 2, scope: undefined, note: '並び順は変えない' }
  ], 'ディレクトリ全体のメモが先で、印が付くのもそちらだけ');
  assert.match(block, /"scope" is "directory"/, '印の読み方も渡す');
});

/** ディレクトリ全体のメモが1件も無ければ、その説明ごと出しません。 */
test('the scope legend stays out of a document that has only its own notes', () => {
  const block = aiContextBlock(resolveAiContext({
    notes: [{ id: 'note-1', kind: 'decision', body: '並び順は変えない' }]
  }));
  assert.doesNotMatch(block, /"scope"/);
});

/** 前提が変われば翻訳キャッシュの鍵も変わります。ディレクトリ全体の前提も同じ扱いです。 */
test('the directory wide context takes part in the context revision', () => {
  const without = resolveAiContext({ document: 'この文書だけの前提。' });
  const with_ = resolveAiContext({ directory: 'ディレクトリ全体の前提。', document: 'この文書だけの前提。' });
  assert.notEqual(with_.revision, without.revision);
  assert.equal(resolveAiContext({}).revision, '', '何も設定していなければ空のまま');

  const withNote = resolveAiContext({
    document: 'この文書だけの前提。',
    directoryNotes: [{ id: 'note-d', kind: 'constraint', body: '用語は原著の訳語に合わせる' }]
  });
  assert.notEqual(withNote.revision, without.revision, 'ディレクトリ全体のメモも鍵に入る');
});
