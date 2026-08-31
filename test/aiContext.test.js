import assert from 'node:assert/strict';
import test from 'node:test';
import { aiContextBlock, normalizeAiContext, readAiContext, resolveAiContext } from '../src/aiContext.js';
import { MAX_AI_CONTEXT_CHARS } from '../src/aiLimits.js';

test('the reading context is refused when it comes in longer than the limit', () => {
  assert.equal(normalizeAiContext('  入門書の第3章。  '), '入門書の第3章。', '前後の空白は落とす');
  assert.equal(normalizeAiContext(undefined), '', '未設定は前提なし');
  assert.equal(normalizeAiContext('あ'.repeat(MAX_AI_CONTEXT_CHARS)), 'あ'.repeat(MAX_AI_CONTEXT_CHARS));

  assert.throws(
    () => normalizeAiContext('あ'.repeat(MAX_AI_CONTEXT_CHARS + 1)),
    new RegExp(`読み取りコンテキスト が長すぎます（${MAX_AI_CONTEXT_CHARS}文字まで）`)
  );
  assert.throws(() => normalizeAiContext(['入門書'], 'aiContext'), /文字列で指定してください/);
});

test('a context saved before the limit came down still reaches the model', () => {
  // 上限は下げることがあります。読むときも断ると、下げた日から、前に書いた前提を持つ
  // 文書だけAIが動かなくなります。短くするのは次に書き換えるときで足ります。
  const saved = `以前に書いた前提。${'あ'.repeat(MAX_AI_CONTEXT_CHARS)}`;

  assert.equal(readAiContext(saved), saved, '保存済みの値は長さで断らない');
  assert.equal(readAiContext(undefined), '', '未設定は前提なし');
  assert.equal(readAiContext(['入門書']), '', '壊れた値は前提なしとして読む');

  const context = resolveAiContext({ project: saved, document: saved });
  assert.equal(context.document, saved);
  assert.match(aiContextBlock(context), /以前に書いた前提。/);
});
