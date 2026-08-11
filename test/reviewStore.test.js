import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildReviewMarkdown, findExistingReviewPath, normalizeRelativePath, readReview, writeReview } from '../src/reviewStore.js';
import { listMarkdownFiles } from '../src/server.js';
import { renderMarkdown } from '../src/markdown.js';

test('normalizeRelativePath rejects paths outside the target root', () => {
  const root = path.resolve('/tmp/review-root');
  assert.equal(normalizeRelativePath(root, './docs/example.md'), 'docs/example.md');
  assert.throws(() => normalizeRelativePath(root, '../secret.md'), /inside target directory/);
});

test('writeReview and readReview persist comments under .review', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'example.md'), '# Example\n', 'utf8');

  await writeReview(root, 'docs/example.md', [
    { type: 'document', comment: '結論を先に書く', createdAt: '2026-06-11T00:00:00.000Z' }
  ]);
  const review = await readReview(root, 'docs/example.md');

  assert.equal(review.targetFile, 'docs/example.md');
  assert.equal(review.comments.length, 1);
  assert.equal(review.comments[0].comment, '結論を先に書く');
  assert.equal(review.comments[0].status, 'open', '状態のない既存コメントは未解決として扱う');
});

test('writeReview preserves existing comment metadata and target fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  await writeReview(root, 'docs/example.md', [
    {
      id: 'comment-existing',
      type: 'text-selection',
      selectedText: '対象として選択された文章',
      targetText: '対象として選択された文章',
      contextBefore: '前の文脈',
      contextAfter: '後ろの文脈',
      headingPath: ['概要'],
      comment: '具体例を追加してほしい',
      status: 'resolved',
      createdAt: '2026-06-11T00:00:00.000Z',
      customField: 'preserved'
    }
  ]);

  const review = await readReview(root, 'docs/example.md');
  assert.equal(review.comments[0].id, 'comment-existing');
  assert.equal(review.comments[0].targetText, '対象として選択された文章');
  assert.equal(review.comments[0].contextBefore, '前の文脈');
  assert.equal(review.comments[0].status, 'resolved');
  assert.equal(review.comments[0].customField, 'preserved');
});

test('readReview finds existing project-root reviews when target root is a subdirectory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  const targetRoot = path.join(root, 'book-draft', '02_drafts');
  const reviewFile = path.join(root, '.review', 'book-draft', '02_drafts', 'draft_001.md.review.json');
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.mkdir(path.dirname(reviewFile), { recursive: true });
  await fs.writeFile(path.join(targetRoot, 'draft_001.md'), '# Draft\n', 'utf8');
  await fs.writeFile(
    reviewFile,
    `${JSON.stringify(
      {
        targetFile: 'book-draft/02_drafts/draft_001.md',
        updatedAt: '2026-06-11T00:00:00.000Z',
        comments: [{ id: 'comment-existing', type: 'document', comment: '既存コメント' }]
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const review = await readReview(targetRoot, 'draft_001.md');
  assert.equal(review.targetFile, 'draft_001.md');
  assert.equal(review.comments.length, 1);
  assert.equal(review.comments[0].comment, '既存コメント');
  assert.equal(await findExistingReviewPath(targetRoot, 'draft_001.md'), reviewFile);
});

test('writeReview updates the existing ancestor review file instead of creating a nested one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  const targetRoot = path.join(root, 'book-draft', '02_drafts');
  const reviewFile = path.join(root, '.review', 'book-draft', '02_drafts', 'draft_001.md.review.json');
  const nestedReviewFile = path.join(targetRoot, '.review', 'draft_001.md.review.json');
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.mkdir(path.dirname(reviewFile), { recursive: true });
  await fs.writeFile(
    reviewFile,
    `${JSON.stringify({ targetFile: 'book-draft/02_drafts/draft_001.md', comments: [] }, null, 2)}\n`,
    'utf8'
  );

  await writeReview(targetRoot, 'draft_001.md', [
    { id: 'comment-updated', type: 'document', comment: '更新後コメント', createdAt: '2026-06-11T00:00:00.000Z' }
  ]);

  const updated = JSON.parse(await fs.readFile(reviewFile, 'utf8'));
  assert.equal(updated.targetFile, 'book-draft/02_drafts/draft_001.md');
  assert.equal(updated.comments[0].comment, '更新後コメント');
  await assert.rejects(fs.stat(nestedReviewFile), { code: 'ENOENT' });
});

test('buildReviewMarkdown groups comments for AI handoff', () => {
  const markdown = buildReviewMarkdown({
    targetFile: 'example.md',
    comments: [
      { type: 'document', comment: '全体を具体化する' },
      { type: 'text-selection', selectedText: '抽象的な説明', comment: '例を追加する', headingPath: ['概要'] },
      { type: 'section', heading: '実装方針', comment: '実装者向けにする' }
    ]
  });

  assert.match(markdown, /# Review for example\.md/);
  assert.match(markdown, /## 文書全体へのコメント/);
  assert.match(markdown, /状態: 未解決/);
  assert.match(markdown, /> 抽象的な説明/);
  assert.match(markdown, /対象見出し: 実装方針/);
});

test('buildReviewMarkdown identifies resolved comments', () => {
  const markdown = buildReviewMarkdown({
    targetFile: 'example.md',
    comments: [{ type: 'document', status: 'resolved', comment: '対応済み' }]
  });

  assert.match(markdown, /状態: 解決済み/);
});

test('buildReviewMarkdown keeps repeated comments for the same target', () => {
  const markdown = buildReviewMarkdown({
    targetFile: 'example.md',
    comments: [
      { type: 'text-selection', selectedText: '同じ対象', comment: '1つ目のコメント' },
      { type: 'text-selection', selectedText: '同じ対象', comment: '2つ目のコメント' }
    ]
  });

  assert.match(markdown, /### コメント1/);
  assert.match(markdown, /1つ目のコメント/);
  assert.match(markdown, /### コメント2/);
  assert.match(markdown, /2つ目のコメント/);
});

test('renderMarkdown can rewrite image sources relative to the current document', async () => {
  const html = await renderMarkdown('![client home](../captures/home.png)', {
    resolveImageSrc: (src) => `/api/asset?from=${encodeURIComponent('book-draft/02_drafts/draft_001.md')}&src=${encodeURIComponent(src)}`
  });

  assert.match(html, /<p[^>]*>/);
  assert.match(html, /class="md-img"/);
  assert.match(html, /alt="client home"/);
  assert.match(html, /src="\/api\/asset\?from=book-draft%2F02_drafts%2Fdraft_001\.md&amp;src=\.\.%2Fcaptures%2Fhome\.png"/);
});

test('listMarkdownFiles ignores .review, .git, and node_modules directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-files-'));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, '.review'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Readme\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'plan.markdown'), '# Plan\n', 'utf8');
  await fs.writeFile(path.join(root, '.review', 'old.md'), '# Old\n', 'utf8');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'ignored.md'), '# Ignored\n', 'utf8');

  assert.deepEqual(await listMarkdownFiles(root), ['docs/plan.markdown', 'README.md'].sort((a, b) => a.localeCompare(b)));
});
