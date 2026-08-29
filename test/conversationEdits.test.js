import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConversationEdits } from '../src/conversationEdits.js';

const NOW = new Date('2026-08-30T09:00:00.000Z');

function conversation() {
  return {
    id: 'conversation-1',
    title: 'Run the program.',
    codexThreadId: 'thread-1',
    updatedAt: '2026-08-01T00:00:10.000Z',
    messages: [
      { id: 'user-1', role: 'user', content: 'run はどう訳す？', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'assistant-1', role: 'assistant', content: '「走る」です。', createdAt: '2026-08-01T00:00:10.000Z' }
    ]
  };
}

test('a corrected answer keeps its place and says it was edited', () => {
  const { conversation: next, transcriptChanged } = applyConversationEdits(conversation(), {
    messages: [
      { id: 'user-1', content: 'run はどう訳す？' },
      { id: 'assistant-1', content: 'この文脈では「実行する」です。' }
    ]
  }, NOW);

  assert.equal(transcriptChanged, true);
  assert.deepEqual(next.messages.map(({ id }) => id), ['user-1', 'assistant-1']);
  assert.equal(next.messages[1].content, 'この文脈では「実行する」です。');
  assert.equal(next.messages[1].editedAt, NOW.toISOString());
  assert.equal(next.messages[0].editedAt, undefined, '触っていない発言には印を付けない');
  assert.equal(next.updatedAt, NOW.toISOString());
});

test('a message left out of the list is the way to delete it', () => {
  const { conversation: next, transcriptChanged } = applyConversationEdits(conversation(), {
    messages: [{ id: 'user-1', content: 'run はどう訳す？' }]
  }, NOW);

  assert.equal(transcriptChanged, true);
  assert.deepEqual(next.messages.map(({ id }) => id), ['user-1']);
});

test('renaming a conversation leaves the transcript alone', () => {
  const { conversation: next, transcriptChanged } = applyConversationEdits(conversation(), {
    title: '  run の訳語  '
  }, NOW);

  assert.equal(transcriptChanged, false, '題名はモデルが読む文面ではない');
  assert.equal(next.title, 'run の訳語');
  assert.equal(next.messages.length, 2);
});

test('sending the same text back is not a change', () => {
  const { transcriptChanged } = applyConversationEdits(conversation(), {
    messages: [
      { id: 'user-1', content: 'run はどう訳す？' },
      { id: 'assistant-1', content: '「走る」です。' }
    ]
  }, NOW);

  assert.equal(transcriptChanged, false);
});

test('edits that would quietly lose a message or leave an empty one are refused', () => {
  assert.throws(
    () => applyConversationEdits(conversation(), { messages: [{ id: 'user-9', content: 'あれ？' }] }, NOW),
    /この会話に無いやり取り/
  );
  assert.throws(
    () => applyConversationEdits(conversation(), { messages: [{ id: 'user-1', content: '   ' }] }, NOW),
    /空にはできません|空にできません/
  );
  assert.throws(
    () => applyConversationEdits(conversation(), { messages: [{ id: 'user-1', content: 'あ'.repeat(12_001) }] }, NOW),
    /長すぎます/
  );
  assert.throws(() => applyConversationEdits(conversation(), { title: '' }, NOW), /題名は空にできません/);
  assert.throws(() => applyConversationEdits(conversation(), { title: 'あ'.repeat(49) }, NOW), /48文字まで/);
  assert.throws(() => applyConversationEdits(conversation(), {}, NOW), /題名か、残すやり取り/);
});
