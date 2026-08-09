import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBlockEdits } from './editorMarkdown.js';
import { renderMarkdown } from './markdown.js';
import {
  buildReviewMarkdown,
  exportPathFor,
  findExistingReviewPath,
  normalizeRelativePath,
  readReview,
  reviewPathFor,
  writeReview
} from './reviewStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const zennContentCssPath = fileURLToPath(import.meta.resolve('zenn-content-css'));
const markdownExtensions = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const ignoredDirectories = new Set(['.git', 'node_modules', '.review']);
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon']
]);

export function createServer(targetDir = '.') {
  const rootDir = path.resolve(targetDir);
  const app = {
    listen(port, callback) {
      const server = http.createServer((request, response) => {
        handleRequest(request, response, rootDir).catch((error) => sendError(response, error));
      });
      return server.listen(port, callback);
    }
  };
  return { app, rootDir };
}

async function handleRequest(request, response, rootDir) {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/api/files') {
    return sendJson(response, { rootDir, files: await listMarkdownFiles(rootDir) });
  }

  if (request.method === 'GET' && url.pathname === '/api/file') {
    const relativeFile = normalizeRelativePath(rootDir, url.searchParams.get('path'));
    const markdown = await fs.readFile(path.join(rootDir, relativeFile), 'utf8');
    const review = await readReview(rootDir, relativeFile);
    const rendered = await renderFile(markdown, relativeFile);
    return sendJson(response, {
      path: relativeFile,
      markdown,
      ...rendered,
      review,
      reviewFile: await relativeReviewPath(rootDir, relativeFile)
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/file') {
    const body = await readJsonBody(request);
    const relativeFile = normalizeRelativePath(rootDir, body.path);
    ensureMarkdownFile(relativeFile);
    const filePath = path.join(rootDir, relativeFile);
    const currentMarkdown = await fs.readFile(filePath, 'utf8');
    const { markdown, appliedEdits } = applyBlockEdits(currentMarkdown, body.edits);
    const comments = Array.isArray(body.comments) ? body.comments : [];

    const review = await writeReview(rootDir, relativeFile, comments);
    await fs.writeFile(filePath, markdown, 'utf8');
    const rendered = await renderFile(markdown, relativeFile);
    return sendJson(response, {
      path: relativeFile,
      markdown,
      ...rendered,
      appliedEdits,
      review,
      reviewFile: await relativeReviewPath(rootDir, relativeFile)
    });
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/asset') {
    const relativeFile = normalizeRelativePath(rootDir, url.searchParams.get('from'));
    return serveAsset(rootDir, relativeFile, url.searchParams.get('src'), response, request.method === 'HEAD');
  }

  if (request.method === 'POST' && url.pathname === '/api/review') {
    const body = await readJsonBody(request);
    const relativeFile = normalizeRelativePath(rootDir, body.path);
    const comments = Array.isArray(body.comments) ? body.comments : [];
    const review = await writeReview(rootDir, relativeFile, comments);
    return sendJson(response, {
      review,
      reviewFile: await relativeReviewPath(rootDir, relativeFile)
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/export') {
    const relativeFile = normalizeRelativePath(rootDir, url.searchParams.get('path'));
    const review = await readReview(rootDir, relativeFile);
    const markdown = buildReviewMarkdown(review);
    const outputPath = await exportPathForExistingReview(rootDir, relativeFile);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, markdown, 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return response.end(markdown);
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    return serveStatic(url.pathname, response, request.method === 'HEAD');
  }

  const error = new Error('Not found');
  error.statusCode = 404;
  throw error;
}

async function relativeReviewPath(rootDir, relativeFile) {
  const reviewFilePath = await findExistingReviewPath(rootDir, relativeFile);
  return path.relative(rootDir, reviewFilePath).split(path.sep).join('/');
}

async function exportPathForExistingReview(rootDir, relativeFile) {
  const reviewFilePath = await findExistingReviewPath(rootDir, relativeFile);
  const primaryReviewPath = reviewPathFor(rootDir, relativeFile);
  if (reviewFilePath === primaryReviewPath) return exportPathFor(rootDir, relativeFile);
  return reviewFilePath.replace(/\.review\.json$/, '.review.md');
}

function assetUrlFor(relativeFile, src) {
  const trimmedSrc = String(src || '').trim();
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmedSrc)) return trimmedSrc;
  return `/api/asset?from=${encodeURIComponent(relativeFile)}&src=${encodeURIComponent(trimmedSrc)}`;
}

async function renderFile(markdown, relativeFile) {
  const resolveImageSrc = (src) => assetUrlFor(relativeFile, src);
  const [html, editableHtml] = await Promise.all([
    renderMarkdown(markdown, { resolveImageSrc }),
    renderMarkdown(markdown, { editableBlocks: true, resolveImageSrc })
  ]);
  return { html, editableHtml };
}

function ensureMarkdownFile(relativeFile) {
  if (!markdownExtensions.has(path.extname(relativeFile).toLowerCase())) {
    const error = new Error('Only Markdown files can be edited');
    error.statusCode = 400;
    throw error;
  }
}

async function serveAsset(rootDir, relativeFile, src, response, headOnly) {
  const assetPath = await resolveAssetPath(rootDir, relativeFile, src);
  const data = await fs.readFile(assetPath);
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(path.extname(assetPath).toLowerCase()) || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache'
  });
  if (!headOnly) response.end(data);
  else response.end();
}

/**
 * Markdown image paths reach us in whatever form the document used: relative to
 * the Markdown file, rooted at the target directory, percent-encoded by the
 * renderer (non-ASCII file names, escaped spaces), or carrying a `?query`/`#hash`
 * suffix. Try each plausible spelling and serve the first file that exists.
 */
async function resolveAssetPath(rootDir, relativeFile, src) {
  const source = String(src || '').trim().replace(/[?#].*$/, '');
  if (!source || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) {
    const error = new Error('Invalid asset path');
    error.statusCode = 400;
    throw error;
  }

  const markdownDir = path.dirname(path.join(rootDir, relativeFile));
  const candidates = [];
  for (const spelling of assetPathSpellings(source)) {
    // A leading slash means the target directory, not the filesystem root.
    const assetPath = spelling.startsWith('/')
      ? path.resolve(rootDir, `.${spelling}`)
      : path.resolve(markdownDir, spelling);
    const relative = path.relative(rootDir, assetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!candidates.includes(assetPath)) candidates.push(assetPath);
  }

  if (candidates.length === 0) {
    const error = new Error('asset path must stay inside target directory');
    error.statusCode = 400;
    throw error;
  }

  for (const candidate of candidates) {
    const stats = await fs.stat(candidate).catch(() => null);
    if (stats?.isFile()) return candidate;
  }

  const error = new Error(`Asset not found: ${source}`);
  error.statusCode = 404;
  throw error;
}

function assetPathSpellings(source) {
  const spellings = [source];
  try {
    const decoded = decodeURIComponent(source);
    if (decoded !== source) spellings.unshift(decoded);
  } catch {
    // A stray '%' is part of the file name rather than an escape sequence.
  }
  return spellings;
}

async function serveStatic(urlPath, response, headOnly) {
  const requested = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  if (requested === '/zenn-content.css') {
    const data = await fs.readFile(zennContentCssPath);
    response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    if (!headOnly) response.end(data);
    else response.end();
    return;
  }
  const filePath = path.resolve(publicDir, `.${requested}`);
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Invalid static path');
    error.statusCode = 400;
    throw error;
  }
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, { 'Content-Type': mimeTypes.get(path.extname(filePath)) || 'application/octet-stream' });
    if (!headOnly) response.end(data);
    else response.end();
  } catch (error) {
    if (error.code === 'ENOENT') {
      const index = await fs.readFile(path.join(publicDir, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (!headOnly) response.end(index);
      else response.end();
      return;
    }
    throw error;
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, payload) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  const statusCode = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
}

export async function listMarkdownFiles(rootDir) {
  const files = [];
  await walk(rootDir, '');
  return files.sort((a, b) => a.localeCompare(b));

  async function walk(currentDir, relativeDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        await walk(path.join(currentDir, entry.name), path.posix.join(relativeDir, entry.name));
      } else if (entry.isFile() && markdownExtensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.posix.join(relativeDir, entry.name));
      }
    }
  }
}
