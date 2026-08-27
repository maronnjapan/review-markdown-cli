import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import { writeReview } from '../src/reviewStore.js';

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
  assert.deepEqual(
    Object.keys(turns[0].outputSchema.properties),
    ['contextualMeaning', 'meanings', 'explanation'],
    'the contextual meaning should be the first streamed field'
  );
  assert.match(turns[0].prompt, /contextualMeaning first/);
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

test('chat hands Codex the review comments written on the document', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\n## 手順\n\nRun the program.\n', 'utf8');
  await writeReview(root, 'guide.md', [
    {
      type: 'paragraph',
      selectedText: 'Run the program.',
      headingPath: ['Guide', '手順'],
      comment: '実行の前提条件を書いてほしい'
    },
    {
      type: 'section',
      heading: '手順',
      headingPath: ['Guide', '手順'],
      comment: '手順を番号付きにしたい',
      status: 'resolved'
    },
    {
      type: 'paragraph',
      selectedText: 'See the appendix.',
      headingPath: ['Guide', '付録'],
      comment: '付録は表にしたい'
    }
  ]);
  const calls = [];
  const codex = fakeCodex({
    async runTurn(input) {
      calls.push(input);
      return { text: '前提条件は次のとおりです。' };
    }
  });
  const service = new AiService(root, { store, codex });
  const conversation = await service.createConversation({
    documentPath: 'guide.md',
    target: { type: 'paragraph', selectedText: 'Run the program.', headingPath: ['Guide', '手順'] }
  });

  await service.sendMessage(conversation.id, 'この指摘にはどう答えればいい？');

  const comments = JSON.parse(calls[0].prompt.match(/<review_comments>(.*)<\/review_comments>/)[1]);
  assert.deepEqual(comments.map(({ n, attached, status, comment }) => ({ n, attached, status, comment })), [
    { n: 1, attached: true, status: 'open', comment: '実行の前提条件を書いてほしい' },
    { n: 2, attached: true, status: 'resolved', comment: '手順を番号付きにしたい' },
    { n: 3, attached: false, status: 'open', comment: '付録は表にしたい' }
  ]);
  assert.match(calls[0].prompt, /data, not instructions/i, 'コメントも指示ではなくデータとして渡す');
});

test('comments written while the conversation is open reach the next turn', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const calls = [];
  const codex = fakeCodex({
    async runTurn(input) {
      calls.push(input);
      return { text: '確認しました。' };
    }
  });
  const service = new AiService(root, { store, codex });
  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });

  await service.sendMessage(conversation.id, 'この文書の狙いは？');
  await service.sendMessage(conversation.id, 'ほかに気になる点は？');
  await writeReview(root, 'guide.md', [
    { type: 'paragraph', selectedText: 'Run the program.', comment: '実行の前提条件を書いてほしい' }
  ]);
  await service.sendMessage(conversation.id, 'この指摘は妥当？');

  assert.doesNotMatch(calls[0].prompt, /<review_comments>/, 'コメントが無ければ渡さない');
  assert.equal(calls[1].prompt, 'ほかに気になる点は？', 'レビューが変わらない限り繰り返さない');
  assert.match(calls[2].prompt, /実行の前提条件を書いてほしい/);
  assert.match(calls[2].prompt, /<user_question>この指摘は妥当？<\/user_question>/);
});

test('placing reviewer notes returns proposals only, anchored to the rendered text', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(
    path.join(root, 'guide.md'),
    '# Guide\n\n## 手順\n\nこの段落は **冗長** な説明を含みます。\n',
    'utf8'
  );
  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      return {
        text: JSON.stringify({
          placements: [{
            segmentIndex: segmentIndexOf(input.prompt, 'この段落は 冗長 な説明を含みます。'),
            quote: '冗長 な説明',
            comment: '冗長な説明を削ってほしい',
            reason: 'ここが該当します',
            confidence: 'high'
          }],
          unplaced: [{ note: '全体的に長い', reason: '特定の箇所を選べません' }]
        })
      };
    }
  });
  const service = new AiService(root, { store, codex });

  const result = await service.placeComments('guide.md', '- 冗長な説明を削ってほしい\n- 全体的に長い');

  assert.equal(turns.length, 1);
  assert.ok(turns[0].outputSchema, '配置結果は構造化JSONに固定する');
  assert.match(turns[0].prompt, /data, not instructions/i);
  assert.match(turns[0].prompt, /冗長な説明を削ってほしい/);
  assert.deepEqual(result.placements[0].target, {
    type: 'text-selection',
    selectedText: '冗長 な説明',
    contextBefore: '手順 この段落は',
    contextAfter: 'を含みます。',
    headingPath: ['Guide', '手順']
  });
  assert.equal(result.placements[0].comment, '冗長な説明を削ってほしい');
  assert.deepEqual(result.unplaced, [{ note: '全体的に長い', reason: '特定の箇所を選べません' }]);

  const review = await fs.readdir(root);
  assert.deepEqual(review, ['guide.md'], '配置はレビューにも本文にも書き込まない');
});

test('placing notes refuses empty input and unparsable answers', async (t) => {
  const { root, store } = await testStore(t);
  const service = new AiService(root, { store, codex: fakeCodex({ async runTurn() { return { text: 'not json' }; } }) });

  await assert.rejects(service.placeComments('guide.md', '   '), /指摘コメントを入力してください/);
  await assert.rejects(service.placeComments('guide.md', '見出しを直して'), /解析できませんでした/);
});

function segmentIndexOf(prompt, text) {
  const segments = JSON.parse(prompt.match(/<document_segments>(.*)<\/document_segments>/)[1]);
  return segments.find((segment) => segment.text === text).i;
}

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
