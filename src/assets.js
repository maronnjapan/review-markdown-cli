import fs from 'node:fs/promises';
import path from 'node:path';
import { contentTypeFor, httpError, sendBuffer } from './http.js';
import { isExternalUrl, splitUrl } from './urlPath.js';

export async function serveAsset(rootDir, relativeFile, source, response, headOnly) {
  const assetPath = await resolveAssetPath(rootDir, relativeFile, source);
  const data = await fs.readFile(assetPath);
  sendBuffer(response, data, { 'Content-Type': contentTypeFor(assetPath), 'Cache-Control': 'no-cache' }, headOnly);
}

/**
 * Asset paths reach us in whatever form the document used: relative to the
 * Markdown file, rooted at the review directory, percent-encoded by the renderer
 * (non-ASCII names, escaped spaces), or carrying a `?query`/`#hash` suffix.
 * Try each plausible spelling and serve the first file that exists.
 */
export async function resolveAssetPath(rootDir, relativeFile, source) {
  const requested = splitUrl(source).path;
  if (!requested || isExternalUrl(requested)) throw httpError('Invalid asset path', 400);

  const markdownDir = path.dirname(path.join(rootDir, relativeFile));
  const candidates = [];
  for (const spelling of assetPathSpellings(requested)) {
    // A leading slash means the review directory, not the filesystem root.
    const assetPath = spelling.startsWith('/')
      ? path.resolve(rootDir, `.${spelling}`)
      : path.resolve(markdownDir, spelling);
    const relative = path.relative(rootDir, assetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!candidates.includes(assetPath)) candidates.push(assetPath);
  }

  if (candidates.length === 0) throw httpError('asset path must stay inside target directory', 400);

  for (const candidate of candidates) {
    const stats = await fs.stat(candidate).catch(() => null);
    if (stats?.isFile()) return candidate;
  }

  throw httpError(`Asset not found: ${requested}`, 404);
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
