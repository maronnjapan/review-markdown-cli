import fs from 'node:fs/promises';
import path from 'node:path';
import { serveAsset } from './assets.js';
import { applyBlockEdits } from './editorMarkdown.js';
import { httpError, readJsonBody, sendBuffer, sendJson, startNdjson } from './http.js';
import { assetUrlFor, isMarkdownPath, isTextDocumentPath, resolveDocumentLink } from './links.js';
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
  { methods: ['GET'], pathname: '/api/export', handle: exportReview },
  { methods: ['GET'], pathname: '/api/ai/status', handle: aiStatus },
  { methods: ['GET'], pathname: '/api/ai/conversations', handle: listAiConversations },
  { methods: ['POST', 'DELETE'], pathname: '/api/ai/conversation', handle: aiConversation },
  { methods: ['POST'], pathname: '/api/ai/translate', handle: translateWithAi },
  { methods: ['POST'], pathname: '/api/ai/message', handle: sendAiMessage },
  { methods: ['POST'], pathname: '/api/ai/place-comments', handle: placeAiComments },
  { methods: ['GET'], pathname: '/api/ai/review-skills', handle: listAiReviewSkills },
  { methods: ['GET'], pathname: '/api/ai/review-skill', handle: readAiReviewSkill },
  { methods: ['POST'], pathname: '/api/ai/persona', handle: composeAiPersona },
  { methods: ['POST'], pathname: '/api/ai/review', handle: reviewWithAi }
];

export function createRequestHandler({ rootDir, filter, aiService, aiToken, projectAiContext = '' }) {
  return async function handleRequest(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const route = ROUTES.find((candidate) => (
      candidate.pathname === url.pathname && candidate.methods.includes(request.method)
    ));
    const context = {
      rootDir,
      filter,
      aiService,
      aiToken,
      projectAiContext,
      request,
      response,
      url,
      headOnly: request.method === 'HEAD'
    };

    if (route) return route.handle(context);
    if (request.method === 'GET' || request.method === 'HEAD') {
      return serveStatic(url.pathname, response, context.headOnly);
    }
    throw httpError('Not found', 404);
  };
}

async function aiStatus({ aiService, aiToken, request, response }) {
  assertLocalAiRequest(request);
  response.setHeader('Cache-Control', 'no-store');
  return sendJson(response, { token: aiToken, ...await aiService.status() });
}

async function listAiConversations(context) {
  const { rootDir, filter, aiService, request, response, url } = context;
  authorizeAiRequest(context);
  const relativeFile = reviewTarget(rootDir, filter, url.searchParams.get('path'));
  return sendJson(response, { conversations: await aiService.listConversations(relativeFile) });
}

async function aiConversation(context) {
  const { rootDir, filter, aiService, request, response } = context;
  authorizeAiRequest(context);
  const body = await readJsonBody(request);
  if (request.method === 'DELETE') {
    await aiService.deleteConversation(body.id);
    return sendJson(response, { deleted: true });
  }
  const relativeFile = reviewTarget(rootDir, filter, body.path);
  return sendJson(response, {
    conversation: await aiService.createConversation({ documentPath: relativeFile, target: body.target })
  });
}

/**
 * 生成しながら返すAIエンドポイント、5本ぶんの共通の手順です。
 *
 * どれも同じことをします。トークンを確かめ、本文を読み、対象ファイルを解決し、
 * NDJSONを開いて `started` → `delta`（何度でも）→ `result` の順に流します。
 * 違うのは「どのサービス呼び出しか」と「結果をどう包むか」の2つだけなので、
 * 各エンドポイントはその2つだけを書きます。
 *
 * @param {Function} options.run ({ aiService, documentPath, body, signal, onDelta, send }) を
 *   受け取り、結果を返します。`send` は途中経過を足したいときだけ使います（AIレビューの phase）。
 * @param {Function} options.toEvent 結果を `result` イベントの中身へ包みます。
 * @param {boolean} [options.needsDocument] 対象ファイルを要求するか。チャットだけが false です
 *   （どの文書の話かは会話idで決まるので、リクエストは path を持ちません）。
 */
async function streamAiRequest(context, { run, toEvent, needsDocument = true }) {
  const { rootDir, filter, aiService, request, response } = context;
  authorizeAiRequest(context);
  const body = await readJsonBody(request);
  // ここで弾けば、NDJSONを開く前に 400 を返せます。開いてしまうと 200 のまま
  // 中身がエラーになり、呼ぶ側は「使い方の誤り」と「AIの失敗」を区別できません。
  const documentPath = needsDocument ? reviewTarget(rootDir, filter, body.path) : null;
  return streamAiResponse(request, response, async ({ send, signal }) => {
    send({ type: 'started' });
    const result = await run({
      aiService,
      documentPath,
      body,
      signal,
      send,
      onDelta: (delta) => send({ type: 'delta', delta })
    });
    send({ type: 'result', ...toEvent(result) });
  });
}

function translateWithAi(context) {
  return streamAiRequest(context, {
    run: ({ aiService, documentPath, body, signal, onDelta }) => (
      aiService.translate(documentPath, body.target, { signal, onDelta })
    ),
    toEvent: (translation) => ({ translation })
  });
}

/** Proposes where the reviewer's notes belong. Saving stays with /api/review. */
function placeAiComments(context) {
  return streamAiRequest(context, {
    run: ({ aiService, documentPath, body, signal, onDelta }) => (
      aiService.placeComments(documentPath, body.notes, { signal, onDelta })
    ),
    toEvent: (placement) => placement
  });
}

/** レビュアーの走り書きを読み手ペルソナへ組み直します。保存は /api/review です。 */
function composeAiPersona(context) {
  return streamAiRequest(context, {
    run: ({ aiService, documentPath, body, signal, onDelta }) => (
      aiService.composePersona(documentPath, body.input, { signal, onDelta })
    ),
    toEvent: (persona) => ({ persona })
  });
}

/** Reviews one document with the chosen skills. Saving stays with /api/review. */
function reviewWithAi(context) {
  return streamAiRequest(context, {
    run: ({ aiService, documentPath, body, signal, onDelta, send }) => (
      aiService.reviewDocument(documentPath, { skillIds: body.skillIds ?? body.skillId }, {
        signal,
        onDelta,
        // レビューは2周するので、いまどちらを読んでいるかを待っている画面へ流します。
        onPhase: (phase) => send({ type: 'phase', phase })
      })
    ),
    toEvent: (review) => review
  });
}

function sendAiMessage(context) {
  return streamAiRequest(context, {
    needsDocument: false,
    run: ({ aiService, body, signal, onDelta }) => (
      aiService.sendMessage(body.conversationId, body.message, { signal, onDelta })
    ),
    toEvent: (result) => result
  });
}

/** 選べるレビュースキル。Codexを起動しないので、レビュー実行前でも一覧できます。 */
async function listAiReviewSkills(context) {
  const { aiService, response } = context;
  authorizeAiRequest(context);
  return sendJson(response, { skills: await aiService.listReviewSkills() });
}

/** 1つのスキルの中身。選ぶ前に何を見るスキルかを画面で読めるようにします。 */
async function readAiReviewSkill(context) {
  const { aiService, response, url } = context;
  authorizeAiRequest(context);
  return sendJson(response, { skill: await aiService.readReviewSkill(url.searchParams.get('id')) });
}

async function streamAiResponse(request, response, run) {
  const send = startNdjson(response);
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once('aborted', abort);
  response.once('close', abort);
  try {
    await run({ send, signal: controller.signal });
  } catch (error) {
    send({ type: 'error', error: error.message || 'AI request failed' });
  } finally {
    request.removeListener('aborted', abort);
    response.end();
  }
}

function authorizeAiRequest({ request, response, aiToken }) {
  assertLocalAiRequest(request);
  if (request.headers['x-review-markdown-token'] !== aiToken) {
    throw httpError('Invalid AI request token', 403);
  }
  response.setHeader('Cache-Control', 'no-store');
}

function assertLocalAiRequest(request) {
  const host = request.headers.host;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw httpError('Invalid host', 403);
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostUrl.hostname)) {
    throw httpError('AI endpoints are available on localhost only', 403);
  }
  const origin = request.headers.origin;
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw httpError('Invalid origin', 403);
    }
    if (originUrl.host !== host) throw httpError('Cross-origin AI requests are not allowed', 403);
  }
}

async function listFiles({ rootDir, filter, response }) {
  return sendJson(response, {
    rootDir,
    files: await listMarkdownFiles(rootDir, filter),
    filters: { include: filter.include, exclude: filter.exclude }
  });
}

async function openFile({ rootDir, filter, projectAiContext, url, response }) {
  const relativeFile = reviewTarget(rootDir, filter, url.searchParams.get('path'));
  const markdown = await fs.readFile(path.join(rootDir, relativeFile), 'utf8');
  const review = await readReview(rootDir, relativeFile);
  return sendJson(response, {
    path: relativeFile,
    markdown,
    textBody: isTextDocumentPath(relativeFile),
    ...await renderBothViews(markdown, relativeFile, filter),
    review,
    projectAiContext,
    reviewFile: await relativeReviewPath(rootDir, relativeFile)
  });
}

async function saveFile({ rootDir, filter, projectAiContext, request, response }) {
  const body = await readJsonBody(request);
  const relativeFile = reviewTarget(rootDir, filter, body.path);
  if (!isMarkdownPath(relativeFile)) throw httpError('Only Markdown files can be edited', 400);

  const filePath = path.join(rootDir, relativeFile);
  const currentMarkdown = await fs.readFile(filePath, 'utf8');
  const { markdown, appliedEdits } = applyBlockEdits(currentMarkdown, body.edits);
  const review = await writeReview(rootDir, relativeFile, commentsOf(body), reviewPremiseOf(body));
  await fs.writeFile(filePath, markdown, 'utf8');

  return sendJson(response, {
    path: relativeFile,
    markdown,
    textBody: isTextDocumentPath(relativeFile),
    ...await renderBothViews(markdown, relativeFile, filter),
    appliedEdits,
    review,
    projectAiContext,
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
  // A request carrying only the reading context or the persona keeps the comments already on file.
  const comments = Array.isArray(body.comments)
    ? body.comments
    : (await readReview(rootDir, relativeFile)).comments;
  return sendJson(response, {
    review: await writeReview(rootDir, relativeFile, comments, reviewPremiseOf(body)),
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

/** Normalizes the requested path and refuses anything the include/exclude patterns hide. */
function reviewTarget(rootDir, filter, requestedPath) {
  const relativeFile = normalizeRelativePath(rootDir, requestedPath);
  if (isMarkdownPath(relativeFile) && !filter.matchesFile(relativeFile)) {
    throw httpError(`このファイルは include / exclude の設定によりレビュー対象から外れています: ${relativeFile}`, 404);
  }
  return relativeFile;
}

function commentsOf(body) {
  return Array.isArray(body.comments) ? body.comments : [];
}

/**
 * A request that says nothing about the reading context, the context notes or
 * the reader persona keeps the saved ones: the page beacon on the way out
 * carries comments only. `persona: null` is how the reviewer clears the persona,
 * and an empty `contextNotes` array is how they clear the last note.
 */
function reviewPremiseOf(body) {
  return {
    ...(typeof body.aiContext === 'string' ? { aiContext: body.aiContext } : {}),
    ...(Array.isArray(body.contextNotes) ? { contextNotes: body.contextNotes } : {}),
    ...(body.persona !== undefined ? { persona: body.persona } : {})
  };
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
