import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from '../http.js';
import { createPathFilter } from '../pathFilter.js';

const PDF_EXTENSION = '.pdf';

/**
 * `readPdfText` がPDF.jsへ渡す添付データの置き場です。CJKのPDFから文字を取り出すには
 * cmap が、埋め込まれていないフォントを持つPDFには標準フォントの実体が要ります。
 * どちらも `pdfjs-dist` に同梱されているので、そこを指します。
 *
 * `file://` のURLではなくディレクトリのパスを渡すのは、Nodeの `fetch` が `file://` を
 * 扱えないからです。URLで渡すとPDF.jsは読めずに警告だけ出し、埋め込みフォントを持たない
 * PDFの文字が落ちます。
 */
const PDFJS_DATA = {
  cMapUrl: fileURLToPath(import.meta.resolve('pdfjs-dist/cmaps/')),
  standardFontDataUrl: fileURLToPath(import.meta.resolve('pdfjs-dist/standard_fonts/'))
};
const PDFJS_ASSETS = new Map([
  ['/vendor/pdfjs/pdf.mjs', {
    path: fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.mjs')),
    type: 'text/javascript; charset=utf-8'
  }],
  ['/vendor/pdfjs/pdf.worker.min.mjs', {
    path: fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.worker.min.mjs')),
    type: 'text/javascript; charset=utf-8'
  }]
]);

export function isPdfPath(relativePath) {
  return path.posix.extname(String(relativePath)).toLowerCase() === PDF_EXTENSION;
}

/** Kept separate from the Markdown walker so PDF support can be removed as one unit. */
export async function listPdfFiles(rootDir, filter = createPathFilter()) {
  const files = [];
  await walk(rootDir, '');
  return files.sort((a, b) => a.localeCompare(b));

  async function walk(currentDir, relativeDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (filter.allowsDirectory(relativePath)) await walk(path.join(currentDir, entry.name), relativePath);
      } else if (entry.isFile() && isPdfPath(entry.name) && filter.matchesFile(relativePath)) {
        files.push(relativePath);
      }
    }
  }
}

export function pdfUrlFor(relativeFile) {
  return `/api/pdf?path=${encodeURIComponent(relativeFile)}`;
}

/**
 * PDFの本文を、参照ファイルとしてモデルへ渡せるテキストにします。
 *
 * 画面のPDFはブラウザのPDF.jsが描いていて、サーバーはPDF本体を流すだけでした。
 * 参照ファイルは本文を読ませるものなので、ここだけはNode側でも文字を取り出します。
 * 使うのは同じ `pdfjs-dist` の、ブラウザAPIに依らない legacy ビルドです。
 *
 * 取り出せるのは文字だけで、段組み・表・図の位置関係は落ちます。落ちることは
 * プロンプト側でモデルへ伝えます（`prompts/readingContext.js` の kind="pdf"）。
 * 画像だけのPDF（スキャン）からは何も取れません。空文字が返るので、
 * 呼ぶ側は「読めなかった」と同じ扱いにします。
 *
 * @param {number} [maxChars] これだけ取れたら残りのページは開きません。
 *   1000ページのPDFを添えられても、渡す分より先は読まないためです。
 */
export async function readPdfText(filePath, maxChars = Infinity) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fsp.readFile(filePath));
  const loadingTask = pdfjs.getDocument({
    data,
    // 文字を取り出すだけなので、フォントもJavaScriptも要りません。
    // `isEvalSupported: false` はPDF側のコードを走らせないための指定です。
    isEvalSupported: false,
    useSystemFonts: false,
    cMapUrl: PDFJS_DATA.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_DATA.standardFontDataUrl
  });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    let length = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages && length < maxChars; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      // `hasEOL` は元のPDFで行が変わったところです。これを改行に戻さないと、
      // ページ全体が1行に潰れて、見出しと本文の切れ目が読めなくなります。
      const text = content.items
        .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
        .join('')
        .trim();
      page.cleanup();
      if (!text) continue;
      pages.push(text);
      length += text.length;
    }
    return pages.join('\n\n');
  } finally {
    await loadingTask.destroy();
  }
}

export function assertSupportedPdfAiTarget(relativeFile, target) {
  if (isPdfPath(relativeFile) && target?.type === 'document') {
    throw httpError('PDF全体は翻訳・AIチャットの対象にできません。PDF内の文章を選択してください。', 400);
  }
}

/** Streams the original PDF read-only. Single byte ranges are supported for PDF.js. */
export async function servePdf(rootDir, relativeFile, request, response, headOnly = false) {
  if (!isPdfPath(relativeFile)) throw httpError('Only PDF files are available from this endpoint', 400);
  const filePath = path.join(rootDir, relativeFile);
  const stats = await fsp.stat(filePath);
  if (!stats.isFile()) throw httpError(`PDF not found: ${relativeFile}`, 404);

  const range = parseRange(request.headers.range, stats.size);
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/pdf',
    'X-Content-Type-Options': 'nosniff'
  };

  if (range === INVALID_RANGE) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stats.size}` });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, stats.size - 1);
  const length = stats.size === 0 ? 0 : end - start + 1;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
  headers['Content-Length'] = String(length);
  response.writeHead(range ? 206 : 200, headers);
  if (headOnly || length === 0) {
    response.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start, end });
    stream.once('error', reject);
    response.once('finish', resolve);
    response.once('close', resolve);
    stream.pipe(response);
  });
}

/** Serves only the two browser modules used by the isolated PDF viewer. */
export async function servePdfJsAsset(urlPath, response, headOnly = false) {
  const asset = PDFJS_ASSETS.get(urlPath);
  if (!asset) throw httpError('PDF.js asset not found', 404);
  const data = await fsp.readFile(asset.path);
  response.writeHead(200, {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Length': data.length,
    'Content-Type': asset.type,
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(headOnly ? undefined : data);
}

const INVALID_RANGE = Symbol('invalid PDF byte range');

function parseRange(value, size) {
  if (!value) return null;
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size === 0) return INVALID_RANGE;

  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return INVALID_RANGE;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return INVALID_RANGE;
  }
  return { start, end: Math.min(end, size - 1) };
}
