const CONTEXT_LENGTH = 120;

/** Converts viewport rectangles into page-relative coordinates that survive reloads. */
export function normalizePdfRectangles(rectangles, pageRect) {
  if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) return [];
  return Array.from(rectangles || [])
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      x: round((rect.left - pageRect.left) / pageRect.width),
      y: round((rect.top - pageRect.top) / pageRect.height),
      width: round(rect.width / pageRect.width),
      height: round(rect.height / pageRect.height)
    }))
    .filter((rect) => rect.x < 1 && rect.y < 1 && rect.x + rect.width > 0 && rect.y + rect.height > 0)
    .map(clampRectangle);
}

export function buildPdfSelectionTarget(range, selectedText) {
  const startElement = elementForNode(range?.startContainer);
  const endElement = elementForNode(range?.endContainer);
  const startLayer = startElement?.closest?.('.pdf-text-layer');
  const endLayer = endElement?.closest?.('.pdf-text-layer');
  if (!range || !selectedText || !startLayer || startLayer !== endLayer) return null;

  const page = startLayer.closest('.pdf-page');
  const pageNumber = Number(page?.dataset.pageNumber);
  if (!page || !Number.isInteger(pageNumber) || pageNumber < 1) return null;

  const pageRect = page.getBoundingClientRect();
  const rectangles = normalizePdfRectangles(range.getClientRects(), pageRect);
  const context = contextAroundRange(startLayer, range);
  return {
    type: 'text-selection',
    documentType: 'pdf',
    selectedText,
    targetText: selectedText,
    pageNumber,
    contextBefore: context.before,
    contextAfter: context.after,
    pdfAnchor: { version: 1, pageNumber, rectangles }
  };
}

export function pdfAnchorOf(comment) {
  const anchor = comment?.pdfAnchor;
  const pageNumber = Number(anchor?.pageNumber || comment?.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  const rectangles = Array.isArray(anchor?.rectangles) ? anchor.rectangles.map(clampRectangle) : [];
  return { pageNumber, rectangles };
}

function contextAroundRange(textLayer, range) {
  const beforeRange = textLayer.ownerDocument.createRange();
  beforeRange.selectNodeContents(textLayer);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = textLayer.ownerDocument.createRange();
  afterRange.selectNodeContents(textLayer);
  afterRange.setStart(range.endContainer, range.endOffset);
  return {
    before: cleanText(beforeRange.cloneContents().textContent).slice(-CONTEXT_LENGTH).trim(),
    after: cleanText(afterRange.cloneContents().textContent).slice(0, CONTEXT_LENGTH).trim()
  };
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ');
}

function elementForNode(node) {
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement;
}

function clampRectangle(rectangle) {
  const x = clamp(Number(rectangle?.x));
  const y = clamp(Number(rectangle?.y));
  return {
    x,
    y,
    width: clamp(Number(rectangle?.width), 0, 1 - x),
    height: clamp(Number(rectangle?.height), 0, 1 - y)
  };
}

function clamp(value, minimum = 0, maximum = 1) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
