import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiStore, defaultAiDataDir, projectStorageKey, translationCacheKey } from '../src/aiStore.js';

test('AI conversations and translations are stored outside the reviewed project', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-project-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-data-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));

  const store = new AiStore(root, { dataDir });
  const conversation = {
    id: 'conversation-1234',
    documentPath: 'guide.md',
    title: 'run',
    messages: [{ role: 'user', content: 'What does this mean?' }],
    updatedAt: '2026-08-11T00:00:00.000Z'
  };
  await store.saveConversation(conversation);

  assert.deepEqual((await store.getConversation(conversation.id)).messages, conversation.messages);
  assert.equal((await store.listConversations('other.md')).length, 0);
  assert.equal((await store.listConversations('guide.md')).length, 1);
  assert.deepEqual(await fs.readdir(root), [], 'reviewed project is never used for AI persistence');

  const key = translationCacheKey({ selectedText: 'run', contextAfter: 'the program' });
  await store.saveTranslation(key, { kind: 'term', result: { contextualMeaning: '実行する' } });
  assert.equal((await store.getTranslation(key)).result.contextualMeaning, '実行する');

  const projectDir = path.join(dataDir, 'projects', projectStorageKey(root));
  const storedFile = path.join(projectDir, 'conversations', `${conversation.id}.json`);
  assert.equal((await fs.stat(storedFile)).mode & 0o777, 0o600);

  await store.deleteConversation(conversation.id);
  assert.equal(await store.getConversation(conversation.id), null);
});

test('the AI data directory can be overridden without using the project directory', () => {
  assert.equal(
    defaultAiDataDir({ REVIEW_MARKDOWN_DATA_DIR: './private-ai-data' }, 'linux'),
    path.resolve('./private-ai-data')
  );
});
