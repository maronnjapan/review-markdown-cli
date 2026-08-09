import fs from 'node:fs/promises';
import path from 'node:path';
import { serveAsset } from './assets.js';
import { applyBlockEdits } from './editorMarkdown.js';
import { httpError, readJsonBody, sendBuffer, sendJson } from './http.js';
import { assetUrlFor, isMarkdownPath, resolveDocumentLink } from './links.js';
import { renderMarkdown } from './markdown.js';
import { listMarkdownFiles } from './markdownFiles.js';
import {
  buildReviewMarkdown,
  exportPathFor,
  findExistingReviewPath,
  normalizeRelativePath,
  readReview,
  reviewPathFor,
  writeReview
} from './reviewStore.js';
import { serveStatic } from './staticFiles.js';

/**
 * Every route resolves the requested path against the review root first, so a
 * handler only ever sees a path that stays inside the directory being reviewed.
 */
const ROUTES = [
  { methods: ['GET'], pathname: '/api/files', handle: listFiles },
  { methods: ['GET'], pathname: '/api/file', handle: openFile },
  { methods: ['POST'], pathname: '/api/file', handle: saveFile },
  { methods: ['GET', 'HEAD'], pathname: '/api/asset', handle: openAsset },
  { methods: ['POST'], pathname: '/api/review', handle: saveReview },
  { methods: ['GET'], pathname: '/api/export', handle: exportReview }
];

export function createRequestHandler({ rootDir, filter }) {
  return async function handleRequest(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const route = ROUTES.find((candidate) => (
      candidate.pathname === url.pathname && candidate.methods.includes(request.method)
    ));
    const context = { rootDir, filter, request, response, url, headOnly: request.method === 'HEAD' };

    if (route) return route.handle(context);
    if (request.method === 'GET' || request.method === 'HEAD') {
      return serveStatic(url.pathname, response, context.headOnly);
    }
    throw httpError('Not found', 404);
  };
}

async function listFiles({ rootDir, filter, response }) {
  return sendJson(response, {
    rootDir,
    files: await listMarkdownFiles(rootDir, filter),
    filters: { include: filter.include, exclude: filter.exclude }
  });
}

async function openFile({ rootDir, filter, url, response }) {
  const relativeFile = reviewTarget(rootDir, filter, url.searchParams.get('path'));
  const markdown = await fs.readFile(path.join(rootDir, relativeFile), 'utf8');
  const review = await readReview(rootDir, relativeFile);
  return sendJson(response, {
    path: relativeFile,
    markdown,
    ...await renderBothViews(markdown, relativeFile, filter),
    review,
    reviewFile: await relativeReviewPath(rootDir, relativeFile)
  });
}

async function saveFile({ rootDir, filter, request, response }) {
  const body = await readJsonBody(request);
  const relativeFile = reviewTarget(rootDir, filter, body.path);
  if (!isMarkdownPath(relativeFile)) throw httpError('Only Markdown files can be edited', 400);

  const filePath = path.join(rootDir, relativeFile);
  const currentMarkdown = await fs.readFile(filePath, 'utf8');
  const { markdown, appliedEdits } = applyBlockEdits(currentMarkdown, body.edits);
  const review = await writeReview(rootDir, relativeFile, commentsOf(body));
  await fs.writeFile(filePath, markdown, 'utf8');

  return sendJson(response, {
    path: relativeFile,
    markdown,
    ...await renderBothViews(markdown, relativeFile, filter),
    appliedEdits,
    review,
    reviewFile: await relativeReviewPath(rootDir, relativeFile)
  });
}

function openAsset({ rootDir, filter, url, response, headOnly }) {
  const relativeFile = reviewTarget(rootDir, filter, url.searchParams.get('from'));
  return serveAsset(rootDir, relativeFile, url.searchParams.get('src'), response, headOnly);
}

async function saveReview({ rootDir, filter, request, response }) {
  const body = await readJsonBody(request);
  const relativeFile = reviewTarget(rootDir, filter, body.path);
  return sendJson(response, {
    review: await writeReview(rootDir, relativeFile, commentsOf(body)),
    reviewFile: await relativeReviewPath(rootDir, relativeFile)
  });
}

async function exportReview({ rootDir, filter, url, response }) {
  const relativeFile = reviewTarget(rootDir, filter, url.searchParams.get('path'));
  const review = await readReview(rootDir, relativeFile);
  const markdown = buildReviewMarkdown(review);
  const outputPath = await exportPathForExistingReview(rootDir, relativeFile);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, markdown, 'utf8');
  return sendBuffer(response, Buffer.from(markdown, 'utf8'), { 'Content-Type': 'text/markdown; charset=utf-8' }, false);
}

/** Normalizes the requested path and refuses anything --include/--exclude hides. */
function reviewTarget(rootDir, filter, requestedPath) {
  const relativeFile = normalizeRelativePath(rootDir, requestedPath);
  if (isMarkdownPath(relativeFile) && !filter.matchesFile(relativeFile)) {
    throw httpError(`このファイルは --include / --exclude によりレビュー対象から外れています: ${relativeFile}`, 404);
  }
  return relativeFile;
}

function commentsOf(body) {
  return Array.isArray(body.comments) ? body.comments : [];
}

/** The reader view and the editable view differ only in the metadata they carry. */
function renderBothViews(markdown, relativeFile, filter) {
  const options = {
    resolveImageSrc: (source) => assetUrlFor(relativeFile, source),
    resolveLink: (href) => resolveDocumentLink(href, {
      relativeFile,
      isInScope: (target) => filter.matchesFile(target)
    })
  };
  return Promise.all([
    renderMarkdown(markdown, options),
    renderMarkdown(markdown, { ...options, editableBlocks: true })
  ]).then(([html, editableHtml]) => ({ html, editableHtml }));
}

async function relativeReviewPath(rootDir, relativeFile) {
  const reviewFilePath = await findExistingReviewPath(rootDir, relativeFile);
  return path.relative(rootDir, reviewFilePath).split(path.sep).join('/');
}

async function exportPathForExistingReview(rootDir, relativeFile) {
  const reviewFilePath = await findExistingReviewPath(rootDir, relativeFile);
  if (reviewFilePath === reviewPathFor(rootDir, relativeFile)) return exportPathFor(rootDir, relativeFile);
  return reviewFilePath.replace(/\.review\.json$/, '.review.md');
}
