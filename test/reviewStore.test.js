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

test('the reading context lives with the review and survives a comment only save', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-context-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');

  await writeReview(root, 'guide.md', [], { aiContext: '  入門書の第3章。読者は初学者。  ' });
  assert.equal((await readReview(root, 'guide.md')).aiContext, '入門書の第3章。読者は初学者。', '前後の空白は落とす');

  await writeReview(root, 'guide.md', [{ type: 'document', comment: '結論を先に' }]);
  const kept = await readReview(root, 'guide.md');
  assert.equal(kept.aiContext, '入門書の第3章。読者は初学者。', 'コメントだけの保存では消さない');
  assert.equal(kept.comments.length, 1);

  await writeReview(root, 'guide.md', kept.comments, { aiContext: '' });
  assert.equal((await readReview(root, 'guide.md')).aiContext, '', '空文字は取り消しとして扱う');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.review', 'guide.md.review.json'), 'utf8')).aiContext, undefined);

  await assert.rejects(writeReview(root, 'guide.md', [], { aiContext: 'あ'.repeat(4001) }), /長すぎます/);
});

test('a review without a reading context reads back as an empty one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-nocontext-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');

  assert.equal((await readReview(root, 'guide.md')).aiContext, '', 'レビューファイルがなくても読める');
  await writeReview(root, 'guide.md', []);
  assert.equal((await readReview(root, 'guide.md')).aiContext, '');
});

test('buildReviewMarkdown puts the reading context ahead of the comments', () => {
  const markdown = buildReviewMarkdown({
    targetFile: 'guide.md',
    aiContext: '入門書の第3章。読者は初学者。',
    comments: [{ type: 'document', comment: '結論を先に', status: 'open' }]
  });

  assert.match(markdown, /# Review for guide\.md\n\n## 読み取りコンテキスト\n\n入門書の第3章。読者は初学者。\n\n## 文書全体へのコメント/);
  assert.doesNotMatch(buildReviewMarkdown({ targetFile: 'guide.md', comments: [] }), /読み取りコンテキスト/);
});

test('context notes live with the review and survive a comment only save', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');

  await writeReview(root, 'guide.md', [], {
    aiContext: '入門書の第3章。',
    contextNotes: [
      { kind: 'decision', body: '節の並び順は検討済みで、変えない', createdAt: '2026-08-01T00:00:00.000Z' },
      { kind: 'constraint', body: '用語は原著の訳語に合わせる', source: 'chat', createdAt: '2026-08-02T00:00:00.000Z' }
    ]
  });
  // コメントだけを保存する要求（画面を離れるときのビーコンがこの形です）。
  await writeReview(root, 'guide.md', [{ type: 'document', comment: '結論を先に書く' }]);
  const review = await readReview(root, 'guide.md');

  assert.equal(review.contextNotes.length, 2, 'コメントだけの保存でメモは消えない');
  assert.equal(review.aiContext, '入門書の第3章。');
  assert.deepEqual(review.contextNotes.map(({ kind }) => kind), ['decision', 'constraint']);
  assert.equal(review.contextNotes[1].source, 'chat');
  assert.ok(review.contextNotes[0].id, '編集と削除のためにidを振る');

  // 空の配列は「最後の1件を消した」です。据え置きの undefined と区別します。
  await writeReview(root, 'guide.md', [], { contextNotes: [] });
  const cleared = await readReview(root, 'guide.md');
  assert.deepEqual(cleared.contextNotes, []);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.review', 'guide.md.review.json'), 'utf8'));
  assert.equal('contextNotes' in saved, false, 'メモの無い文書にキーは現れない');
  assert.equal(saved.aiContext, '入門書の第3章。', '読み取りコンテキストは据え置く');
});

test('a review written before context notes existed reads back as an empty list', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  const reviewFile = path.join(root, '.review', 'guide.md.review.json');
  await fs.mkdir(path.dirname(reviewFile), { recursive: true });
  await fs.writeFile(reviewFile, `${JSON.stringify({
    targetFile: 'guide.md',
    aiContext: '入門書の第3章。',
    comments: [{ id: 'comment-existing', type: 'document', comment: '既存コメント' }]
  })}\n`, 'utf8');

  const review = await readReview(root, 'guide.md');
  assert.deepEqual(review.contextNotes, []);
  assert.equal(review.comments.length, 1);
});

test('buildReviewMarkdown writes the notes between the reading context and the comments', () => {
  const markdown = buildReviewMarkdown({
    targetFile: 'guide.md',
    aiContext: '入門書の第3章。',
    contextNotes: [
      { kind: 'decision', body: '節の並び順は変えない', createdAt: '2026-08-01T00:00:00.000Z' },
      { kind: 'question', body: '付録を入れるか未定。\n担当と相談中。', updatedAt: '2026-08-03T00:00:00.000Z' }
    ],
    comments: [{ type: 'document', comment: '結論を先に書く' }]
  });

  assert.match(markdown, /## 読み取りコンテキスト[\s\S]*## コンテキストメモ[\s\S]*## 文書全体へのコメント/);
  assert.match(markdown, /- 決定（2026-08-01）: 節の並び順は変えない/);
  // 改行を含むメモは、2文字下げて同じ箇条書きの中へ収めます。
  assert.match(markdown, /- 未決（2026-08-03）: 付録を入れるか未定。\n  担当と相談中。/);
});

test('the document brief lives with the review and survives a comment only save', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-brief-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');

  await writeReview(root, 'guide.md', [], {
    aiContext: '入門書の第3章。',
    brief: {
      purpose: '  読者が第4章へ進める状態にする。  ',
      story: '前提の確認 → 例 → 落とし穴 → まとめ。',
      expectation: '第4章の質問が減る。',
      updatedAt: '2026-08-01T00:00:00.000Z'
    }
  });
  // コメントだけを保存する要求（画面を離れるときのビーコンがこの形です）。
  await writeReview(root, 'guide.md', [{ type: 'document', comment: '結論を先に書く' }]);
  const review = await readReview(root, 'guide.md');

  assert.equal(review.brief.purpose, '読者が第4章へ進める状態にする。', 'コメントだけの保存で3点は消えない');
  assert.equal(review.brief.updatedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(review.aiContext, '入門書の第3章。');

  // 一部だけ決まっている状態も、そのまま残します。決めた分から前提として効かせるためです。
  await writeReview(root, 'guide.md', [], { brief: { purpose: '読者が第4章へ進める。' } });
  const partial = await readReview(root, 'guide.md');
  assert.equal(partial.brief.story, '');

  // null は「3つを消す」です。据え置きの undefined と区別します。
  await writeReview(root, 'guide.md', [], { brief: null });
  const cleared = await readReview(root, 'guide.md');
  assert.equal(cleared.brief, null);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.review', 'guide.md.review.json'), 'utf8'));
  assert.equal('brief' in saved, false, '3点の無い文書にキーは現れない');
  assert.equal(saved.aiContext, '入門書の第3章。', '読み取りコンテキストは据え置く');

  await assert.rejects(
    writeReview(root, 'guide.md', [], { brief: { story: 'あ'.repeat(601) } }),
    /「ストーリー」が長すぎます/
  );
});

test('a review written before the document manager existed reads back without a brief', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-nobrief-'));
  const reviewFile = path.join(root, '.review', 'guide.md.review.json');
  await fs.mkdir(path.dirname(reviewFile), { recursive: true });
  await fs.writeFile(reviewFile, `${JSON.stringify({
    targetFile: 'guide.md',
    aiContext: '入門書の第3章。',
    comments: [{ id: 'comment-existing', type: 'document', comment: '既存コメント' }]
  })}\n`, 'utf8');

  const review = await readReview(root, 'guide.md');
  assert.equal(review.brief, null);
  assert.equal(review.comments.length, 1);
});

test('buildReviewMarkdown opens with what the document was for', () => {
  const markdown = buildReviewMarkdown({
    targetFile: 'guide.md',
    aiContext: '入門書の第3章。',
    brief: {
      purpose: '読者が第4章へ進める状態にする。',
      story: '前提の確認 → 例 → 落とし穴。\nまとめは短く。',
      expectation: '第4章の質問が減る。'
    },
    comments: [{ type: 'document', comment: '結論を先に書く' }]
  });

  // 何を目指した資料かを知らないまま指摘だけ読んでも、直すかどうかを決められません。
  assert.match(markdown, /# Review for guide\.md\n\n## 資料の管理者[\s\S]*## 読み取りコンテキスト[\s\S]*## 文書全体へのコメント/);
  assert.match(markdown, /- 目的: 読者が第4章へ進める状態にする。/);
  // 改行を含む欄は、2文字下げて同じ箇条書きの中へ収めます。
  assert.match(markdown, /- ストーリー: 前提の確認 → 例 → 落とし穴。\n  まとめは短く。/);
  assert.doesNotMatch(buildReviewMarkdown({ targetFile: 'guide.md', comments: [] }), /資料の管理者/);
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
