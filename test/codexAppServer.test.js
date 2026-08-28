import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { CodexAppServer } from '../src/codexAppServer.js';

test('Codex turns are started with read-only filesystem and network disabled', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-codex-runtime-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const protocol = createFakeProtocol();
  const client = new CodexAppServer({
    runtimeDir,
    spawnProcess(command, args, options) {
      assert.equal(command, 'codex');
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.equal(options.cwd, runtimeDir);
      assert.equal(options.shell, false);
      return protocol.child;
    }
  });

  const threadId = await client.createThread({ ephemeral: true });
  const deltas = [];
  const result = await client.runTurn({
    threadId,
    prompt: 'Translate "run".',
    outputSchema: { type: 'object' },
    onDelta: (delta) => deltas.push(delta)
  });

  assert.equal(client.model, 'gpt-5.6-luna');
  assert.equal(client.effort, 'low');
  assert.equal(result.text, '{"translation":"実行する"}');
  assert.deepEqual(deltas, ['{"translation":"実行する"}']);

  const threadStart = protocol.messages.find(({ method }) => method === 'thread/start');
  assert.equal(threadStart.params.sandbox, 'read-only');
  assert.equal(threadStart.params.approvalPolicy, 'never');
  assert.equal(threadStart.params.cwd, runtimeDir);
  assert.match(threadStart.params.developerInstructions, /Never call tools/);

  const turnStart = protocol.messages.find(({ method }) => method === 'turn/start');
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turnStart.params.approvalPolicy, 'never');
  assert.equal(turnStart.params.effort, 'low');
  assert.deepEqual(turnStart.params.outputSchema, { type: 'object' });

  await client.close();
});

const DEFAULT_MODEL = {
  id: 'gpt-5.6-luna',
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  defaultReasoningEffort: 'low'
};

test('a review thread reads deeper than a translation thread, and its turns stay on that model', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-codex-runtime-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const protocol = createFakeProtocol({
    models: [
      {
        id: 'gpt-5.6-luna',
        supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'low' }],
        defaultReasoningEffort: 'low'
      },
      {
        id: 'gpt-5.6-codex',
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }
        ],
        defaultReasoningEffort: 'medium'
      }
    ]
  });
  const client = new CodexAppServer({ runtimeDir, spawnProcess: () => protocol.child });

  const threadId = await client.createThread({ ephemeral: true, purpose: 'review' });
  await client.runTurn({ threadId, prompt: 'Review this document.' });

  // 翻訳とチャットは待ち時間が体感を決めるので速いモデル、レビューは読み落としが結果から抜けるので深く読むモデル。
  assert.equal(client.model, 'gpt-5.6-luna');
  assert.equal(client.effort, 'none');
  assert.equal(client.reviewModel, 'gpt-5.6-codex');
  assert.equal(client.reviewEffort, 'high');

  const threadStart = protocol.messages.find(({ method }) => method === 'thread/start');
  assert.equal(threadStart.params.model, 'gpt-5.6-codex');
  assert.match(threadStart.params.baseInstructions, /reviewer of Markdown documents/);
  assert.match(threadStart.params.developerInstructions, /Ground every finding in text you can quote/);

  const turnStart = protocol.messages.find(({ method }) => method === 'turn/start');
  assert.equal(turnStart.params.model, 'gpt-5.6-codex', 'スレッドの途中でモデルが入れ替わると読みを引き継げない');
  assert.equal(turnStart.params.effort, 'high');

  await client.close();
});

test('設定ファイルで名指ししたモデルと推論強度を、その用途に使う', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-codex-runtime-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const protocol = createFakeProtocol({ models: [FAST_MODEL, DEEP_MODEL] });
  const client = new CodexAppServer({
    runtimeDir,
    spawnProcess: () => protocol.child,
    models: {
      assistant: { model: 'gpt-5.6-luna', effort: 'low' },
      review: { model: 'gpt-5.6-codex', effort: 'medium' }
    }
  });

  const threadId = await client.createThread({ ephemeral: true, purpose: 'review' });
  await client.runTurn({ threadId, prompt: 'Review this document.' });

  assert.equal(client.model, 'gpt-5.6-luna');
  assert.equal(client.effort, 'low');
  assert.equal(client.reviewModel, 'gpt-5.6-codex');
  // 自動選択なら 'high' を選ぶところを、設定した 'medium' が勝ちます。
  assert.equal(client.reviewEffort, 'medium');
  assert.equal(protocol.messages.find(({ method }) => method === 'turn/start').params.effort, 'medium');

  await client.close();
});

test('Codexが持っていないモデルを設定したら、黙って別のモデルへ落とさずに止まる', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-codex-runtime-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const protocol = createFakeProtocol({ models: [FAST_MODEL, DEEP_MODEL] });
  const client = new CodexAppServer({
    runtimeDir,
    spawnProcess: () => protocol.child,
    models: { review: { model: 'gpt-9-imaginary' } }
  });

  await assert.rejects(
    client.createThread({ ephemeral: true, purpose: 'review' }),
    /aiReviewModel がCodexにありません: gpt-9-imaginary.*gpt-5\.6-luna, gpt-5\.6-codex/s,
    '設定したつもりの人が気づけるように、使えるモデルまで出す'
  );

  await client.close();
});

const FAST_MODEL = {
  id: 'gpt-5.6-luna',
  supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'low' }],
  defaultReasoningEffort: 'low'
};

const DEEP_MODEL = {
  id: 'gpt-5.6-codex',
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }
  ],
  defaultReasoningEffort: 'medium'
};

function createFakeProtocol({ models = [DEFAULT_MODEL] } = {}) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const messages = [];
  let input = '';

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      const lines = input.split('\n');
      input = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line);
        messages.push(message);
        respond(message);
      }
      callback();
    }
  });

  function send(message) {
    stdout.write(`${JSON.stringify(message)}\n`);
  }

  function respond(message) {
    if (message.id === undefined) return;
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    if (message.method === 'model/list') send({ id: message.id, result: { data: models } });
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread-read-only' } } });
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      setImmediate(() => {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-read-only', turnId: 'turn-1', delta: '{"translation":"実行する"}' }
        });
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-read-only',
            turn: {
              id: 'turn-1',
              status: 'completed',
              items: [{ type: 'agentMessage', text: '{"translation":"実行する"}' }]
            }
          }
        });
      });
    }
  }

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill() {
      this.exitCode = 0;
      stdout.end();
      stderr.end();
      this.emit('exit', 0, null);
      return true;
    }
  });
  return { child, messages };
}
