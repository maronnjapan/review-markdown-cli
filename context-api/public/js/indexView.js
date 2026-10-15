/**
 * 索引の画面です。ChromaDB（または1ファイルの索引）に入っているChunkを、入れた形のまま並べます。
 *
 * 「保存したのに引けない」ときに見るところです。何を埋め込んだか（本文・範囲・出どころ）と、
 * 埋め込みの結果（ベクトル）をその場で確かめられます。ChromaDBはこの端末の外へ公開していないので、
 * ローカルでもデプロイ先でも、このサービスの口（`GET /index/chunks`）を通して見ます。
 */

import { escapeHtml, relativeTime } from './util.js';

const PAGE_SIZE = 50;
const SOURCE_LABELS = { context: '判断', page: 'ページ' };

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.api
 * @param {Function} options.toast `(kind, message)`
 * @param {Function} options.hrefForPage `(pageId, workspaceId)`
 * @param {Function} options.hrefForContext `(contextId, workspaceId)`
 */
export function createIndexView({ root, api, toast, hrefForPage, hrefForContext }) {
  let filter = { source: '', id: '' };
  let offset = 0;
  let listed = { chunks: [], total: 0 };
  /** 開いたベクトル。Chunk id -> `{ vector }`。一覧には付かないので、開いたときに1件ずつ引きます。 */
  const vectors = new Map();

  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);

  async function show({ source = '', id = '' } = {}) {
    document.title = '索引 · Knowledge';
    filter = { source, id };
    offset = 0;
    vectors.clear();
    paintShell();
    await Promise.all([paintFacts(), load()]);
  }

  function paintShell() {
    root.innerHTML = `
      <section class="index-view">
        <header class="view-head">
          <h1>索引</h1>
          <p class="view-lead">ChromaDB（または1ファイルの索引）に入っているChunkを、入れた形のまま並べます。本文は判断とページから切ったもので、ベクトルはそれを埋め込んだ結果です。「保存したのに引けない」ときは、ここで何が埋め込まれているかを確かめられます。</p>
        </header>
        <dl class="settings-facts" data-facts><dt>索引</dt><dd>確認しています…</dd></dl>
        <form class="index-filter" data-filter>
          <label class="field"><span>出どころ</span>
            <select name="source">
              <option value="">すべて</option>
              <option value="context">判断</option>
              <option value="page">ページ</option>
            </select></label>
          <label class="field"><span>判断またはページのid</span><input name="id" type="text" placeholder="ctx_… / pg_…" value="${escapeHtml(filter.id)}"></label>
          <button type="submit">絞る</button>
          <button type="button" data-clear>すべて表示</button>
        </form>
        <h2 class="context-list-label" data-count></h2>
        <div class="index-list" data-list></div>
        <nav class="index-pager" data-pager aria-label="索引のページ送り"></nav>
      </section>`;
    root.querySelector('select[name="source"]').value = filter.source;
  }

  async function paintFacts() {
    const facts = root.querySelector('[data-facts]');
    if (!facts) return;
    try {
      const health = await api.health();
      facts.innerHTML = [
        ['索引', escapeHtml(health.vector_store?.label || '')],
        ['埋め込み', escapeHtml(health.embedding?.label || '')],
        ['件数', `Chunk ${health.counts?.chunks ?? '?'}件（判断 ${health.counts?.contexts ?? 0}件 · ページ ${health.counts?.pages ?? 0}件から）`]
      ].map(([term, detail]) => `<dt>${term}</dt><dd>${detail}</dd>`).join('');
    } catch (error) {
      facts.innerHTML = `<dt>索引</dt><dd class="error">${escapeHtml(error.message)}</dd>`;
    }
  }

  async function load() {
    try {
      listed = await api.listChunks({
        limit: PAGE_SIZE,
        offset,
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.id ? { id: filter.id } : {})
      });
      paintList();
    } catch (error) {
      toast('error', `索引を読み込めませんでした: ${error.message}`);
    }
  }

  function paintList() {
    const { chunks, total } = listed;
    root.querySelector('[data-count]').textContent = total
      ? `Chunk ${total}件（${offset + 1}〜${offset + chunks.length}件目）`
      : 'Chunk 0件';
    root.querySelector('[data-list]').innerHTML = chunks.length
      ? chunks.map(cardHtml).join('')
      : `<p class="muted">${filter.source || filter.id
        ? '条件に合うChunkはありません。'
        : 'まだ索引はありません。判断を保存するかページを書くと、少し遅れてここに並びます。'}</p>`;
    root.querySelector('[data-pager]').innerHTML = total > PAGE_SIZE
      ? `<button type="button" data-page="prev" ${offset === 0 ? 'disabled' : ''}>前へ</button>
         <span>${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.ceil(total / PAGE_SIZE)} ページ</span>
         <button type="button" data-page="next" ${offset + PAGE_SIZE >= total ? 'disabled' : ''}>次へ</button>`
      : '';
  }

  function cardHtml(chunk) {
    const source = chunk.source || 'context';
    const metadata = chunk.metadata || {};
    const opened = vectors.get(chunk.id);
    return `
      <article class="chunk-card" data-chunk-id="${escapeHtml(chunk.id)}">
        <header class="context-meta">
          <span class="chip chip-source" data-source="${escapeHtml(source)}">${escapeHtml(SOURCE_LABELS[source] || source)}</span>
          <code class="chunk-id">${escapeHtml(chunk.id)}</code>
          ${chunk.source_id ? `<a href="${escapeHtml(hrefForSource(chunk))}">${source === 'page' ? 'ページを開く' : '判断を開く'}</a>` : ''}
          ${metadata.heading ? `<span class="muted">${escapeHtml(metadata.heading)}</span>` : ''}
          ${metadata.updated_at ? `<span class="muted">${escapeHtml(relativeTime(metadata.updated_at))}</span>` : ''}
        </header>
        ${chunk.text === null || chunk.text === undefined
          ? '<p class="muted">本文は索引に入っていません（古い形の索引です。起動し直すと作り直されます）。</p>'
          : `<p class="context-content">${escapeHtml(chunk.text)}</p>`}
        <dl class="chunk-meta">${Object.entries(metadata)
          .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
          .join('')}</dl>
        <div class="chunk-vector">${opened
          ? vectorHtml(chunk.id, opened.vector)
          : `<button type="button" data-open-vector="${escapeHtml(chunk.id)}">ベクトルを見る</button>`}</div>
      </article>`;
  }

  function vectorHtml(chunkId, vector) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return `
      <div class="chunk-vector-head">
        <span>${vector.length}次元 · 長さ ${norm.toFixed(3)}</span>
        <button type="button" data-copy-vector="${escapeHtml(chunkId)}">JSONをコピー</button>
        <button type="button" data-close-vector="${escapeHtml(chunkId)}">閉じる</button>
      </div>
      <pre class="chunk-vector-values">[${vector.map(formatValue).join(', ')}]</pre>`;
  }

  /**
   * 正本のある場所へのリンク。判断のWorkspaceは範囲の鍵（`ws:ID` / `path:ID:...`）に、
   * ページのWorkspaceは `workspace_id` に入っています。
   */
  function hrefForSource(chunk) {
    const metadata = chunk.metadata || {};
    if (chunk.source === 'page') return hrefForPage(chunk.source_id, metadata.workspace_id || '');
    const match = String(metadata.scope_key || '').match(/^(?:ws|path):([^:]+)/);
    return hrefForContext(chunk.source_id, match ? match[1] : '');
  }

  async function onSubmit(event) {
    event.preventDefault();
    const form = event.target;
    if (!form.matches('[data-filter]')) return;
    filter = { source: form.source.value, id: form.id.value.trim() };
    offset = 0;
    await load();
  }

  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-clear')) {
      filter = { source: '', id: '' };
      offset = 0;
      root.querySelector('select[name="source"]').value = '';
      root.querySelector('input[name="id"]').value = '';
      await load();
    } else if (button.dataset.page) {
      offset = Math.max(0, offset + (button.dataset.page === 'next' ? PAGE_SIZE : -PAGE_SIZE));
      await load();
      root.querySelector('[data-count]')?.scrollIntoView({ block: 'start' });
    } else if (button.dataset.openVector) {
      await openVector(button.dataset.openVector);
    } else if (button.dataset.closeVector) {
      vectors.delete(button.dataset.closeVector);
      repaintCard(button.dataset.closeVector);
    } else if (button.dataset.copyVector) {
      const opened = vectors.get(button.dataset.copyVector);
      if (!opened) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(opened.vector));
        toast('success', 'コピーしました。');
      } catch {
        toast('error', 'コピーできませんでした。');
      }
    }
  }

  async function openVector(chunkId) {
    try {
      const chunk = await api.chunk(chunkId);
      if (!Array.isArray(chunk.vector)) return toast('error', 'この索引はベクトルを返しません。');
      vectors.set(chunkId, { vector: chunk.vector });
      repaintCard(chunkId);
    } catch (error) {
      toast('error', `ベクトルを読めませんでした: ${error.message}`);
    }
    return undefined;
  }

  function repaintCard(chunkId) {
    const chunk = listed.chunks.find((candidate) => candidate.id === chunkId);
    const card = root.querySelector(`[data-chunk-id="${CSS.escape(chunkId)}"]`);
    if (!chunk || !card) return;
    card.outerHTML = cardHtml(chunk);
  }

  return {
    show,
    hide() {
      root.replaceChildren();
    }
  };
}

/** ベクトルの値。小数4桁に揃えます（512〜3072個並ぶので、桁をそのまま出すと読めません）。 */
export function formatValue(value) {
  const text = Number(value).toFixed(4).replace(/\.?0+$/, '');
  return text === '' || text === '-0' ? '0' : text;
}
