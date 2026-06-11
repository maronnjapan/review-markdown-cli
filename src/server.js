import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './markdown.js';
import {
  buildReviewMarkdown,
  exportPathFor,
  normalizeRelativePath,
  readReview,
  reviewPathFor,
  writeReview
} from './reviewStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
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
  ['.jpeg', 'image/jpeg']
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
    return sendJson(response, {
      path: relativeFile,
      markdown,
      html: renderMarkdown(markdown),
      review,
      reviewFile: path.relative(rootDir, reviewPathFor(rootDir, relativeFile)).split(path.sep).join('/')
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/review') {
    const body = await readJsonBody(request);
    const relativeFile = normalizeRelativePath(rootDir, body.path);
    const comments = Array.isArray(body.comments) ? body.comments : [];
    const review = await writeReview(rootDir, relativeFile, comments);
    return sendJson(response, {
      review,
      reviewFile: path.relative(rootDir, reviewPathFor(rootDir, relativeFile)).split(path.sep).join('/')
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/export') {
    const relativeFile = normalizeRelativePath(rootDir, url.searchParams.get('path'));
    const review = await readReview(rootDir, relativeFile);
    const markdown = buildReviewMarkdown(review);
    const outputPath = exportPathFor(rootDir, relativeFile);
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

async function serveStatic(urlPath, response, headOnly) {
  const requested = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
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
