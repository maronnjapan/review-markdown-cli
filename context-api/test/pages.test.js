import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalEmbedder } from '../src/embedding.js';
import { chunkPage, splitSections } from '../src/pages/chunking.js';
import { applyPagePatch, buildPage, buildWorkspace, createWorkspaceId } from '../src/pages/model.js';
import { createPageStore } from '../src/pages/store.js';
import { createLocalVectorStore } from '../src/vectorStores/local.js';

/**
 * ページ（Notion風の階層を持つ文書）のテストです。
 *
 * 守っているのは、木として扱えること（親子・並び順・移動・まとめて削除）、
 * 保存のあとで索引が作られて意味で引けること、取り込みと書き出しで階層が保たれることです。
 */

test('ページは見出しごとに切り、題名と見出しの経路を付けて埋め込む', () => {
  const content = [
    '前書き。',
    '',
    '# トークン',
    '',
    '有効期限は15分にする。',
    '',
    '## Refresh',
    '',
    'Refresh TokenはAgentへ渡さない。',
    '',
    '```',
    '# これは見出しではない',
    '```',
    '',
    '# 課金',
    ''
  ].join('\n');

  const sections = splitSections(content);
  assert.deepEqual(sections.map((section) => section.headingPath), [[], ['トークン'], ['トークン', 'Refresh'], ['課金']]);
  assert.match(sections[2].text, /これは見出しではない/, 'コードブロックの中の # は見出しにしない');
  assert.equal(sections[3].text, '課金', '本文の無い見出しは、見出しの字を本文にする');

  const chunks = chunkPage({ title: '認証の設計', content });
  assert.equal(chunks[1].heading, 'トークン');
  assert.equal(chunks[1].text, '有効期限は15分にする。', '抜粋には題名と見出しを混ぜない');
  assert.equal(chunks[1].embedText, '認証の設計\nトークン\n有効期限は15分にする。', '埋め込む文には題名と見出しを付ける');
  assert.deepEqual(chunkPage({ title: '題名だけ', content: '' }), [{ text: '', heading: '', embedText: '題名だけ' }]);
  assert.deepEqual(chunkPage({ title: '', content: '' }), []);
});

test('ページとWorkspaceの形。題名は空でもよく、本文の改行はLFに揃える', () => {
  const page = buildPage({ workspace_id: 'W', content: 'a\r\nb' });
  assert.equal(page.title, '');
  assert.equal(page.content, 'a\nb');
  assert.match(page.page_id, /^pg_/);
  assert.throws(() => buildPage({ content: 'x' }), /workspace_id を指定してください/);
  assert.throws(() => buildPage({ workspace_id: 'W', content: 'x'.repeat(200_001) }), /content が長すぎます/);
  assert.throws(() => buildPage({ workspace_id: 'W', title: 5 }), /title は文字列/);

  const { page: patched, contentChanged, moved } = applyPagePatch(page, { parent_id: 'pg_parent', position: 2 });
  assert.equal(contentChanged, false);
  assert.equal(moved, true);
  assert.equal(patched.updated_at, page.updated_at, '並べ替えだけでは更新日時を動かさない');
  assert.throws(() => applyPagePatch(page, { workspace_id: 'OTHER' }), /workspace_id は更新できません/);

  const workspace = buildWorkspace({ name: '  認証基盤  ' });
  assert.match(workspace.workspace_id, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'CLIと同じULIDの形');
  assert.equal(workspace.name, '認証基盤');
  assert.equal(buildWorkspace({ workspace_id: 'proj-a' }).name, 'proj-a', '名前が無ければidを名前にする');
  assert.throws(() => buildWorkspace({ workspace_id: 'bad id' }), /英数字/);
  assert.ok(createWorkspaceId(1) < createWorkspaceId(2), '先頭が時刻なので作った順に並ぶ');
});

test('ページは親子と並び順を持ち、動かすと兄弟の番号を振り直す', async (t) => {
  const store = await seedStore(t);
  const root = await store.create({ workspace_id: 'W', title: '設計' });
  const first = await store.create({ workspace_id: 'W', parent_id: root.page_id, title: '認証' });
  const second = await store.create({ workspace_id: 'W', parent_id: root.page_id, title: '課金' });
  const third = await store.create({ workspace_id: 'W', parent_id: root.page_id, title: '監査', position: 0 });

  assert.deepEqual(
    (await store.tree('W')).map((page) => [page.title, page.depth, page.position]),
    [['設計', 0, 0], ['監査', 1, 0], ['認証', 1, 1], ['課金', 1, 2]],
    '木の順に並び、position を指定すればそこへ割り込む'
  );

  await store.patch(second.page_id, { parent_id: null, position: 0 });
  assert.deepEqual(
    (await store.tree('W')).map((page) => [page.title, page.depth, page.position]),
    [['課金', 0, 0], ['設計', 0, 1], ['監査', 1, 0], ['認証', 1, 1]],
    '動かしたあと、元の兄弟も新しい兄弟も0から番号が振り直される'
  );
  assert.deepEqual((await store.get(first.page_id)).breadcrumb.map((entry) => entry.title), ['設計', '認証']);

  await assert.rejects(() => store.patch(root.page_id, { parent_id: first.page_id }), /自分自身や、その下のページ/);
  await assert.rejects(() => store.patch(root.page_id, { parent_id: root.page_id }), /自分自身/);
  await assert.rejects(() => store.create({ workspace_id: 'OTHER', parent_id: root.page_id, title: 'x' }), /別のWorkspace/);
  await assert.rejects(() => store.patch('pg_none', { title: 'x' }), (error) => error.statusCode === 404);

  const { deleted } = await store.remove(root.page_id);
  assert.equal(deleted.length, 3, '下のページごと消える');
  assert.deepEqual((await store.tree('W')).map((page) => page.title), ['課金']);
  assert.equal(third.page_id !== undefined, true);
});

test('保存したページは、索引ができたあと意味で引ける。直せば直したあとの本文が引ける', async (t) => {
  const store = await seedStore(t);
  const page = await store.create({
    workspace_id: 'W', title: '認証の設計', content: '# トークン\n\n有効期限は15分にする。'
  });
  assert.equal((await store.get(page.page_id)).index.status, 'pending', '保存の直後は索引待ち');
  await store.idle();
  assert.equal((await store.get(page.page_id)).index.status, 'indexed');

  const hits = await store.vectorStore.query({ vector: (await store.embedder.embed(['有効期限は15分にする']))[0], limit: 5, sources: ['page'] });
  assert.equal(hits[0].contextId, page.page_id);
  assert.equal(hits[0].metadata.source, 'page');
  assert.equal(hits[0].metadata.scope_key, 'ws:W', 'CLIがWorkspaceの判断を引く範囲と同じ鍵');

  await store.patch(page.page_id, { content: '# トークン\n\n有効期限は30分にした。' });
  await store.idle();
  const after = await store.vectorStore.query({ vector: (await store.embedder.embed(['有効期限']))[0], limit: 5, sources: ['page'] });
  assert.ok(after.length >= 1);
  assert.equal(await store.vectorStore.count(), 1, '古いChunkは消えて、新しい本文のぶんだけが残る');

  await store.remove(page.page_id);
  await store.idle();
  assert.equal(await store.vectorStore.count(), 0, '消したページは索引からも消える');
});

test('同じページの編集が続いても、索引は最後の1回ぶんだけ作る', async (t) => {
  const dataDir = await temporaryDir(t);
  let embedCalls = 0;
  const embedder = createLocalEmbedder();
  const counting = {
    ...embedder,
    async embed(texts) {
      embedCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return embedder.embed(texts);
    }
  };
  const store = createPageStore({ dataDir, embedder: counting, vectorStore: createLocalVectorStore({ dataDir }) });
  await store.ready();
  const page = await store.create({ workspace_id: 'W', title: 'メモ', content: 'a' });
  for (const content of ['ab', 'abc', 'abcd', 'abcde']) await store.patch(page.page_id, { content });
  await store.idle();
  assert.ok(embedCalls < 5, `編集5回に対して埋め込みは${embedCalls}回で済む`);
  assert.equal((await store.get(page.page_id)).index.status, 'indexed');
  await store.close();
});

test('索引に失敗しても保存は残り、あとで作り直せる', async (t) => {
  const dataDir = await temporaryDir(t);
  let broken = true;
  const embedder = createLocalEmbedder();
  const flaky = {
    ...embedder,
    async embed(texts) {
      if (broken) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      return embedder.embed(texts);
    }
  };
  const store = createPageStore({ dataDir, embedder: flaky, vectorStore: createLocalVectorStore({ dataDir }) });
  await store.ready();
  const page = await store.create({ workspace_id: 'W', title: '認証', content: 'OIDCを使う' });
  await store.idle();
  const saved = await store.get(page.page_id);
  assert.equal(saved.content, 'OIDCを使う', '正本は残っている');
  assert.equal(saved.index.status, 'failed');
  assert.match(saved.index.error, /ECONNREFUSED/);
  assert.deepEqual(store.indexSummary(), { pending: 0, failed: 1 });

  broken = false;
  assert.deepEqual(await store.retryFailedIndexes(), { retried: 1, pending: 0, failed: 0 });
  assert.equal((await store.get(page.page_id)).index.status, 'indexed');
  await store.close();
});

test('Workspaceは登録が無くても、ページを置いた時点で名前付きで並ぶ', async (t) => {
  const store = await seedStore(t);
  const created = await store.createWorkspace({ name: '認証基盤' });
  await store.create({ workspace_id: 'auto', title: 'x' });
  const listed = await store.listWorkspaces({ extraIds: ['from-cli', created.workspace_id] });
  assert.deepEqual(
    listed.map((workspace) => [workspace.workspace_id, workspace.name, workspace.registered, workspace.page_count]),
    [['auto', 'auto', true, 1], ['from-cli', 'from-cli', false, 0], [created.workspace_id, '認証基盤', true, 0]]
  );
  await store.patchWorkspace('from-cli', { name: 'CLIのプロジェクト' });
  assert.equal((await store.getWorkspace('from-cli')).name, 'CLIのプロジェクト', '判断だけのWorkspaceにも名前を付けられる');
  await assert.rejects(() => store.createWorkspace({ workspace_id: 'auto' }), (error) => error.statusCode === 409);

  const removed = await store.removeWorkspace('auto');
  assert.deepEqual(removed, { deleted: true, deleted_pages: 1 });
  await store.idle();
  assert.equal(await store.vectorStore.count(), 0);
});

test('Markdownの束をパスの階層どおりに取り込み、同じ階層で書き出す', async (t) => {
  const store = await seedStore(t);
  const result = await store.importPages('W', [
    { path: 'docs/auth/token.md', content: '# トークンの決まり\n\n有効期限は15分。' },
    { path: 'docs/auth/refresh.md', content: 'Refresh Tokenは渡さない。' },
    { path: 'README.md', content: '# 全体\n\n概要。' }
  ]);
  assert.equal(result.created, 5, 'docs と auth の2つが階層のページとして作られる');

  const tree = await store.tree('W');
  assert.deepEqual(tree.map((page) => [page.title, page.depth]), [
    ['docs', 0], ['auth', 1], ['トークンの決まり', 2], ['refresh', 2], ['全体', 0]
  ]);
  const token = await store.get(tree[2].page_id);
  assert.equal(token.content, '有効期限は15分。', '題名にした見出しは本文から外す');

  const exported = await store.exportWorkspace('W');
  assert.deepEqual(exported.pages.map((page) => page.path), ['docs', 'docs/auth', 'docs/auth/トークンの決まり', 'docs/auth/refresh', '全体']);
  await assert.rejects(() => store.importPages('W', [{ path: '../x.md', content: 'x' }]), /\.\. は使えません/);
  await assert.rejects(() => store.importPages('W', []), /1件以上/);
});

test('埋め込みを取り替えたら、ページの索引も作り直す', async (t) => {
  const dataDir = await temporaryDir(t);
  const first = createPageStore({ dataDir, embedder: createLocalEmbedder({ dimensions: 64 }), vectorStore: createLocalVectorStore({ dataDir }) });
  await first.ready();
  await first.create({ workspace_id: 'W', title: '認証', content: 'OIDCを使う' });
  await first.close();

  const second = createPageStore({ dataDir, embedder: createLocalEmbedder({ dimensions: 512 }), vectorStore: createLocalVectorStore({ dataDir }) });
  assert.deepEqual(await second.ready(), { reindexed: 1 });
  const hits = await second.vectorStore.query({ vector: (await second.embedder.embed(['OIDC']))[0], limit: 1 });
  assert.equal(hits[0].vector?.length ?? 512, 512);
  await second.close();
});

/* ---------------------------------------------------------------- *
 * 道具
 * ---------------------------------------------------------------- */

async function temporaryDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-markdown-pages-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedStore(t) {
  // 索引は保存のあとで非同期に作られるので、ディレクトリを消す前に列が空になるのを待ちます。
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-markdown-pages-'));
  const store = createPageStore({
    dataDir,
    embedder: createLocalEmbedder(),
    vectorStore: createLocalVectorStore({ dataDir })
  });
  await store.ready();
  t.after(async () => {
    await store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return store;
}
