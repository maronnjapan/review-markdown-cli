import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { applyBlockEdits } from '../src/editorMarkdown.js';
import { renderMarkdown } from '../src/markdown.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('edit mode writes back only the range that changed, and says which comment came loose', async (t) => {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost/#/review/example.md',
    pretendToBeVisual: true
  });
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => {
    if (!String(args[0]).includes('Syntax highlight skipped')) originalConsoleWarn(...args);
  };
  let currentMarkdown = '# Title\n\nOriginal text.\n\n:::message\n触っていない囲み\n:::\n';
  let currentComments = [{
    id: 'comment-selection',
    type: 'text-selection',
    selectedText: 'Original',
    contextBefore: 'Title',
    contextAfter: 'text.',
    comment: 'Keep this comment'
  }];
  const requests = [];
  let failNextSave = true;

  installDomGlobals(dom.window);
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('/api/file?')) {
      return jsonResponse(await filePayload(currentMarkdown, currentComments));
    }
    if (url === '/api/render' && options.method === 'POST') {
      return jsonResponse({ html: await renderMarkdown(JSON.parse(options.body).markdown) });
    }
    if (url === '/api/file' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (failNextSave) {
        failNextSave = false;
        return new Response(JSON.stringify({ error: 'temporary failure' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const result = applyBlockEdits(currentMarkdown, body.edits);
      currentMarkdown = result.markdown;
      currentComments = body.comments;
      return jsonResponse({
        ...await filePayload(currentMarkdown, currentComments),
        appliedEdits: result.appliedEdits,
        review: { targetFile: 'example.md', comments: currentComments }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  t.after(() => {
    console.warn = originalConsoleWarn;
    dom.window.close();
  });
  await import(`${pathToFileURL(path.join(projectDir, 'public', 'app.js')).href}?dom-test=${Date.now()}`);
  await waitFor(() => document.querySelector('#markdown-content h1'));

  document.querySelector('#edit-mode-button').click();
  const source = document.querySelector('#markdown-source');
  await waitFor(() => source.value === currentMarkdown);
  assert.equal(source.classList.contains('hidden'), false, '編集モードでは生のMarkdownが出る');

  source.value = '# Title\n\nUpdated text.\n\n:::message\n触っていない囲み\n:::\n';
  source.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.match(document.querySelector('#editor-save-status').textContent, /未保存/);
  await waitFor(() => requests.length === 1, 1600);
  await waitFor(() => document.querySelector('#editor-save-row').dataset.state === 'error');
  assert.equal(source.value.includes('Updated text.'), true, '失敗しても書いたものは残る');
  assert.equal(document.querySelector('#retry-save-button').classList.contains('hidden'), false);

  document.querySelector('#retry-save-button').click();
  await waitFor(() => requests.length === 2);
  await waitFor(() => document.querySelector('#editor-save-row').dataset.state === 'saved');

  // 送るのは書き換えた1か所だけ。Zennの囲みは通り道にも乗らないので、崩れようがありません。
  assert.deepEqual(requests[1].edits, [{
    blockId: 'document',
    start: 9,
    end: 17,
    markdown: 'Updated',
    before: 'Original'
  }]);
  assert.equal(currentMarkdown, '# Title\n\nUpdated text.\n\n:::message\n触っていない囲み\n:::\n');
  // 追いかけられなくなったコメントは、黙って別の場所に付け替えず、外れたと言います。
  await waitFor(() => document.querySelector('#comments-list .comment-card.detached'));
  assert.equal(requests[1].comments[0].targetDetached, true);
  assert.equal(requests[1].comments[0].comment, 'Keep this comment');
});

test('the toolbar and the keyboard write Markdown, and the preview follows', async (t) => {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost/#/review/example.md',
    pretendToBeVisual: true
  });
  let currentMarkdown = 'First paragraph.\n\nSecond paragraph.\n';
  const requests = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => {
    if (!String(args[0]).includes('Syntax highlight skipped')) originalConsoleWarn(...args);
  };

  installDomGlobals(dom.window);
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('/api/file?')) return jsonResponse(await filePayload(currentMarkdown));
    if (url === '/api/render' && options.method === 'POST') {
      return jsonResponse({ html: await renderMarkdown(JSON.parse(options.body).markdown) });
    }
    if (url === '/api/file' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      requests.push(body);
      const result = applyBlockEdits(currentMarkdown, body.edits);
      currentMarkdown = result.markdown;
      return jsonResponse({
        ...await filePayload(currentMarkdown),
        appliedEdits: result.appliedEdits
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  t.after(() => {
    console.warn = originalConsoleWarn;
    dom.window.close();
  });
  await import(`${pathToFileURL(path.join(projectDir, 'public', 'app.js')).href}?dom-test=${Date.now()}-shortcuts`);
  // 読み込み中の差し込みではなく、組み上がった本文が出るまで待ちます。
  await waitFor(() => document.querySelector('#markdown-content p:not(.muted)'));

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'e',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true
  }));
  const source = document.querySelector('#markdown-source');
  await waitFor(() => source.value === currentMarkdown);

  // 太字は選んだところを囲むだけ。押した印がそのまま本文の文字になります。
  source.setSelectionRange(6, 15);
  document.querySelector('[data-editor-action="bold"]').click();
  assert.equal(source.value, 'First **paragraph**.\n\nSecond paragraph.\n');
  assert.deepEqual([source.selectionStart, source.selectionEnd], [8, 17]);

  // もう一度押すと外れます。太字の印を1つだけ削るような壊し方はしません。
  document.querySelector('[data-editor-action="bold"]').click();
  assert.equal(source.value, 'First paragraph.\n\nSecond paragraph.\n');

  source.setSelectionRange(0, 0);
  document.querySelector('[data-editor-action="bullet-list"]').click();
  assert.equal(source.value, '- First paragraph.\n\nSecond paragraph.\n');

  // 箇条書きの途中でEnterを押せば、次の行も箇条書きで始まります。
  source.setSelectionRange(18, 18);
  source.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(source.value, '- First paragraph.\n- \n\nSecond paragraph.\n');
  // 中身の無い項目でもう一度押せば、印は消えてリストから出ます。
  source.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(source.value, '- First paragraph.\n\n\nSecond paragraph.\n');

  await waitFor(() => document.querySelector('#markdown-content li'), 1600);
  assert.match(document.querySelector('#markdown-content li').textContent, /First paragraph\./);

  await waitFor(() => requests.length === 1, 1600);
  await waitFor(() => document.querySelector('#editor-save-row').dataset.state === 'saved');
  assert.equal(currentMarkdown, '- First paragraph.\n\n\nSecond paragraph.\n');

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'e',
    metaKey: true,
    shiftKey: true,
    bubbles: true
  }));
  await waitFor(() => document.querySelector('#markdown-source').classList.contains('hidden'));
  assert.equal(document.querySelector('#comment-mode-button').getAttribute('aria-pressed'), 'true');
});

test('comments autosave without waiting for the save button and survive a reload', async (t) => {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost/#/review/example.md',
    pretendToBeVisual: true
  });
  const markdown = '# Title\n\nOriginal text.\n';
  let storedComments = [];
  const requests = [];

  installDomGlobals(dom.window);
  const dialog = document.querySelector('#comment-dialog');
  // jsdom has no dialog implementation; the app only needs open/close bookkeeping.
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('/api/file?')) return jsonResponse(await filePayload(markdown, storedComments));
    if (url === '/api/review' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      requests.push(body);
      storedComments = body.comments.map((comment, index) => ({
        ...comment,
        id: comment.id || `comment-server-${index}`,
        createdAt: comment.createdAt || '2026-01-01T00:00:00.000Z'
      }));
      return jsonResponse({
        review: { targetFile: 'example.md', comments: storedComments },
        reviewFile: '.review/example.md.review.json'
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  t.after(() => dom.window.close());
  await import(`${pathToFileURL(path.join(projectDir, 'public', 'app.js')).href}?dom-test=${Date.now()}-autosave`);
  await waitFor(() => document.querySelector('#markdown-content h1'));

  document.querySelector('#document-comment-button').click();
  document.querySelector('#comment-input').value = '全体の構成を見直したい';
  dialog.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const saveStatus = document.querySelector('#save-status');
  assert.equal(saveStatus.dataset.state, 'dirty');
  await waitFor(() => requests.length === 1, 1600);
  await waitFor(() => saveStatus.dataset.state === 'saved');
  assert.equal(requests[0].path, 'example.md');
  assert.equal(storedComments[0].comment, '全体の構成を見直したい');

  const textarea = document.querySelector('#comments-list textarea[data-comment-index="0"]');
  textarea.focus();
  textarea.value = '全体の構成を見直したい（追記）';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => requests.length === 2, 1600);
  await waitFor(() => saveStatus.dataset.state === 'saved');
  assert.equal(storedComments[0].comment, '全体の構成を見直したい（追記）');
  // Autosave must not re-render the pane: that would drop the caret the reviewer is typing at.
  assert.equal(document.activeElement, textarea);

  // Deleting asks first: the confirmation replaces the card's own actions.
  document.querySelector('#comments-list button[data-action="onRequestDelete"]').click();
  assert.equal(document.querySelector('#comments-list .comment-card').classList.contains('confirming'), true);
  document.querySelector('#comments-list button[data-action="onCancelDelete"]').click();
  assert.equal(document.querySelector('#comments-list .comment-card').classList.contains('confirming'), false);
  assert.equal(requests.length, 2, '確認を取り消しただけでは保存しない');

  document.querySelector('#comments-list button[data-action="onRequestDelete"]').click();
  document.querySelector('#comments-list button[data-action="onConfirmDelete"]').click();
  await waitFor(() => requests.length === 3, 1600);
  assert.deepEqual(storedComments, []);
});

async function filePayload(markdown, comments = []) {
  const html = await renderMarkdown(markdown);
  return {
    path: 'example.md',
    markdown,
    html,
    review: { targetFile: 'example.md', comments },
    reviewFile: '.review/example.md.review.json'
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function installDomGlobals(domWindow) {
  globalThis.window = domWindow;
  globalThis.document = domWindow.document;
  globalThis.Node = domWindow.Node;
  globalThis.NodeFilter = domWindow.NodeFilter;
  globalThis.InputEvent = domWindow.InputEvent;
  globalThis.Event = domWindow.Event;
  globalThis.CSS = domWindow.CSS;
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for DOM state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
