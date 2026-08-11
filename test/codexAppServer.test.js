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

function createFakeProtocol() {
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
    if (message.method === 'model/list') {
      send({
        id: message.id,
        result: {
          data: [{
            id: 'gpt-5.6-luna',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            defaultReasoningEffort: 'low'
          }]
        }
      });
    }
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
