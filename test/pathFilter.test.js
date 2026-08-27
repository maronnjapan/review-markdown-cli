import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/cli.js';
import { createPathFilter } from '../src/pathFilter.js';
import { createServer, listMarkdownFiles } from '../src/server.js';

test('a pattern without wildcards covers the whole directory below it', () => {
  const filter = createPathFilter({ exclude: ['drafts'] });

  assert.equal(filter.matchesFile('drafts/chapter1.md'), false);
  assert.equal(filter.matchesFile('drafts/deep/nested/chapter1.md'), false);
  assert.equal(filter.allowsDirectory('drafts'), false);
  assert.equal(filter.matchesFile('published/chapter1.md'), true);
});

test('a single segment pattern matches at any depth, a path pattern stays anchored', () => {
  const anyDepth = createPathFilter({ exclude: ['drafts', '*.wip.md'] });

  assert.equal(anyDepth.matchesFile('drafts/a.md'), false);
  assert.equal(anyDepth.matchesFile('book/part1/drafts/a.md'), false);
  assert.equal(anyDepth.matchesFile('book/part1/plan.wip.md'), false);
  assert.equal(anyDepth.matchesFile('book/part1/plan.md'), true);

  const anchored = createPathFilter({ exclude: ['/drafts'] });
  assert.equal(anchored.matchesFile('drafts/a.md'), false);
  assert.equal(anchored.matchesFile('book/drafts/a.md'), true);
});

test('wildcards match segments, ** crosses directories and {} picks alternatives', () => {
  const filter = createPathFilter({
    include: ['docs/*.md', '**/chapter-?.md', '{notes,memo}/**']
  });

  assert.equal(filter.matchesFile('docs/intro.md'), true);
  assert.equal(filter.matchesFile('docs/nested/intro.md'), false);
  assert.equal(filter.matchesFile('book/part1/chapter-3.md'), true);
  assert.equal(filter.matchesFile('book/part1/chapter-10.md'), false);
  assert.equal(filter.matchesFile('notes/2026/today.md'), true);
  assert.equal(filter.matchesFile('memo/today.md'), true);
  assert.equal(filter.matchesFile('other/today.md'), false);
});

test('--exclude wins over --include', () => {
  const filter = createPathFilter({ include: ['docs/**'], exclude: ['**/*.draft.md'] });

  assert.equal(filter.matchesFile('docs/plan.md'), true);
  assert.equal(filter.matchesFile('docs/plan.draft.md'), false);
});

test('directories are only walked when they could still hold an included file', () => {
  const filter = createPathFilter({ include: ['docs/guide/**'] });

  assert.equal(filter.allowsDirectory('docs'), true);
  assert.equal(filter.allowsDirectory('docs/guide'), true);
  assert.equal(filter.allowsDirectory('docs/guide/advanced'), true);
  assert.equal(filter.allowsDirectory('assets'), false);
});

test('.git, node_modules and .review stay hidden even with an --include', () => {
  const filter = createPathFilter({ include: ['**/*.md'] });

  assert.equal(filter.matchesFile('.review/example.md'), false);
  assert.equal(filter.matchesFile('node_modules/pkg/readme.md'), false);
  assert.equal(filter.allowsDirectory('docs/.git'), false);
});

test('patterns accept ./ prefixes, trailing slashes, backslashes and comma separated lists', () => {
  const filter = createPathFilter({ exclude: ['./drafts/,notes\\private/'] });

  assert.equal(filter.matchesFile('drafts/a.md'), false);
  assert.equal(filter.matchesFile('notes/private/a.md'), false);
  assert.equal(filter.matchesFile('notes/public/a.md'), true);
});

test('parseArgs collects repeated and comma separated globs', () => {
  const options = parseArgs([
    'book',
    '--exclude', 'drafts/**',
    '--exclude=tmp,archive',
    '--include', 'book/**',
    '--port', '4100',
    '--no-open'
  ]);

  assert.equal(options.targetDir, 'book');
  assert.equal(options.port, 4100);
  assert.equal(options.open, false);
  assert.deepEqual(options.include, ['book/**']);
  assert.deepEqual(options.exclude, ['drafts/**', 'tmp', 'archive']);
});

test('parseArgs reports unusable input instead of guessing', () => {
  assert.throws(() => parseArgs(['--port', 'abc']), /--port must be an integer/);
  assert.throws(() => parseArgs(['--exclude']), /--exclude requires a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option: --nope/);
  assert.throws(() => parseArgs(['a', 'b']), /already set/);
  assert.equal(parseArgs([], { PORT: '5050' }).port, 5050);
});

test('listMarkdownFiles applies --include and --exclude', async () => {
  const root = await seedProject();

  assert.deepEqual(
    await listMarkdownFiles(root, createPathFilter({ exclude: ['drafts'] })),
    ['docs/guide/intro.md', 'docs/plan.md', 'README.md']
  );
  assert.deepEqual(
    await listMarkdownFiles(root, createPathFilter({ include: ['docs/**'] })),
    ['docs/guide/intro.md', 'docs/plan.md']
  );
  assert.deepEqual(
    await listMarkdownFiles(root, createPathFilter({ include: ['**/*.md'], exclude: ['docs/guide/**', 'drafts/**'] })),
    ['docs/plan.md', 'README.md']
  );
});

test('the API refuses files that --exclude hides', async (t) => {
  const root = await seedProject();
  const { app } = createServer(root, { exclude: ['drafts/**'] });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listed = await fetch(`${baseUrl}/api/files`).then((response) => response.json());
  assert.deepEqual(listed.files, ['docs/guide/intro.md', 'docs/plan.md', 'README.md']);
  assert.deepEqual(listed.filters, { include: [], exclude: ['drafts/**'] });

  const allowed = await fetch(`${baseUrl}/api/file?path=docs/plan.md`);
  assert.equal(allowed.status, 200);

  const hidden = await fetch(`${baseUrl}/api/file?path=drafts/wip.md`);
  assert.equal(hidden.status, 404);
  assert.match((await hidden.json()).error, /レビュー対象から外れています/);

  const hiddenWrite = await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'drafts/wip.md', comments: [{ type: 'document', comment: 'nope' }] })
  });
  assert.equal(hiddenWrite.status, 404);
  await assert.rejects(fs.stat(path.join(root, '.review')), { code: 'ENOENT' });
});

async function seedProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-filter-'));
  await fs.mkdir(path.join(root, 'docs', 'guide'), { recursive: true });
  await fs.mkdir(path.join(root, 'drafts'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Readme\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'plan.md'), '# Plan\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'guide', 'intro.md'), '# Intro\n', 'utf8');
  await fs.writeFile(path.join(root, 'drafts', 'wip.md'), '# WIP\n', 'utf8');
  return root;
}
