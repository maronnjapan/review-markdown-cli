import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentTypeFor, httpError, sendBuffer } from './http.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const zennContentCssPath = fileURLToPath(import.meta.resolve('zenn-content-css'));

export async function serveStatic(urlPath, response, headOnly) {
  if (urlPath === '/zenn-content.css') {
    const css = await fs.readFile(zennContentCssPath);
    return sendBuffer(response, css, { 'Content-Type': 'text/css; charset=utf-8' }, headOnly);
  }

  const requested = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const filePath = path.resolve(publicDir, `.${requested}`);
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw httpError('Invalid static path', 400);

  try {
    const data = await fs.readFile(filePath);
    return sendBuffer(response, data, { 'Content-Type': contentTypeFor(filePath) }, headOnly);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
    // Unknown paths belong to the single page app, so hand back its shell.
    const index = await fs.readFile(path.join(publicDir, 'index.html'));
    return sendBuffer(response, index, { 'Content-Type': 'text/html; charset=utf-8' }, headOnly);
  }
}
