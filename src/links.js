import path from 'node:path';
import { decodeMarkdownPath, isExternalUrl, splitUrl } from './urlPath.js';

export const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);

/**
 * Plain-text documents: not Markdown, but still text we can read out and hand
 * to the clipboard. Anything outside this set and MARKDOWN_EXTENSIONS (PDFs,
 * images, archives) has no body we can offer as text.
 */
export const TEXT_EXTENSIONS = new Set(['.txt', '.text', '.log', '.csv', '.tsv']);

export function isMarkdownPath(relativePath) {
  return MARKDOWN_EXTENSIONS.has(extensionOf(relativePath));
}

/** True when the file's body is text — Markdown or a plain-text file. */
export function isTextDocumentPath(relativePath) {
  const extension = extensionOf(relativePath);
  return MARKDOWN_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension);
}

function extensionOf(relativePath) {
  return path.posix.extname(String(relativePath)).toLowerCase();
}

export function assetUrlFor(relativeFile, source) {
  const trimmed = String(source || '').trim();
  if (isExternalUrl(trimmed) || trimmed.startsWith('#')) return trimmed;
  return `/api/asset?from=${encodeURIComponent(relativeFile)}&src=${encodeURIComponent(trimmed)}`;
}

export function reviewUrlFor(relativePath, hash = '') {
  return `#/review/${encodeURIComponent(relativePath)}${hash}`;
}

/**
 * Decides what a link written inside a Markdown file should do in the review UI.
 *
 * Returns `null` for anything we leave alone (external URLs, `mailto:`, in-page
 * anchors), otherwise a descriptor the renderer turns into DOM attributes:
 *
 * - `internal` — another Markdown file under the review root: navigate in-app.
 * - `asset`    — a non-Markdown file under the review root: serve it as a file.
 * - `outside`  — resolves above the review root: refuse with an explanation.
 * - `filtered` — under the root but hidden by --include/--exclude.
 *
 * @param {object} context
 * @param {string} context.relativeFile POSIX path of the Markdown file holding the link.
 * @param {(relativePath: string) => boolean} [context.isInScope] --include/--exclude test.
 */
export function resolveDocumentLink(href, { relativeFile, isInScope = () => true } = {}) {
  const raw = String(href || '').trim();
  if (!raw || isExternalUrl(raw) || raw.startsWith('#')) return null;

  const { path: rawPath, query, hash } = splitUrl(raw);
  if (!rawPath) return null;

  const decodedPath = decodeMarkdownPath(rawPath);
  const target = resolveAgainstRoot(relativeFile, decodedPath);
  if (target === ESCAPES_ROOT) {
    return {
      state: 'outside',
      href: raw,
      message: `このリンクはレビュー対象ディレクトリの外を指しています: ${decodedPath}`
    };
  }
  // A link to the review root itself already lands on the file list.
  if (target === '') return null;

  if (!isMarkdownPath(target)) {
    return { state: 'asset', href: assetUrlFor(relativeFile, `${rawPath}${query}`), path: target };
  }

  if (!isInScope(target)) {
    return {
      state: 'filtered',
      href: raw,
      path: target,
      message: `このリンク先は include / exclude の設定によりレビュー対象から外れています: ${target}`
    };
  }

  return { state: 'internal', href: reviewUrlFor(target, hash), path: target, hash };
}

const ESCAPES_ROOT = Symbol('escapes review root');

/** Returns the root-relative POSIX path, `''` for the root itself, or ESCAPES_ROOT. */
function resolveAgainstRoot(relativeFile, linkPath) {
  const posix = path.posix;
  const documentDir = posix.dirname(String(relativeFile || '.').replaceAll('\\', '/'));
  const resolved = linkPath.startsWith('/')
    ? posix.normalize(linkPath.slice(1))
    : posix.normalize(posix.join(documentDir === '.' ? '' : documentDir, linkPath));
  const normalized = resolved.replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) return ESCAPES_ROOT;
  return normalized === '.' ? '' : normalized;
}
