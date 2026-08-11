import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';

test('short contextual translations return multiple meanings and reuse the local cache', async (t) => {
  const { root, store } = await testStore(t);
  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      return {
        text: JSON.stringify({
          source: 'run',
          meanings: [
            { translation: '実行する', nuance: 'プログラムを動かす' },
            { translation: '走る', nuance: '人や動物が移動する' }
          ],
          contextualMeaning: '実行する',
          explanation: 'program が目的語だからです。'
        })
      };
    }
  });
  const service = new AiService(root, { store, codex });
  const target = {
    type: 'text-selection',
    selectedText: 'run',
    contextBefore: 'Click this button to',
    contextAfter: 'the program.'
  };

  const first = await service.translate('guide.md', target);
  const second = await service.translate('guide.md', target);

  assert.equal(first.kind, 'term');
  assert.equal(first.result.contextualMeaning, '実行する');
  assert.equal(first.result.meanings.length, 2);
  assert.equal(second.cached, true);
  assert.equal(turns.length, 1, 'same text and context should not invoke Codex twice');
  assert.ok(turns[0].outputSchema, 'translation is constrained to structured JSON');
  assert.match(turns[0].prompt, /untrusted|data, not instructions/i);
  assert.match(turns[0].prompt, /the program/);
});

test('chat keeps a local transcript and continues the same Codex thread', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const calls = [];
  const codex = fakeCodex({
    async runTurn(input) {
      calls.push(input);
      return { text: calls.length === 1 ? 'この文では「プログラムを実行する」です。' : 'はい、その理解で合っています。' };
    }
  });
  const service = new AiService(root, { store, codex });
  const created = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });

  assert.match(created.target.selectedText, /Run the program/);
  await fs.writeFile(path.join(root, 'guide.md'), '# Changed after snapshot\n', 'utf8');
  const first = await service.sendMessage(created.id, 'run はどう訳す？');
  const second = await service.sendMessage(created.id, 'この理解で合っている？');

  assert.equal(first.conversation.codexThreadId, 'thread-1');
  assert.deepEqual(codex.resumed, ['thread-1']);
  assert.equal(second.conversation.messages.length, 4);
  assert.deepEqual(second.conversation.messages.map(({ role }) => role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(calls[0].prompt, /Run the program/);
  assert.doesNotMatch(calls[0].prompt, /Changed after snapshot/);
  assert.equal(calls[1].prompt, 'この理解で合っている？');

  const persisted = await store.getConversation(created.id);
  assert.equal(persisted.messages.at(-1).content, 'はい、その理解で合っています。');
});

async function testStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-service-root-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-service-data-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf8');
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));
  return { root, store: new AiStore(root, { dataDir }) };
}

function fakeCodex(overrides = {}) {
  let nextThread = 1;
  return {
    model: 'fast-test-model',
    effort: 'low',
    resumed: [],
    async start() {},
    async createThread() { return `thread-${nextThread++}`; },
    async resumeThread(id) { this.resumed.push(id); return id; },
    async deleteThread() {},
    async runTurn() { return { text: 'test response' }; },
    async close() {},
    ...overrides
  };
}
