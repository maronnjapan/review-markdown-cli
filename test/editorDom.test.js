import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { applyBlockEdits } from '../src/editorMarkdown.js';
import { renderMarkdown } from '../src/markdown.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('edit mode keeps a changed block after failure and retries autosave with updated comment context', async (t) => {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost/#/review/example.md',
    pretendToBeVisual: true
  });
  const originalMarkdown = '# Title\n\nOriginal text.\n';
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => {
    if (!String(args[0]).includes('Syntax highlight skipped')) originalConsoleWarn(...args);
  };
  let currentMarkdown = originalMarkdown;
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
  document.execCommand = () => true;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('/api/file?')) {
      return jsonResponse(await filePayload(currentMarkdown, currentComments));
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
  await waitFor(() => document.querySelectorAll('.markdown-block').length === 2);
  const paragraphBlock = document.querySelectorAll('.markdown-block')[1];
  const commentAnchor = paragraphBlock.querySelector('.editor-comment-anchor');
  assert.equal(commentAnchor.textContent, 'Original');
  commentAnchor.textContent = 'Updated';
  paragraphBlock.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.match(document.querySelector('#editor-save-status').textContent, /未保存/);
  await waitFor(() => requests.length === 1, 1600);
  await waitFor(() => document.querySelector('#editor-save-row').dataset.state === 'error');
  assert.equal(commentAnchor.textContent, 'Updated');
  assert.equal(document.querySelector('#retry-save-button').classList.contains('hidden'), false);
  document.querySelector('#retry-save-button').click();
  await waitFor(() => requests.length === 2);
  await waitFor(() => document.querySelector('#editor-save-row').dataset.state === 'saved');

  assert.equal(currentMarkdown, '# Title\n\nUpdated text.\n');
  assert.equal(requests[1].path, 'example.md');
  assert.match(requests[1].edits[0].html, /Updated text\./);
  assert.equal(requests[1].comments[0].selectedText, 'Updated');
  assert.equal(requests[1].comments[0].contextAfter, 'text.');
});

test('keyboard mode switching applies Markdown syntax immediately and removes an empty paragraph', async (t) => {
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
  document.execCommand = () => true;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('/api/file?')) return jsonResponse(await filePayload(currentMarkdown));
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
  await waitFor(() => document.querySelector('#markdown-content p.code-line'));

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'e',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true
  }));
  await waitFor(() => document.querySelectorAll('.markdown-block').length === 2);

  const [firstBlock, secondBlock] = document.querySelectorAll('.markdown-block');
  firstBlock.innerHTML = '<p># **bold** and [link](https://example.com)</p>';
  firstBlock.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  assert.equal(firstBlock.querySelector('h1') !== null, true);
  assert.equal(firstBlock.querySelector('strong')?.textContent, 'bold');
  assert.equal(firstBlock.querySelector('a')?.textContent, 'link');

  secondBlock.innerHTML = '<p><br></p>';
  secondBlock.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  assert.equal(secondBlock.classList.contains('pending-deletion'), true);

  await waitFor(() => requests.length === 1, 1600);
  await waitFor(() => document.querySelector('#editor-save-row').dataset.state === 'saved');
  assert.equal(requests[0].edits.find((edit) => edit.blockId === secondBlock.dataset.blockId).delete, true);
  assert.equal(currentMarkdown, '# **bold** and [link](https://example.com)');
  assert.equal(document.querySelectorAll('.markdown-block').length, 1);

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'e',
    metaKey: true,
    shiftKey: true,
    bubbles: true
  }));
  await waitFor(() => !document.querySelector('#markdown-content').classList.contains('editing'));
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

  document.querySelector('#comments-list button[data-delete-index="0"]').click();
  await waitFor(() => requests.length === 3, 1600);
  assert.deepEqual(storedComments, []);
});

async function filePayload(markdown, comments = []) {
  const [html, editableHtml] = await Promise.all([
    renderMarkdown(markdown),
    renderMarkdown(markdown, { editableBlocks: true })
  ]);
  return {
    path: 'example.md',
    markdown,
    html,
    editableHtml,
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
