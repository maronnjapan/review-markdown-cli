import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoId, normalizeMemos, readMemos } from '../src/memos.js';

test('readMemos keeps where a memo was left and drops the ones with nothing written', () => {
  const memos = readMemos([
    {
      id: 'memo-1',
      type: 'paragraph',
      body: '  第4章と重複していないか、あとで確かめる  ',
      selectedText: 'この段落はレビュー対象です。',
      targetText: 'この段落はレビュー対象です。',
      headingPath: ['設計メモ', '背景'],
      createdAt: '2026-08-01T00:00:00.000Z'
    },
    { body: '   ' },
    'メモではない値',
    null
  ]);

  assert.equal(memos.length, 1, '本文の無いメモと、メモではない値は落とす');
  assert.equal(memos[0].id, 'memo-1', '保存済みのidは編集と削除の手掛かりなので保つ');
  assert.equal(memos[0].body, '第4章と重複していないか、あとで確かめる');
  assert.equal(memos[0].type, 'paragraph');
  assert.deepEqual(memos[0].headingPath, ['設計メモ', '背景']);
  assert.equal(memos[0].createdAt, '2026-08-01T00:00:00.000Z');
  // 状態はコメントのものです。メモは誰かへの依頼ではないので持ちません。
  assert.equal('status' in memos[0], false);
});

test('readMemos never throws, so a hand edited review file still opens', () => {
  // 読む側は、レビューファイルを手で直した1文字で文書が開けなくなってはいけません。
  assert.deepEqual(readMemos(undefined), []);
  assert.deepEqual(readMemos('メモ'), []);
  assert.deepEqual(readMemos([42, { body: 123 }, { body: '' }]), []);

  // コンテキストメモと違って、件数と長さの上限はありません。プロンプトに載らないからです。
  const many = readMemos(Array.from({ length: 200 }, (_, index) => ({ body: `メモ${index}` })));
  assert.equal(many.length, 200);
  const long = readMemos([{ body: 'あ'.repeat(5_000) }]);
  assert.equal(long[0].body.length, 5_000);
});

test('a memo written by hand is read as one that points nowhere in particular', () => {
  const [plain] = readMemos([{ body: 'あとで確かめる' }]);
  assert.equal(plain.type, 'document', '対象の文字が無いメモは文書全体のものとして読む');
  assert.match(plain.id, /^memo-/, '無いidはこちらで振る');
  assert.equal('createdAt' in plain, false, '日時は補わない。開き直すだけで残した日が動くから');

  const [anchored] = readMemos([{ body: 'ここ', targetText: 'この段落はレビュー対象です。' }]);
  assert.equal(anchored.type, 'text-selection', '対象の文字があれば、その文字を指すものとして読む');
});

test('readMemos drops the keys it does not know, and keeps the PDF rectangles as they are', () => {
  const [memo] = readMemos([{
    body: '図の単位を確かめる',
    type: 'text-selection',
    documentType: 'pdf',
    pageNumber: 2,
    pdfAnchor: { version: 1, pageNumber: 2, rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] },
    selectedText: '図3',
    somethingWrittenByHand: '知らない項目'
  }]);

  assert.equal(memo.documentType, 'pdf');
  assert.equal(memo.pageNumber, 2);
  assert.deepEqual(memo.pdfAnchor.rectangles, [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]);
  assert.equal('somethingWrittenByHand' in memo, false);
});

test('normalizeMemos refuses something that is not a list of memos', () => {
  assert.throws(() => normalizeMemos('メモ'), /配列で指定/);
  assert.deepEqual(normalizeMemos(undefined), [], 'メモを持たないレビューファイルは空の一覧');
  assert.deepEqual(normalizeMemos([{ body: '  ' }]), [], '本文の無いメモは受け取らない');
  assert.equal(normalizeMemos([{ body: '確かめる' }]).length, 1);
});

test('memo ids do not collide with comment ids', () => {
  assert.match(createMemoId(), /^memo-\d+-[0-9a-f]{6}$/);
});
