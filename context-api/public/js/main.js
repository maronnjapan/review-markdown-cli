/**
 * 画面の入口です。Workspaceとページの木、画面の切り替え、検索、キー操作をまとめます。
 *
 * ── 速さのために、手元に持てるものは持つ ─────────────────────
 * ページの木と、開いたページの本文は手元に置き、画面の切り替えはまず手元の物で描きます。
 * サーバへは後ろで問い合わせ、変わっていたら描き直します。ページを作る・動かす・消すも、
 * 手元の木を先に直してから送ります。押した瞬間に画面が動くことが、書く道具では大事だからです。
 *
 * ── 画面はAPIの一利用者 ──────────────────────────────
 * ここが使うのは `api.js` にある口だけで、それは外部のツールに開いている口と同じです。
 */

import { createApi } from './api.js';
import { createAskView } from './ask.js';
import { createContextsView } from './contexts.js';
import { createPageView } from './page.js';
import { createPalette } from './palette.js';
import { createSettingsView } from './settings.js';
import { createTree } from './tree.js';
import { el, escapeHtml, modKey, storage, untitled } from './util.js';

const KEYS = {
  token: 'knowledge.token',
  workspace: 'knowledge.workspace',
  expanded: 'knowledge.expanded',
  lastPage: 'knowledge.lastPage',
  sidebar: 'knowledge.sidebarCollapsed'
};

const WELCOME_PAGE = {
  title: 'はじめに',
  content: [
    'ここは、あなたのナレッジベースです。ページを書き、決めたことを残し、あとから意味で引けます。',
    '',
    '## 書く',
    '',
    '- 段落を押して書き始めます。Enterで次のブロック、Shift+Enterで改行です。',
    '- 空のブロックで `/` と打つと、見出し・箇条書き・ToDo・コードなどを選べます。',
    '- 書いたそばから保存され、少し遅れて索引が作られます。',
    '',
    '## 探す・聞く',
    '',
    `- ${modKey()}+K で、ページと保存した判断を意味で探せます。言い換えでも引けます。`,
    '- 「資料に聞く」は、見つかった資料だけを根拠に答えます。回答を作るには `CHAT_PROVIDER` の設定が要ります。',
    '',
    '## 外のツールから使う',
    '',
    '- review-markdown CLI のAIは、このWorkspaceの判断とページを質問に応じて引きます。',
    '- Claude Code などのエージェントは、MCP（`/mcp`）でこのナレッジベースをツールとして使えます。設定の画面に手順があります。',
    ''
  ].join('\n')
};

const state = {
  token: storage.get(KEYS.token, null),
  health: null,
  workspaces: [],
  workspaceId: null,
  tree: [],
  pages: new Map(),
  expanded: new Set(storage.get(KEYS.expanded, [])),
  route: { name: 'home' },
  view: null,
  loading: null
};

const api = createApi({
  getToken: () => state.token,
  onUnauthorized: () => promptToken()
});

const refs = {
  app: document.getElementById('app'),
  view: document.getElementById('view'),
  tree: document.getElementById('page-tree'),
  workspaceName: document.getElementById('workspace-name'),
  workspaceAvatar: document.getElementById('workspace-avatar'),
  workspaceButton: document.getElementById('workspace-button'),
  breadcrumb: document.getElementById('breadcrumb'),
  saveStatus: document.getElementById('save-status'),
  pageMenuButton: document.getElementById('page-menu-button'),
  contextsLink: document.getElementById('contexts-link'),
  askLink: document.getElementById('ask-link'),
  settingsLink: document.getElementById('settings-link'),
  searchButton: document.getElementById('search-button'),
  newPageButton: document.getElementById('new-page-button'),
  sidebarCollapse: document.getElementById('sidebar-collapse'),
  sidebarOpen: document.getElementById('sidebar-open'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  popover: document.getElementById('popover'),
  toast: document.getElementById('toast'),
  palette: document.getElementById('palette'),
  shortcutHint: document.getElementById('shortcut-hint')
};

/* ------------------------------------------------------------------ *
 * 小さな道具
 * ------------------------------------------------------------------ */

const encode = encodeURIComponent;
const hrefForWorkspace = (workspaceId) => `#/w/${encode(workspaceId)}`;
const hrefForPage = (pageId, workspaceId = state.workspaceId) => `#/w/${encode(workspaceId)}/p/${encode(pageId)}`;
const hrefForContexts = (contextId, workspaceId = state.workspaceId) => `#/w/${encode(workspaceId)}/contexts${contextId ? `?id=${encode(contextId)}` : ''}`;
const hrefForAsk = (question, workspaceId = state.workspaceId) => `#/w/${encode(workspaceId)}/ask${question ? `?q=${encode(question)}` : ''}`;
const hrefForSettings = (workspaceId = state.workspaceId) => (workspaceId ? `#/w/${encode(workspaceId)}/settings` : '#/settings');

function navigate(href, { replace = false } = {}) {
  if (replace) window.location.replace(href);
  else window.location.hash = href.replace(/^#/, '');
}

function toast(kind, message) {
  const item = el('div', { class: `toast-item toast-${kind}`, role: 'status', text: message });
  refs.toast.append(item);
  setTimeout(() => item.classList.add('show'), 10);
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, kind === 'error' ? 6000 : 2800);
}

function currentWorkspace() {
  return state.workspaces.find((workspace) => workspace.workspace_id === state.workspaceId) || null;
}

function promptToken() {
  if (promptToken.open) return;
  promptToken.open = true;
  const token = window.prompt('このサーバはアクセストークン（CONTEXT_API_TOKEN）を求めています。トークンを入力してください。', state.token || '');
  promptToken.open = false;
  if (token === null) return;
  setToken(token.trim());
  window.location.reload();
}

function setToken(token) {
  state.token = token || null;
  if (state.token) storage.set(KEYS.token, state.token);
  else storage.remove(KEYS.token);
}

/* ------------------------------------------------------------------ *
 * 吹き出しのメニュー
 * ------------------------------------------------------------------ */

function showMenu(anchor, items) {
  closeMenu();
  const menu = refs.popover;
  menu.innerHTML = items.map((item) => (item === 'divider'
    ? '<hr>'
    : `<button type="button" data-action="${escapeHtml(item.id)}" class="${item.danger ? 'danger' : ''}"${item.disabled ? ' disabled' : ''}>${escapeHtml(item.label)}</button>`
  )).join('');
  menu.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 220;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  menu.onclick = (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const item = items.find((entry) => entry !== 'divider' && entry.id === button.dataset.action);
    closeMenu();
    item?.run();
  };
  setTimeout(() => document.addEventListener('mousedown', closeMenuOnOutside), 0);
}

function closeMenuOnOutside(event) {
  if (!refs.popover.contains(event.target)) closeMenu();
}

function closeMenu() {
  refs.popover.classList.add('hidden');
  refs.popover.innerHTML = '';
  document.removeEventListener('mousedown', closeMenuOnOutside);
}

/* ------------------------------------------------------------------ *
 * Workspace
 * ------------------------------------------------------------------ */

async function loadWorkspaces() {
  state.workspaces = await api.listWorkspaces();
  if (state.workspaces.length === 0) {
    // 何も無い最初の1回だけ、書き始められる場所を用意します。
    const workspace = await api.createWorkspace({ name: 'ノート' });
    const page = await api.createPage({ workspace_id: workspace.workspace_id, ...WELCOME_PAGE });
    state.pages.set(page.page_id, page);
    state.workspaces = await api.listWorkspaces();
  }
}

async function selectWorkspace(workspaceId) {
  if (state.loading?.workspaceId === workspaceId) return state.loading.promise;
  const promise = (async () => {
    state.workspaceId = workspaceId;
    if (!currentWorkspace()) {
      // 一覧に無いidでも（消した直後など）、名前だけ置いて先へ進みます。
      state.workspaces.push({ workspace_id: workspaceId, name: workspaceId, registered: false, page_count: 0 });
    }
    storage.set(KEYS.workspace, workspaceId);
    paintWorkspace();
    await refreshTree();
  })();
  state.loading = { workspaceId, promise };
  try {
    await promise;
  } finally {
    if (state.loading?.promise === promise) state.loading = null;
  }
  return undefined;
}

function paintWorkspace() {
  const workspace = currentWorkspace();
  const name = workspace?.name || 'Workspace';
  refs.workspaceName.textContent = name;
  refs.workspaceAvatar.textContent = [...name][0]?.toUpperCase() || 'K';
  refs.contextsLink.href = hrefForContexts(null);
  refs.askLink.href = hrefForAsk('');
  refs.settingsLink.href = hrefForSettings();
}

async function refreshTree() {
  if (!state.workspaceId) return;
  const workspaceId = state.workspaceId;
  const tree = await api.tree(workspaceId);
  if (workspaceId !== state.workspaceId) return;
  state.tree = tree;
  paintTree();
}

function paintTree() {
  tree.render({ pages: state.tree, activeId: state.route.pageId || null });
}

function isExpanded(pageId) {
  return state.expanded.has(pageId);
}

function setExpanded(pageId, expanded) {
  if (expanded) state.expanded.add(pageId);
  else state.expanded.delete(pageId);
  storage.set(KEYS.expanded, [...state.expanded].slice(-500));
}

function workspaceMenu() {
  const items = state.workspaces.map((workspace) => ({
    id: `ws:${workspace.workspace_id}`,
    label: `${workspace.workspace_id === state.workspaceId ? '● ' : ''}${workspace.name}（${workspace.page_count}ページ）`,
    run: () => navigate(hrefForWorkspace(workspace.workspace_id))
  }));
  items.push('divider', {
    id: 'new',
    label: '＋ 新しいWorkspace',
    run: async () => {
      const name = window.prompt('Workspaceの名前', '');
      if (name === null) return;
      try {
        const workspace = await api.createWorkspace({ name: name.trim() || undefined });
        state.workspaces = await api.listWorkspaces();
        navigate(hrefForWorkspace(workspace.workspace_id));
      } catch (error) {
        toast('error', error.message);
      }
    }
  });
  showMenu(refs.workspaceButton, items);
}

/* ------------------------------------------------------------------ *
 * ページの操作
 * ------------------------------------------------------------------ */

function treePage(pageId) {
  return state.tree.find((page) => page.page_id === pageId) || null;
}

function siblingsOf(parentId, { except = null } = {}) {
  return state.tree.filter((page) => page.parent_id === parentId && page.page_id !== except);
}

async function createPage({ parentId = null, title = '' } = {}) {
  if (!state.workspaceId) return;
  try {
    const page = await api.createPage({ workspace_id: state.workspaceId, parent_id: parentId, title });
    state.pages.set(page.page_id, page);
    const parent = parentId ? treePage(parentId) : null;
    const insertAt = parentId
      ? state.tree.findIndex((entry, index) => index > state.tree.indexOf(parent) && entry.depth <= parent.depth)
      : -1;
    const summary = { ...page, depth: parent ? parent.depth + 1 : 0 };
    if (insertAt === -1) state.tree.push(summary);
    else state.tree.splice(insertAt, 0, summary);
    if (parentId) setExpanded(parentId, true);
    navigate(hrefForPage(page.page_id));
    refreshTree().catch(() => {});
  } catch (error) {
    toast('error', `ページを作れませんでした: ${error.message}`);
  }
}

async function deletePage(pageId) {
  const page = treePage(pageId) || state.pages.get(pageId);
  const childCount = state.tree.filter((entry) => isDescendant(entry.page_id, pageId)).length;
  const label = untitled(page?.title);
  if (!window.confirm(childCount
    ? `「${label}」と、その下の${childCount}ページを削除しますか？`
    : `「${label}」を削除しますか？`)) return;
  try {
    await api.deletePage(pageId);
    const removed = new Set([pageId, ...state.tree.filter((entry) => isDescendant(entry.page_id, pageId)).map((entry) => entry.page_id)]);
    state.tree = state.tree.filter((entry) => !removed.has(entry.page_id));
    for (const id of removed) state.pages.delete(id);
    paintTree();
    toast('success', '削除しました。');
    if (removed.has(state.route.pageId)) navigate(hrefForWorkspace(state.workspaceId), { replace: true });
    refreshTree().catch(() => {});
  } catch (error) {
    toast('error', `削除できませんでした: ${error.message}`);
  }
}

function isDescendant(pageId, ancestorId) {
  let current = treePage(pageId);
  while (current?.parent_id) {
    if (current.parent_id === ancestorId) return true;
    current = treePage(current.parent_id);
  }
  return false;
}

async function movePage(pageId, { parentId, position }) {
  try {
    await api.patchPage(pageId, { parent_id: parentId, position });
    if (parentId) setExpanded(parentId, true);
    await refreshTree();
  } catch (error) {
    toast('error', `動かせませんでした: ${error.message}`);
  }
}

function moveByDrop(draggedId, { targetId, zone }) {
  const target = treePage(targetId);
  if (!target || draggedId === targetId || isDescendant(targetId, draggedId)) return;
  if (zone === 'inside') return movePage(draggedId, { parentId: targetId, position: null });
  const siblings = siblingsOf(target.parent_id, { except: draggedId });
  const index = siblings.findIndex((entry) => entry.page_id === targetId);
  return movePage(draggedId, { parentId: target.parent_id, position: zone === 'before' ? index : index + 1 });
}

function pageMenuItems(pageId) {
  const page = treePage(pageId);
  if (!page) return [];
  const siblings = siblingsOf(page.parent_id);
  const index = siblings.findIndex((entry) => entry.page_id === pageId);
  const parent = page.parent_id ? treePage(page.parent_id) : null;
  const previous = index > 0 ? siblings[index - 1] : null;
  return [
    { id: 'child', label: '＋ サブページを追加', run: () => createPage({ parentId: pageId }) },
    { id: 'rename', label: '名前を変える', run: () => { navigate(hrefForPage(pageId)); setTimeout(() => pageView.focusTitle(), 50); } },
    'divider',
    { id: 'up', label: '↑ 上へ', disabled: index <= 0, run: () => movePage(pageId, { parentId: page.parent_id, position: index - 1 }) },
    { id: 'down', label: '↓ 下へ', disabled: index >= siblings.length - 1, run: () => movePage(pageId, { parentId: page.parent_id, position: index + 1 }) },
    {
      id: 'outdent',
      label: '← 階層を上げる',
      disabled: !parent,
      run: () => {
        const grandSiblings = siblingsOf(parent.parent_id);
        movePage(pageId, { parentId: parent.parent_id, position: grandSiblings.findIndex((entry) => entry.page_id === parent.page_id) + 1 });
      }
    },
    { id: 'indent', label: '→ 階層を下げる', disabled: !previous, run: () => movePage(pageId, { parentId: previous.page_id, position: null }) },
    'divider',
    {
      id: 'markdown',
      label: 'Markdownをコピー',
      run: async () => {
        try {
          const full = await api.page(pageId);
          await navigator.clipboard.writeText(`# ${untitled(full.title)}\n\n${full.content}`);
          toast('success', 'コピーしました。');
        } catch (error) {
          toast('error', error.message);
        }
      }
    },
    { id: 'delete', label: '削除', danger: true, run: () => deletePage(pageId) }
  ];
}

/* ------------------------------------------------------------------ *
 * 画面
 * ------------------------------------------------------------------ */

const tree = createTree({
  root: refs.tree,
  hrefFor: (pageId) => hrefForPage(pageId),
  isExpanded,
  setExpanded,
  onMenu: (pageId, anchor) => showMenu(anchor, pageMenuItems(pageId)),
  onAddChild: (pageId) => createPage({ parentId: pageId }),
  onMove: moveByDrop
});

const pageView = createPageView({
  root: refs.view,
  api,
  onStatus: (status, message) => {
    refs.saveStatus.textContent = message;
    refs.saveStatus.dataset.state = status;
  },
  onTitleChange: (pageId, title) => {
    tree.updateTitle(pageId, title);
    paintBreadcrumb();
    const cached = state.pages.get(pageId);
    if (cached) cached.title = title;
    document.title = `${untitled(title)} · Knowledge`;
  },
  onSaved: (page) => {
    state.pages.set(page.page_id, page);
    const summary = treePage(page.page_id);
    if (summary) {
      summary.title = page.title;
      summary.updated_at = page.updated_at;
    }
  }
});

const contextsView = createContextsView({ root: refs.view, api, toast });
const askView = createAskView({
  root: refs.view,
  api,
  toast,
  hrefForPage,
  hrefForContext: (contextId, workspaceId) => hrefForContexts(contextId, workspaceId || state.workspaceId || ''),
  getHealth: () => state.health
});
const settingsView = createSettingsView({
  root: refs.view,
  api,
  toast,
  getWorkspace: currentWorkspace,
  getToken: () => state.token,
  setToken,
  onWorkspaceChanged: async ({ deleted } = {}) => {
    state.workspaces = await api.listWorkspaces();
    if (deleted) {
      storage.remove(KEYS.workspace);
      state.workspaceId = null;
      navigate('#/', { replace: true });
      return;
    }
    paintWorkspace();
  },
  onImported: () => refreshTree()
});

const palette = createPalette({
  root: refs.palette,
  api,
  getWorkspaceId: () => state.workspaceId,
  onOpenPage: (pageId, workspaceId) => navigate(hrefForPage(pageId, workspaceId || state.workspaceId)),
  onOpenContexts: (contextId, workspaceId) => navigate(hrefForContexts(contextId, workspaceId || state.workspaceId || '')),
  onAsk: (question) => navigate(hrefForAsk(question)),
  onCreatePage: (title) => createPage({ title }),
  onError: (message) => toast('error', message)
});

function mount(view, show) {
  if (state.view && state.view !== view) state.view.hide();
  else if (state.view === view && view !== pageView) view.hide();
  state.view = view;
  return show();
}

function paintBreadcrumb() {
  const { route } = state;
  const crumbs = [];
  if (route.name === 'page') {
    const trail = [];
    let current = treePage(route.pageId);
    const seen = new Set();
    while (current && !seen.has(current.page_id)) {
      seen.add(current.page_id);
      trail.unshift(current);
      current = current.parent_id ? treePage(current.parent_id) : null;
    }
    if (trail.length === 0) {
      const cached = state.pages.get(route.pageId);
      if (cached?.breadcrumb) trail.push(...cached.breadcrumb);
      else if (cached) trail.push(cached);
    }
    for (const page of trail) crumbs.push({ label: untitled(page.title), href: hrefForPage(page.page_id) });
  } else if (route.name === 'contexts') crumbs.push({ label: '保存した判断' });
  else if (route.name === 'ask') crumbs.push({ label: '資料に聞く' });
  else if (route.name === 'settings') crumbs.push({ label: '設定' });
  refs.breadcrumb.innerHTML = crumbs.map((crumb, index) => (
    `${index ? '<span class="crumb-sep">/</span>' : ''}`
    + (crumb.href && index < crumbs.length - 1
      ? `<a class="crumb" href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`
      : `<span class="crumb current">${escapeHtml(crumb.label)}</span>`)
  )).join('');
  refs.pageMenuButton.classList.toggle('hidden', route.name !== 'page');
}

async function showPage(pageId) {
  const cached = state.pages.get(pageId);
  if (cached) mount(pageView, () => pageView.show(cached));
  else refs.view.innerHTML = '<p class="view-loading">読み込んでいます…</p>';
  try {
    const fresh = await api.page(pageId);
    if (state.route.pageId !== pageId) return;
    state.pages.set(pageId, fresh);
    if (!cached) mount(pageView, () => pageView.show(fresh));
    else pageView.refresh(fresh);
    storage.set(`${KEYS.lastPage}.${state.workspaceId}`, pageId);
  } catch (error) {
    if (state.route.pageId !== pageId) return;
    if (error.status === 404) {
      toast('error', 'そのページはありません。');
      navigate(hrefForWorkspace(state.workspaceId), { replace: true });
    } else {
      toast('error', error.message);
    }
  }
}

function showWorkspaceHome() {
  const lastPage = storage.get(`${KEYS.lastPage}.${state.workspaceId}`, null);
  const first = (lastPage && treePage(lastPage)) ? lastPage : state.tree[0]?.page_id;
  if (first) {
    navigate(hrefForPage(first), { replace: true });
    return;
  }
  mount({ hide: () => refs.view.replaceChildren() }, () => {
    refs.view.innerHTML = `
      <section class="empty-state">
        <h1>${escapeHtml(currentWorkspace()?.name || 'Workspace')}</h1>
        <p>まだページがありません。最初のページを作るか、Markdownのファイルを取り込んでください。</p>
        <div class="empty-actions">
          <button type="button" class="primary" data-new-page>＋ 新しいページ</button>
          <a class="button" href="${escapeHtml(hrefForSettings())}">Markdownを取り込む</a>
        </div>
      </section>`;
    refs.view.querySelector('[data-new-page]').addEventListener('click', () => createPage());
    document.title = 'Knowledge';
  });
}

/* ------------------------------------------------------------------ *
 * 道
 * ------------------------------------------------------------------ */

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = hash.split('?');
  const segments = pathPart.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  const query = new URLSearchParams(queryPart);
  if (segments[0] === 'settings') return { name: 'settings', ws: null };
  if (segments[0] === 'w' && segments[1]) {
    const ws = segments[1];
    if (segments[2] === 'p' && segments[3]) return { name: 'page', ws, pageId: segments[3] };
    if (segments[2] === 'contexts') return { name: 'contexts', ws, contextId: query.get('id') };
    if (segments[2] === 'ask') return { name: 'ask', ws, question: query.get('q') || '' };
    if (segments[2] === 'settings') return { name: 'settings', ws };
    return { name: 'workspace', ws };
  }
  return { name: 'home' };
}

let routing = 0;

async function route() {
  const target = parseHash();
  const ticket = ++routing;
  closeMenu();
  palette.close();
  refs.app.classList.remove('sidebar-open');
  if (target.name === 'home') {
    const remembered = storage.get(KEYS.workspace, null);
    const workspaceId = state.workspaces.some((workspace) => workspace.workspace_id === remembered)
      ? remembered
      : state.workspaces[0]?.workspace_id;
    if (workspaceId) navigate(hrefForWorkspace(workspaceId), { replace: true });
    return;
  }
  // 別のページへ移る前に、書きかけを送ります。
  if (state.view === pageView && (target.name !== 'page' || target.pageId !== state.route.pageId)) await pageView.flush();
  state.route = target;
  if (target.ws && target.ws !== state.workspaceId) {
    try {
      await selectWorkspace(target.ws);
    } catch (error) {
      toast('error', error.message);
      return;
    }
  }
  if (ticket !== routing) return;
  tree.setActive(target.pageId || null);
  paintBreadcrumb();
  refs.saveStatus.textContent = '';
  switch (target.name) {
    case 'page':
      await showPage(target.pageId);
      break;
    case 'contexts':
      mount(contextsView, () => contextsView.show(state.workspaceId, { highlight: target.contextId }));
      break;
    case 'ask':
      mount(askView, () => askView.show(state.workspaceId, { question: target.question }));
      break;
    case 'settings':
      mount(settingsView, () => settingsView.show());
      break;
    default:
      showWorkspaceHome();
  }
}

/* ------------------------------------------------------------------ *
 * 出来事
 * ------------------------------------------------------------------ */

refs.workspaceButton.addEventListener('click', workspaceMenu);
refs.newPageButton.addEventListener('click', () => createPage());
refs.searchButton.addEventListener('click', () => palette.open());
refs.pageMenuButton.addEventListener('click', () => {
  if (state.route.pageId) showMenu(refs.pageMenuButton, pageMenuItems(state.route.pageId));
});
refs.sidebarCollapse.addEventListener('click', () => {
  refs.app.classList.toggle('sidebar-collapsed');
  storage.set(KEYS.sidebar, refs.app.classList.contains('sidebar-collapsed'));
});
refs.sidebarOpen.addEventListener('click', () => {
  refs.app.classList.remove('sidebar-collapsed');
  refs.app.classList.toggle('sidebar-open');
});
refs.sidebarBackdrop.addEventListener('click', () => refs.app.classList.remove('sidebar-open'));

document.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    palette.toggle();
  } else if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (state.view === pageView) pageView.flush().then(() => toast('success', '保存しました。'));
  } else if (event.key === 'Escape') {
    closeMenu();
  }
});

window.addEventListener('beforeunload', () => {
  if (state.view === pageView) pageView.flush();
});
window.addEventListener('hashchange', () => route());

/* ------------------------------------------------------------------ *
 * 立ち上げ
 * ------------------------------------------------------------------ */

async function boot() {
  if (storage.get(KEYS.sidebar, false)) refs.app.classList.add('sidebar-collapsed');
  refs.shortcutHint.textContent = `${modKey()}+K`;
  api.health().then((health) => { state.health = health; }).catch(() => {});
  try {
    await loadWorkspaces();
  } catch (error) {
    refs.view.innerHTML = `<section class="empty-state"><h1>繋がりませんでした</h1><p class="error">${escapeHtml(error.message)}</p><p class="muted">Context API が動いているか、アクセストークンが合っているかを確かめてください。</p></section>`;
    return;
  }
  await route();
}

boot();
