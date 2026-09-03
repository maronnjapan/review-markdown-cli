import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { buildPdfSelectionTarget, normalizePdfRectangles } from '../public/js/pdf/anchors.js';
import { createApp } from '../public/js/createApp.js';
import { createServer } from '../src/server.js';
import { assertSupportedPdfAiTarget, listPdfFiles } from '../src/pdf/index.js';
import { createPathFilter } from '../src/pathFilter.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n% read-only test fixture\n%%EOF\n', 'utf8');
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PDF discovery is isolated from Markdown discovery and obeys filters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-pdf-files-'));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, '.review'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'guide.PDF'), PDF_BYTES);
  await fs.writeFile(path.join(root, 'docs', 'notes.md'), '# Notes\n');
  await fs.writeFile(path.join(root, '.review', 'hidden.pdf'), PDF_BYTES);

  assert.deepEqual(await listPdfFiles(root), ['docs/guide.PDF']);
  assert.deepEqual(await listPdfFiles(root, createPathFilter({ exclude: ['docs/**'] })), []);
});

test('PDF-wide AI targets are rejected while selected PDF text remains available', () => {
  assert.throws(
    () => assertSupportedPdfAiTarget('spec.pdf', { type: 'document' }),
    (error) => error.statusCode === 400 && /PDF内の文章を選択/.test(error.message)
  );
  assert.doesNotThrow(() => assertSupportedPdfAiTarget('spec.pdf', {
    type: 'text-selection', selectedText: 'selected'
  }));
  assert.doesNotThrow(() => assertSupportedPdfAiTarget('notes.md', { type: 'document' }));
});

test('PDF API lists and streams the original file without exposing an edit path', async (t) => {
  const { root, baseUrl } = await startPdfServer(t);

  const listing = await fetch(`${baseUrl}/api/files`).then((response) => response.json());
  assert.deepEqual(listing.files, ['notes.md', 'spec.pdf']);

  const opened = await fetch(`${baseUrl}/api/file?path=spec.pdf`).then((response) => response.json());
  assert.deepEqual(Object.keys(opened).sort(), [
    'directoryAiContext', 'directoryContextFile', 'documentType', 'features', 'path', 'pdfUrl',
    'projectAiContext', 'review', 'reviewFile', 'textBody'
  ]);
  assert.equal(opened.documentType, 'pdf');
  assert.equal(opened.textBody, false);
  assert.equal(opened.pdfUrl, '/api/pdf?path=spec.pdf');

  const pdf = await fetch(`${baseUrl}${opened.pdfUrl}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF_BYTES);

  const range = await fetch(`${baseUrl}${opened.pdfUrl}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${PDF_BYTES.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), PDF_BYTES.subarray(0, 8));

  const original = await fs.readFile(path.join(root, 'spec.pdf'));
  const editAttempt = await fetch(`${baseUrl}/api/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'spec.pdf', edits: [], comments: [] })
  });
  assert.equal(editAttempt.status, 400);
  assert.match((await editAttempt.json()).error, /Only Markdown files/);
  assert.deepEqual(await fs.readFile(path.join(root, 'spec.pdf')), original);
});

test('PDF comments persist anchors and export page-aware confirmation statuses', async (t) => {
  const { root, baseUrl } = await startPdfServer(t);
  const comments = [{
    id: 'pdf-comment-1',
    type: 'text-selection',
    documentType: 'pdf',
    pageNumber: 2,
    selectedText: 'selected PDF text',
    contextBefore: 'before',
    contextAfter: 'after',
    pdfAnchor: {
      version: 1,
      pageNumber: 2,
      rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]
    },
    comment: '確認する',
    status: 'resolved'
  }];

  const saved = await fetch(`${baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'spec.pdf', comments })
  }).then((response) => response.json());
  assert.deepEqual(saved.review.comments[0].pdfAnchor, comments[0].pdfAnchor);

  const reviewFile = JSON.parse(await fs.readFile(path.join(root, '.review', 'spec.pdf.review.json'), 'utf8'));
  assert.equal(reviewFile.comments[0].pageNumber, 2);
  assert.equal(reviewFile.comments[0].status, 'resolved');

  const exported = await fetch(`${baseUrl}/api/export?path=spec.pdf`).then((response) => response.text());
  assert.match(exported, /対象PDFは読み取り専用/);
  assert.match(exported, /状態: 確認済み/);
  assert.match(exported, /ページ: 2/);
  assert.match(exported, /> selected PDF text/);
});

test('PDF.js browser modules are served from the dedicated vendor endpoints', async (t) => {
  const { baseUrl } = await startPdfServer(t);
  const response = await fetch(`${baseUrl}/vendor/pdfjs/pdf.mjs`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.match((await response.text()).slice(0, 2000), /Mozilla Foundation/);
});

test('PDF selection anchors normalize geometry and retain page context', () => {
  assert.deepEqual(normalizePdfRectangles([
    { left: 120, top: 240, width: 80, height: 20 }
  ], { left: 100, top: 200, width: 400, height: 800 }), [
    { x: 0.05, y: 0.05, width: 0.2, height: 0.025 }
  ]);

  const dom = new JSDOM(`
    <section class="pdf-page" data-page-number="3">
      <div class="pdf-text-layer"><span>Before selected after</span></div>
    </section>`);
  const { document } = dom.window;
  const page = document.querySelector('.pdf-page');
  const text = document.querySelector('span').firstChild;
  page.getBoundingClientRect = () => ({ left: 100, top: 200, width: 400, height: 800 });
  const range = document.createRange();
  range.setStart(text, 7);
  range.setEnd(text, 15);
  range.getClientRects = () => [{ left: 140, top: 280, width: 100, height: 24 }];

  const target = buildPdfSelectionTarget(range, 'selected');
  assert.equal(target.pageNumber, 3);
  assert.equal(target.contextBefore, 'Before');
  assert.equal(target.contextAfter, 'after');
  assert.deepEqual(target.pdfAnchor.rectangles, [
    { x: 0.1, y: 0.1, width: 0.25, height: 0.03 }
  ]);
  dom.window.close();
});

test('PDF UI removes edit actions and uses confirmation-oriented statuses', async (t) => {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost/#/review/spec.pdf',
    pretendToBeVisual: true
  });
  installDomGlobals(dom.window);
  const dialog = document.querySelector('#comment-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const saved = [];
  const api = {
    prepareAi: async () => ({ available: false, error: 'test' }),
    openFile: async () => ({
      path: 'spec.pdf',
      documentType: 'pdf',
      pdfUrl: '/api/pdf?path=spec.pdf',
      review: {
        targetFile: 'spec.pdf',
        comments: [{
          id: 'pdf-open',
          type: 'text-selection',
          documentType: 'pdf',
          pageNumber: 1,
          selectedText: 'PDF text',
          comment: '確認待ち',
          status: 'open'
        }]
      },
      reviewFile: '.review/spec.pdf.review.json'
    }),
    saveComments: async (payload) => {
      saved.push(payload);
      return {
        review: { targetFile: payload.path, comments: payload.comments },
        reviewFile: '.review/spec.pdf.review.json'
      };
    },
    exportReview: async () => '',
    beaconComments: () => true
  };
  const fakePdfViewer = ({ content }) => ({
    dispose() {},
    async open() { content.innerHTML = '<div class="fake-pdf-page"></div>'; },
    renderHighlights() {},
    selectionTarget() { return null; }
  });

  t.after(() => dom.window.close());
  const app = createApp(document, { api, pdfViewerFactory: fakePdfViewer });
  await app.start();

  assert.equal(app.state.documentType, 'pdf');
  assert.equal(document.querySelector('#mode-switch').classList.contains('hidden'), true);
  assert.equal(document.querySelector('#edit-mode-button').disabled, true);
  assert.equal(document.querySelector('#document-translate-button').disabled, true);
  assert.match(document.querySelector('#document-notice').textContent, /PDFは読み取り専用/);
  assert.match(document.querySelector('[data-comment-id="pdf-open"]').textContent, /未確認/);
  assert.match(document.querySelector('[data-comment-id="pdf-open"] .target-summary').textContent, /ページ 1/);

  document.querySelector('[data-comment-id="pdf-open"] [data-action="onToggleStatus"]').click();
  assert.match(document.querySelector('[data-comment-id="pdf-open"]').textContent, /確認済み/);
  document.querySelector('#save-button').click();
  await waitFor(() => saved.length === 1);
  assert.equal(saved[0].comments[0].status, 'resolved');
});

async function startPdfServer(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-pdf-server-'));
  await fs.writeFile(path.join(root, 'spec.pdf'), PDF_BYTES);
  await fs.writeFile(path.join(root, 'notes.md'), '# Notes\n');
  const { app } = createServer(root);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { root, baseUrl: `http://127.0.0.1:${server.address().port}` };
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
