import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { resolveDocumentLink } from '../src/links.js';
import { renderMarkdown } from '../src/markdown.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the file list opens with every directory collapsed and can expand them all', async (t) => {
  const files = ['README.md', 'docs/plan.md', 'docs/guide/intro.md', 'docs/guide/deep/appendix.md'];
  const { document, window } = await startApp(t, 'http://localhost/#/', {
    '/api/files': () => ({
      rootDir: '/tmp/book',
      files,
      filters: { include: [], exclude: ['drafts/**'] }
    })
  });
  await waitFor(() => document.querySelector('.file-tree details.tree-dir'));

  const directories = () => [...document.querySelectorAll('.file-tree details.tree-dir')];
  assert.deepEqual(directories().map((node) => node.dataset.dirPath), ['docs', 'docs/guide', 'docs/guide/deep']);
  assert.deepEqual(directories().map((node) => node.open), [false, false, false], '既定ではすべて閉じている');
  assert.match(document.querySelector('.filter-chips').textContent, /exclude: drafts\/\*\*/);

  document.querySelector('[data-tree-action="expand"]').click();
  assert.deepEqual(directories().map((node) => node.open), [true, true, true]);

  document.querySelector('[data-tree-action="collapse"]').click();
  assert.deepEqual(directories().map((node) => node.open), [false, false, false]);

  // Opening one folder by hand is remembered for the next visit to the list.
  const docs = directories()[0];
  docs.open = true;
  docs.dispatchEvent(new window.Event('toggle'));
  const stored = JSON.parse(window.sessionStorage.getItem('review-markdown:open-dirs:/tmp/book'));
  assert.deepEqual(stored, ['docs']);
});

test('the comment dialog names its target, and a link outside the root reports an error', async (t) => {
  const markdown = [
    '# 設計メモ',
    '',
    '## 背景',
    '',
    'この段落はレビュー対象です。',
    '',
    '詳細は[外部資料](../../secret/notes.md)を参照。'
  ].join('\n');
  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fnote.md', {
    '/api/file': async () => ({
      path: 'docs/note.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/note.md', comments: [] },
      reviewFile: '.review/docs/note.md.review.json'
    })
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  const paragraph = [...document.querySelectorAll('#markdown-content p')]
    .find((element) => element.textContent.includes('この段落はレビュー対象です。'));
  paragraph.querySelector('.inline-comment-button').click();

  assert.equal(document.querySelector('#comment-dialog').open, true);
  assert.equal(document.querySelector('#dialog-type-badge').textContent, '段落');
  assert.equal(document.querySelector('#dialog-target-quote').textContent, 'この段落はレビュー対象です。');
  assert.equal(document.querySelector('#dialog-target-path').hidden, false);
  assert.equal(document.querySelector('#dialog-target-path').textContent, '設計メモ › 背景');
  assert.equal(document.querySelector('#submit-dialog').disabled, true, '本文が空のうちは追加できない');

  const input = document.querySelector('#comment-input');
  input.value = '根拠を足してほしい';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#submit-dialog').disabled, false);

  // Ctrl+Enter is the same as pressing the button.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  assert.equal(document.querySelector('#comment-dialog').open, false);
  assert.equal(document.querySelector('#comment-count').textContent, '1');
  assert.match(document.querySelector('#toast-region').textContent, /コメントを追加しました/);
  assert.equal(document.querySelector('.comment-card .target-badge').textContent, '段落');

  const outsideLink = document.querySelector('#markdown-content a[data-link-state="outside"]');
  assert.ok(outsideLink, 'ルート外リンクには判定が付く');
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  outsideLink.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'ルート外リンクは遷移しない');
  assert.match(document.querySelector('#toast-region').textContent, /レビュー対象ディレクトリの外/);
});

test('paragraph translation and chat use the same read-only target without leaking UI labels', async (t) => {
  const markdown = '# Guide\n\nClick this button to run the program.\n';
  const requests = [];
  const conversation = {
    id: 'conversation-ui-test',
    documentPath: 'guide.md',
    title: 'run the program',
    target: { type: 'paragraph', selectedText: 'Click this button to run the program.' },
    messages: []
  };
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({
      token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model', effort: 'low'
    }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/translate': (_input, options) => {
      requests.push(['translate', JSON.parse(options.body), options.headers]);
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          translation: {
            kind: 'passage',
            result: { translation: 'このボタンをクリックしてプログラムを実行します。', notes: [] }
          }
        }
      ]);
    },
    '/api/ai/conversation': (_input, options) => {
      requests.push(['conversation', JSON.parse(options.body), options.headers]);
      return { conversation };
    },
    '/api/ai/message': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(['message', body, options.headers]);
      return ndjsonResponse([
        { type: 'started' },
        { type: 'delta', delta: 'ここでは実行する、' },
        {
          type: 'result',
          conversation: {
            ...conversation,
            messages: [
              { id: 'user-1', role: 'user', content: body.message },
              { id: 'assistant-1', role: 'assistant', content: 'ここでは実行する、という意味です。' }
            ]
          },
          message: { id: 'assistant-1', role: 'assistant', content: 'ここでは実行する、という意味です。' }
        }
      ]);
    }
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-translate-button'));

  const paragraph = document.querySelector('#markdown-content p');
  paragraph.querySelector('.inline-translate-button').click();
  await waitFor(() => document.querySelector('.translated-passage'));
  assert.equal(document.querySelector('.translated-passage').textContent, 'このボタンをクリックしてプログラムを実行します。');
  assert.equal(requests[0][1].target.selectedText, 'Click this button to run the program.');
  assert.equal(requests[0][2]['X-Review-Markdown-Token'], 'ui-ai-token');

  paragraph.querySelector('.inline-ai-button').click();
  const input = document.querySelector('#ai-chat-input');
  input.value = 'run はここではどういう意味？';
  document.querySelector('#ai-chat-form').requestSubmit();
  await waitFor(() => document.querySelectorAll('.ai-message').length === 2);

  assert.equal(requests.find(([type]) => type === 'conversation')[1].target.selectedText, 'Click this button to run the program.');
  assert.equal(requests.find(([type]) => type === 'message')[1].message, 'run はここではどういう意味？');
  assert.match(document.querySelector('#ai-messages').textContent, /ここでは実行する、という意味です/);
  assert.equal(document.querySelector('#ai-panel').textContent.includes('本文に反映'), false);
});

test('finishing a text selection prefetches its translation and streams the contextual meaning first', async (t) => {
  const markdown = '# Guide\n\nClick to run the program.\n';
  const stream = controlledNdjsonResponse();
  let translationRequests = 0;
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({
      token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model', effort: 'low'
    }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/translate': () => {
      translationRequests += 1;
      return stream.response;
    }
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-translate-button'));

  window.Range.prototype.getBoundingClientRect = () => ({ left: 10, bottom: 20 });
  document.querySelector('#markdown-content').dispatchEvent(new window.Event('pointerdown'));
  const text = document.querySelector('#markdown-content p').firstChild;
  const range = document.createRange();
  range.setStart(text, 9);
  range.setEnd(text, 12);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new window.Event('selectionchange'));

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(translationRequests, 0, 'dragging through an unfinished selection should not translate');

  document.dispatchEvent(new window.Event('pointerup'));
  await waitFor(() => translationRequests === 1);
  assert.equal(document.querySelector('#ai-panel').classList.contains('hidden'), true);
  const translateButton = document.querySelector('#selection-translate-button');
  translateButton.click();
  assert.equal(translationRequests, 1, 'opening a selected translation should reuse its request');

  stream.send({ type: 'started' });
  stream.send({ type: 'delta', delta: '{"contextualMeaning":"実行する",' });

  await waitFor(() => document.querySelector('.contextual-meaning'));
  assert.equal(document.querySelector('.contextual-meaning').textContent, '実行する');
  assert.match(document.querySelector('#translation-result').textContent, /ほかの意味と説明を生成中/);
  assert.equal(document.querySelector('#translation-result details').hidden, true);

  const meanings = [
    { translation: '実行する', nuance: 'プログラムを動かす' },
    { translation: '走る', nuance: '人や動物が移動する' }
  ];
  stream.send({ type: 'delta', delta: `"meanings":${JSON.stringify(meanings)},` });
  await waitFor(() => document.querySelector('#translation-result details').hidden === false);
  assert.match(document.querySelector('#translation-result details').textContent, /走る/);

  stream.send({ type: 'delta', delta: '"explanation":"program が目的語だからです。"}' });
  stream.send({
    type: 'result',
    translation: {
      kind: 'term',
      result: { contextualMeaning: '実行する', meanings, explanation: 'program が目的語だからです。' }
    }
  });
  stream.close();

  await waitFor(() => !document.querySelector('.translation-details-loading'));
  assert.match(document.querySelector('#translation-result').textContent, /program が目的語だからです/);
  assert.equal(translationRequests, 1, 'opening the prefetched translation should reuse the active request');
});

test('a repeated text selection keeps the context of the range that was actually selected', async (t) => {
  const markdown = '# Repeated\n\nFirst run here.\n\nSecond run here.\n';
  const savedRequests = [];
  const { document, window } = await startApp(t, 'http://localhost/#/review/repeated.md', {
    '/api/file': async () => ({
      path: 'repeated.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'repeated.md', comments: [] },
      reviewFile: '.review/repeated.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      if (body.path === 'repeated.md') savedRequests.push(body);
      return {
        review: { targetFile: body.path, comments: body.comments },
        reviewFile: '.review/repeated.md.review.json'
      };
    }
  });
  await waitFor(() => document.querySelectorAll('#markdown-content p').length === 2);

  window.Range.prototype.getBoundingClientRect = () => ({ left: 10, bottom: 20 });
  const secondText = document.querySelectorAll('#markdown-content p')[1].firstChild;
  const range = document.createRange();
  range.setStart(secondText, 7);
  range.setEnd(secondText, 10);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new window.Event('selectionchange'));
  document.querySelector('#selection-comment-button').click();

  const input = document.querySelector('#comment-input');
  input.value = 'Second の run を確認';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#comment-dialog form').requestSubmit();
  await waitFor(() => savedRequests.length === 1, 1600);

  const target = savedRequests[0].comments[0];
  assert.equal(target.selectedText, 'run');
  assert.match(target.contextBefore, /Second$/);
  assert.doesNotMatch(target.contextBefore, /First$/);
  assert.match(target.contextAfter, /^here/);
});

test('comments are separated by status and can be resolved or reopened', async (t) => {
  const markdown = '# Status review\n';
  const comments = [
    { id: 'comment-open', type: 'document', status: 'open', comment: '未対応の指摘' },
    { id: 'comment-resolved', type: 'document', status: 'resolved', comment: '対応済みの指摘' }
  ];
  const savedRequests = [];
  const { document } = await startApp(t, 'http://localhost/#/review/status.md', {
    '/api/file': async () => ({
      path: 'status.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'status.md', comments },
      reviewFile: '.review/status.md.review.json'
    }),
    '/api/review': async (_input, options) => {
      const body = JSON.parse(options.body);
      if (body.path === 'status.md') savedRequests.push(body);
      return {
        review: { targetFile: body.path, comments: body.comments },
        reviewFile: '.review/status.md.review.json'
      };
    }
  });
  await waitFor(() => document.querySelector('[data-comment-id="comment-open"]'));

  assert.equal(document.querySelector('.comment-group[data-status="open"] .comment-group-count').textContent, '1');
  assert.equal(document.querySelector('.comment-group[data-status="resolved"] .comment-group-count').textContent, '1');
  assert.match(document.querySelector('[data-comment-id="comment-open"]').textContent, /未解決/);
  assert.match(document.querySelector('[data-comment-id="comment-resolved"]').textContent, /解決済み/);

  document.querySelector('[data-comment-id="comment-open"] [data-action="onToggleStatus"]').click();
  assert.equal(document.querySelector('.comment-group[data-status="open"]'), null);
  assert.equal(document.querySelector('.comment-group[data-status="resolved"] .comment-group-count').textContent, '2');
  await waitFor(() => savedRequests.length === 1, 1600);
  assert.equal(savedRequests[0].comments[0].status, 'resolved');

  document.querySelector('[data-comment-id="comment-open"] [data-action="onToggleStatus"]').click();
  assert.equal(document.querySelector('.comment-group[data-status="open"] .comment-group-count').textContent, '1');
  await waitFor(() => savedRequests.length === 2, 1600);
  assert.equal(savedRequests[1].comments[0].status, 'open');
});

test('AI comment placement anchors a pasted note and only saves it once the reviewer adds it', async (t) => {
  const markdown = [
    '# 設計メモ',
    '',
    '## 背景',
    '',
    'この段落は冗長な説明を含みます。',
    '',
    '別の段落です。'
  ].join('\n');
  const savedRequests = [];
  const placementRequests = [];
  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fnote.md', {
    '/api/file': async () => ({
      path: 'docs/note.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/note.md', comments: [] },
      reviewFile: '.review/docs/note.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/place-comments': (_input, options) => {
      placementRequests.push([JSON.parse(options.body), options.headers]);
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          placements: [{
            comment: '冗長な説明を削ってほしい',
            reason: '該当する説明です',
            confidence: 'high',
            target: {
              type: 'text-selection',
              selectedText: '冗長な説明',
              contextBefore: '背景 この段落は',
              contextAfter: 'を含みます。',
              headingPath: ['設計メモ', '背景']
            }
          }],
          unplaced: [{ note: '全体的に長い', reason: '特定の箇所を選べません' }],
          droppedPlacements: 0
        }
      ]);
    },
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      savedRequests.push(body);
      return { review: { targetFile: 'docs/note.md', comments: body.comments }, reviewFile: '.review/docs/note.md.review.json' };
    }
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  document.querySelector('#placement-tab-button').click();
  assert.equal(document.querySelector('#placement-panel').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#comments-panel').classList.contains('hidden'), true);

  assert.equal(document.querySelector('#placement-submit-button').disabled, true, '指摘が空のうちは実行できない');
  const notes = document.querySelector('#placement-input');
  notes.value = '- 冗長な説明を削ってほしい\n- 全体的に長い';
  notes.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#placement-submit-button').disabled, false);
  document.querySelector('#placement-form').requestSubmit();
  await waitFor(() => document.querySelector('.placement-card'));

  assert.deepEqual(placementRequests[0][0], { path: 'docs/note.md', notes: '- 冗長な説明を削ってほしい\n- 全体的に長い' });
  assert.equal(placementRequests[0][1]['X-Review-Markdown-Token'], 'ui-ai-token');
  assert.equal(document.querySelector('.placement-card .target-badge').textContent, '範囲選択');
  assert.equal(document.querySelector('.placement-quote').textContent, '冗長な説明');
  assert.equal(document.querySelector('.placement-path').textContent, '設計メモ › 背景');
  assert.match(document.querySelector('.placement-unplaced').textContent, /全体的に長い/);
  assert.equal(document.querySelector('#comment-count').textContent, '0', '候補のうちはレビューに入らない');
  assert.equal(savedRequests.length, 0);

  // Before accepting, the reviewer can check where the proposal would land.
  document.querySelector('[data-placement-action="reveal"]').click();
  const revealed = document.querySelector('#markdown-content .reveal-flash');
  assert.match(revealed.textContent, /この段落は冗長な説明を含みます。/);
  assert.equal(window.getSelection().toString(), '冗長な説明');

  // The reviewer can reword the proposal before accepting it.
  const draft = document.querySelector('.placement-card textarea');
  draft.value = '冗長な説明を削ってください';
  draft.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('[data-placement-action="add"]').click();

  assert.equal(document.querySelector('#comment-count').textContent, '1');
  assert.equal(document.querySelector('.placement-card'), null, '追加した候補は一覧から消える');
  await waitFor(() => savedRequests.length === 1, 1600);
  assert.deepEqual(savedRequests[0].comments.map(({ comment, type, selectedText, source }) => (
    { comment, type, selectedText, source }
  )), [{
    comment: '冗長な説明を削ってください',
    type: 'text-selection',
    selectedText: '冗長な説明',
    source: 'ai'
  }]);

  document.querySelector('#comments-tab-button').click();
  assert.equal(document.querySelector('.comment-source').textContent, 'AI配置');
  assert.ok(
    document.querySelector('#markdown-content .comment-highlight-text'),
    '追加後は本文の対象箇所がハイライトされる'
  );
});

async function renderViews(markdown) {
  const options = {
    resolveLink: (href) => resolveDocumentLink(href, { relativeFile: 'docs/note.md' })
  };
  const [html, editableHtml] = await Promise.all([
    renderMarkdown(markdown, options),
    renderMarkdown(markdown, { ...options, editableBlocks: true })
  ]);
  return { html, editableHtml };
}

/** Boots public/app.js against a fresh jsdom with the given API responses. */
async function startApp(t, url, responses) {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, { url, pretendToBeVisual: true });
  const { window } = dom;

  installDomGlobals(window);
  const dialog = window.document.querySelector('#comment-dialog');
  // jsdom has no dialog implementation; the app only needs open/close bookkeeping.
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };

  globalThis.fetch = async (input, options = {}) => {
    const requested = String(input).split('?')[0];
    const handler = responses[requested];
    if (!handler) throw new Error(`Unexpected fetch: ${input}`);
    const result = await handler(input, options);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  t.after(() => window.close());
  await import(`${pathToFileURL(path.join(projectDir, 'public', 'app.js')).href}?ui-test=${Date.now()}-${Math.random()}`);
  return { document: window.document, window };
}

function ndjsonResponse(events) {
  return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' }
  });
}

function controlledNdjsonResponse() {
  const encoder = new TextEncoder();
  let controller;
  const response = new Response(new ReadableStream({
    start(streamController) {
      controller = streamController;
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' }
  });
  return {
    response,
    send(event) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    close() {
      controller.close();
    }
  };
}

function installDomGlobals(window) {
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.InputEvent = window.InputEvent;
  globalThis.Event = window.Event;
  globalThis.CSS = window.CSS;
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for DOM state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
