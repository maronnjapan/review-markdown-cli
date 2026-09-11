import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/markdown.js';

/**
 * 「保存した判断」の画面と、回答に付く根拠の表示です。
 *
 * 仕様1.3の3つ目（根拠の提示）と4つ目（訂正の反映）は、画面に出ていないと成立しません。
 * 根拠が見えなければ、誤った判断が回答を歪めていても気づけず、気づけなければ直せません。
 * だから、出ていることと、そこから直しに行けることをここで守ります。
 */

const projectDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');

test('保存した判断は、一覧から直せて消せる', async (t) => {
  const requests = [];
  const contexts = [{
    context_id: 'ctx_1',
    content: 'このプロジェクトではOIDCを利用する',
    scope: 'path',
    scope_path: 'docs',
    kind: 'decision',
    source_type: 'manual',
    updated_at: '2026-09-11T00:00:00.000Z'
  }];
  const { document, window } = await startApp(t, {
    '/api/saved-contexts': () => ({
      status: { configured: true, available: true, endpoint: 'http://127.0.0.1:8765', embedding: { label: 'ローカル計算' } },
      contexts
    }),
    '/api/saved-context': (_input, options) => {
      requests.push([options.method, JSON.parse(options.body)]);
      return { context: { ...contexts[0], content: '認証方式をSAMLへ変更した' } };
    }
  });

  await openToolPage(document, 'savedContext');
  await waitFor(() => document.querySelectorAll('.saved-context-card').length === 1);

  const card = document.querySelector('.saved-context-card');
  assert.equal(card.dataset.contextId, 'ctx_1');
  // どこで効くかは本文から読めないので、範囲と種類を必ず添えます。
  assert.equal(card.querySelector('.saved-context-kind').textContent, '決定');
  assert.equal(card.querySelector('.saved-context-scope').textContent, 'docs 以下');
  assert.equal(card.querySelector('.saved-context-content').textContent, 'このプロジェクトではOIDCを利用する');

  // 直す（仕様6.3の PATCH）。押した1件だけが入力欄へ変わります。
  card.querySelector('[data-context-edit]').click();
  const input = card.querySelector('[data-context-body]');
  assert.equal(input.value, 'このプロジェクトではOIDCを利用する');
  input.value = '認証方式をSAMLへ変更した';
  card.querySelector('[data-context-save]').click();
  await waitFor(() => requests.length === 1);
  assert.deepEqual(requests[0], ['PATCH', { contextId: 'ctx_1', content: '認証方式をSAMLへ変更した' }]);

  // 消す。確認してからにするので、断れば何も起きません。
  window.confirm = () => false;
  document.querySelector('[data-context-delete]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1, '確認を断ったら消さない');

  window.confirm = () => true;
  document.querySelector('[data-context-delete]').click();
  await waitFor(() => requests.length === 2);
  assert.deepEqual(requests[1], ['DELETE', { contextId: 'ctx_1' }]);
});

test('新しい判断は、効く範囲と種類を選んでから保存する', async (t) => {
  const requests = [];
  const { document } = await startApp(t, {
    '/api/saved-contexts': () => ({
      status: { configured: true, available: true, endpoint: 'http://127.0.0.1:8765' },
      contexts: []
    }),
    '/api/saved-context': (_input, options) => {
      requests.push(JSON.parse(options.body));
      return { context_id: 'ctx_new' };
    }
  });

  await openToolPage(document, 'savedContext');
  await waitFor(() => document.querySelector('#saved-context-form').classList.contains('hidden') === false);

  document.querySelector('#saved-context-input').value = 'Refresh TokenをAgentへ渡さない';
  document.querySelector('#saved-context-scope').value = 'path';
  document.querySelector('#saved-context-kind').value = 'decision';
  document.querySelector('#saved-context-form').dispatchEvent(new document.defaultView.Event('submit'));
  await waitFor(() => requests.length === 1);

  assert.deepEqual(requests[0], {
    content: 'Refresh TokenをAgentへ渡さない',
    scope: 'path',
    kind: 'decision',
    sourceType: 'manual',
    path: 'docs/note.md',
    sourcePath: 'docs/note.md'
  });
  assert.equal(document.querySelector('#saved-context-input').value, '', '保存したら欄は空になる');
});

test('預け先が止まっていれば、欄は出したまま、使えない理由と直し方を出す', async (t) => {
  const { document } = await startApp(t, {
    '/api/saved-contexts': () => ({
      status: { configured: true, available: false, endpoint: 'http://127.0.0.1:8765', error: 'fetch failed' },
      contexts: []
    })
  });

  await openToolPage(document, 'savedContext');
  await waitFor(() => document.querySelector('#saved-context-status').dataset.state === 'error');

  const status = document.querySelector('#saved-context-status').textContent;
  assert.match(status, /接続できません/);
  assert.match(status, /docker compose up -d/, '立ち上げるための1行を出す');
  assert.match(status, /ファイルの閲覧・編集・コメントはそのまま使えます/);
  // 欄ごと消すと、この機能があることも、いま使えないことも画面から分かりません。
  assert.equal(document.querySelector('#saved-context-panel').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#saved-context-form').classList.contains('hidden'), true, '押せる保存欄は出さない');
});

test('回答には、根拠にした判断と、渡したが使われなかった判断が付く', async (t) => {
  const conversation = {
    id: 'conversation-1',
    documentPath: 'docs/note.md',
    target: { type: 'document', headingPath: [] },
    messages: [
      { id: 'm1', role: 'user', content: 'このプロジェクトの認証方式って何？', createdAt: '2026-09-11T00:00:00.000Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'OIDCです[ctx_1]。',
        createdAt: '2026-09-11T00:00:01.000Z',
        context: {
          status: 'used',
          query: '認証方式 OIDC',
          evidence: [
            {
              contextId: 'ctx_1',
              content: 'このプロジェクトではOIDCを利用する',
              scope: 'workspace',
              kind: 'decision',
              cited: true
            },
            {
              contextId: 'ctx_2',
              content: '請求は月末締め',
              scope: 'path',
              scopePath: 'src/billing',
              kind: 'note',
              cited: false
            }
          ]
        }
      }
    ]
  };
  const { document, window } = await startApp(t, {
    '/api/ai/conversations': () => ({ conversations: [conversation] })
  });

  document.querySelector('#ai-tab-button').click();
  await waitFor(() => document.querySelectorAll('#ai-conversation-select option').length === 2);
  document.querySelector('#ai-conversation-select').value = 'conversation-1';
  document.querySelector('#ai-conversation-select').dispatchEvent(new window.Event('change'));
  await waitFor(() => document.querySelectorAll('.ai-message').length === 2);

  const evidence = document.querySelector('.ai-context-evidence[data-state="used"]');
  assert.ok(evidence, '根拠の欄が出る');
  assert.match(evidence.querySelector('.ai-context-evidence-label').textContent, /根拠にした判断 1件/);
  // 仕様7.3が求める3つ（context_id、本文の冒頭、範囲）が出ています。
  const cited = evidence.querySelector('.ai-evidence-item');
  assert.equal(cited.querySelector('.ai-evidence-id').textContent, 'ctx_1');
  assert.match(cited.querySelector('.ai-evidence-content').textContent, /OIDCを利用する/);
  assert.equal(cited.querySelector('.ai-evidence-scope').textContent, 'このWorkspace全体');
  // 「渡していない」と「渡したが効いていない」は別のことなので、分けて出します。
  assert.match(evidence.querySelector('.ai-context-evidence-rest summary').textContent, /使われなかった判断 1件/);

  // 根拠から訂正の画面へ行けます（仕様7.5の訂正の導線）。
  evidence.querySelector('[data-open-saved-context]').click();
  await waitFor(() => window.location.hash === '#/saved-context/docs%2Fnote.md');
});

test('引けなかった回答には、以前の決定と食い違っているかもしれないと出す', async (t) => {
  const conversation = {
    id: 'conversation-1',
    documentPath: 'docs/note.md',
    target: { type: 'document', headingPath: [] },
    messages: [
      { id: 'm1', role: 'user', content: '認証方式は？', createdAt: '2026-09-11T00:00:00.000Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: '一般には…',
        createdAt: '2026-09-11T00:00:01.000Z',
        context: { status: 'unavailable', error: 'Context API を利用できません' }
      }
    ]
  };
  const { document, window } = await startApp(t, { '/api/ai/conversations': () => ({ conversations: [conversation] }) });

  document.querySelector('#ai-tab-button').click();
  await waitFor(() => document.querySelectorAll('#ai-conversation-select option').length === 2);
  document.querySelector('#ai-conversation-select').value = 'conversation-1';
  document.querySelector('#ai-conversation-select').dispatchEvent(new window.Event('change'));
  await waitFor(() => document.querySelector('.ai-context-evidence[data-state="unavailable"]'));

  assert.match(
    document.querySelector('.ai-context-evidence[data-state="unavailable"]').textContent,
    /食い違っているかもしれません/
  );
});

test('保存した判断が1件も当たらなかったことも、回答に出す', async (t) => {
  const conversation = {
    id: 'conversation-1',
    documentPath: 'docs/note.md',
    target: { type: 'document', headingPath: [] },
    messages: [
      { id: 'm1', role: 'user', content: '認証方式は？', createdAt: '2026-09-11T00:00:00.000Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: '保存済みの決定は見つかりませんでした。',
        createdAt: '2026-09-11T00:00:01.000Z',
        context: { status: 'used', query: '認証方式' }
      }
    ]
  };
  const { document, window } = await startApp(t, { '/api/ai/conversations': () => ({ conversations: [conversation] }) });

  document.querySelector('#ai-tab-button').click();
  await waitFor(() => document.querySelectorAll('#ai-conversation-select option').length === 2);
  document.querySelector('#ai-conversation-select').value = 'conversation-1';
  document.querySelector('#ai-conversation-select').dispatchEvent(new window.Event('change'));
  await waitFor(() => document.querySelector('.ai-context-evidence[data-state="empty"]'));

  assert.match(
    document.querySelector('.ai-context-evidence[data-state="empty"]').textContent,
    /関係する判断は保存されていませんでした/
  );
});

test('コメントに混ざっていた決定は、押したときだけ判断へ移す', async (t) => {
  const comment = {
    id: 'comment-1',
    comment: '認証はOIDCで統一すると決めたので、ここもそろえてください。',
    status: 'open',
    target: { type: 'document', headingPath: [] }
  };
  const { document, window } = await startApp(t, {
    '/api/file': null,
    '/api/saved-contexts': () => ({
      status: { configured: true, available: true, endpoint: 'http://127.0.0.1:8765' },
      contexts: []
    })
  }, { comments: [comment] });

  await waitFor(() => document.querySelector('[data-action="onSaveContext"]'));
  document.querySelector('[data-action="onSaveContext"]').click();

  // 移すのは本文だけです。保存するかどうかは、移した先で本人が決めます（仕様4.4）。
  await waitFor(() => window.location.hash === '#/saved-context/docs%2Fnote.md');
  assert.equal(document.querySelector('#saved-context-input').value, comment.comment);
  assert.equal(document.querySelectorAll('.saved-context-card').length, 0, '押しただけでは保存しない');
});

test('AIパネルは、保存した判断も渡りうることを質問の前に言う', async (t) => {
  const { document } = await startApp(t, {
    '/api/saved-contexts': () => ({
      status: { configured: true, available: true, endpoint: 'http://127.0.0.1:8765' },
      contexts: []
    })
  });

  document.querySelector('#ai-tab-button').click();
  // 「新規」は、文書全体を対象にした会話の始まりです。何が渡るかはここから出ます。
  document.querySelector('#ai-new-conversation').click();
  await waitFor(() => document.querySelector('#ai-target-comments')?.textContent.includes('保存した判断'));
  // 件数は出しません。引くかどうかは質問ごとにAIが決めるので、渡る件数は質問の前に決まりません。
  assert.match(document.querySelector('#ai-target-comments').textContent, /質問に関係する「保存した判断」/);
});

/* ---------------------------------------------------------------- *
 * 道具
 * ---------------------------------------------------------------- */

async function startApp(t, responses = {}, { comments = [] } = {}) {
  const markdown = '# 設計メモ\n\n本文です。\n';
  const [html, editableHtml] = await Promise.all([
    renderMarkdown(markdown),
    renderMarkdown(markdown, { editableBlocks: true })
  ]);
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, { url: 'http://localhost/#/review/docs%2Fnote.md', pretendToBeVisual: true });
  const { window } = dom;

  installDomGlobals(window);
  for (const dialog of window.document.querySelectorAll('dialog')) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }

  const handlers = {
    '/api/files': () => ({ files: ['docs/note.md'] }),
    '/api/file': () => ({
      path: 'docs/note.md',
      markdown,
      html,
      editableHtml,
      review: { targetFile: 'docs/note.md', comments },
      features: { manager: false, translation: false },
      reviewFile: '.review/docs/note.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', label: 'Codex' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/review-skills': () => ({ skills: [] }),
    '/api/ai/reference-files': () => ({ files: [], total: 0 }),
    '/api/saved-contexts': () => ({ status: { configured: false, available: false, endpoint: null }, contexts: [] }),
    '/api/review': () => ({ saved: true }),
    // null を渡した口は、既定のまま使うという指定です（コメント付きで開くときなど）。
    ...Object.fromEntries(Object.entries(responses).filter(([, handler]) => handler))
  };

  globalThis.fetch = async (input, options = {}) => {
    const requested = String(input).split('?')[0];
    const handler = handlers[requested];
    if (!handler) throw new Error(`Unexpected fetch: ${input}`);
    const result = await handler(input, options);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  t.after(() => window.close());
  await import(`${pathToFileURL(path.join(projectDir, 'public', 'app.js')).href}?ui-test=${Date.now()}-${Math.random()}`);
  await waitFor(() => window.document.querySelector('#markdown-content h1'));
  return { document: window.document, window };
}

/** `test/reviewUiDom.test.js` と同じ並びです。画面側が素で触るものだけを渡します。 */
function installDomGlobals(window) {
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.InputEvent = window.InputEvent;
  globalThis.Event = window.Event;
  globalThis.CSS = window.CSS;
}

async function openToolPage(document, key) {
  const link = document.querySelector(`.side-pane-tools [data-tool-link="${key}"]`);
  assert.ok(link, `${key} の画面へのリンクが出ている`);
  assert.equal(link.classList.contains('hidden'), false, `${key} の画面へのリンクが押せる`);
  link.click();
  await waitFor(() => !document.querySelector('#tool-view').classList.contains('hidden'));
  return link;
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for DOM state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
