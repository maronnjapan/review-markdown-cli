import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { resolveDocumentLink } from '../src/links.js';
import { renderMarkdown } from '../src/markdown.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function renderViews(markdown) {
  const options = { resolveLink: (href) => resolveDocumentLink(href, { relativeFile: 'docs/note.md' }) };
  const [html, editableHtml] = await Promise.all([
    renderMarkdown(markdown, options),
    renderMarkdown(markdown, { ...options, editableBlocks: true })
  ]);
  return { html, editableHtml };
}

function installDomGlobals(window) {
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.InputEvent = window.InputEvent;
  globalThis.Event = window.Event;
  globalThis.CSS = window.CSS;
}

async function startApp(t, url, responses) {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, { url, pretendToBeVisual: true });
  const { window } = dom;
  installDomGlobals(window);
  const dialog = window.document.querySelector('#comment-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  globalThis.fetch = async (input, options = {}) => {
    const requested = String(input).split('?')[0];
    const handler = responses[requested];
    if (!handler) throw new Error(`Unexpected fetch: ${input}`);
    const result = await handler(input, options);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => window.close());
  await import(`${pathToFileURL(path.join(projectDir, 'public', 'app.js')).href}?ui-test=${Date.now()}-${Math.random()}`);
  return { document: window.document, window };
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for DOM state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function responsesFor(review, projectAiContext) {
  const markdown = '# Guide\n\nRun the program.\n';
  return {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review,
      ...(projectAiContext ? { projectAiContext } : {}),
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 't', available: true, provider: 'codex', model: 'm', effort: 'low' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  };
}

test('SCENARIO: reading context set, zero notes', async (t) => {
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md',
    responsesFor({ targetFile: 'guide.md', comments: [], aiContext: '第3章。読者は初学者。' }));
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));
  const placement = document.querySelector('#placement-context-hint');
  const review = document.querySelector('#review-context-hint');
  console.log('placement.hidden =', placement.hidden, '| text =', placement.textContent.trim());
  console.log('review.hidden    =', review.hidden, '| text =', review.textContent.trim());
  assert.equal(placement.hidden, false);
  assert.equal(review.hidden, false, '指摘の配置が出ているならAIレビューも出る');
});

test('SCENARIO: project context only, zero notes', async (t) => {
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md',
    responsesFor({ targetFile: 'guide.md', comments: [] }, '入門書の原稿。'));
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));
  const placement = document.querySelector('#placement-context-hint');
  const review = document.querySelector('#review-context-hint');
  console.log('project-only placement.hidden =', placement.hidden);
  console.log('project-only review.hidden    =', review.hidden, '| text =', review.textContent.trim());
  assert.equal(placement.hidden, false);
  assert.equal(review.hidden, false);
});

test('SCENARIO: notes present', async (t) => {
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md',
    responsesFor({
      targetFile: 'guide.md',
      comments: [],
      contextNotes: [{ id: 'note-1', kind: 'decision', body: '節の並びは変えない。', source: 'reviewer', createdAt: '2026-08-01T00:00:00.000Z' }]
    }));
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));
  const review = document.querySelector('#review-context-hint');
  console.log('with-notes review.hidden =', review.hidden, '| text =', review.textContent.trim());
  assert.equal(review.hidden, false);
});

test('SCENARIO: nothing at all', async (t) => {
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md',
    responsesFor({ targetFile: 'guide.md', comments: [] }));
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));
  console.log('empty placement.hidden =', document.querySelector('#placement-context-hint').hidden);
  console.log('empty review.hidden    =', document.querySelector('#review-context-hint').hidden);
});

test('SCENARIO: reviewer types a reading context in this session, zero notes', async (t) => {
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md',
    responsesFor({ targetFile: 'guide.md', comments: [] }));
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));
  const placement = document.querySelector('#placement-context-hint');
  const review = document.querySelector('#review-context-hint');
  console.log('BEFORE typing: placement.hidden =', placement.hidden, ' review.hidden =', review.hidden);
  const input = document.querySelector('#ai-context-input');
  input.value = '第3章。読者は運用当番。';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  console.log('AFTER  typing: placement.hidden =', placement.hidden, ' review.hidden =', review.hidden,
    '| review text =', JSON.stringify(review.textContent.trim()));
});
