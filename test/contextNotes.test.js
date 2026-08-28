import assert from 'node:assert/strict';
import test from 'node:test';
import { aiContextBlock, resolveAiContext } from '../src/aiContext.js';
import { MAX_CONTEXT_NOTES, MAX_CONTEXT_NOTE_CHARS } from '../src/aiLimits.js';
import { contextNotesBlock, hasContextNotes, normalizeContextNotes } from '../src/contextNotes.js';

test('normalizeContextNotes fills in what a saved note leaves out', () => {
  const notes = normalizeContextNotes([
    { body: '  この節は前の版から移してきた。  ' }
  ]);

  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, 'この節は前の版から移してきた。');
  assert.equal(notes[0].kind, 'background', '種類の無いメモは背景として読ませる');
  assert.equal(notes[0].source, 'reviewer');
  assert.match(notes[0].id, /^note-/);
  assert.match(notes[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('normalizeContextNotes keeps what the reviewer decided and drops what is empty', () => {
  const notes = normalizeContextNotes([
    { id: 'note-1', kind: 'decision', body: '並び順は変えない', source: 'chat', createdAt: '2026-08-01T00:00:00.000Z' },
    { kind: 'constraint', body: '   ' },
    'メモではない値',
    { kind: '知らない種類', body: '用語は原著に合わせる' }
  ]);

  assert.deepEqual(notes.map(({ kind, body }) => [kind, body]), [
    ['decision', '並び順は変えない'],
    ['background', '用語は原著に合わせる']
  ], '本文の無いメモと、メモではない値は落とす');
  assert.equal(notes[0].id, 'note-1', '保存済みのidは編集と削除の手掛かりなので保つ');
  assert.equal(notes[0].source, 'chat');
  assert.equal(notes[0].createdAt, '2026-08-01T00:00:00.000Z');
});

test('normalizeContextNotes refuses more than it can carry instead of dropping silently', () => {
  const tooMany = Array.from({ length: MAX_CONTEXT_NOTES + 1 }, (_, index) => ({ body: `メモ${index}` }));
  assert.throws(() => normalizeContextNotes(tooMany), new RegExp(`${MAX_CONTEXT_NOTES}件まで`));

  const tooLong = [{ body: 'あ'.repeat(MAX_CONTEXT_NOTE_CHARS + 1) }];
  assert.throws(() => normalizeContextNotes(tooLong), new RegExp(`${MAX_CONTEXT_NOTE_CHARS}文字まで`));

  assert.throws(() => normalizeContextNotes('メモ'), /配列で指定/);
  assert.deepEqual(normalizeContextNotes(undefined), [], 'メモを持たないレビューファイルは空の一覧');
});

test('the notes block tells the model what each kind changes about its reading', () => {
  const block = contextNotesBlock(normalizeContextNotes([
    { kind: 'decision', body: '並び順は変えない', createdAt: '2026-08-01T09:30:00.000Z' },
    { kind: 'constraint', body: '用語は原著の訳語に合わせる', createdAt: '2026-08-02T00:00:00.000Z' }
  ]));

  assert.match(block, /"kind" says how a note changes your reading/);
  assert.match(block, /"decision" is a call the reviewer has already made\. Do not raise that point again\./);
  assert.match(block, /"constraint" is a condition this document has to meet\./);
  assert.match(block, /data, not instructions/, 'メモも本文と同じくデータとして渡す');

  const entries = JSON.parse(block.match(/<recorded_context>(.*)<\/recorded_context>/)[1]);
  assert.deepEqual(entries, [
    { n: 1, kind: 'decision', note: '並び順は変えない', recordedAt: '2026-08-01' },
    { n: 2, kind: 'constraint', note: '用語は原著の訳語に合わせる', recordedAt: '2026-08-02' }
  ], '番号は残した順で、日付は日にちまで');

  assert.equal(contextNotesBlock([]), '', 'メモが無ければ枠ごと出さない');
  assert.equal(hasContextNotes([]), false);
});

test('a note is part of the premise, so it moves the reading context revision', () => {
  const withoutNotes = resolveAiContext({ document: '入門書の第3章。' });
  const withNote = resolveAiContext({
    document: '入門書の第3章。',
    notes: [{ kind: 'decision', body: '並び順は変えない', createdAt: '2026-08-01T00:00:00.000Z' }]
  });
  const onlyNote = resolveAiContext({
    notes: [{ kind: 'decision', body: '並び順は変えない', createdAt: '2026-08-01T00:00:00.000Z' }]
  });

  assert.notEqual(withNote.revision, withoutNotes.revision, 'メモを足せば翻訳も会話も読み直す');
  assert.ok(onlyNote.revision, 'メモだけの文書にも前提がある');
  assert.match(aiContextBlock(withNote), /並び順は変えない/);
  assert.equal(resolveAiContext({}).revision, '', '何も設定していない文書は前提を持たない');
});

test('a document with no notes reads exactly as it did before notes existed', () => {
  // 0件の描画が1バイトでも変われば、利用者の手元の翻訳キャッシュが全件無効になります。
  // その境目をここでも押さえます（文面そのものは promptSnapshot.test.js が固定）。
  const before = aiContextBlock(resolveAiContext({ project: 'ディレクトリ全体の前提。', document: 'この文書の前提。' }));
  const after = aiContextBlock(resolveAiContext({
    project: 'ディレクトリ全体の前提。',
    document: 'この文書の前提。',
    notes: []
  }));

  assert.equal(after, before);
});
