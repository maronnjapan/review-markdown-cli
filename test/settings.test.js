import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { createSettings, createSettingsFile, settingsFromOptions } from '../src/settings.js';

test('画面から翻訳を有効にすると、次の要求から翻訳のAPIが通る', async (t) => {
  const { baseUrl, calls } = await startServer(t, { translation: false });

  const before = await fetch(`${baseUrl}/api/ai/translate`, {
    method: 'POST', headers: aiHeaders(), body: JSON.stringify(translateBody())
  });
  assert.equal(before.status, 404, '既定では翻訳は無効');

  const saved = await postSettings(baseUrl, { translation: true });
  assert.equal(saved.features.translation, true);
  assert.equal(saved.settings.translation, true);

  const after = await fetch(`${baseUrl}/api/ai/translate`, {
    method: 'POST', headers: aiHeaders(), body: JSON.stringify(translateBody())
  });
  assert.equal(after.status, 200, '立ち上げ直さずに使えるようになる');
  assert.deepEqual(calls, ['translate']);

  // 文書を開き直したときも、同じ機能一覧が返ります。直接URLで開いても同じ画面になります。
  const opened = await fetch(`${baseUrl}/api/file?path=guide.md`).then((response) => response.json());
  assert.deepEqual(opened.features, { manager: false, translation: true, autoTasks: false });
});

test('画面から翻訳を無効にすると、その場でAPIも断る', async (t) => {
  const { baseUrl } = await startServer(t, { translation: true });

  const saved = await postSettings(baseUrl, { translation: false });
  assert.equal(saved.features.translation, false);

  const response = await fetch(`${baseUrl}/api/ai/translate`, {
    method: 'POST', headers: aiHeaders(), body: JSON.stringify(translateBody())
  });
  assert.equal(response.status, 404, '画面から消すだけでなく、APIも断る');
});

test('画面で選んだモデルは、走っているAIへその場で渡る', async (t) => {
  const { baseUrl, client } = await startServer(t);

  const read = await fetch(`${baseUrl}/api/settings`, { headers: aiHeaders() }).then((r) => r.json());
  assert.deepEqual(read.ai.models.map(({ id }) => id), ['fast-model', 'deep-model']);
  assert.deepEqual(read.ai.efforts, ['none', 'low', 'high']);
  assert.equal(read.ai.supportsEffort, true);
  assert.deepEqual(read.settings, { translation: false, autoTasks: false });

  const saved = await postSettings(baseUrl, { aiReviewModel: 'deep-model', aiReviewEffort: 'high' });
  assert.deepEqual(client.models, {
    assistant: { model: undefined, effort: undefined },
    review: { model: 'deep-model', effort: 'high' }
  });
  assert.equal(saved.settings.aiReviewModel, 'deep-model');
  assert.equal(saved.settings.aiReviewEffort, 'high');
});

test('そのAIが持っていないモデルは断り、走っているモデルも設定も変えない', async (t) => {
  const { baseUrl, client } = await startServer(t);
  await postSettings(baseUrl, { aiModel: 'fast-model' });

  const response = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers: aiHeaders(), body: JSON.stringify({ aiModel: 'no-such-model' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /持っていません: no-such-model/);
  assert.equal(client.models.assistant.model, 'fast-model', '断ったので、走っているモデルはそのまま');

  const read = await fetch(`${baseUrl}/api/settings`, { headers: aiHeaders() }).then((r) => r.json());
  assert.equal(read.settings.aiModel, 'fast-model', '設定も直前のまま');
});

test('モデルの欄を空にすると、そのAIの既定へ戻る', async (t) => {
  const { baseUrl, client } = await startServer(t);
  await postSettings(baseUrl, { aiModel: 'fast-model', aiEffort: 'low' });

  const saved = await postSettings(baseUrl, { aiModel: '', aiEffort: '' });
  assert.equal(saved.settings.aiModel, undefined);
  assert.equal(saved.settings.aiEffort, undefined);
  assert.deepEqual(client.models.assistant, { model: undefined, effort: undefined });
});

test('設定のAPIは、AIと同じくトークンとローカルホストを求める', async (t) => {
  const { baseUrl } = await startServer(t);

  const read = await fetch(`${baseUrl}/api/settings`);
  assert.equal(read.status, 403);
  const write = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ translation: true })
  });
  assert.equal(write.status, 403);
});

test('保存した設定は、次の起動のための設定ファイルへ書かれる', async () => {
  const root = await seedProject();
  const home = path.join(root, 'home');
  const file = createSettingsFile({ targetDir: root, env: { XDG_CONFIG_HOME: home, HOME: home }, platform: 'linux' });
  const settings = createSettings({ values: { translation: false }, file });

  const saved = await settings.update({ translation: true, aiReviewModel: 'deep-model' });

  assert.equal(saved.path, path.join(home, 'review-markdown', 'config.json'));
  assert.deepEqual(saved.shadowed, []);
  assert.deepEqual(JSON.parse(await fs.readFile(saved.path, 'utf8')), {
    translation: true,
    aiReviewModel: 'deep-model'
  });
});

test('保存しても次の起動で上書きされるキーは、保存したときに知らせる', async () => {
  const root = await seedProject({ aiReviewModel: 'project-model' });
  const home = path.join(root, 'home');
  const file = createSettingsFile({
    targetDir: root,
    fixedByCommandLine: ['translation'],
    env: { XDG_CONFIG_HOME: home, HOME: home },
    platform: 'linux'
  });
  const settings = createSettings({ file });

  const saved = await settings.update({ translation: true, aiReviewModel: 'deep-model' });

  assert.deepEqual(saved.shadowed, [
    { key: 'translation', source: '今回の起動のコマンドライン指定' },
    { key: 'aiReviewModel', source: path.join(root, '.review-markdown.json') }
  ]);
});

test('保存先を持たない起動では、変更は今回のあいだだけ効く', async () => {
  const settings = createSettings({ values: { translation: false } });

  const saved = await settings.update({ translation: true });

  assert.deepEqual(saved, { path: null, shadowed: [], error: null });
  assert.equal(settings.features.translation, true);
  assert.equal(settings.configPath, null);
});

test('保存に失敗しても、当てた設定は戻さない', async () => {
  const settings = createSettings({
    file: { path: '/nowhere/config.json', save() { throw new Error('書き込めません'); } }
  });

  const saved = await settings.update({ translation: true });

  assert.equal(saved.error, '書き込めません');
  assert.equal(settings.features.translation, true, '画面ではもう変わっているので、戻さない');
});

test('起動時に決まった値は、画面が扱う1キー1値の形へほどける', () => {
  assert.deepEqual(
    settingsFromOptions({
      translation: true,
      aiModels: { assistant: { model: 'fast-model' }, review: { model: 'deep-model', effort: 'high' } }
    }),
    { translation: true, autoTasks: false, aiModel: 'fast-model', aiReviewModel: 'deep-model', aiReviewEffort: 'high' }
  );
  assert.deepEqual(
    settingsFromOptions({ aiModels: { assistant: {}, review: {} } }),
    { translation: false, autoTasks: false },
    '名指ししなかった用途はキーごと落ちる（未設定と、既定と同じ名前を書いたのは別）'
  );
  // 自動タスクの決め事も、設定ファイルに書いたぶんだけがそのまま届きます。
  assert.deepEqual(
    settingsFromOptions({ autoTasks: true, autoTasksInterval: 300, autoTasksActions: ['research'], autoTasksInstructions: '顧客の質問を拾う' }),
    { translation: false, autoTasks: true, autoTasksInterval: 300, autoTasksActions: ['research'], autoTasksInstructions: '顧客の質問を拾う' }
  );
});

/* ---------------------------------------------------------------- *
 * 差し替え口
 * ---------------------------------------------------------------- */

/**
 * モデルを覚えているだけのAI。`setModels` は本物と同じく、持っていないモデルを断ります。
 * 本物のCodexは `selectProfiles` が同じ理由で投げます（`src/codexProfiles.js`）。
 */
function fakeAiClient() {
  const available = ['fast-model', 'deep-model'];
  return {
    provider: 'codex',
    models: { assistant: {}, review: {} },
    get model() { return this.models.assistant.model ?? 'fast-model'; },
    get effort() { return this.models.assistant.effort ?? 'none'; },
    get reviewModel() { return this.models.review.model ?? 'deep-model'; },
    get reviewEffort() { return this.models.review.effort ?? 'high'; },
    supportsEffort: true,
    async start() {},
    listModels() {
      return [
        { id: 'fast-model', efforts: ['none', 'low'], isDefault: true },
        { id: 'deep-model', efforts: ['low', 'high'] }
      ];
    },
    setModels(models) {
      for (const { model } of Object.values(models)) {
        if (model && !available.includes(model)) {
          throw new Error(`設定したモデルをCodexは持っていません: ${model}`);
        }
      }
      this.models = models;
    },
    close() {}
  };
}

async function startServer(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-settings-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const client = fakeAiClient();
  const calls = [];
  const aiService = {
    status: async () => ({ available: true, provider: 'codex', label: 'Codex', model: client.model }),
    modelChoices: async () => ({
      models: client.listModels(),
      efforts: [...new Set(client.listModels().flatMap(({ efforts }) => efforts))],
      supportsEffort: true,
      running: {
        assistant: { model: client.model, effort: client.effort },
        review: { model: client.reviewModel, effort: client.reviewEffort }
      }
    }),
    applyModels: (models) => client.setModels(models),
    async translate() {
      calls.push('translate');
      return { kind: 'passage', result: { translation: 'プログラムを実行する。', notes: [] } };
    },
    close() {}
  };

  const { app } = createServer(root, { ...options, aiService, aiToken: 'settings-token' });
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
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, client, calls, root };
}

function aiHeaders() {
  return { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'settings-token' };
}

function translateBody() {
  return { path: 'guide.md', target: { type: 'paragraph', selectedText: 'Run the program.' } };
}

async function postSettings(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers: aiHeaders(), body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function seedProject(config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-settings-file-'));
  if (config) await fs.writeFile(path.join(root, '.review-markdown.json'), JSON.stringify(config), 'utf8');
  return root;
}
