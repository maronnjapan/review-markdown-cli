import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCommentContext, commentContextBlock } from '../src/commentContext.js';
import { writeReview } from '../src/reviewStore.js';

test('a conversation about the whole document reads every comment', async (t) => {
  const root = await reviewRoot(t, [
    { type: 'document', comment: '全体の構成を見直したい' },
    { type: 'paragraph', selectedText: 'Run the program.', comment: '前提条件が抜けている' }
  ]);

  const context = await collectCommentContext(root, 'guide.md', { type: 'document', selectedText: '# Guide\n' });

  assert.deepEqual(context.entries.map(({ n, attached, comment }) => ({ n, attached, comment })), [
    { n: 1, attached: true, comment: '全体の構成を見直したい' },
    { n: 2, attached: true, comment: '前提条件が抜けている' }
  ]);
  assert.equal(context.dropped, 0);
  assert.match(commentContextBlock(context), /<review_comments>/);
});

test('an empty review says so rather than leaving the AI to guess', async (t) => {
  const root = await reviewRoot(t, [{ type: 'paragraph', selectedText: 'Run the program.', comment: '   ' }]);

  const context = await collectCommentContext(root, 'guide.md', { type: 'document' });

  assert.deepEqual(context.entries, [], 'a comment with no text tells the AI nothing');
  assert.equal(commentContextBlock(context), 'The reviewer has written no review comments on this document.');
});

test('a long review keeps the comments on the discussed text and reports the rest', async (t) => {
  const elsewhere = Array.from({ length: 70 }, (_, index) => ({
    type: 'paragraph',
    selectedText: `別の段落${index}`,
    comment: `ほかの指摘${index}`
  }));
  const root = await reviewRoot(t, [
    ...elsewhere,
    { type: 'paragraph', selectedText: 'Run the program.', comment: 'この段落の指摘' }
  ]);

  const context = await collectCommentContext(root, 'guide.md', {
    type: 'paragraph',
    selectedText: 'Run the program.'
  });

  assert.equal(context.entries.length, 60);
  assert.equal(context.dropped, 11);
  assert.deepEqual(
    context.entries.filter(({ attached }) => attached).map(({ comment }) => comment),
    ['この段落の指摘'],
    'the comment on the discussed text survives the cap'
  );
  assert.match(commentContextBlock(context), /11 further comments were left out\./);
});

test('a comment on a heading reaches the paragraphs under it', async (t) => {
  const root = await reviewRoot(t, [
    { type: 'section', heading: '手順', headingPath: ['Guide', '手順'], comment: '節を分けてほしい' },
    { type: 'section', heading: '付録', headingPath: ['Guide', '付録'], comment: '付録は削ってよい' }
  ]);

  const context = await collectCommentContext(root, 'guide.md', {
    type: 'paragraph',
    selectedText: 'Run the program.',
    headingPath: ['Guide', '手順']
  });

  assert.deepEqual(context.entries.map(({ attached, comment }) => ({ attached, comment })), [
    { attached: true, comment: '節を分けてほしい' },
    { attached: false, comment: '付録は削ってよい' }
  ]);
});

async function reviewRoot(t, comments) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-comment-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\n## 手順\n\nRun the program.\n', 'utf8');
  await writeReview(root, 'guide.md', comments);
  return root;
}
