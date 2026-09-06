import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutomationAppError,
  buildAutomationAppTodoInput,
  createAutomationAppTodo,
  resolveAutomationAppTarget
} from '../src/integrations/automationApp.js';

test('resolveAutomationAppTarget は連携先URLが無ければ null', () => {
  assert.equal(resolveAutomationAppTarget({}, {}), null);
  assert.equal(resolveAutomationAppTarget({ automationAppUrl: '   ' }, {}), null);
});

test('resolveAutomationAppTarget は末尾の / を落とし、設定のトークンを使う', () => {
  const target = resolveAutomationAppTarget(
    { automationAppUrl: 'https://automation-app.example.com/', automationAppToken: 'from-config' },
    {}
  );
  assert.deepEqual(target, { baseUrl: 'https://automation-app.example.com', token: 'from-config' });
});

test('resolveAutomationAppTarget は環境変数のトークンを設定より優先する', () => {
  const target = resolveAutomationAppTarget(
    { automationAppUrl: 'https://automation-app.example.com', automationAppToken: 'from-config' },
    { AUTOMATION_APP_ACCESS_TOKEN: 'from-env' }
  );
  assert.equal(target.token, 'from-env');
});

test('buildAutomationAppTodoInput は題名の無いタスクを断る', () => {
  assert.throws(() => buildAutomationAppTodoInput({ title: '' }), AutomationAppError);
  assert.throws(() => buildAutomationAppTodoInput({}), AutomationAppError);
});

test('buildAutomationAppTodoInput は優先度・期限・文脈を組み立てる', () => {
  const task = {
    title: '未処理の経費申請を確認する',
    detail: '10万円を超えるものを一覧にする',
    priority: 'now',
    owner: '田中',
    quote: '経費精算は月末までにお願いします',
    reference: { knowledge: '経理フォルダの「未処理」を見る' },
    plan: { commitment: 'committed', due: '2026-09-30' }
  };
  const input = buildAutomationAppTodoInput(task, { documentPath: 'meeting.md' });
  assert.equal(input.title, task.title);
  assert.equal(input.description, task.detail);
  assert.equal(input.priority, 'high');
  assert.equal(input.due_on, '2026-09-30');
  assert.deepEqual(input.done_criteria, []);
  assert.deepEqual(input.steps, []);
  assert.deepEqual(input.notes, []);
  assert.match(input.context, /meeting\.md/);
  assert.match(input.context, /田中/);
  assert.match(input.context, /経費精算は月末までにお願いします/);
  assert.match(input.context, /経理フォルダの「未処理」を見る/);
});

test('buildAutomationAppTodoInput は優先度 next / later を normal / low に写す', () => {
  assert.equal(buildAutomationAppTodoInput({ title: 'x', priority: 'next' }).priority, 'normal');
  assert.equal(buildAutomationAppTodoInput({ title: 'x', priority: 'later' }).priority, 'low');
  assert.equal(buildAutomationAppTodoInput({ title: 'x' }).priority, 'normal');
});

test('buildAutomationAppTodoInput は期限が無ければ due_on を送らない', () => {
  const input = buildAutomationAppTodoInput({ title: 'x' });
  assert.equal('due_on' in input, false);
});

test('createAutomationAppTodo は接続先が無ければ問い合わせずに断る', async () => {
  let called = false;
  await assert.rejects(
    createAutomationAppTodo(null, { title: 'x' }, { fetchImpl: async () => { called = true; } }),
    AutomationAppError
  );
  assert.equal(called, false);
});

test('createAutomationAppTodo はトークンが無ければ問い合わせずに断る', async () => {
  let called = false;
  await assert.rejects(
    createAutomationAppTodo(
      { baseUrl: 'https://automation-app.example.com', token: '' },
      { title: 'x' },
      { fetchImpl: async () => { called = true; } }
    ),
    AutomationAppError
  );
  assert.equal(called, false);
});

test('createAutomationAppTodo は成功時に登録したToDoを返す', async () => {
  const calls = [];
  const created = { work_definition_id: 'wd-1', status: 'DRAFT', title: 'x' };
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    return {
      ok: true,
      status: 201,
      async json() { return created; }
    };
  };
  const target = { baseUrl: 'https://automation-app.example.com', token: 'tok-123' };
  const result = await createAutomationAppTodo(target, { title: 'x' }, { fetchImpl });
  assert.deepEqual(result, created);
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, 'https://automation-app.example.com/external/todos');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer tok-123');
  assert.deepEqual(JSON.parse(init.body), { title: 'x' });
});

test('createAutomationAppTodo は 401 invalid_token を分かる日本語にする', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, async json() { return { error: 'invalid_token' }; } });
  await assert.rejects(
    createAutomationAppTodo({ baseUrl: 'https://x', token: 't' }, { title: 'x' }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof AutomationAppError);
      assert.equal(error.status, 401);
      assert.match(error.message, /アクセストークン/);
      return true;
    }
  );
});

test('createAutomationAppTodo は 403 insufficient_scope を分かる日本語にする', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, async json() { return { error: 'insufficient_scope' }; } });
  await assert.rejects(
    createAutomationAppTodo({ baseUrl: 'https://x', token: 't' }, { title: 'x' }, { fetchImpl }),
    (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, /agent:operate/);
      return true;
    }
  );
});

test('createAutomationAppTodo は接続できないとき理由を添えて断る', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    createAutomationAppTodo({ baseUrl: 'https://x', token: 't' }, { title: 'x' }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof AutomationAppError);
      assert.match(error.message, /接続できませんでした/);
      return true;
    }
  );
});
