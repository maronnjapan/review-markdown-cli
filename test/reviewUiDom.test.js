import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { documentRevision } from '../src/documentEdits.js';
import { applyBlockEdits } from '../src/editorMarkdown.js';
import { resolveDocumentLink } from '../src/links.js';
import { parseMarkdownBlocks, renderMarkdown } from '../src/markdown.js';

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

test('the persistent review workspace exposes document tools, outline navigation, and mobile drawer controls', async (t) => {
  const markdown = '# 設計メモ\n\n## 背景\n\nレビュー対象です。\n';
  const comments = [{
    id: 'workspace-comment',
    type: 'paragraph',
    selectedText: 'レビュー対象です。',
    targetText: 'レビュー対象です。',
    comment: '確認してください',
    status: 'open'
  }];
  const { document, window } = await startApp(t, 'http://localhost/#/review/workspace.md', {
    '/api/file': async () => ({
      path: 'workspace.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'workspace.md', comments },
      reviewFile: '.review/workspace.md.review.json'
    })
  });
  await waitFor(() => document.querySelectorAll('.outline-item').length === 2);

  assert.ok(document.querySelector('.document-toolbar #document-title'), '文書名は追従ツールバー内にある');
  assert.deepEqual(
    [...document.querySelectorAll('.outline-item-label')].map((item) => item.textContent),
    ['設計メモ', '背景']
  );
  assert.equal(document.querySelector('#side-pane-toggle-count').textContent, '1');
  assert.equal(document.querySelector('#side-pane').getAttribute('aria-hidden'), 'true');

  document.querySelector('#side-pane-toggle').click();
  assert.equal(document.querySelector('#review-view').classList.contains('side-pane-open'), true);
  assert.equal(document.querySelector('#side-pane-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('#side-pane').hasAttribute('inert'), false);

  document.querySelector('#outline-tab-button').click();
  assert.equal(document.querySelector('#outline-panel').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#comments-panel').classList.contains('hidden'), true);
  document.querySelector('#outline-tab-button').dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'ArrowRight', bubbles: true
  }));
  assert.equal(document.querySelector('#comments-tab-button').getAttribute('aria-selected'), 'true');
  document.querySelector('#outline-tab-button').click();

  document.querySelector('#side-document-comment-button').click();
  assert.equal(document.querySelector('#comment-dialog').open, true);
  assert.equal(document.querySelector('#dialog-type-badge').textContent, '文書全体');
  document.querySelector('#cancel-dialog').click();

  document.querySelector('#side-pane-close').click();
  assert.equal(document.querySelector('#review-view').classList.contains('side-pane-open'), false);
  assert.equal(document.querySelector('#side-pane').getAttribute('aria-hidden'), 'true');

  document.querySelector('#side-pane-toggle').click();
  document.querySelector('#comments-tab-button').click();
  document.querySelector('[data-comment-id="workspace-comment"] .target-summary').click();
  const paragraph = [...document.querySelectorAll('#markdown-content p')]
    .find((element) => element.textContent.includes('レビュー対象です。'));
  assert.equal(paragraph.classList.contains('focused-review-target'), true, 'コメントから本文の対象へ戻れる');

  paragraph.querySelector('.inline-ai-button').click();
  assert.equal(document.querySelector('#ai-tab-button').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('#review-view').classList.contains('side-pane-open'), true);
});

test('the manager and translation controls stay hidden until the server enables them', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      features: { manager: false, translation: false },
      reviewFile: '.review/guide.md.review.json'
    })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-ai-button'));

  assert.equal(document.querySelector('#manager-tab-button').classList.contains('hidden'), true);
  assert.equal(document.querySelector('#tasks-tab-button').classList.contains('hidden'), true, '自動タスクも有効にするまで出ない');
  assert.equal(document.querySelector('#document-translate-button').classList.contains('hidden'), true);
  assert.equal(document.querySelector('#side-document-translate-button').classList.contains('hidden'), true);
  assert.equal(document.querySelector('#selection-translate-button').classList.contains('hidden'), true);
  assert.equal(document.querySelector('#markdown-content .inline-translate-button'), null);
  assert.equal(document.querySelector('#ai-tab-button').textContent, 'AI');
  assert.equal(document.querySelector('#review-brief-hint').hidden, true);
  assert.equal(
    document.querySelector('#workspace-brief').classList.contains('hidden'),
    true,
    'コンテキスト画面にも、保存できない3点の欄は出さない'
  );
});

test('設定から翻訳を有効にすると、開いている文書の翻訳ボタンがその場で出る', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const settings = {
    settings: { translation: false, aiReviewEffort: 'high' },
    features: { manager: false, translation: false },
    configPath: '/home/reviewer/.config/review-markdown/config.json',
    ai: {
      available: true,
      provider: 'codex',
      label: 'Codex',
      supportsEffort: true,
      efforts: ['none', 'low', 'high'],
      models: [{ id: 'fast-model' }, { id: 'deep-model' }],
      providers: [
        { id: 'codex', label: 'Codex', summary: 'Codex CLI', requires: 'codexへのログイン', active: true, command: 'review-markdown config set aiProvider codex --global' },
        { id: 'claude', label: 'Claude', summary: 'Anthropic Messages API', requires: '@anthropic-ai/sdk と資格情報', active: false, command: 'review-markdown config set aiProvider claude --global' }
      ],
      running: {
        assistant: { model: 'fast-model', effort: 'none' },
        review: { model: 'deep-model', effort: 'high' }
      }
    }
  };
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      features: { manager: false, translation: false },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', label: 'Codex' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/settings': (_input, options) => {
      if (!options.body) return settings;
      requests.push([JSON.parse(options.body), options.headers]);
      return {
        ...settings,
        settings: { translation: true, aiReviewModel: 'deep-model', aiReviewEffort: 'high' },
        features: { manager: false, translation: true },
        saved: {
          path: settings.configPath,
          shadowed: [{ key: 'translation', source: '今回の起動のコマンドライン指定' }],
          error: null
        }
      };
    }
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-ai-button'));
  assert.equal(document.querySelector('#markdown-content .inline-translate-button'), null);

  document.querySelector('#settings-button').click();
  await waitFor(() => document.querySelectorAll('#settings-ai-model option').length === 4);

  assert.equal(document.querySelector('#settings-dialog').open, true);
  assert.equal(document.querySelector('#settings-translation').checked, false);
  assert.equal(document.querySelector('#settings-provider').textContent, 'Codexで実行中');
  assert.deepEqual(
    [...document.querySelectorAll('#settings-ai-provider option')].map(
      (option) => [option.value, option.disabled]
    ),
    [['codex', false], ['claude', true]],
    '走らせていないAIも一覧に残し、選べない状態で出す'
  );
  assert.match(
    document.querySelector('#settings-ai-provider option[value="claude"]').textContent,
    /いまは選べません: @anthropic-ai\/sdk と資格情報/,
    '選べない理由は、その選択肢そのものに書く'
  );
  assert.match(
    document.querySelector('#settings-provider-hint').textContent,
    /config set aiProvider claude --global/,
    '選べるようにするための1行も出す'
  );
  assert.deepEqual(
    [...document.querySelectorAll('#settings-ai-model option')].map((option) => option.value),
    ['', 'fast-model', 'deep-model', '__custom__'],
    '選べるモデルを並べ、一覧に無い名前を書く道も残す'
  );
  assert.match(
    document.querySelector('#settings-ai-model option[value=""]').textContent,
    /自動で選ぶ（いまは fast-model）/,
    '名指ししていない用途でも、いま何で走っているかを書く'
  );
  assert.equal(
    document.querySelector('#settings-ai-model-running').textContent,
    '実行中: fast-model / none'
  );
  assert.equal(
    document.querySelector('#settings-ai-review-model-running').textContent,
    '実行中: deep-model / high'
  );
  assert.deepEqual(
    [...document.querySelectorAll('#settings-ai-effort option')].map((option) => option.value),
    ['', 'none', 'low', 'high']
  );
  assert.equal(document.querySelector('#settings-ai-review-effort').value, 'high', '設定済みの強度が選ばれている');
  assert.match(document.querySelector('#settings-model-hint').textContent, /選べるモデル: fast-model, deep-model/);
  assert.match(document.querySelector('#settings-save-target').textContent, /保存先: .*config\.json/);

  document.querySelector('#settings-translation').checked = true;
  document.querySelector('#settings-ai-review-model').value = 'deep-model';
  document.querySelector('#settings-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => requests.length === 1);
  await waitFor(() => document.querySelector('#markdown-content .inline-translate-button'));

  assert.deepEqual(requests[0][0], {
    translation: true,
    autoTasks: false,
    autoTasksInterval: '',
    // 何も設定していなければ全部に印が付いているので、全部を送ります。
    autoTasksActions: ['organize', 'focus', 'research', 'sample', 'inquiry'],
    autoTasksInstructions: '',
    aiEmptyTarget: 'document',
    aiModel: '',
    aiEffort: '',
    aiReviewModel: 'deep-model',
    aiReviewEffort: 'high'
  }, '「自動で選ぶ」は「設定しない」として送る');
  assert.equal(requests[0][1]['X-Review-Markdown-Token'], 'ui-ai-token');
  assert.equal(document.querySelector('#document-translate-button').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#selection-translate-button').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#ai-tab-button').textContent.trim(), '翻訳・AI');
  assert.match(
    document.querySelector('#settings-status').textContent,
    /次の起動では次の設定が優先されます: translation（今回の起動のコマンドライン指定）/,
    '保存しても次の起動で戻る設定は、そう言う'
  );
});

test('使えないモデルを選んだら、断られた理由を出したまま直せる', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      features: { manager: false, translation: false },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', label: 'Codex' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/settings': (_input, options) => {
      if (!options.body) {
        return {
          settings: { translation: false },
          features: { manager: false, translation: false },
          configPath: null,
          ai: { available: true, provider: 'codex', label: 'Codex', supportsEffort: false, models: [] }
        };
      }
      return new Response(
        JSON.stringify({ error: '設定したaiModel がCodexにありません: gpt-9-imaginary' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-ai-button'));

  document.querySelector('#settings-button').click();
  await waitFor(() => document.querySelector('#settings-save-target').textContent.includes('--no-config'));
  assert.equal(
    document.querySelector('#settings-ai-effort-field').classList.contains('hidden'),
    false,
    '推論強度を持たないAIでも、欄そのものは残す'
  );
  assert.equal(
    document.querySelector('#settings-ai-effort').disabled,
    true,
    '残したうえで、選べない状態にする'
  );
  assert.match(
    document.querySelector('#settings-ai-effort').textContent,
    /推論強度を受け付けません/,
    '選べない理由を欄の中に書く'
  );
  assert.match(document.querySelector('#settings-model-hint').textContent, /モデル名を書いてください/);
  assert.match(
    document.querySelector('#settings-ai-model option[disabled]').textContent,
    /モデル名を書いてください/,
    '一覧が空でも欄は残し、空である理由を選べない選択肢として出す'
  );

  const modelSelect = document.querySelector('#settings-ai-model');
  modelSelect.value = '__custom__';
  modelSelect.dispatchEvent(new window.Event('change'));
  assert.equal(document.querySelector('#settings-ai-model-custom').hidden, false, '選んだときだけ手入力が出る');
  document.querySelector('#settings-ai-model-custom').value = 'gpt-9-imaginary';
  document.querySelector('#settings-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => document.querySelector('#settings-error').hidden === false);

  assert.match(document.querySelector('#settings-error').textContent, /gpt-9-imaginary/);
  assert.equal(document.querySelector('#settings-dialog').open, true, '開いたままで直せる');
  assert.equal(
    document.querySelector('#settings-ai-model-custom').value,
    'gpt-9-imaginary',
    '書いた値も残る'
  );
  assert.equal(document.querySelector('#settings-save').disabled, false);
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

test('a question from the AI pane saves the comments first and says they are shared', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const conversation = {
    id: 'conversation-comment-context',
    documentPath: 'guide.md',
    title: 'Run the program.',
    target: { type: 'paragraph', selectedText: 'Run the program.' },
    messages: []
  };
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(['review', body]);
      return {
        review: {
          targetFile: 'guide.md',
          comments: body.comments.map((comment, index) => ({ ...comment, id: `comment-${index}` }))
        },
        reviewFile: '.review/guide.md.review.json'
      };
    },
    '/api/ai/status': () => ({
      token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model', effort: 'low'
    }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/conversation': (_input, options) => {
      requests.push(['conversation', JSON.parse(options.body)]);
      return { conversation };
    },
    '/api/ai/message': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(['message', body]);
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          conversation: {
            ...conversation,
            messages: [
              { id: 'user-1', role: 'user', content: body.message },
              { id: 'assistant-1', role: 'assistant', content: '前提条件を先に書くのが良さそうです。' }
            ]
          },
          message: { id: 'assistant-1', role: 'assistant', content: '前提条件を先に書くのが良さそうです。' }
        }
      ]);
    }
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  const paragraph = document.querySelector('#markdown-content p');
  paragraph.querySelector('.inline-comment-button').click();
  const commentInput = document.querySelector('#comment-input');
  commentInput.value = '実行の前提条件を書いてほしい';
  commentInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#comment-dialog form').requestSubmit();

  paragraph.querySelector('.inline-ai-button').click();
  assert.equal(document.querySelector('#ai-target-comments').hidden, false);
  assert.match(document.querySelector('#ai-target-comments').textContent, /コメント1件も渡します/);

  const input = document.querySelector('#ai-chat-input');
  input.value = 'この指摘にはどう答えるべき？';
  document.querySelector('#ai-chat-form').requestSubmit();
  await waitFor(() => document.querySelectorAll('.ai-message').length === 2);

  // 前のテストの自動保存（800ms）は、window.close のあとでもこのテストの fetch スタブへ届きます。
  // 順番を見るのはこの文書ぶんだけにします。
  const ours = requests.filter(([type, body]) => type !== 'review' || body.path === 'guide.md');
  assert.deepEqual(
    ours.map(([type]) => type),
    ['review', 'conversation', 'message'],
    'AIへ渡す前に、書いたばかりのコメントを保存する'
  );
  assert.equal(ours[0][1].comments[0].comment, '実行の前提条件を書いてほしい');

  // A comment added while the pane is open changes what the next question carries.
  paragraph.querySelector('.inline-comment-button').click();
  commentInput.value = '例を足してほしい';
  commentInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#comment-dialog form').requestSubmit();
  assert.match(document.querySelector('#ai-target-comments').textContent, /コメント2件も渡します/);
});

test('the reading context is editable, saved with the review, and announced to the AI pane', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [], aiContext: '第3章。読者は初学者。' },
      projectAiContext: '入門書の原稿。',
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return {
        review: { targetFile: 'guide.md', comments: body.comments || [], aiContext: body.aiContext },
        reviewFile: '.review/guide.md.review.json'
      };
    },
    '/api/ai/status': () => ({
      token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model', effort: 'low'
    }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  assert.equal(document.querySelector('#ai-context-input').value, '第3章。読者は初学者。');
  assert.equal(document.querySelector('#ai-context-state').textContent.trim(), 'このファイルのみ');
  assert.equal(document.querySelector('#ai-context-project').hidden, false);
  assert.equal(document.querySelector('#ai-context-project-text').textContent, '入門書の原稿。');
  assert.equal(document.querySelector('#placement-context-hint').hidden, false, '指摘の配置にも渡すと伝える');

  const contextInput = document.querySelector('#ai-context-input');
  contextInput.value = '第3章。読者は運用当番の担当者。';
  contextInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(document.querySelector('#ai-context-status').textContent, /自動保存待ち/);

  document.querySelector('#save-button').click();
  await waitFor(() => requests.length === 1);
  assert.equal(requests[0].aiContext, '第3章。読者は運用当番の担当者。');
  await waitFor(() => document.querySelector('#ai-context-status').dataset.state === 'saved');

  // The pane promises to say what a question carries; the context is part of it.
  document.querySelector('#markdown-content p .inline-ai-button').click();
  assert.match(document.querySelector('#ai-target-comments').textContent, /読み取りコンテキストも渡します/);
});

test('the reading context can be written for the whole directory instead of one file', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const { document, window } = await startApp(t, 'http://localhost/#/review/chapter3.md', {
    '/api/file': async () => ({
      path: 'chapter3.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'chapter3.md', comments: [], aiContext: '第3章。読者は初学者。' },
      directoryAiContext: 'この本は入門者向け。',
      directoryContextFile: '.review/context.json',
      reviewFile: '.review/chapter3.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      // 前のテストの自動保存もこのスタブへ届くので、この文書ぶんだけを見ます。
      if (body.path === 'chapter3.md') requests.push(['review', body]);
      return {
        review: { targetFile: body.path, comments: body.comments || [], aiContext: body.aiContext },
        reviewFile: '.review/chapter3.md.review.json'
      };
    },
    '/api/context/directory': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(['directory', body]);
      return { directoryAiContext: body.aiContext, directoryContextFile: '.review/context.json' };
    },
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: false, error: 'Codexへログインしてください' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  // 開いた直後は、そのファイルだけの前提を書く欄です。ディレクトリ全体の前提は下に見えます。
  const contextInput = document.querySelector('#ai-context-input');
  assert.equal(contextInput.value, '第3章。読者は初学者。');
  assert.equal(document.querySelector('#ai-context-state').textContent.trim(), 'このファイル＋ディレクトリ全体');
  assert.equal(document.querySelector('#ai-context-other').hidden, false);
  assert.equal(document.querySelector('#ai-context-other-text').textContent, 'この本は入門者向け。');

  // 範囲を切り替えると、欄の中身が入れ替わります。書いた前提はどちらも残ります。
  const directoryRadio = document.querySelector('#ai-context-scope input[value="directory"]');
  directoryRadio.checked = true;
  directoryRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(contextInput.value, 'この本は入門者向け。');
  assert.equal(document.querySelector('#ai-context-other-text').textContent, '第3章。読者は初学者。');
  // 選んだ範囲は、コンテキスト画面の同じ欄にも映ります。
  assert.equal(document.querySelector('#workspace-ai-context-input').value, 'この本は入門者向け。');
  assert.equal(
    document.querySelector('#workspace-ai-context-scope input[value="directory"]').checked,
    true,
    '2か所の欄が別々の範囲を書いていることはない'
  );

  contextInput.value = 'この本は入門者向け。用語は原著の訳語に合わせる。';
  contextInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(document.querySelector('#ai-context-status').textContent, /自動保存待ち/);

  document.querySelector('#save-button').click();
  await waitFor(() => requests.some(([type]) => type === 'directory') && requests.some(([type]) => type === 'review'));
  const [, directoryBody] = requests.find(([type]) => type === 'directory');
  assert.equal(directoryBody.aiContext, 'この本は入門者向け。用語は原著の訳語に合わせる。');
  const [, reviewBody] = requests.find(([type]) => type === 'review');
  assert.equal(reviewBody.aiContext, '第3章。読者は初学者。', 'ファイルごとの前提は書き換えない');
  await waitFor(() => document.querySelector('#ai-context-status').dataset.state === 'saved');
});

test('a document without a reading context says so and offers an empty box', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: false, error: 'Codexへログインしてください' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  assert.equal(document.querySelector('#ai-context-input').value, '');
  assert.equal(document.querySelector('#ai-context-state').textContent.trim(), '未設定');
  assert.equal(document.querySelector('#ai-context-project').hidden, true);
  assert.equal(document.querySelector('#placement-context-hint').hidden, true);
});

test('a note kept from a chat answer is saved with the review and travels with the next question', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const conversation = {
    id: 'conversation-context-note',
    documentPath: 'guide.md',
    title: 'Run the program.',
    target: { type: 'paragraph', selectedText: 'Run the program.' },
    messages: []
  };
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: {
        targetFile: 'guide.md',
        comments: [],
        contextNotes: [{
          id: 'note-saved',
          kind: 'constraint',
          body: '用語は原著の訳語に合わせる',
          source: 'reviewer',
          createdAt: '2026-08-01T00:00:00.000Z'
        }]
      },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return {
        review: { targetFile: 'guide.md', comments: body.comments || [], contextNotes: body.contextNotes },
        reviewFile: '.review/guide.md.review.json'
      };
    },
    '/api/ai/status': () => ({
      token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model', effort: 'low'
    }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/conversation': () => ({ conversation }),
    '/api/ai/message': (_input, options) => {
      const body = JSON.parse(options.body);
      const answer = '節の並び順は前の版から引き継いだもので、意図があります。';
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          conversation: {
            ...conversation,
            messages: [
              { id: 'user-1', role: 'user', content: body.message },
              { id: 'assistant-1', role: 'assistant', content: answer }
            ]
          },
          message: { id: 'assistant-1', role: 'assistant', content: answer }
        }
      ]);
    }
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  // 保存済みのメモは、開いた時点で一覧と要約に出ます。
  assert.equal(document.querySelector('#context-notes-state').textContent.trim(), '1件');
  assert.equal(document.querySelector('.context-note-kind').textContent, '制約');
  assert.match(document.querySelector('.context-note-body').textContent, /原著の訳語/);
  assert.equal(document.querySelector('#review-context-hint').hidden, false, 'AIレビューにも効くと言う');

  // 相談し、返ってきた答えをメモの下書きにします。
  const paragraph = document.querySelector('#markdown-content p');
  paragraph.querySelector('.inline-ai-button').click();
  assert.match(document.querySelector('#ai-target-comments').textContent, /コンテキストメモ1件も渡します/);

  const input = document.querySelector('#ai-chat-input');
  input.value = 'この節の並びは変では？';
  document.querySelector('#ai-chat-form').requestSubmit();
  await waitFor(() => document.querySelector('.ai-message[data-role="assistant"] .ai-message-keep'));

  document.querySelector('.ai-message[data-role="assistant"] .ai-message-keep').click();
  assert.equal(document.querySelector('#context-notes').open, true, 'メモの欄を開いて見せる');
  assert.match(document.querySelector('#context-note-input').value, /前の版から引き継いだ/);

  // 前提として残す形へ直し、種類を決めて残します。
  const noteInput = document.querySelector('#context-note-input');
  noteInput.value = '節の並び順は前の版から引き継いだもの。変えない。';
  noteInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  const kind = document.querySelector('#context-note-kind');
  kind.value = 'decision';
  kind.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(document.querySelector('#context-note-kind-hint').textContent, /蒸し返しません/);
  document.querySelector('#context-note-form').requestSubmit();

  assert.equal(document.querySelector('#context-notes-state').textContent.trim(), '2件');
  // メモの一覧はサイドパネルとコンテキスト画面の2か所に出るので、片方を数えます。
  assert.equal(
    document.querySelectorAll('#context-notes-list .context-note-source').length,
    1,
    '相談から残したメモには出どころが付く'
  );
  assert.match(document.querySelector('#ai-target-comments').textContent, /コンテキストメモ2件も渡します/);

  document.querySelector('#save-button').click();
  await waitFor(() => requests.some((body) => Array.isArray(body.contextNotes)));
  const saved = requests.at(-1).contextNotes;
  assert.deepEqual(saved.map(({ kind: noteKind, body }) => [noteKind, body]), [
    ['constraint', '用語は原著の訳語に合わせる'],
    ['decision', '節の並び順は前の版から引き継いだもの。変えない。']
  ], '残した順のまま保存する');
  assert.equal(saved[1].source, 'chat');

  // 消すのは2段階です。一覧から黙って消えないようにします。
  document.querySelector('[data-note-delete]').click();
  assert.match(document.querySelector('.context-note-confirm').textContent, /削除しますか/);
  document.querySelector('[data-note-confirm-delete]').click();
  assert.equal(document.querySelector('#context-notes-state').textContent.trim(), '1件');
});

test('添えた参照ファイルは前提として渡り、レビューファイルへ保存される', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const { document, window } = await startApp(t, 'http://localhost/#/review/docs/guide.md', {
    '/api/file': async () => ({
      path: 'docs/guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/guide.md', comments: [], referenceFiles: ['docs/glossary.md'] },
      reviewFile: '.review/docs/guide.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return {
        review: { targetFile: 'docs/guide.md', comments: body.comments || [], referenceFiles: body.referenceFiles },
        reviewFile: '.review/docs/guide.md.review.json'
      };
    },
    '/api/ai/status': () => ({
      token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model', effort: 'low'
    }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/reference-files': () => ({
      base: 'docs',
      total: 3,
      // サーバーはパスの順に並べて返します（`src/referenceFiles.js`）。
      files: [
        { path: 'docs/glossary.md', kind: 'text' },
        { path: 'docs/notes/history.md', kind: 'text' },
        { path: 'docs/spec.pdf', kind: 'pdf' }
      ]
    })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  // 保存済みの添付は、開いた時点で一覧と要約に出ます。
  assert.equal(document.querySelector('#reference-files-state').textContent.trim(), '1件');
  assert.equal(document.querySelector('.reference-file-path').textContent, 'docs/glossary.md');

  // 選択欄は一覧が届いてから埋まります。すでに添えたファイルは出しません。
  await waitFor(() => document.querySelector('#reference-file-select option[value="docs/spec.pdf"]'));
  const options = [...document.querySelectorAll('#reference-file-select option')].map((node) => node.value);
  assert.deepEqual(options, ['docs/notes/history.md', 'docs/spec.pdf'], '添えたものは選択欄から外す');
  assert.match(
    document.querySelector('#reference-file-select option[value="docs/spec.pdf"]').textContent,
    /（PDF）/,
    'PDFはそうと分かるように出す'
  );
  // 一覧はサイドパネル・コンテキスト画面・AIレビューの3か所に出ますが、取りに行くのは1回だけです。
  assert.equal(
    document.querySelectorAll('#workspace-reference-file-select option').length,
    2,
    'もう一方の画面にも同じ一覧が出る'
  );
  assert.equal(
    document.querySelectorAll('#review-reference-file-select option').length,
    2,
    'AIレビューのパネルからも、同じ一覧から添えられる'
  );
  assert.equal(
    document.querySelector('#review-reference-files-state').textContent.trim(),
    '1件',
    '添えてあるものは、レビューを実行する画面にも出る'
  );

  // 絞り込みは選択欄だけを狭めます。
  const filter = document.querySelector('#reference-file-filter');
  filter.value = 'spec';
  filter.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(
    [...document.querySelectorAll('#reference-file-select option')].map((node) => node.value),
    ['docs/spec.pdf']
  );

  // 添えるのはAIレビューのパネルからでもできます。決めた1組はどの画面でも同じです。
  document.querySelector('#review-reference-file-select').value = 'docs/spec.pdf';
  document.querySelector('#review-reference-file-form').requestSubmit();

  assert.equal(document.querySelector('#reference-files-state').textContent.trim(), '2件');
  assert.equal(document.querySelector('#review-reference-files-state').textContent.trim(), '2件');
  assert.deepEqual(
    [...document.querySelectorAll('#review-reference-files-list .reference-file-path')]
      .map((node) => node.textContent),
    ['docs/glossary.md', 'docs/spec.pdf']
  );
  const paragraph = document.querySelector('#markdown-content p');
  paragraph.querySelector('.inline-ai-button').click();
  assert.match(
    document.querySelector('#ai-target-comments').textContent,
    /参照ファイル2件の中身も渡します/,
    '質問を投げる前に、何が渡るかを言う'
  );

  document.querySelector('#save-button').click();
  await waitFor(() => requests.some((body) => Array.isArray(body.referenceFiles)));
  assert.deepEqual(requests.at(-1).referenceFiles, ['docs/glossary.md', 'docs/spec.pdf']);

  // 外すと次のAI操作からは読ませません。
  document.querySelector('[data-reference-detach="docs/glossary.md"]').click();
  assert.equal(document.querySelector('#reference-files-state').textContent.trim(), '1件');
  assert.deepEqual(
    [...document.querySelectorAll('#reference-files-list .reference-file-path')].map((node) => node.textContent),
    ['docs/spec.pdf']
  );
});

test('a note written while a save is in flight is still saved', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  let releaseFirstSave;
  const firstSaveHeld = new Promise((resolve) => { releaseFirstSave = resolve; });
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/review': async (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      // 1件目だけを載せた保存を握ったまま、その最中にもう1件残させます。
      // 何件目かで見分けると、前のテストから漏れてきた保存を自分のものと取り違えます。
      if (sentNote(body, '1件目のメモ') && !sentNote(body, '2件目のメモ')) await firstSaveHeld;
      return {
        review: { targetFile: 'guide.md', comments: body.comments || [], contextNotes: body.contextNotes },
        reviewFile: '.review/guide.md.review.json'
      };
    },
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: false, error: 'Codexを利用できません' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  const keep = (text) => {
    const input = document.querySelector('#context-note-input');
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.querySelector('#context-note-form').requestSubmit();
  };

  keep('1件目のメモ');
  document.querySelector('#save-button').click();
  await waitFor(() => requests.some((body) => sentNote(body, '1件目のメモ')), 3000);

  // 保存の返事を待っている間に、もう1件残します。
  keep('2件目のメモ');
  releaseFirstSave();

  // 件数ではなく中身で待ちます。前のテストが残した自動保存が混ざることがあるためです。
  const bothKept = (body) => sentNote(body, '1件目のメモ') && sentNote(body, '2件目のメモ');
  await waitFor(() => requests.some(bothKept), 3000);
  const saved = requests.find(bothKept).contextNotes;
  assert.deepEqual(
    saved.map(({ body }) => body),
    ['1件目のメモ', '2件目のメモ'],
    '保存中に残したメモも、続く保存で必ずサーバーへ届く'
  );
});

test('what the reviewer wrote in the AI pane is saved before leaving a document in edit mode', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/files': () => ({ rootDir: '/tmp/book', files: ['guide.md'], filters: { include: [], exclude: [] } }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return {
        review: { targetFile: 'guide.md', comments: body.comments || [], contextNotes: body.contextNotes },
        reviewFile: '.review/guide.md.review.json'
      };
    },
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: false, error: 'Codexを利用できません' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  // 編集モードでも、AIパネルの欄は使えます。
  document.querySelector('#edit-mode-button').click();
  const input = document.querySelector('#context-note-input');
  input.value = '本文を直しながら気づいたこと';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#context-note-form').requestSubmit();

  // 自動保存(800ms)を待たずに一覧へ戻る。
  document.querySelector('#back-button').click();
  await waitFor(() => requests.some((body) => (body.contextNotes || []).length === 1), 3000);
  assert.equal(requests.at(-1).contextNotes[0].body, '本文を直しながら気づいたこと');
  // 一覧の描画まで待ってから終わります。待たずに窓を閉じると、描画の途中で落ちます。
  await waitFor(() => document.querySelector('.file-tree'), 3000);
});

test('the notes pane stays quiet about a save it had nothing in, and says the right thing after an edit', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: {
        targetFile: 'guide.md',
        comments: [],
        contextNotes: [{ id: 'note-a', kind: 'decision', body: '決めたこと', createdAt: '2026-08-01T00:00:00.000Z' }]
      },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      return {
        review: { targetFile: 'guide.md', comments: body.comments || [], contextNotes: body.contextNotes },
        reviewFile: '.review/guide.md.review.json'
      };
    },
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: false, error: 'Codexを利用できません' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  // メモには触らずコメントだけ保存する。メモ欄は何も言わない。
  document.querySelector('#markdown-content p .inline-comment-button').click();
  const commentInput = document.querySelector('#comment-input');
  commentInput.value = '根拠を足してほしい';
  commentInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#comment-dialog form').requestSubmit();
  document.querySelector('#save-button').click();
  await waitFor(() => document.querySelector('#save-status').dataset.state === 'saved', 3000);
  assert.equal(document.querySelector('#context-notes-status').textContent, '', 'メモを送っていない保存で「保存しました」と言わない');

  // 既存のメモを直すと、増やしたのではなく直したと言う。
  document.querySelector('[data-note-edit]').click();
  assert.equal(document.querySelector('#context-note-submit').textContent, 'このメモを直す');
  const noteInput = document.querySelector('#context-note-input');
  noteInput.value = '決めたこと（言い直した）';
  noteInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#context-note-form').requestSubmit();

  assert.match(document.querySelector('#toast-region').textContent, /メモを直しました/);
  assert.equal(document.querySelector('#context-notes-state').textContent.trim(), '1件', '直しても件数は増えない');
});

test('at the limit the notes pane stops before the reviewer writes, but still lets them fix a note', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const contextNotes = Array.from({ length: 20 }, (_, index) => ({
    id: `note-${index}`, kind: 'background', body: `メモ${index}`, createdAt: '2026-08-01T00:00:00.000Z'
  }));
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [], contextNotes },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: false, error: 'Codexを利用できません' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  assert.equal(document.querySelector('#context-notes-state').textContent.trim(), '20件');
  assert.equal(document.querySelector('#context-note-full').hidden, false, '上限に達したと先に言う');
  const input = document.querySelector('#context-note-input');
  input.value = '21件目';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#context-note-submit').disabled, true, '書いてから断るのではなく、押せなくする');

  // 上限は「増やせない」であって「直せない」ではない。
  document.querySelector('[data-note-edit]').click();
  assert.equal(document.querySelector('#context-note-full').hidden, true, '編集中に上限の注意は出さない');
  assert.equal(document.querySelector('#context-note-submit').disabled, false);
});

test('a document with no context notes says so and still offers the form', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const { document } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: false, error: 'Codexへログインしてください' }),
    '/api/ai/conversations': () => ({ conversations: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content p .inline-comment-button'));

  assert.equal(document.querySelector('#context-notes-state').textContent.trim(), '未設定');
  assert.equal(document.querySelector('#context-note-submit').disabled, true, '本文が空のうちは残せない');
  assert.equal(document.querySelector('#review-context-hint').hidden, true);
  assert.equal(document.querySelector('#placement-context-hint').hidden, true);
  assert.match(document.querySelector('#context-notes-list').textContent, /まだメモはありません/);
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

test('clicking a commented place brings up the comment that was written there', async (t) => {
  const markdown = [
    '# 設計メモ',
    '',
    '## 背景',
    '',
    'この段落はレビュー対象です。',
    '',
    '別の段落です。'
  ].join('\n');
  const comments = [
    {
      id: 'comment-paragraph',
      type: 'paragraph',
      selectedText: 'この段落はレビュー対象です。',
      targetText: 'この段落はレビュー対象です。',
      status: 'open',
      comment: '根拠を足してほしい'
    },
    {
      id: 'comment-selection-open',
      type: 'text-selection',
      selectedText: '別の段落',
      contextAfter: 'です。',
      status: 'open',
      comment: '言い換えたい'
    },
    {
      id: 'comment-selection-resolved',
      type: 'text-selection',
      selectedText: '別の段落',
      contextAfter: 'です。',
      status: 'resolved',
      comment: '前に見た指摘'
    }
  ];
  const savedRequests = [];
  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fnote.md', {
    '/api/file': async () => ({
      path: 'docs/note.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/note.md', comments },
      reviewFile: '.review/docs/note.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      savedRequests.push(body);
      return {
        review: { targetFile: body.path, comments: body.comments },
        reviewFile: '.review/docs/note.md.review.json'
      };
    }
  });
  await waitFor(() => document.querySelector('#markdown-content .comment-highlight-text'));
  const revealed = () => [...document.querySelectorAll('.comment-card.revealed')].map((card) => card.dataset.commentId);

  const paragraph = document.querySelector('#markdown-content .comment-highlight-target');
  assert.match(paragraph.textContent, /この段落はレビュー対象です。/);
  const marker = paragraph.querySelector('.comment-marker');
  assert.equal(marker.textContent, '1件');
  assert.equal(marker.getAttribute('aria-label'), 'コメントを確認: 根拠を足してほしい');

  const mark = document.querySelector('#markdown-content .comment-highlight-text');
  assert.equal(mark.textContent, '別の段落');
  assert.equal(mark.title, 'コメント2件を確認', '同じ範囲の2件は1つのハイライトにまとまる');

  // Reading a comment starts from the document, so the click brings the pane back.
  document.querySelector('#placement-tab-button').click();
  assert.equal(document.querySelector('#comments-panel').classList.contains('hidden'), true);

  paragraph.click();
  assert.equal(document.querySelector('#comments-panel').classList.contains('hidden'), false);
  assert.deepEqual(revealed(), ['comment-paragraph']);

  mark.click();
  assert.deepEqual(
    revealed(),
    ['comment-paragraph', 'comment-selection-open', 'comment-selection-resolved'],
    '同じ範囲のコメントは解決済みも含めて出す'
  );

  // The marker is an affordance, not text: what a new comment records is unchanged.
  paragraph.querySelector('.inline-comment-button').click();
  assert.equal(document.querySelector('#dialog-target-quote').textContent, 'この段落はレビュー対象です。');
  document.querySelector('#cancel-dialog').click();

  document.querySelector('#placement-tab-button').click();
  mark.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(document.querySelector('#comments-panel').classList.contains('hidden'), false, 'キーボードでも開ける');

  // Re-rendering the comment list must not leave a second marker on the block.
  document.querySelector('[data-comment-id="comment-paragraph"] [data-action="onToggleStatus"]').click();
  assert.equal(document.querySelectorAll('#markdown-content .comment-marker').length, 1);
  paragraph.click();
  assert.ok(document.querySelector('[data-comment-id="comment-paragraph"]').classList.contains('revealed'));
  await waitFor(() => savedRequests.length === 1, 1600);
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

test('an AI review runs with the chosen skills and the reader the AI rebuilt from the reviewer\'s notes', async (t) => {
  const markdown = [
    '# デプロイ手順',
    '',
    '## 手順',
    '',
    'まず deploy.sh を実行します。'
  ].join('\n');
  const savedRequests = [];
  const personaRequests = [];
  const reviewRequests = [];
  const skillDetailRequests = [];
  // レビューは2周するので、途中でどちらを読んでいるかが画面へ出る。1つずつ流して確かめる。
  const reviewStream = controlledNdjsonResponse();
  const reviewComment = [
    '実行前に確認することを書いてください',
    '影響: この読み手は、実行してよい状態かを判断できません',
    '直し方: 「稼働中のジョブを確認する」を手順の前に足してください'
  ].join('\n');
  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fnote.md', {
    '/api/file': async () => ({
      path: 'docs/note.md',
      markdown,
      ...await renderViews(markdown),
      // 管理者の3点は決まっている文書。揃っていないときに止まることは別のテストで確かめる。
      review: {
        targetFile: 'docs/note.md',
        comments: [],
        brief: {
          purpose: '当番が手順書だけで再起動を完了できるようになる。',
          story: '止めてよい条件 → 止める手順 → 戻ったことの確かめ方。',
          expectation: '再起動についての問い合わせが来なくなる。'
        }
      },
      reviewFile: '.review/docs/note.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/review-skills': () => ({
      skills: [
        { id: 'reader-fit-review', name: '読み手適合レビュー', description: '読み手に届くかを見る。', source: 'builtin' },
        { id: 'ops-review', name: '運用レビュー', description: '当番が実行できるかを見る。', source: 'project' }
      ]
    }),
    '/api/ai/review-skill': (input) => {
      skillDetailRequests.push(new URL(input, 'http://localhost').searchParams.get('id'));
      return {
        skill: {
          id: 'ops-review',
          name: '運用レビュー',
          source: 'project',
          instructions: '# 運用レビュー\n\n1. 開始条件が書かれているか',
          references: [{ name: 'checklist.md', text: '# 確認するもの\n\n- 稼働中のジョブ', truncated: false }]
        }
      };
    },
    '/api/ai/persona': (_input, options) => {
      personaRequests.push(JSON.parse(options.body));
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          persona: {
            label: '運用当番の新人',
            background: '異動したての運用担当。',
            knowledge: ['Linuxの基本操作'],
            gaps: ['この製品の構成'],
            goals: ['当番中に手順どおり作業する'],
            concerns: ['危険な操作を踏まないか'],
            summary: '製品は初めての運用担当。',
            assumptions: ['「新人」から経験1年未満と想定しました'],
            input: '異動したての運用担当。Linuxは触れる。'
          }
        }
      ]);
    },
    '/api/ai/review': (_input, options) => {
      reviewRequests.push(JSON.parse(options.body));
      return reviewStream.response;
    },
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      savedRequests.push(body);
      return {
        review: { targetFile: 'docs/note.md', comments: body.comments || [], persona: body.persona },
        reviewFile: '.review/docs/note.md.review.json'
      };
    }
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  document.querySelector('#review-tab-button').click();
  assert.equal(document.querySelector('#review-panel').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#comments-panel').classList.contains('hidden'), true);

  const skillList = document.querySelector('#review-skill-list');
  await waitFor(() => skillList.querySelectorAll('input[data-skill-id]').length === 2);
  const skillNames = () => [...skillList.querySelectorAll('.review-skill-choice')].map((label) => label.textContent.trim().replace(/\s+/g, ' '));
  assert.deepEqual(skillNames(), ['読み手適合レビュー 標準', '運用レビュー']);
  assert.deepEqual([...skillList.querySelectorAll('.review-skill-description')].map((node) => node.textContent),
    ['読み手に届くかを見る。', '当番が実行できるかを見る。']);
  assert.equal(document.querySelector('#review-skill-state').textContent, '1個選択中', '最初のスキルは選ばれている');

  // どの観点で読むスキルなのかは、選ぶ前に画面のなかで開いて確かめられる。
  skillList.querySelector('[data-skill-detail="ops-review"]').click();
  await waitFor(() => document.querySelector('.review-skill-detail')?.textContent.includes('開始条件'));
  assert.deepEqual(skillDetailRequests, ['ops-review']);
  // 参照ファイルもプロンプトへ載るので、選ぶ前に本文と同じ場所で読める。
  assert.equal(document.querySelector('.review-skill-reference').textContent, 'references/checklist.md');
  assert.match(document.querySelectorAll('.review-skill-detail')[1].textContent, /稼働中のジョブ/);
  skillList.querySelector('[data-skill-detail="ops-review"]').click();
  assert.equal(document.querySelector('.review-skill-detail'), null, 'もう一度押すと閉じる');

  // スキルは複数選べる。選んだ順にレビューへ渡す。
  const opsCheckbox = skillList.querySelector('input[data-skill-id="ops-review"]');
  opsCheckbox.checked = true;
  opsCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('#review-skill-state').textContent, '2個選択中');

  // 読み手は走り書きのまま渡し、AIが組み直したものを画面で確かめてから使う。
  assert.equal(document.querySelector('#persona-state').textContent, '未設定');
  assert.equal(document.querySelector('#review-run-hint').classList.contains('hidden'), false,
    '読み手を決めないまま実行できるが、何が変わるかは実行前に言う');
  assert.equal(document.querySelector('#persona-compose-button').disabled, true, '説明が空のうちは組み立てられない');
  const personaInput = document.querySelector('#persona-input');
  personaInput.value = '異動したての運用担当。Linuxは触れる。';
  personaInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#persona-compose-button').disabled, false);
  document.querySelector('#persona-form').requestSubmit();
  await waitFor(() => document.querySelector('.persona-card'));

  assert.deepEqual(personaRequests, [{ path: 'docs/note.md', input: '異動したての運用担当。Linuxは触れる。' }]);
  assert.match(document.querySelector('.persona-card h3').textContent, /^運用当番の新人AIが組み立て$/);
  assert.match(document.querySelector('.persona-card').textContent, /この製品の構成/);
  assert.match(document.querySelector('.persona-assumptions').textContent, /経験1年未満/, 'AIが補った前提は隠さない');
  assert.equal(document.querySelector('#persona-state').textContent, '設定済み');
  assert.equal(document.querySelector('#persona-compose-button').textContent, 'AIで組み直す');
  assert.equal(document.querySelector('#review-run-hint').classList.contains('hidden'), true);


  // 組み直したペルソナはコメントと同じ自動保存でレビューファイルへ入る。
  await waitFor(() => savedRequests.length === 1, 1600);
  assert.equal(savedRequests[0].persona.label, '運用当番の新人');

  // 読み手が既に固まっているなら、AIに組み直させずそのまま使える。
  personaInput.value = '当番の新人。\nこの製品は初めて。';
  personaInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#persona-use-button').click();
  assert.match(document.querySelector('.persona-card h3').textContent, /^当番の新人。そのまま使用$/);
  assert.equal(document.querySelector('.persona-notes').textContent, '当番の新人。\nこの製品は初めて。');
  assert.equal(document.querySelector('#persona-compose-button').textContent, 'AIで組み立てる');
  assert.equal(personaRequests.length, 1, 'そのまま使うときはAIを呼ばない');
  await waitFor(() => savedRequests.some((request) => request.persona?.source === 'manual'), 1600);

  // 3点が決まっているので、管理者は止めない。
  assert.equal(document.querySelector('#review-brief-hint').hidden, true);
  assert.equal(document.querySelector('#review-run-button').textContent, 'レビューを実行');
  document.querySelector('#review-form').requestSubmit();
  await waitFor(() => reviewRequests.length === 1);

  // 待たせている間、どちらの読みで待たせているかを出す。
  reviewStream.send({ type: 'started' });
  reviewStream.send({ type: 'phase', phase: 'reading' });
  await waitFor(() => document.querySelector('#review-results .ai-loading')?.textContent === 'レビュー中…');
  reviewStream.send({ type: 'phase', phase: 'verifying' });
  await waitFor(() => document.querySelector('#review-results .ai-loading')?.textContent.includes('検証中'));
  reviewStream.send({
    type: 'result',
    skills: [
      { id: 'reader-fit-review', name: '読み手適合レビュー', source: 'builtin' },
      { id: 'ops-review', name: '運用レビュー', source: 'project' }
    ],
    persona: { label: '運用当番の新人' },
    summary: 'この読み手には実行前の前提が足りません。',
    verified: true,
    refuted: 2,
    placements: [{
      comment: reviewComment,
      reason: 'この読み手は製品を知らないためです',
      skill: { id: 'ops-review', name: '運用レビュー' },
      severity: 'must',
      confidence: 'high',
      target: {
        type: 'text-selection',
        selectedText: 'deploy.sh',
        contextBefore: '手順 まず',
        contextAfter: 'を実行します。',
        headingPath: ['デプロイ手順', '手順']
      }
    }],
    unplaced: [{ note: '章の冒頭に前提をまとめてほしい', reason: '特定の段落に結び付かないためです' }],
    droppedPlacements: 0
  });
  reviewStream.close();
  await waitFor(() => document.querySelector('.placement-card'));

  assert.deepEqual(reviewRequests, [{ path: 'docs/note.md', skillIds: ['reader-fit-review', 'ops-review'] }]);
  assert.match(document.querySelector('.review-summary').textContent, /実行前の前提が足りません/);
  assert.match(document.querySelector('.review-verification').textContent, /根拠の弱い2件を取り下げました/,
    'どれだけ絞り込まれた指摘なのかが分からないと、レビュアーは結局全部読み直す');
  assert.equal(document.querySelector('#review-results textarea').rows, 3,
    '依頼・影響・直し方が採用する前に読める高さで出る');
  assert.equal(document.querySelector('.placement-severity').textContent, '要対応');
  assert.equal(document.querySelector('#review-results .placement-skill').textContent, '運用レビュー',
    'どの観点から出た指摘かは候補のうちから分かる');
  assert.equal(document.querySelector('#review-results .placement-quote').textContent, 'deploy.sh');
  assert.match(document.querySelector('#review-results .placement-unplaced').textContent, /章の冒頭に前提をまとめてほしい/);
  assert.equal(document.querySelector('#comment-count').textContent, '0', '候補のうちはレビューに入らない');

  document.querySelector('#review-results [data-placement-action="add"]').click();
  assert.equal(document.querySelector('#comment-count').textContent, '1');
  await waitFor(() => savedRequests.at(-1)?.comments?.length === 1, 1600);
  assert.deepEqual(savedRequests.at(-1).comments.map(({ comment, selectedText, source, review }) => (
    { comment, selectedText, source, review }
  )), [{
    comment: reviewComment,
    selectedText: 'deploy.sh',
    source: 'ai-review',
    review: {
      skillId: 'ops-review',
      skillName: '運用レビュー',
      persona: '運用当番の新人',
      severity: 'must',
      reason: 'この読み手は製品を知らないためです'
    }
  }]);

  // レビューされた部分は、コメント一覧からそのまま読める。
  document.querySelector('#comments-tab-button').click();
  assert.equal(document.querySelector('.comment-source').textContent, 'AIレビュー');
  assert.equal(document.querySelector('.comment-reviewed-quote').textContent, 'deploy.sh');
  assert.match(document.querySelector('.comment-reviewed-meta').textContent, /スキル: 運用レビュー/);
  assert.match(document.querySelector('.comment-reviewed-meta').textContent, /読み手: 運用当番の新人/);
  assert.match(document.querySelector('.comment-reviewed-meta').textContent, /重大度: 要対応/);
  assert.match(document.querySelector('.comment-reviewed-reason').textContent, /製品を知らない/);
});

test('an AI body revision is shown next to the current text and only written once the reviewer allows it', async (t) => {
  const markdown = [
    '# 設計メモ',
    '',
    '## 背景',
    '',
    'この段落は冗長な説明を含みます。',
    '',
    '古い注記です。',
    '',
    'まとめの段落です。'
  ].join('\n');
  const blocks = parseMarkdownBlocks(markdown);
  const comments = [{
    id: 'comment-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'paragraph',
    status: 'open',
    targetText: 'この段落は冗長な説明を含みます。',
    selectedText: 'この段落は冗長な説明を含みます。',
    headingPath: ['設計メモ', '背景'],
    comment: '冗長な説明を削ってほしい'
  }];

  let currentMarkdown = markdown;
  let refuseNextSave = false;
  const reviseRequests = [];
  const saveRequests = [];
  const reviewFile = '.review/docs/note.md.review.json';

  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fnote.md', {
    '/api/file': async (_input, options = {}) => {
      if (options.method !== 'POST') {
        return {
          path: 'docs/note.md',
          markdown: currentMarkdown,
          ...await renderViews(currentMarkdown),
          review: { targetFile: 'docs/note.md', comments },
          reviewFile
        };
      }
      const body = JSON.parse(options.body);
      saveRequests.push(body);
      if (refuseNextSave) {
        return new Response(JSON.stringify({ error: '本文がこの修正案を作ったときから変わっています' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // 本物の適用器へ通します。画面が送った範囲と原文が、そのまま本文になるかを見るためです。
      const applied = applyBlockEdits(currentMarkdown, body.edits);
      currentMarkdown = applied.markdown;
      return {
        path: 'docs/note.md',
        markdown: currentMarkdown,
        revision: documentRevision(currentMarkdown),
        appliedEdits: applied.appliedEdits,
        ...await renderViews(currentMarkdown),
        review: { targetFile: 'docs/note.md', comments },
        reviewFile
      };
    },
    '/api/review': (_input, options) => ({
      review: { targetFile: 'docs/note.md', comments: JSON.parse(options.body).comments || comments },
      reviewFile
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/revise': (_input, options) => {
      reviseRequests.push([JSON.parse(options.body), options.headers]);
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          documentRevision: documentRevision(markdown),
          summary: '冗長な説明を削り、古い注記を消しました。',
          requestedComments: 1,
          droppedComments: 0,
          droppedBlocks: 0,
          droppedEdits: 0,
          edits: [
            {
              blockId: blocks[2].id,
              blockIndex: 2,
              kind: 'paragraph',
              headingPath: ['設計メモ', '背景'],
              start: blocks[2].start,
              end: blocks[2].end,
              before: blocks[2].source,
              after: 'この段落は説明を含みます。',
              delete: false,
              reason: '冗長な説明を削りました。',
              confidence: 'high',
              target: {
                type: 'paragraph',
                selectedText: 'この段落は冗長な説明を含みます。',
                targetText: 'この段落は冗長な説明を含みます。',
                headingPath: ['設計メモ', '背景']
              }
            },
            {
              blockId: blocks[3].id,
              blockIndex: 3,
              kind: 'paragraph',
              headingPath: ['設計メモ', '背景'],
              start: blocks[3].start,
              end: blocks[3].end,
              before: blocks[3].source,
              after: '',
              delete: true,
              reason: '古い注記なので消します。',
              confidence: 'medium',
              target: {
                type: 'paragraph',
                selectedText: '古い注記です。',
                targetText: '古い注記です。',
                headingPath: ['設計メモ', '背景']
              }
            }
          ],
          skipped: [{ request: '図を足す', reason: '図の内容が分かりません' }]
        }
      ]);
    }
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  document.querySelector('#revise-tab-button').click();
  assert.equal(document.querySelector('#revise-panel').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#comments-panel').classList.contains('hidden'), true);
  // 未解決のコメントが依頼になるので、指示を書かなくても実行できます。
  assert.match(document.querySelector('#revise-context-hint').textContent, /未解決のレビューコメント1件/);
  assert.equal(document.querySelector('#revise-submit-button').disabled, false);

  const instruction = document.querySelector('#revise-input');
  instruction.value = '冗長な説明を削ってください。';
  instruction.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#revise-form').requestSubmit();
  await waitFor(() => document.querySelector('.revise-card'));

  assert.deepEqual(reviseRequests[0][0], { path: 'docs/note.md', instruction: '冗長な説明を削ってください。' });
  assert.equal(reviseRequests[0][1]['X-Review-Markdown-Token'], 'ui-ai-token');
  assert.equal(document.querySelectorAll('.revise-card').length, 2);
  assert.match(document.querySelector('.placement-note').textContent, /未解決のコメント1件を読ませました/);
  assert.match(document.querySelector('.placement-unplaced').textContent, /図を足す/);

  // 修正前と修正後を必ず並べます。どちらか片方では、何が変わるかを判断できません。
  const [firstCard, secondCard] = document.querySelectorAll('.revise-card');
  assert.equal(firstCard.querySelector('[data-side="before"] .revise-text').textContent, 'この段落は冗長な説明を含みます。');
  assert.equal(firstCard.querySelector('[data-side="after"] textarea').value, 'この段落は説明を含みます。');
  assert.equal(firstCard.querySelector('.placement-path').textContent, '設計メモ › 背景');
  assert.equal(secondCard.dataset.delete, 'true');
  assert.match(secondCard.querySelector('.revise-removed').textContent, /まるごと削除/);

  // 許可する前に、本文のどこが変わるのかを確かめられます。
  firstCard.querySelector('[data-revise-action="reveal"]').click();
  assert.match(document.querySelector('#markdown-content .reveal-flash').textContent, /この段落は冗長な説明を含みます。/);

  // 修正案はその場で直せます。適用されるのはAIの下書きではなく、ここにある文面です。
  const draft = firstCard.querySelector('[data-side="after"] textarea');
  draft.value = 'この段落は説明だけを含みます。';
  draft.dispatchEvent(new window.Event('input', { bubbles: true }));

  // 「適用」の1回目は書き換えません。許可を求める行に変わるだけです。
  firstCard.querySelector('[data-revise-action="requestApply"]').click();
  assert.equal(saveRequests.length, 0, '許可する前は本文へ書き込まない');
  assert.match(document.querySelector('.revise-confirm').textContent, /この箇所を書き換えますか/);

  // やめれば元の行へ戻り、本文はそのままです。
  document.querySelector('[data-revise-action="cancelApply"]').click();
  assert.equal(document.querySelector('.revise-confirm'), null);
  assert.equal(saveRequests.length, 0);

  document.querySelectorAll('.revise-card')[0].querySelector('[data-revise-action="requestApply"]').click();
  document.querySelector('[data-revise-action="applyOne"]').click();
  await waitFor(() => saveRequests.length === 1);
  await waitFor(() => document.querySelectorAll('.revise-card').length === 1);

  assert.equal(saveRequests[0].baseRevision, documentRevision(markdown), '作ったときの本文かを申告する');
  assert.deepEqual(saveRequests[0].edits, [{
    blockId: blocks[2].id,
    start: blocks[2].start,
    end: blocks[2].end,
    markdown: 'この段落は説明だけを含みます。'
  }]);
  assert.equal(saveRequests[0].comments, undefined, 'コメントは送らないので、保存済みのものが残る');
  assert.equal(currentMarkdown.includes('この段落は説明だけを含みます。'), true);
  assert.match(document.querySelector('#markdown-content').textContent, /この段落は説明だけを含みます。/);
  assert.equal(document.querySelector('#comment-count').textContent, '1', '本文を書き換えてもコメントは残る');

  // 残った候補の位置は、書き換えで前が伸び縮みしたぶんずれています。
  const remaining = document.querySelector('.revise-card');
  assert.match(remaining.querySelector('[data-side="before"] .revise-text').textContent, /古い注記です。/);
  remaining.querySelector('[data-revise-action="requestApply"]').click();
  document.querySelector('[data-revise-action="applyOne"]').click();
  await waitFor(() => saveRequests.length === 2);
  await waitFor(() => document.querySelector('.revise-card') === null);
  assert.equal(currentMarkdown.includes('古い注記です。'), false, 'ずらした範囲でも狙った段落が消える');
  assert.match(currentMarkdown, /まとめの段落です。/);
});

test('a revision proposal made against older text is refused rather than written to the wrong place', async (t) => {
  const markdown = '# 手順\n\n古い段落です。\n\nもう一つの段落です。\n';
  const blocks = parseMarkdownBlocks(markdown);
  const saveRequests = [];
  const reviewFile = '.review/docs/note.md.review.json';

  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fnote.md', {
    '/api/file': async (_input, options = {}) => {
      if (options.method !== 'POST') {
        return {
          path: 'docs/note.md',
          markdown,
          ...await renderViews(markdown),
          review: { targetFile: 'docs/note.md', comments: [] },
          reviewFile
        };
      }
      saveRequests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ error: '本文がこの修正案を作ったときから変わっています。修正案を作り直してください' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    '/api/review': (_input, options) => ({
      review: { targetFile: 'docs/note.md', comments: JSON.parse(options.body).comments || [] },
      reviewFile
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/revise': () => ndjsonResponse([
      { type: 'started' },
      {
        type: 'result',
        documentRevision: 'stale-revision',
        summary: '言い回しを整えました。',
        requestedComments: 0,
        droppedComments: 0,
        droppedBlocks: 0,
        droppedEdits: 0,
        edits: [{
          blockId: blocks[1].id,
          blockIndex: 1,
          kind: 'paragraph',
          headingPath: ['手順'],
          start: blocks[1].start,
          end: blocks[1].end,
          before: blocks[1].source,
          after: '新しい段落です。',
          delete: false,
          reason: '言い回しを整えました。',
          confidence: 'medium',
          target: { type: 'paragraph', selectedText: '古い段落です。', targetText: '古い段落です。', headingPath: ['手順'] }
        }],
        skipped: []
      }
    ])
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  document.querySelector('#revise-tab-button').click();
  const instruction = document.querySelector('#revise-input');
  instruction.value = '言い回しを整えてください。';
  instruction.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#revise-form').requestSubmit();
  await waitFor(() => document.querySelector('.revise-card'));

  const card = document.querySelector('.revise-card');
  card.querySelector('[data-revise-action="requestApply"]').click();
  document.querySelector('[data-revise-action="applyOne"]').click();
  await waitFor(() => saveRequests.length === 1);
  await waitFor(() => document.querySelector('#revise-results .ai-error'));

  assert.match(document.querySelector('#revise-results .ai-error').textContent, /作り直してください/);
  // 位置がもう当たらないので、残った候補も適用させません。
  assert.equal(
    document.querySelector('.revise-card [data-revise-action="requestApply"]').disabled,
    true
  );
  assert.match(document.querySelector('#markdown-content').textContent, /古い段落です。/, '本文は変わっていない');
});

test('a Markdown body gets a copy button, and a file we cannot read as text does not', async (t) => {
  const markdown = '# 手順書\n\n最初に環境を用意します。\n';
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      textBody: true,
      ...await renderViews(markdown),
      review: { targetFile: 'guide.md', comments: [] },
      reviewFile: '.review/guide.md.review.json'
    })
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } }
  });

  const copyButton = document.querySelector('#copy-body-button');
  assert.equal(copyButton.classList.contains('hidden'), false, 'Markdownには本文コピーボタンが出る');

  copyButton.click();
  await waitFor(() => copied.length > 0);
  assert.equal(copied[0], markdown, '本文をそのままコピーする');
  assert.match(document.querySelector('#toast-region').textContent, /本文をコピーしました/);
});

test('a PDF has no body to copy, so the copy button stays hidden', async (t) => {
  const { document } = await startApp(t, 'http://localhost/#/review/spec.pdf', {
    '/api/file': async () => ({
      path: 'spec.pdf',
      markdown: '%PDF-1.7',
      textBody: false,
      ...await renderViews('%PDF-1.7'),
      review: { targetFile: 'spec.pdf', comments: [] },
      reviewFile: '.review/spec.pdf.review.json'
    })
  });
  await waitFor(() => document.querySelector('#markdown-content p'));

  assert.equal(
    document.querySelector('#copy-body-button').classList.contains('hidden'),
    true,
    '本文を扱えないファイルではコピーボタンを出さない'
  );
});

test('the manager asks for what is not settled, and holds the review back once', async (t) => {
  const markdown = ['# 再起動手順', '', 'まず deploy.sh を実行します。'].join('\n');
  const savedRequests = [];
  const briefRequests = [];
  const reviewRequests = [];
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
    '/api/ai/review-skills': () => ({
      skills: [{ id: 'reader-fit-review', name: '読み手適合レビュー', description: '読み手に届くかを見る。', source: 'builtin' }]
    }),
    '/api/ai/brief': (_input, options) => {
      briefRequests.push(JSON.parse(options.body));
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          // 走り書きが言っていない2つは、埋めずに問いとして返ってくる。
          brief: { purpose: '当番が一人で再起動を完了できるようになる。', story: '', expectation: '' },
          questions: ['止めてよい条件は誰が決めますか。', '読んだ人に何を判断してほしいですか。'],
          assumptions: ['「当番」を運用当番と読みました']
        }
      ]);
    },
    '/api/ai/review': (_input, options) => {
      reviewRequests.push(JSON.parse(options.body));
      return ndjsonResponse([
        { type: 'started' },
        { type: 'result', skills: [], summary: '', verified: true, refuted: 0, placements: [], unplaced: [], droppedPlacements: 0 }
      ]);
    },
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      savedRequests.push(body);
      return {
        review: { targetFile: 'docs/note.md', comments: body.comments || [], brief: body.brief },
        reviewFile: '.review/docs/note.md.review.json'
      };
    }
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  document.querySelector('#manager-tab-button').click();
  assert.equal(document.querySelector('#manager-panel').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#brief-state').textContent, '0 / 3');
  assert.equal(document.querySelector('#brief-compose-button').disabled, true, '走り書きが空のうちは聞けない');

  const briefInput = document.querySelector('#brief-input');
  briefInput.value = '運用チームから当番向けの再起動手順を頼まれた。';
  briefInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#brief-compose-button').disabled, false);
  document.querySelector('#brief-compose-form').requestSubmit();
  await waitFor(() => document.querySelector('.brief-questions'));

  assert.deepEqual(briefRequests, [{ path: 'docs/note.md', input: '運用チームから当番向けの再起動手順を頼まれた。' }]);
  assert.equal(document.querySelector('#brief-purpose').value, '当番が一人で再起動を完了できるようになる。');
  assert.equal(document.querySelector('#brief-story').value, '', '言っていない項目は埋めない');
  assert.equal(document.querySelectorAll('.brief-questions li').length, 2, '埋めない代わりに問い返す');
  assert.match(document.querySelector('.brief-assumptions').textContent, /運用当番と読みました/);
  assert.equal(document.querySelector('#brief-state').textContent, '1 / 3');

  // 決まった分は、コメントと同じ自動保存でレビューファイルへ入る。
  await waitFor(() => savedRequests.some((request) => request.brief?.purpose), 1600);

  // まだ2つ足りないので、レビューのパネルは押す前から何が足りないかを言う。
  document.querySelector('#review-tab-button').click();
  await waitFor(() => document.querySelectorAll('#review-skill-list input[data-skill-id]').length === 1);
  const briefHint = document.querySelector('#review-brief-hint');
  assert.equal(briefHint.hidden, false);
  assert.match(briefHint.textContent, /ストーリー・期待値を求めています/);

  // 1度目の実行は止める。関門は「決めないまま進んでいる」ことに気づかせるためのもの。
  document.querySelector('#review-form').requestSubmit();
  await waitFor(() => document.querySelector('#review-run-button').textContent === 'それでも実行する');
  assert.deepEqual(reviewRequests, [], '1度目は実行しない');
  assert.match(document.querySelector('#toast-region').textContent, /資料の管理者が/);

  // 止め続けはしない。押し直せば、決めないままでも実行する。
  document.querySelector('#review-form').requestSubmit();
  await waitFor(() => reviewRequests.length === 1);

  // 3つとも決まれば、関門は開いたままになる。
  document.querySelector('#manager-tab-button').click();
  for (const [selector, value] of [
    ['#brief-story', '止めてよい条件 → 止める手順 → 戻ったことの確かめ方。'],
    ['#brief-expectation', '再起動についての問い合わせが来なくなる。']
  ]) {
    const field = document.querySelector(selector);
    field.value = value;
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  assert.equal(document.querySelector('#brief-state').textContent, '揃いました');
  assert.equal(document.querySelector('#review-brief-hint').hidden, true);
  assert.equal(document.querySelector('#review-run-button').textContent, 'レビューを実行');

  // 3点は前提の一部なので、質問と一緒に渡すもののなかにも出る。
  document.querySelector('#ai-tab-button').click();
  assert.match(document.querySelector('#placement-context-hint').textContent, /「管理者」タブで決めた3点/);
  assert.equal(document.querySelector('#placement-context-hint').hidden, false);
});

test('a document with nothing written yet cannot be edited until the manager has been answered', async (t) => {
  // 骨組みだけの資料。これから「作る」もので、依頼どおり作る手前で止める対象。
  const markdown = '# 再起動手順\n';
  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fnew.md', {
    '/api/file': async () => ({
      path: 'docs/new.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/new.md', comments: [] },
      reviewFile: '.review/docs/new.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/review-skills': () => ({ skills: [] }),
    '/api/review': (_input, options) => ({
      review: { targetFile: 'docs/new.md', comments: JSON.parse(options.body).comments || [] },
      reviewFile: '.review/docs/new.md.review.json'
    })
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  // タブは既定でコメントを開くので、決まっていない数をラベルへ出して求めていることを見せる。
  const tabCount = document.querySelector('#manager-tab-count');
  assert.equal(tabCount.hidden, false);
  assert.equal(tabCount.textContent, '0 / 3');

  document.querySelector('#edit-mode-button').click();
  await waitFor(() => document.querySelector('#manager-panel').classList.contains('hidden') === false);
  assert.equal(document.querySelector('#edit-mode-button').getAttribute('aria-pressed'), 'false',
    'まだ本文の無い資料は、3点を決めるまで書き始めさせない');
  assert.match(document.querySelector('#toast-region').textContent, /まだ本文の無い資料です/);

  // 止め続けはしない。押し直せば、決めないままでも書き始められる。
  document.querySelector('#edit-mode-button').click();
  await waitFor(() => document.querySelector('#edit-mode-button').getAttribute('aria-pressed') === 'true');

  // 3つとも決めれば、タブの印は消える。
  document.querySelector('#manager-tab-button').click();
  for (const [selector, value] of [
    ['#brief-purpose', '当番が一人で再起動できるようになる。'],
    ['#brief-story', '条件 → 手順 → 確認。'],
    ['#brief-expectation', '問い合わせが来なくなる。']
  ]) {
    const field = document.querySelector(selector);
    field.value = value;
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  assert.equal(tabCount.hidden, true);
});

test('a document that is already written is not held back, only told once', async (t) => {
  const markdown = '# 再起動手順\n\nまず deploy.sh を実行します。\n';
  const { document } = await startApp(t, 'http://localhost/#/review/docs%2Fwritten.md', {
    '/api/file': async () => ({
      path: 'docs/written.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/written.md', comments: [] },
      reviewFile: '.review/docs/written.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/review-skills': () => ({ skills: [] })
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  // 直しに来た人と読みに来た人を、編集の手前で締め出さない。言うのは1回だけ。
  document.querySelector('#edit-mode-button').click();
  await waitFor(() => document.querySelector('#edit-mode-button').getAttribute('aria-pressed') === 'true');
  assert.match(document.querySelector('#toast-region').textContent, /資料の管理者が目的・ストーリー・期待値を求めています/);
  assert.doesNotMatch(document.querySelector('#toast-region').textContent, /まだ本文の無い資料です/);
});

test('every side pane scrolls inside itself, so nothing is cut off below the fold', async (t) => {
  const indexHtml = await fs.readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const styles = await fs.readFile(path.join(projectDir, 'public', 'style.css'), 'utf8');
  const { window } = new JSDOM(indexHtml, { url: 'http://localhost/#/' });
  t.after(() => window.close());
  const { document } = window;

  // パネルが伸びる部分は、外へはみ出さずここでスクロールします。
  for (const selector of [
    '#comments-list', '#export-button',
    '#brief-form', '#brief-compose',
    '#ai-context', '#ai-target', '#translation-result', '#ai-messages',
    '#placement-form', '#placement-results',
    '#review-skill-list', '#review-persona', '#review-results',
    '#revise-form', '#revise-results'
  ]) {
    assert.ok(
      document.querySelector(selector)?.closest('.pane-scroll'),
      `${selector} はスクロールする領域の中に置く`
    );
  }
  // 送信欄と保存の見出しは、スクロールしても手が届く位置に残します。
  assert.equal(document.querySelector('#ai-chat-form').closest('.pane-scroll'), null);
  assert.equal(document.querySelector('#save-button').closest('.pane-scroll'), null);

  for (const panel of [
    '#comments-panel', '#manager-panel', '#ai-panel',
    '#placement-panel', '#review-panel', '#revise-panel'
  ]) {
    assert.equal(document.querySelectorAll(`${panel} .pane-scroll`).length, 1, `${panel} のスクロール領域は1つ`);
  }
  assert.match(styles, /\.pane-scroll \{[^}]*overflow-y: auto;/, '.pane-scroll が実際にスクロールする');
});

test('the context screen opens the saved premises wide, and lets the reviewer fix a saved chat', async (t) => {
  const markdown = '# Guide\n\nRun the program.\n';
  const requests = [];
  const conversation = {
    id: 'conversation-context-page',
    documentPath: 'guide.md',
    title: 'Run the program.',
    codexThreadId: 'thread-1',
    target: { type: 'paragraph', selectedText: 'Run the program.', headingPath: ['Guide'] },
    messages: [
      { id: 'user-1', role: 'user', content: 'run はどう訳す？', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'assistant-1', role: 'assistant', content: '「実行する」です。', createdAt: '2026-08-01T00:00:10.000Z' }
    ],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:10.000Z'
  };
  const { document, window } = await startApp(t, 'http://localhost/#/review/guide.md', {
    '/api/file': async () => ({
      path: 'guide.md',
      markdown,
      ...await renderViews(markdown),
      review: {
        targetFile: 'guide.md',
        comments: [],
        aiContext: '第3章。読者は初学者。',
        brief: { purpose: '当番が一人で再起動できる', story: '条件 → 手順 → 確かめ方', expectation: '問い合わせが来なくなる' },
        contextNotes: [
          { id: 'note-1', kind: 'constraint', body: '用語は原著の訳語に合わせる', createdAt: '2026-08-01T00:00:00.000Z' }
        ]
      },
      reviewFile: '.review/guide.md.review.json'
    }),
    '/api/review': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push(['review', body]);
      return { review: { targetFile: 'guide.md', comments: [] }, reviewFile: '.review/guide.md.review.json' };
    },
    '/api/ai/status': () => ({
      token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model', effort: 'low'
    }),
    '/api/ai/conversations': () => ({ conversations: [conversation] }),
    '/api/ai/conversation': (_input, options) => {
      const body = JSON.parse(options.body);
      requests.push([options.method, body]);
      conversation.messages = conversation.messages
        .filter((message) => body.messages.some((edited) => edited.id === message.id))
        .map((message) => {
          const edited = body.messages.find((entry) => entry.id === message.id);
          return edited.content === message.content
            ? message
            : { ...message, content: edited.content, editedAt: '2026-08-30T00:00:00.000Z' };
        });
      // 直したやり取りを読み直させるため、サーバーはCodexのスレッドを畳んで返します。
      conversation.codexThreadId = null;
      return { conversation: { ...conversation } };
    }
  });
  await waitFor(() => document.querySelector('#markdown-content p'));
  await waitFor(() => document.querySelectorAll('#ai-conversation-select option').length === 2);

  document.querySelector('#context-open-button').click();
  await waitFor(() => !document.querySelector('#context-view').classList.contains('hidden'));
  assert.equal(document.querySelector('#review-view').classList.contains('hidden'), true, 'レビュー画面とは入れ替わる');
  assert.equal(document.querySelector('#workspace-document-title').textContent, 'guide.md');

  // 保存済みの前提が、そのまま広い欄へ出ています。
  assert.equal(document.querySelector('#workspace-ai-context-input').value, '第3章。読者は初学者。');
  assert.equal(document.querySelector('#workspace-brief-purpose').value, '当番が一人で再起動できる');
  assert.equal(
    document.querySelector('#workspace-context-notes-list .context-note-body').textContent,
    '用語は原著の訳語に合わせる'
  );
  assert.equal(document.querySelector('#workspace-conversation-state').textContent, '1件');

  // 片方の画面で書いたものは、もう片方の欄にも出ます。
  const contextInput = document.querySelector('#workspace-ai-context-input');
  contextInput.value = '第3章。読者は初学者。用語は原著に合わせる。';
  contextInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#ai-context-input').value, '第3章。読者は初学者。用語は原著に合わせる。');

  const noteInput = document.querySelector('#workspace-context-note-input');
  noteInput.value = '図の単位はSIで統一済み。変えない。';
  noteInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#workspace-context-note-form').requestSubmit();
  assert.equal(document.querySelector('#workspace-context-notes-state').textContent, '2件');
  assert.equal(document.querySelectorAll('#context-notes-list .context-note').length, 2, 'サイドパネルの一覧にも出る');

  // 保存した相談は、ここで読み直して直せます。
  document.querySelector('[data-open-conversation]').click();
  assert.equal(document.querySelectorAll('#workspace-conversation-detail .workspace-message').length, 2);
  document.querySelector('[data-edit-message="user-1"]').click();
  const messageForm = document.querySelector('[data-message-form="user-1"]');
  messageForm.querySelector('textarea').value = 'この文脈の run はどう訳す？';
  messageForm.requestSubmit();
  await waitFor(() => requests.some(([method]) => method === 'PATCH'));

  const [, patched] = requests.find(([method]) => method === 'PATCH');
  assert.equal(patched.id, 'conversation-context-page');
  assert.deepEqual(patched.messages, [
    { id: 'user-1', content: 'この文脈の run はどう訳す？' },
    { id: 'assistant-1', content: '「実行する」です。' }
  ], '残す発言を、残す順にそのまま送る');
  await waitFor(() => document.querySelector('.workspace-message .ai-message-body')?.textContent === 'この文脈の run はどう訳す？');
  assert.match(document.querySelector('.workspace-message').textContent, /あとから編集/);

  // 消すのは2段階です。押し間違いで記録が消えないようにします。
  document.querySelector('[data-delete-message="assistant-1"]').click();
  assert.match(document.querySelector('#workspace-conversation-detail .context-note-confirm').textContent, /削除しますか/);
  document.querySelector('[data-confirm-delete="assistant-1"]').click();
  await waitFor(() => requests.filter(([method]) => method === 'PATCH').length === 2);
  assert.deepEqual(
    requests.filter(([method]) => method === 'PATCH').at(-1)[1].messages.map(({ id }) => id),
    ['user-1'],
    '消した発言は、残す一覧から省いて送る'
  );
  await waitFor(() => document.querySelectorAll('#workspace-conversation-detail .workspace-message').length === 1);

  document.querySelector('#workspace-back-button').click();
  await waitFor(() => !document.querySelector('#review-view').classList.contains('hidden'));
  assert.equal(document.querySelector('#context-view').classList.contains('hidden'), true);

  // 読み手を決めるのはレビューを実行する場所と同じなので、そこへ連れて行きます。
  document.querySelector('#context-open-button').click();
  await waitFor(() => !document.querySelector('#context-view').classList.contains('hidden'));
  document.querySelector('#workspace-persona-edit-button').click();
  await waitFor(() => !document.querySelector('#review-view').classList.contains('hidden'));
  assert.equal(document.querySelector('#review-panel').classList.contains('hidden'), false, 'AIレビューのタブを開く');
});

test('文字起こしを開くと、押す前に読む範囲が出て、聞くと要約と次の行動が並ぶ', async (t) => {
  const markdown = [
    '# 定例会議',
    '',
    '---',
    '',
    '**田中** `[10:00:00]`',
    '今日は再起動手順の確認です。',
    '',
    '**鈴木** `[10:20:00]`',
    '手順の前提が書かれていないので、当番は読めません。',
    ''
  ].join('\n');
  const windowRequests = [];
  const recapRequests = [];
  const reviewFile = '.review/docs/meeting.md.review.json';

  const { document, window } = await startApp(t, 'http://localhost/#/review/docs%2Fmeeting.md', {
    '/api/file': async () => ({
      path: 'docs/meeting.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/meeting.md', comments: [] },
      reviewFile
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/recap-window': (input) => {
      const query = new URL(String(input), 'http://localhost').searchParams;
      windowRequests.push(Object.fromEntries(query));
      return {
        window: {
          scope: query.get('scope'),
          appliedScope: query.get('scope') === 'all' ? 'all' : 'minutes',
          fallback: query.get('scope') === 'since-last' ? 'no-mark' : '',
          minutes: Number(query.get('minutes')),
          entries: [{ index: 1 }],
          leadIn: [],
          dropped: 0,
          total: 2,
          chars: 30,
          from: '10:20:00',
          to: '10:20:00',
          reason: ''
        }
      };
    },
    '/api/ai/recap': (_input, options) => {
      recapRequests.push([JSON.parse(options.body), options.headers]);
      return ndjsonResponse([
        { type: 'started' },
        {
          type: 'result',
          recap: {
            summary: '手順書の前提が足りない、という話でした。',
            answer: '「前提」は、当番が読む前に分かっているべき条件のことです。',
            question: '「前提」って何のことですか？',
            points: [{
              kind: 'request',
              speaker: '鈴木',
              point: '手順の前提を書いてほしい',
              quote: '手順の前提が書かれていないので、当番は読めません。'
            }],
            actions: [{ action: '3章の冒頭に前提を書く', reason: '鈴木さんの依頼' }],
            range: {
              scope: 'since-last',
              appliedScope: 'minutes',
              fallback: 'no-mark',
              minutes: 10,
              entries: 1,
              leadIn: 0,
              dropped: 0,
              total: 2,
              from: '10:20:00',
              to: '10:20:00'
            }
          }
        }
      ]);
    }
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));
  await waitFor(() => windowRequests.length === 1);

  // 押す前に、どこからどこまでを読むのかが出ます。初回は前回の位置が無いので落ちた旨も出ます。
  document.querySelector('#recap-tab-button').click();
  assert.equal(document.querySelector('#recap-tab-button').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#recap-panel').classList.contains('hidden'), false);
  assert.deepEqual(windowRequests[0], { path: 'docs/meeting.md', scope: 'since-last', minutes: '10' });
  assert.match(document.querySelector('#recap-range').textContent, /直近10分の1発言（10:20:00〜10:20:00）/);
  assert.match(document.querySelector('#recap-range').textContent, /まだ聞いていない/);

  // 決め方を変えたら、範囲もその場で引き直します。
  const allScope = [...document.querySelectorAll('input[name="recap-scope"]')].find((input) => input.value === 'all');
  allScope.checked = true;
  allScope.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => windowRequests.length === 2);
  assert.equal(windowRequests[1].scope, 'all');
  assert.match(document.querySelector('#recap-range').textContent, /会議の最初からの1発言/);

  const question = document.querySelector('#recap-question');
  question.value = '「前提」って何のことですか？';
  document.querySelector('#recap-form').requestSubmit();
  await waitFor(() => document.querySelector('.recap-section'));

  assert.deepEqual(recapRequests[0][0], {
    path: 'docs/meeting.md',
    scope: 'all',
    minutes: 10,
    question: '「前提」って何のことですか？'
  });
  assert.equal(recapRequests[0][1]['X-Review-Markdown-Token'], 'ui-ai-token');
  assert.match(document.querySelector('.review-summary').textContent, /前提が足りない/);
  assert.match(document.querySelector('.recap-answer').textContent, /当番が読む前に分かっているべき条件/);
  assert.match(document.querySelector('.placement-card').textContent, /手順の前提を書いてほしい/);
  assert.equal(document.querySelector('.placement-card .target-badge').textContent, '依頼');
  assert.match(document.querySelector('.recap-actions li').textContent, /3章の冒頭に前提を書く/);
  // 読んだ範囲は結果にも残します。要約だけでは、会議のどこの話か分かりません。
  assert.match(document.querySelector('.placement-note').textContent, /読んだのは 直近10分の1発言/);
  // 聞いたぶん「前回の位置」が進むので、範囲は取り直します。
  await waitFor(() => windowRequests.length === 3);
});

test('文字起こしでない文書に、聞き直しのタブは出ない', async (t) => {
  const markdown = '# 設計メモ\n\n**太字**の段落です。\n';
  const windowRequests = [];
  const { document } = await startApp(t, 'http://localhost/#/review/docs%2Fnote.md', {
    '/api/file': async () => ({
      path: 'docs/note.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/note.md', comments: [] },
      reviewFile: '.review/docs/note.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/recap-window': (input) => {
      windowRequests.push(String(input));
      return { window: null };
    }
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));

  assert.equal(document.querySelector('#recap-tab-button').classList.contains('hidden'), true);
  assert.deepEqual(windowRequests, [], '発言の無い文書では範囲も引きに行かない');
});

test('自動タスクが有効な文書ではタスクのタブが出て、整理すると一覧が並び、状態の変更は変えたことだけを送る', async (t) => {
  const markdown = [
    '# 定例会議',
    '',
    '**田中** `[10:00:00]`',
    '今日は再起動手順の確認です。',
    '',
    '**鈴木** `[10:02:00]`',
    '前提を調べて書いてください。',
    ''
  ].join('\n');
  const readRequests = [];
  const changeRequests = [];
  const extractRequests = [];
  let record = {
    targetFile: 'docs/meeting.md',
    watch: false,
    analysis: null,
    focus: null,
    tasks: [],
    lastError: null
  };
  const runner = { enabled: true, intervalSeconds: 120, actions: ['organize', 'focus', 'research'], captioned: false, watching: false, running: false, lastTickAt: null, nextTickAt: null };
  const payload = () => ({ tasks: record, tasksFile: '.review/docs/meeting.md.tasks.json', runner: { ...runner, watching: record.watch } });

  const { document } = await startApp(t, 'http://localhost/#/review/docs%2Fmeeting.md', {
    '/api/file': async () => ({
      path: 'docs/meeting.md',
      markdown,
      ...await renderViews(markdown),
      review: { targetFile: 'docs/meeting.md', comments: [] },
      features: { manager: false, translation: false, autoTasks: true },
      reviewFile: '.review/docs/meeting.md.review.json'
    }),
    '/api/ai/status': () => ({ token: 'ui-ai-token', available: true, provider: 'codex', model: 'fast-test-model' }),
    '/api/ai/conversations': () => ({ conversations: [] }),
    '/api/ai/recap-window': () => ({ window: { scope: 'since-last', appliedScope: 'minutes', fallback: 'no-mark', minutes: 10, entries: [{ index: 1 }], leadIn: [], dropped: 0, total: 2, chars: 20, from: '10:02:00', to: '10:02:00', reason: '' } }),
    '/api/tasks': (input, options) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        changeRequests.push([body, options.headers]);
        if (body.watch !== undefined) record = { ...record, watch: body.watch };
        for (const { id, status } of body.setStatus || []) {
          record = { ...record, tasks: record.tasks.map((task) => (task.id === id ? { ...task, status } : task)) };
        }
        for (const added of body.add || []) {
          record = { ...record, tasks: [...record.tasks, { id: `task-${record.tasks.length + 1}`, ...added, status: 'open', source: 'reviewer', priority: 'next', quote: '', owner: '' }] };
        }
        // サーバー側の `applyTasksChange` と同じで、送られた欄だけを当てます。
        for (const patch of body.plan || []) {
          record = { ...record, tasks: record.tasks.map((task) => {
            if (task.id !== patch.id) return task;
            const plan = {
              commitment: patch.commitment ?? task.plan?.commitment ?? 'undecided',
              due: patch.due ?? task.plan?.due ?? '',
              note: patch.note ?? task.plan?.note ?? '',
              decidedAt: '2026-09-03T02:00:00.000Z'
            };
            const next = { ...task };
            if (plan.commitment === 'undecided' && !plan.due && !plan.note) delete next.plan;
            else next.plan = plan;
            if (patch.priority !== undefined) next.priority = patch.priority;
            if (patch.owner !== undefined) next.owner = patch.owner;
            return next;
          }) };
        }
        return payload();
      }
      readRequests.push(String(input));
      return payload();
    },
    '/api/ai/tasks/extract': (_input, options) => {
      extractRequests.push([JSON.parse(options.body), options.headers]);
      record = {
        ...record,
        analysis: { revision: 'r1', length: markdown.length, sourceKind: 'transcript', analyzedAt: '2026-09-03T01:00:00.000Z', summary: '前提が足りません。' },
        focus: { now: '前提を調べて書く', reason: '鈴木さんの依頼だから', updatedAt: '2026-09-03T01:00:00.000Z' },
        tasks: [
          { id: 'task-1', title: '手順の前提を調べる', detail: '当番が知らない前提を洗い出す。', kind: 'research', priority: 'now', status: 'ready', source: 'ai', quote: '前提を調べて書いてください。', owner: '', createdAt: '2026-09-03T01:00:00.000Z', result: { summary: '前提は3つです。', body: '# 調査メモ\n\n- OSの版', truncated: false, followUps: [], questions: ['どの環境か'], completedAt: '2026-09-03T01:00:30.000Z' } },
          { id: 'task-2', title: '停止条件を運用チームに確認する', detail: '', kind: 'action', priority: 'next', status: 'open', source: 'ai', quote: '', owner: '田中', createdAt: '2026-09-03T01:00:00.000Z' }
        ]
      };
      return ndjsonResponse([
        { type: 'started' },
        { type: 'phase', phase: 'extracting' },
        { type: 'phase', phase: 'performing:手順の前提を調べる' },
        { type: 'result', ...payload() }
      ]);
    }
  });
  await waitFor(() => document.querySelector('#markdown-content h1'));
  await waitFor(() => readRequests.length === 1);

  // 有効な文書ではタブが出て、開くと記録の写しが並びます。まだ何も無ければそう言います。
  const tab = document.querySelector('#tasks-tab-button');
  assert.equal(tab.classList.contains('hidden'), false);
  assert.equal(document.querySelector('#tasks-tab-count').hidden, true);
  tab.click();
  assert.equal(document.querySelector('#tasks-panel').classList.contains('hidden'), false);
  assert.match(document.querySelector('#tasks-list').textContent, /まだタスクはありません/);
  assert.equal(document.querySelector('#tasks-focus').hidden, true);
  assert.match(document.querySelector('#tasks-watch-hint').textContent, /120秒ごと/);

  // 「整理する」で抽出と実行が続けて走り、今すべきことと一覧が並びます。
  document.querySelector('#tasks-run-form').requestSubmit();
  await waitFor(() => document.querySelectorAll('.task-card').length === 2);
  assert.deepEqual(extractRequests[0][0], { path: 'docs/meeting.md' });
  assert.equal(extractRequests[0][1]['X-Review-Markdown-Token'], 'ui-ai-token');
  assert.equal(document.querySelector('#tasks-focus').hidden, false);
  assert.equal(document.querySelector('#tasks-focus-now').textContent, '前提を調べて書く');
  assert.equal(document.querySelector('#tasks-tab-count').textContent, '2');
  const cards = [...document.querySelectorAll('.task-card')];
  assert.equal(cards[0].dataset.status, 'ready', '確認待ちが先頭に来る');
  assert.equal(cards[0].querySelector('.task-status').textContent, '確認待ち');
  assert.equal(cards[0].querySelector('.task-kind').textContent, '調査');
  assert.match(cards[0].querySelector('.task-result summary').textContent, /前提は3つです/);
  assert.match(cards[0].querySelector('.task-result-body').textContent, /# 調査メモ/);
  assert.match(cards[0].querySelector('.task-result-list').textContent, /どの環境か/);
  assert.match(cards[1].textContent, /担当: 田中/);
  assert.match(document.querySelector('#tasks-runner-hint').textContent, /文字起こしとして/);

  // 状態の変更は、一覧まるごとではなく変えたことだけを送ります。
  cards[0].querySelector('[data-task-status="done"]').click();
  await waitFor(() => changeRequests.length === 1);
  assert.deepEqual(changeRequests[0][0], { path: 'docs/meeting.md', setStatus: [{ id: 'task-1', status: 'done' }] });
  await waitFor(() => document.querySelector('.task-card[data-task-id="task-1"]').dataset.status === 'done');
  assert.equal(document.querySelector('#tasks-tab-count').textContent, '1', '残っているものだけを数える');

  // 見守りの入り切りも、手で足すのも同じ窓口です。
  const watch = document.querySelector('#tasks-watch');
  watch.checked = true;
  watch.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => changeRequests.length === 2);
  assert.deepEqual(changeRequests[1][0], { path: 'docs/meeting.md', watch: true });

  const addInput = document.querySelector('#tasks-add-input');
  addInput.value = '議事録を配る';
  addInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#tasks-add-submit').disabled, false);
  document.querySelector('#tasks-add-kind').value = 'action';
  document.querySelector('#tasks-add-form').requestSubmit();
  await waitFor(() => changeRequests.length === 3);
  assert.deepEqual(changeRequests[2][0], { path: 'docs/meeting.md', add: [{ title: '議事録を配る', kind: 'action' }] });
  await waitFor(() => document.querySelectorAll('.task-card').length === 3);
  assert.match(document.querySelector('.task-card[data-task-id="task-3"]').textContent, /自分で足した/);

  // 消すのは2段階です。
  document.querySelector('.task-card[data-task-id="task-3"] [data-task-delete]').click();
  assert.match(document.querySelector('.task-card[data-task-id="task-3"]').textContent, /削除しますか/);
  document.querySelector('[data-task-cancel-delete]').click();
  assert.equal(document.querySelector('[data-task-confirm-delete]'), null);

  // やると決めたタスクは印が付き、件数の行が出て、絞り込みで取り出せます。
  document.querySelector('.task-card[data-task-id="task-2"] [data-task-commit]').click();
  await waitFor(() => changeRequests.length === 4);
  assert.deepEqual(changeRequests[3][0], { path: 'docs/meeting.md', plan: [{ id: 'task-2', commitment: 'committed' }] });
  await waitFor(() => document.querySelector('.task-card[data-task-id="task-2"]').dataset.committed === 'true');
  assert.equal(document.querySelector('.task-card[data-task-id="task-2"] .task-commitment').textContent, 'やる');
  assert.match(document.querySelector('#tasks-plan-summary').textContent, /やると決めたこと 1件/);

  const committedFilter = document.querySelector('[data-tasks-filter="committed"]');
  assert.equal(committedFilter.textContent, 'やると決めた（1）');
  committedFilter.click();
  assert.deepEqual(
    [...document.querySelectorAll('.task-card')].map((card) => card.dataset.taskId),
    ['task-2'],
    '決めたものだけを出す'
  );

  // 段取り（期限・優先度・担当・メモ）は、決めたタスクにだけ付きます。
  assert.equal(document.querySelector('.task-card[data-task-id="task-2"] .task-plan') !== null, true);
  const planForm = document.querySelector('[data-task-plan-form="task-2"]');
  planForm.elements.due.value = '2026-09-10';
  planForm.elements.priority.value = 'now';
  planForm.elements.note.value = '手順を出す前に';
  planForm.requestSubmit();
  await waitFor(() => changeRequests.length === 5);
  assert.deepEqual(changeRequests[4][0], {
    path: 'docs/meeting.md',
    plan: [{ id: 'task-2', due: '2026-09-10', priority: 'now', owner: '田中', note: '手順を出す前に' }]
  });
  await waitFor(() => document.querySelector('.task-card[data-task-id="task-2"] .task-due'));
  assert.match(document.querySelector('.task-card[data-task-id="task-2"] .task-due').textContent, /期限 2026-09-10/);
  assert.match(document.querySelector('.task-card[data-task-id="task-2"] .task-plan-note').textContent, /自分のメモ: 手順を出す前に/);

  // 決めたのを取り消すと、印も段取りの欄も消えます。
  document.querySelector('.task-card[data-task-id="task-2"] [data-task-uncommit]').click();
  await waitFor(() => changeRequests.length === 6);
  assert.deepEqual(changeRequests[5][0], { path: 'docs/meeting.md', plan: [{ id: 'task-2', commitment: 'undecided' }] });
  await waitFor(() => document.querySelector('#tasks-plan-summary').hidden === true);
  assert.match(document.querySelector('#tasks-list').textContent, /やると決めたタスクはまだありません/, '絞り込みは押したまま、空だと言う');
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
  // jsdom has no dialog implementation; the app only needs open/close bookkeeping.
  for (const dialog of window.document.querySelectorAll('dialog')) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }

  globalThis.fetch = async (input, options = {}) => {
    const requested = String(input).split('?')[0];
    const handler = responses[requested];
    if (!handler) throw new Error(`Unexpected fetch: ${input}`);
    const result = await handler(input, options);
    if (result instanceof Response) return result;
    const responseBody = requested === '/api/file' && result.features === undefined
      ? { ...result, features: { manager: true, translation: true } }
      : result;
    return new Response(JSON.stringify(responseBody), {
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

/**
 * 前のテストの自動保存（800ms）は、window.close のあとでもこのテストの fetch スタブへ届きます。
 * 何件目かで見分けると、その1件を自分の保存と取り違えて待ち続けることになるので、中身で見ます。
 */
function sentNote(body, text) {
  return (body.contextNotes || []).some((note) => note.body === text);
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for DOM state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
