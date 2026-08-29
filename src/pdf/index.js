import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from '../http.js';
import { createPathFilter } from '../pathFilter.js';

const PDF_EXTENSION = '.pdf';
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
