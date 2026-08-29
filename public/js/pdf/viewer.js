import { buildPdfSelectionTarget, pdfAnchorOf } from './anchors.js';

const PDF_SCALE = 1.25;
const PDFJS_MODULE_URL = '/vendor/pdfjs/pdf.mjs';
const PDFJS_WORKER_URL = '/vendor/pdfjs/pdf.worker.min.mjs';

/**
 * Read-only PDF adapter. It owns PDF.js, canvases, text layers and persisted
 * highlight geometry; the rest of the application only sees ordinary targets.
 */
export function createPdfViewer({ document, content, onSelectComment = () => {} }) {
  let generation = 0;
  let loadingTask = null;
  let pdfDocument = null;
  let textLayers = [];
  let renderTasks = [];

  async function open(data) {
    dispose();
    const currentGeneration = generation;
    content.classList.add('pdf-document');
    content.classList.remove('znc');
    content.innerHTML = `
      <div class="pdf-loading" role="status">PDFを読み込み中…</div>
      <div class="pdf-viewer" aria-label="PDFビューアー"></div>`;
    const viewer = content.querySelector('.pdf-viewer');
    const status = content.querySelector('.pdf-loading');

    const { getDocument, GlobalWorkerOptions, TextLayer } = await import(PDFJS_MODULE_URL);
    if (currentGeneration !== generation) return;
    GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    loadingTask = getDocument({ url: data.pdfUrl });
    pdfDocument = await loadingTask.promise;
    if (currentGeneration !== generation) return;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      status.textContent = `${pdfDocument.numPages}ページ中 ${pageNumber}ページを描画中…`;
      const page = await pdfDocument.getPage(pageNumber);
      if (currentGeneration !== generation) return;
      const pageElement = createPageElement(page);
      viewer.append(pageElement);
      await renderPage(page, pageElement, TextLayer);
      if (currentGeneration !== generation) return;
    }
    status.textContent = `${pdfDocument.numPages}ページ表示中（PDFは読み取り専用）`;
    status.dataset.state = 'ready';
  }

  function selectionTarget(range, selectedText) {
    return buildPdfSelectionTarget(range, String(selectedText || '').trim());
  }

  function renderHighlights(comments) {
    content.querySelectorAll('.pdf-comment-highlight-layer').forEach((layer) => layer.replaceChildren());
    for (const comment of comments || []) {
      const anchor = pdfAnchorOf(comment);
      if (!anchor?.rectangles.length) continue;
      const layer = content.querySelector(
        `.pdf-page[data-page-number="${anchor.pageNumber}"] .pdf-comment-highlight-layer`
      );
      if (!layer) continue;
      for (const rectangle of anchor.rectangles) {
        const highlight = document.createElement('span');
        highlight.className = 'pdf-comment-highlight';
        highlight.dataset.status = comment.status === 'resolved' ? 'resolved' : 'open';
        highlight.dataset.commentId = comment.id || '';
        highlight.setAttribute('role', 'button');
        highlight.tabIndex = 0;
        highlight.setAttribute('aria-label', `ページ${anchor.pageNumber}のコメントを表示`);
        highlight.style.left = `${rectangle.x * 100}%`;
        highlight.style.top = `${rectangle.y * 100}%`;
        highlight.style.width = `${rectangle.width * 100}%`;
        highlight.style.height = `${rectangle.height * 100}%`;
        const select = () => onSelectComment(comment.id);
        highlight.addEventListener('click', select);
        highlight.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          select();
        });
        layer.append(highlight);
      }
    }
  }

  function dispose() {
    generation += 1;
    renderTasks.forEach((task) => task.cancel?.());
    textLayers.forEach((layer) => layer.cancel?.());
    renderTasks = [];
    textLayers = [];
    Promise.resolve(loadingTask?.destroy?.()).catch(() => {});
    loadingTask = null;
    pdfDocument = null;
    content.classList.remove('pdf-document');
    content.classList.add('znc');
  }

  function createPageElement(page) {
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const pageElement = document.createElement('section');
    pageElement.className = 'pdf-page';
    pageElement.dataset.pageNumber = String(page.pageNumber);
    pageElement.setAttribute('aria-label', `${page.pageNumber}ページ目`);
    pageElement.style.width = `${viewport.width}px`;
    pageElement.style.height = `${viewport.height}px`;
    pageElement.style.setProperty('--scale-factor', String(viewport.scale));
    pageElement.style.setProperty('--user-unit', String(page.userUnit));

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const highlights = document.createElement('div');
    highlights.className = 'pdf-comment-highlight-layer';
    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text-layer';
    textLayer.dataset.pageNumber = String(page.pageNumber);
    pageElement.append(canvas, highlights, textLayer);
    return pageElement;
  }

  async function renderPage(page, pageElement, TextLayer) {
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const canvas = pageElement.querySelector('.pdf-canvas');
    const textLayerElement = pageElement.querySelector('.pdf-text-layer');
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
    const renderTask = page.render({ canvas, viewport, transform });
    renderTasks.push(renderTask);
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true }),
      container: textLayerElement,
      viewport
    });
    textLayers.push(textLayer);
    await Promise.all([renderTask.promise, textLayer.render()]);
  }

  return { dispose, open, renderHighlights, selectionTarget };
}
