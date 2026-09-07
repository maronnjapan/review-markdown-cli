import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

const AI_TOKEN = 'automation-app-test-token';

async function startServer(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-automation-app-'));
  await fs.writeFile(path.join(root, 'meeting.md'), '# 定例会議\n\n未処理の経費申請を確認する。\n', 'utf8');
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: AI_TOKEN, autoTasks: true, ...options });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function headers() {
  return { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': AI_TOKEN };
}

async function addTask(baseUrl, patch = {}) {
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ path: 'meeting.md', add: [{ title: '未処理の経費申請を確認する', ...patch }] })
  });
  const payload = await response.json();
  return payload.tasks.tasks.at(-1);
}

test('Automation App連携は既定では無効', async (t) => {
  const { baseUrl } = await startServer(t);
  const task = await addTask(baseUrl);
  const response = await fetch(`${baseUrl}/api/tasks/automation-app`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ path: 'meeting.md', id: task.id })
  });
  assert.equal(response.status, 404);
});

test('有効でも連携先URLが未設定なら400で理由を返す', async (t) => {
  const { baseUrl } = await startServer(t, { automationApp: true });
  const task = await addTask(baseUrl);
  const response = await fetch(`${baseUrl}/api/tasks/automation-app`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ path: 'meeting.md', id: task.id })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /automationAppUrl/);
});

test('タスクを登録し、返ってきたToDoのidを記録へ添える', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://automation-app.example.com')) return originalFetch(url, init);
    calls.push({ url, init });
    return {
      ok: true,
      status: 201,
      async json() {
        return { work_definition_id: 'wd-abc', status: 'DRAFT', title: JSON.parse(init.body).title };
      }
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { baseUrl } = await startServer(t, {
    automationApp: true,
    automationAppUrl: 'https://automation-app.example.com',
    automationAppToken: 'secret-token'
  });
  const task = await addTask(baseUrl);
  await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ path: 'meeting.md', plan: [{ id: task.id, commitment: 'committed' }] })
  });

  const response = await fetch(`${baseUrl}/api/tasks/automation-app`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ path: 'meeting.md', id: task.id })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  const pushed = payload.tasks.tasks.find((entry) => entry.id === task.id);
  assert.equal(pushed.automationApp.workDefinitionId, 'wd-abc');
  assert.equal(pushed.automationApp.url, 'https://automation-app.example.com');
  assert.ok(pushed.automationApp.pushedAt);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://automation-app.example.com/external/todos');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');

  // 読み直しても、登録した記録は残ります。
  const reread = await fetch(`${baseUrl}/api/tasks?path=meeting.md`, { headers: headers() }).then((r) => r.json());
  const rereadTask = reread.tasks.tasks.find((entry) => entry.id === task.id);
  assert.equal(rereadTask.automationApp.workDefinitionId, 'wd-abc');
});

test('連携先が401を返したら、その理由をそのままCLIの応答にする', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://automation-app.example.com')) return originalFetch(url, init);
    return { ok: false, status: 401, async json() { return { error: 'invalid_token' }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { baseUrl } = await startServer(t, {
    automationApp: true,
    automationAppUrl: 'https://automation-app.example.com',
    automationAppToken: 'expired-token'
  });
  const task = await addTask(baseUrl);
  const response = await fetch(`${baseUrl}/api/tasks/automation-app`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ path: 'meeting.md', id: task.id })
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.error, /アクセストークン/);
});

test('存在しないタスクidは404', async (t) => {
  const { baseUrl } = await startServer(t, {
    automationApp: true,
    automationAppUrl: 'https://automation-app.example.com',
    automationAppToken: 'secret-token'
  });
  const response = await fetch(`${baseUrl}/api/tasks/automation-app`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ path: 'meeting.md', id: 'no-such-task' })
  });
  assert.equal(response.status, 404);
});
