/**
 * ページ（Notion風の階層を持つ文書）の正本と、その索引の面倒を見るところです。
 *
 * ── Contextと同じ索引に載せる ───────────────────────────
 * ページはContext（`../store.js`）とは別の正本（`pages.json`）を持ちますが、索引は同じ
 * Vector DBです。Chunkの `source` に `page` と書いて区別します。同じ索引にしておくと、
 * 「このWorkspaceで決めたことと書いたことを、まとめて意味で引く」が1回の検索で済み、
 * 索引を取り替えるときも1か所で済みます。範囲キーは `ws:<workspace_id>` で、
 * Contextの範囲キーと同じ形です（`../scope.js`）。CLIが判断を引くのと同じ絞り込みで、
 * そのWorkspaceのページも引けます。
 *
 * ── 索引は保存のあとで、非同期に作る ──────────────────────
 * 編集のたびに埋め込みを作ってから応答すると、外部の埋め込みサービスを使っているときに
 * 1文字ごとの保存が秒単位で待たされ、書き心地が失われます。保存はすぐに返し、索引は
 * ページごとの列で後から作ります。同じページの編集が続いたら、最後の1回だけを索引にします。
 * 検索は `idle()` で列が空になるのを待ってから引くので（`../search.js`）、
 * 「保存したのに出てこない」ことはありません。
 *
 * ── 並び順は兄弟の中の番号 ─────────────────────────────
 * 兄弟の中で0から順に番号を振り、動かすたびに振り直します。番号を飛ばして持つと、
 * 同じ番号が2つできたときにどちらが先か決められません。1つの親の下は多くて数十件なので、
 * 振り直す手間は気になりません。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { contextApiError } from '../model.js';
import { unavailableAs503 } from '../store.js';
import { chunkPage } from './chunking.js';
import {
  applyPagePatch,
  applyWorkspacePatch,
  buildPage,
  buildWorkspace,
  normalizePageContent,
  normalizeTitle,
  normalizeWorkspaceId
} from './model.js';

const STORE_VERSION = 1;
const STORE_FILE = 'pages.json';

/** 索引の形の版。索引のMetadataに何を入れるかを変えたら上げます（`../store.js` と同じ考え方）。 */
export const PAGE_INDEX_VERSION = 1;

/** 1回の取り込みで受け取るページ数の上限。 */
export const MAX_IMPORT_PAGES = 500;

/**
 * @param {object} options
 * @param {string} options.dataDir 正本と索引を置くディレクトリ。
 * @param {object} options.embedder `../embedding.js` が作ったもの。
 * @param {object} options.vectorStore `../vectorStores/` が作ったもの。
 */
export function createPageStore({ dataDir, embedder: rawEmbedder, vectorStore: rawVectorStore, fileName = STORE_FILE }) {
  const filePath = path.join(dataDir, fileName);
  const vectorStore = unavailableAs503(rawVectorStore, 'Vector DB');
  const embedder = unavailableAs503(rawEmbedder, '埋め込み');

  /** workspace_id -> Workspace。読み込むまでは null です。 */
  let workspaces = null;
  /** page_id -> Page。 */
  let pages = null;
  let indexedWith = null;
  let indexedVersion = null;
  let loading = null;
  let writeQueue = Promise.resolve();

  /** 索引を作り直す必要のあるページ。 */
  const dirty = new Set();
  /** ページごとの、いま走っている索引の列。 */
  const pending = new Map();
  /** page_id -> `{ status: 'pending'|'indexed'|'failed', error, at }`。プロセスの中だけで持ちます。 */
  const indexState = new Map();

  function load() {
    if (pages) return Promise.resolve(pages);
    loading = loading || readFile().finally(() => { loading = null; });
    return loading;
  }

  async function readFile() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      workspaces = new Map((parsed?.workspaces || []).map((workspace) => [workspace.workspace_id, workspace]));
      pages = new Map((parsed?.pages || []).map((page) => [page.page_id, page]));
      indexedWith = typeof parsed?.embedding === 'string' ? parsed.embedding : null;
      indexedVersion = Number.isInteger(parsed?.index_version) ? parsed.index_version : null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      workspaces = new Map();
      pages = new Map();
      indexedWith = null;
      indexedVersion = null;
    }
    return pages;
  }

  function persist() {
    const queued = writeQueue.then(write, write);
    writeQueue = queued.catch(() => {});
    return queued;
  }

  async function write() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = {
      version: STORE_VERSION,
      embedding: indexedWith,
      index_version: indexedVersion,
      workspaces: [...workspaces.values()],
      pages: [...pages.values()]
    };
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  }

  /* ---------------------------------------------------------------- *
   * 索引
   * ---------------------------------------------------------------- */

  async function reindexPage(page) {
    await vectorStore.deleteByContext(page.page_id);
    const chunks = chunkPage(page);
    if (chunks.length === 0) return;
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.embedText));
    await vectorStore.upsert(chunks.map((chunk, index) => ({
      id: `${page.page_id}#${index}`,
      contextId: page.page_id,
      vector: vectors[index],
      text: chunk.text,
      metadata: {
        source: 'page',
        scope_key: `ws:${page.workspace_id}`,
        scope_depth: 0,
        workspace_id: page.workspace_id,
        page_id: page.page_id,
        heading: chunk.heading,
        updated_at: page.updated_at
      }
    })));
  }

  async function runIndex(pageId) {
    const page = pages.get(pageId);
    try {
      if (page) await reindexPage(page);
      else await vectorStore.deleteByContext(pageId);
      if (page) indexState.set(pageId, { status: 'indexed', error: null, at: new Date().toISOString() });
      else indexState.delete(pageId);
    } catch (error) {
      // 索引に失敗しても正本は残っています。状態に残して、画面と `/health` から見えるようにします。
      if (page) indexState.set(pageId, { status: 'failed', error: error.message, at: new Date().toISOString() });
    }
  }

  /** 同じページの編集が続いたら、最後の1回だけを索引にします。 */
  function scheduleIndex(pageId) {
    dirty.add(pageId);
    if (pages.has(pageId)) indexState.set(pageId, { status: 'pending', error: null, at: null });
    if (pending.has(pageId)) return pending.get(pageId);
    const job = (async () => {
      while (dirty.has(pageId)) {
        dirty.delete(pageId);
        await runIndex(pageId);
      }
    })().finally(() => {
      pending.delete(pageId);
      // 列を閉じる直前に届いた編集は、次の列で拾います。
      if (dirty.has(pageId)) scheduleIndex(pageId);
    });
    pending.set(pageId, job);
    return job;
  }

  /* ---------------------------------------------------------------- *
   * 木の道具
   * ---------------------------------------------------------------- */

  function siblingsOf(workspaceId, parentId, { except = null } = {}) {
    return [...pages.values()]
      .filter((page) => page.workspace_id === workspaceId && page.parent_id === parentId && page.page_id !== except)
      .sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
  }

  /** 兄弟の列へ入れて、0から番号を振り直します。`position` が null なら末尾です。 */
  function place(page, position) {
    const siblings = siblingsOf(page.workspace_id, page.parent_id, { except: page.page_id });
    const index = position === null || position === undefined ? siblings.length : Math.min(position, siblings.length);
    siblings.splice(index, 0, page);
    siblings.forEach((sibling, order) => { sibling.position = order; });
  }

  function requirePage(pageId) {
    const page = pages.get(pageId);
    if (!page) throw contextApiError(`ページが見つかりません: ${pageId}`, 404);
    return page;
  }

  function requireWorkspace(workspaceId) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw contextApiError(`Workspaceが見つかりません: ${workspaceId}`, 404);
    return workspace;
  }

  function isDescendant(pageId, ancestorId) {
    let current = pages.get(pageId);
    while (current?.parent_id) {
      if (current.parent_id === ancestorId) return true;
      current = pages.get(current.parent_id);
    }
    return false;
  }

  function subtreeIds(pageId) {
    const ids = [pageId];
    for (let index = 0; index < ids.length; index += 1) {
      for (const page of pages.values()) {
        if (page.parent_id === ids[index]) ids.push(page.page_id);
      }
    }
    return ids;
  }

  function assertParent(page, parentId) {
    if (!parentId) return;
    const parent = pages.get(parentId);
    if (!parent) throw contextApiError(`親のページが見つかりません: ${parentId}`, 400);
    if (parent.workspace_id !== page.workspace_id) throw contextApiError('別のWorkspaceのページの下には置けません', 400);
    if (parentId === page.page_id || isDescendant(parentId, page.page_id)) {
      throw contextApiError('ページを自分自身や、その下のページの中へは動かせません', 400);
    }
  }

  function summary(page) {
    return {
      page_id: page.page_id,
      workspace_id: page.workspace_id,
      parent_id: page.parent_id,
      title: page.title,
      position: page.position,
      created_at: page.created_at,
      updated_at: page.updated_at
    };
  }

  function withIndex(page) {
    return { ...page, index: indexState.get(page.page_id) || { status: 'indexed', error: null, at: null } };
  }

  /**
   * 木の順（親の次に子）でWorkspaceのページを並べます。
   */
  function orderedPages(workspaceId) {
    const ordered = [];
    const visit = (parentId, depth) => {
      for (const page of siblingsOf(workspaceId, parentId)) {
        ordered.push({ page, depth });
        visit(page.page_id, depth + 1);
      }
    };
    visit(null, 0);
    return ordered;
  }

  function breadcrumbOf(pageId) {
    const trail = [];
    let current = pages.get(pageId);
    const seen = new Set();
    while (current && !seen.has(current.page_id)) {
      seen.add(current.page_id);
      trail.unshift({ page_id: current.page_id, title: current.title });
      current = current.parent_id ? pages.get(current.parent_id) : null;
    }
    return trail;
  }

  /* ---------------------------------------------------------------- *
   * 口
   * ---------------------------------------------------------------- */

  return {
    embedder,
    vectorStore,

    /**
     * 使える状態にします。埋め込みか索引の形が前回と違えば、全ページの索引を作り直します。
     * @param {object} [options] Vector DBへそのまま渡します。
     */
    async ready(options = {}) {
      await vectorStore.ready(options);
      await load();
      if (indexedWith === embedder.id && indexedVersion === PAGE_INDEX_VERSION) return { reindexed: 0 };
      let reindexed = 0;
      for (const page of pages.values()) {
        await reindexPage(page);
        reindexed += 1;
      }
      indexedWith = embedder.id;
      indexedVersion = PAGE_INDEX_VERSION;
      await persist();
      return { reindexed };
    },

    /** 走っている索引の列がすべて空になるまで待ちます。検索の前と、テストで使います。 */
    async idle() {
      while (pending.size) {
        await Promise.all([...pending.values()]);
      }
    },

    /** 索引の状態の要約。`/health` が出します。 */
    indexSummary() {
      let pendingCount = 0;
      let failed = 0;
      for (const state of indexState.values()) {
        if (state.status === 'pending') pendingCount += 1;
        if (state.status === 'failed') failed += 1;
      }
      return { pending: pendingCount, failed };
    },

    /** 失敗した索引をもう一度作ります。埋め込みサービスを立ち上げ直したあとに使います。 */
    async retryFailedIndexes() {
      await load();
      const ids = [...indexState.entries()].filter(([, state]) => state.status === 'failed').map(([id]) => id);
      for (const id of ids) scheduleIndex(id);
      await this.idle();
      return { retried: ids.length, ...this.indexSummary() };
    },

    async count() {
      await load();
      return pages.size;
    },

    /* ---- Workspace ---- */

    /**
     * @param {object} [options]
     * @param {string[]} [options.extraIds] Contextだけを持つWorkspaceのid（`../store.js` の `workspaceIds`）。
     *   登録の無いものは名前をidのまま出し、`registered: false` を付けます。
     */
    async listWorkspaces({ extraIds = [] } = {}) {
      await load();
      const counts = new Map();
      for (const page of pages.values()) counts.set(page.workspace_id, (counts.get(page.workspace_id) || 0) + 1);
      const listed = [...workspaces.values()].map((workspace) => ({
        ...workspace,
        registered: true,
        page_count: counts.get(workspace.workspace_id) || 0
      }));
      for (const id of extraIds) {
        if (workspaces.has(id)) continue;
        listed.push({ workspace_id: id, name: id, created_at: null, updated_at: null, registered: false, page_count: 0 });
      }
      return listed.sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.workspace_id.localeCompare(b.workspace_id));
    },

    async createWorkspace(input = {}) {
      await load();
      const workspace = buildWorkspace(input);
      if (workspaces.has(workspace.workspace_id)) {
        throw contextApiError(`同じidのWorkspaceがあります: ${workspace.workspace_id}`, 409);
      }
      workspaces.set(workspace.workspace_id, workspace);
      await persist();
      return workspace;
    },

    /** 登録が無ければ、idを名前にして登録します。CLIが先にContextだけを保存したWorkspaceに名前を付ける道です。 */
    async ensureWorkspace(workspaceId) {
      await load();
      const id = normalizeWorkspaceId(workspaceId);
      if (workspaces.has(id)) return workspaces.get(id);
      const workspace = buildWorkspace({ workspace_id: id });
      workspaces.set(id, workspace);
      await persist();
      return workspace;
    },

    async getWorkspace(workspaceId) {
      await load();
      return workspaces.get(workspaceId) || null;
    },

    async patchWorkspace(workspaceId, patch) {
      await load();
      const stored = workspaces.get(workspaceId) || (await this.ensureWorkspace(workspaceId));
      const workspace = applyWorkspacePatch(stored, patch);
      workspaces.set(workspaceId, workspace);
      await persist();
      return workspace;
    },

    /** Workspaceと、その中のページをすべて消します。Contextは別の正本なので、ここでは消しません。 */
    async removeWorkspace(workspaceId) {
      await load();
      const existed = workspaces.delete(workspaceId);
      const removed = [...pages.values()].filter((page) => page.workspace_id === workspaceId).map((page) => page.page_id);
      if (!existed && removed.length === 0) throw contextApiError(`Workspaceが見つかりません: ${workspaceId}`, 404);
      for (const id of removed) pages.delete(id);
      await persist();
      await Promise.all(removed.map((id) => scheduleIndex(id)));
      return { deleted: true, deleted_pages: removed.length };
    },

    /* ---- ページ ---- */

    /** Workspaceのページを木の順に。本文は含めません（一覧は本文なしで十分に軽く保ちます）。 */
    async tree(workspaceId) {
      await load();
      return orderedPages(workspaceId).map(({ page, depth }) => ({ ...summary(page), depth }));
    },

    async create(input = {}) {
      await load();
      const page = buildPage(input);
      assertParent(page, page.parent_id);
      // 登録の無いWorkspaceへ最初のページを置いたときは、そのまま登録します。
      if (!workspaces.has(page.workspace_id)) {
        workspaces.set(page.workspace_id, buildWorkspace({ workspace_id: page.workspace_id }));
      }
      pages.set(page.page_id, page);
      place(page, normalizeOptionalPosition(input.position));
      await persist();
      scheduleIndex(page.page_id);
      return withIndex(page);
    },

    async get(pageId) {
      await load();
      const page = pages.get(pageId);
      return page ? { ...withIndex(page), breadcrumb: breadcrumbOf(pageId) } : null;
    },

    async breadcrumb(pageId) {
      await load();
      return breadcrumbOf(pageId);
    },

    async patch(pageId, changes) {
      await load();
      const stored = requirePage(pageId);
      const { page, contentChanged, titleChanged, moved, position } = applyPagePatch(stored, changes);
      if (moved) assertParent(page, page.parent_id);
      pages.set(pageId, page);
      if (moved) place(page, position);
      await persist();
      // 題名は埋め込む文に入っているので（`chunking.js`）、題名だけの変更でも作り直します。
      if (contentChanged || titleChanged) scheduleIndex(pageId);
      return { page: withIndex(page), contentChanged, titleChanged, moved };
    },

    /** ページと、その下のページをすべて消します。 */
    async remove(pageId) {
      await load();
      const page = requirePage(pageId);
      const ids = subtreeIds(pageId);
      for (const id of ids) pages.delete(id);
      // 抜けた穴を詰めて、兄弟の番号を振り直します。
      siblingsOf(page.workspace_id, page.parent_id).forEach((sibling, order) => { sibling.position = order; });
      await persist();
      await Promise.all(ids.map((id) => scheduleIndex(id)));
      return { deleted: ids };
    },

    /* ---- 取り込みと書き出し ---- */

    /**
     * Workspaceのページを、木の順に本文ごと返します。`path` は題名を `/` で繋いだもので、
     * Markdownのファイルとして書き出すときの置き場所の目安です。
     */
    async exportWorkspace(workspaceId) {
      await load();
      const workspace = workspaces.get(workspaceId) || null;
      const exported = orderedPages(workspaceId).map(({ page, depth }) => ({
        ...page,
        depth,
        path: breadcrumbOf(page.page_id).map((entry) => entry.title || '無題').join('/')
      }));
      if (!workspace && exported.length === 0) throw contextApiError(`Workspaceが見つかりません: ${workspaceId}`, 404);
      return { workspace, pages: exported };
    },

    /**
     * Markdownのファイルの束を、パスの階層どおりにページへ取り込みます。
     *
     * @param {string} workspaceId
     * @param {Array<{path?: string, title?: string, content: string, parent_id?: string}>} entries
     *   `path` は `docs/auth/token.md` のような相対パスです。ディレクトリは同名のページになり、
     *   すでに同じ題名の兄弟があればそこへ入ります。題名は、指定が無ければ本文の最初の `# 見出し`、
     *   それも無ければファイル名です。
     */
    async importPages(workspaceId, entries = []) {
      await load();
      const id = normalizeWorkspaceId(workspaceId);
      if (!Array.isArray(entries) || entries.length === 0) throw contextApiError('pages を1件以上指定してください');
      if (entries.length > MAX_IMPORT_PAGES) throw contextApiError(`一度に取り込めるのは${MAX_IMPORT_PAGES}件までです`);
      if (!workspaces.has(id)) workspaces.set(id, buildWorkspace({ workspace_id: id }));

      const created = [];
      const now = new Date().toISOString();
      const findChild = (parentId, title) => siblingsOf(id, parentId).find((page) => page.title === title) || null;
      const addPage = (parentId, title, content) => {
        const page = buildPage({ workspace_id: id, parent_id: parentId, title, content }, { now });
        pages.set(page.page_id, page);
        place(page, null);
        created.push(page.page_id);
        return page;
      };

      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') throw contextApiError('pages の各要素はオブジェクトで指定してください');
        const rawPath = typeof entry.path === 'string' ? entry.path.replace(/\\/g, '/').trim() : '';
        const segments = rawPath.split('/').filter((segment) => segment && segment !== '.');
        if (segments.some((segment) => segment === '..')) throw contextApiError(`path に .. は使えません: ${rawPath}`);
        const fileName = segments.pop() || '';
        const { title, content } = titleAndBody(entry, fileName);

        let parentId = entry.parent_id ? normalizeParentForImport(entry.parent_id, id) : null;
        for (const segment of segments) {
          const existing = findChild(parentId, segment);
          parentId = (existing || addPage(parentId, segment, '')).page_id;
        }
        addPage(parentId, title, content);
      }

      await persist();
      for (const pageId of created) scheduleIndex(pageId);
      return { created: created.length, page_ids: created };

      function normalizeParentForImport(parentId, workspace) {
        const parent = pages.get(String(parentId));
        if (!parent || parent.workspace_id !== workspace) throw contextApiError(`親のページが見つかりません: ${parentId}`, 400);
        return parent.page_id;
      }
    },

    async close() {
      await this.idle();
      await writeQueue;
    }
  };
}

function normalizeOptionalPosition(value) {
  if (value === undefined || value === null || value === '') return null;
  const position = Number(value);
  if (!Number.isInteger(position) || position < 0) throw contextApiError(`position は0以上の整数で指定してください: ${value}`);
  return position;
}

/**
 * 取り込む1件の題名と本文。題名の指定が無ければ、本文の最初の `# 見出し` を題名にして本文から外します。
 * 題名と本文の両方に同じ見出しがあると、画面で二重に見えるからです。
 */
function titleAndBody(entry, fileName) {
  let content = normalizePageContent(entry.content);
  let title = normalizeTitle(entry.title);
  if (!title) {
    const lines = content.split('\n');
    const first = lines.findIndex((line) => line.trim());
    const heading = first >= 0 ? lines[first].match(/^#\s+(.*?)\s*#*\s*$/) : null;
    if (heading) {
      title = normalizeTitle(heading[1]);
      content = lines.slice(first + 1).join('\n').replace(/^\n+/, '');
    }
  }
  if (!title) title = normalizeTitle(fileName.replace(/\.(md|markdown|txt)$/i, ''));
  return { title, content };
}
