import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildReviewMarkdown, normalizeRelativePath, readReview, writeReview } from '../src/reviewStore.js';
import { listMarkdownFiles } from '../src/server.js';

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
  assert.match(markdown, /> 抽象的な説明/);
  assert.match(markdown, /対象見出し: 実装方針/);
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
