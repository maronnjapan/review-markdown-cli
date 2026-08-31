import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import { AI_PROVIDERS, createAiClient } from '../src/aiProviders/index.js';
import { ClaudeClient } from '../src/aiProviders/claude.js';
import { LangChainClient, stripJsonFence } from '../src/aiProviders/langchain.js';
import { CodexAppServer } from '../src/codexAppServer.js';

/**
 * Codex以外のAIでも、レビューが同じ形で走ることを確かめます。
 *
 * どのAIも `AiService` からは同じ6つの操作にしか見えません（`aiProviders/turnClient.js`）。
 * ここで押さえるのは、その約束が守られていること、用途ごとにモデルが切り替わること、
 * そして「向こうが何も覚えていない」ぶんをこちらが補っていることの3つです。
 */

test('設定に書いた名前で、走らせるAIが決まる', () => {
  assert.deepEqual(AI_PROVIDERS, ['codex', 'claude', 'langchain']);
  assert.ok(createAiClient({ runtimeDir: '/tmp/x' }) instanceof CodexAppServer, '既定はCodex');
  assert.ok(createAiClient({ provider: 'claude' }) instanceof ClaudeClient);
  assert.ok(
    createAiClient({
      provider: 'langchain',
      modelProvider: 'ollama',
      models: { assistant: { model: 'llama3' }, review: { model: 'llama3' } }
    }) instanceof LangChainClient
  );
  assert.throws(
    () => createAiClient({ provider: 'gemini' }),
    /使えないaiProviderです: gemini（使えるもの: codex, claude, langchain）/
  );
});

test('claudeは用途ごとにモデルと推論強度を切り替え、答えの形をスキーマで縛る', async () => {
  const { client, calls } = fakeClaude(['{"ok":true}', '{"ok":true}']);
  const claude = new ClaudeClient({ createClient: async () => client });

  const chat = await claude.createThread({ purpose: 'assistant' });
  await claude.runTurn({ threadId: chat, prompt: '訳して' });
  const review = await claude.createThread({ purpose: 'review' });
  await claude.runTurn({ threadId: review, prompt: '読んで', outputSchema: { type: 'object' } });

  assert.equal(calls[0].model, 'claude-opus-5');
  assert.equal(calls[0].output_config.effort, 'low', '翻訳とチャットは浅く読ませる');
  assert.equal(calls[0].output_config.format, undefined, 'スキーマを渡さなければ縛らない');
  assert.equal(calls[1].output_config.effort, 'high', 'レビューは深く読ませる');
  assert.deepEqual(calls[1].output_config.format, { type: 'json_schema', schema: { type: 'object' } });
  assert.match(calls[1].system, /meticulous, read-only reviewer/, '用途ごとの立場をsystemで渡す');
  assert.match(calls[1].system, /Never call tools/, '守らせる約束はどのAIでも同じ');
});

test('claudeは覚えていないので、やり取りはこちらが持って毎ターン渡し直す', async () => {
  const { client, calls } = fakeClaude(['はい', 'そうです']);
  const claude = new ClaudeClient({ createClient: async () => client });
  const thread = await claude.createThread({ purpose: 'assistant' });

  await claude.runTurn({ threadId: thread, prompt: '1つ目' });
  await claude.runTurn({ threadId: thread, prompt: '2つ目' });

  assert.deepEqual(calls[0].messages, [{ role: 'user', content: '1つ目' }]);
  assert.deepEqual(calls[1].messages, [
    { role: 'user', content: '1つ目' },
    { role: 'assistant', content: 'はい' },
    { role: 'user', content: '2つ目' }
  ]);

  // 畳んだスレッドは再開させません。黙って新しいスレッドを返すと、前のやり取りを
  // 覚えている前提で続きが飛んできます。
  await claude.deleteThread(thread);
  await assert.rejects(claude.resumeThread(thread), /会話の記録が残っていません/);
});

test('画面から選び直したモデルは、続いているスレッドの次のターンから使われる', async () => {
  const { client, calls } = fakeClaude(['はい', 'そうです']);
  const claude = new ClaudeClient({ createClient: async () => client });
  const thread = await claude.createThread({ purpose: 'assistant' });
  await claude.runTurn({ threadId: thread, prompt: '1つ目' });

  claude.setModels({ assistant: { model: 'claude-sonnet-5', effort: 'medium' } });
  await claude.runTurn({ threadId: thread, prompt: '2つ目' });

  assert.equal(calls[0].model, 'claude-opus-5');
  assert.equal(calls[1].model, 'claude-sonnet-5', '選び直したモデルへ切り替わる');
  assert.equal(calls[1].output_config.effort, 'medium');
  assert.equal(calls[1].messages.length, 3, 'スレッドは畳まれず、やり取りは残る');
  assert.equal(claude.reviewModel, 'claude-opus-5', '書き換えなかった用途は既定のまま');
});

test('claudeが受け付けない推論強度は、選び直しのときも断り、いまのモデルを残す', () => {
  const claude = new ClaudeClient({ createClient: async () => fakeClaude([]).client });

  assert.throws(
    () => claude.setModels({ assistant: { model: 'claude-opus-5', effort: 'none' } }),
    /設定したaiEffort をClaudeは受け付けません: none/
  );
  assert.deepEqual(claude.profiles.assistant, { model: 'claude-opus-5', effort: 'low' });
});

test('選べるモデルの一覧は、持っているAIだけが答える', async () => {
  const { client } = fakeClaude([]);
  client.models.list = async () => ({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] });
  const claude = new ClaudeClient({ createClient: async () => client });

  assert.deepEqual(await claude.listModels(), [], '起動前は鍵も無いので答えられない');
  await claude.start();
  assert.deepEqual(await claude.listModels(), [
    { id: 'claude-opus-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
  ]);

  // LangChainは繋ぎ先がモデルによって変わるので一覧を持てず、推論強度も共通の指定がありません。
  const langchain = new LangChainClient({
    modelProvider: 'ollama',
    models: { assistant: { model: 'llama3' }, review: { model: 'llama3' } }
  });
  assert.deepEqual(await langchain.listModels(), []);
  assert.equal(langchain.supportsEffort, false);
  assert.equal(claude.supportsEffort, true);
});

test('claudeが返した失敗は、次に何をすればよいかが分かる文面になる', () => {
  const claude = new ClaudeClient({});
  assert.match(claude.describeError(new Error('401 authentication_error')), /資格情報を設定してください/);
  assert.match(claude.describeError(new Error('429 rate_limit_error')), /利用上限に達しました/);
  assert.equal(claude.describeError(new Error('socket hang up')), 'socket hang up');
});

test('claudeで走らせても、翻訳もチャットもCodexのときと同じように動く', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const { client } = fakeClaude([
    JSON.stringify({ contextualMeaning: '実行する', meanings: [], explanation: '' }),
    'この段落は運用当番向けです。'
  ]);
  const service = new AiService(root, {
    store,
    client: new ClaudeClient({ createClient: async () => client })
  });

  const status = await service.status();
  assert.deepEqual(
    { available: status.available, provider: status.provider, label: status.label, model: status.model },
    { available: true, provider: 'claude', label: 'Claude', model: 'claude-opus-5' }
  );

  const translated = await service.translate('guide.md', { type: 'text-selection', selectedText: 'run' });
  assert.equal(translated.result.contextualMeaning, '実行する');

  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  const { message } = await service.sendMessage(conversation.id, 'この段落は誰向け？');
  assert.equal(message.content, 'この段落は運用当番向けです。');
});

test('langchainはモデル名を推測しない。書いていなければ、どのキーに書くかを言って止まる', () => {
  assert.throws(
    () => new LangChainClient({ modelProvider: 'ollama' }),
    /langchain で使うモデルが決まっていません。設定ファイルの aiModel にモデル名を書いてください/
  );
  assert.throws(
    () => new LangChainClient({ modelProvider: 'ollama', models: { assistant: { model: 'llama3.1' } } }),
    /aiReviewModel にモデル名を書いてください/
  );
});

test('langchainは送り先も推測しない。モデル名から推測させると、原稿の行き先が原稿側から決まる', () => {
  // aiModel はプロジェクト設定にも書けます。LangChainにモデル名から推測させると、
  // レビュー対象のリポジトリが `gpt-4o` と書くだけで送り先を選べてしまいます。
  assert.throws(
    () => new LangChainClient({ models: { assistant: { model: 'gpt-4o' }, review: { model: 'gpt-4o' } } }),
    /aiModelProvider に anthropic \/ openai \/ ollama などを書いてください/
  );
});

test('Codexの推論強度を持ち越したまま切り替えても、起動の前に断る', () => {
  // `none` はCodexにはあってClaudeには無い強度です。レビューを頼んだ時点で断られると、
  // レビュアーは指摘を書いたあとで設定を直すことになります。
  assert.throws(
    () => new ClaudeClient({ models: { assistant: { effort: 'none' } } }),
    /設定したaiEffort をClaudeは受け付けません: none（使える強度: low, medium, high, xhigh, max）/
  );
  assert.throws(
    () => new ClaudeClient({ models: { review: { effort: 'ultra' } } }),
    /設定したaiReviewEffort をClaudeは受け付けません: ultra/
  );
});

test('claudeは資格情報と名指ししたモデルを、画面に「使える」と出す前に確かめる', async () => {
  const { client, retrieved } = fakeClaude([]);
  await new ClaudeClient({
    models: { assistant: { model: 'claude-haiku-4-5' } },
    createClient: async () => client
  }).start();
  assert.deepEqual(retrieved, ['claude-haiku-4-5', 'claude-opus-5'], '用途ごとのモデルを1つずつ確かめる');

  const denied = new ClaudeClient({
    createClient: async () => fakeClaude([], {
      retrieve: () => { throw new Error('401 authentication_error: x-api-key header is required'); }
    }).client
  });
  await assert.rejects(denied.start(), /authentication_error/);
  assert.match(denied.describeError(new Error('401 authentication_error')), /資格情報を設定してください/);
});

test('スレッドIDは使い回さない。保存した会話が、別の用途のスレッドへ繋がらないように', async () => {
  const first = new ClaudeClient({ createClient: async () => fakeClaude([]).client });
  const second = new ClaudeClient({ createClient: async () => fakeClaude([]).client });
  const ids = [
    await first.createThread({ purpose: 'assistant' }),
    await first.createThread({ purpose: 'review' }),
    // 立ち上げ直した後の1本目。連番なら1本目と同じIDになります。
    await second.createThread({ purpose: 'assistant' })
  ];

  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^claude-[0-9a-f-]{36}$/);
});

test('空の答えはやり取りへ足さない。次のターンで中身の無い発言を渡し直さないため', async () => {
  const { client, calls } = fakeClaude(['', 'はい']);
  const claude = new ClaudeClient({ createClient: async () => client });
  const thread = await claude.createThread({ purpose: 'assistant' });

  assert.equal((await claude.runTurn({ threadId: thread, prompt: '1つ目' })).text, '');
  await claude.runTurn({ threadId: thread, prompt: '2つ目' });

  assert.deepEqual(calls[1].messages, [{ role: 'user', content: '2つ目' }]);
});

test('langchainは答えの形を言葉で頼み、コードフェンスで包まれても中身だけを返す', async () => {
  const calls = [];
  const chain = new LangChainClient({
    models: { assistant: { model: 'llama3.1' }, review: { model: 'llama3.1' } },
    modelProvider: 'ollama',
    initChatModel: async (model, options) => {
      calls.push({ model, options });
      return { stream: async (messages) => {
        calls.push({ messages });
        return chunks(['```json\n{"ok"', ':true}\n```']);
      } };
    }
  });

  const deltas = [];
  const thread = await chain.createThread({ purpose: 'review' });
  const { text } = await chain.runTurn({
    threadId: thread,
    prompt: '読んで',
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    onDelta: (delta) => deltas.push(delta)
  });

  assert.deepEqual(calls[0], { model: 'llama3.1', options: { modelProvider: 'ollama' } });
  assert.equal(calls[1].messages[0].role, 'system');
  assert.match(calls[1].messages[1].content, /Reply with JSON only/);
  assert.match(calls[1].messages[1].content, /"properties":\{"ok"/, 'スキーマそのものを見せて頼む');
  assert.equal(text, '{"ok":true}', '包みだけ外して、中身は触らない');
  assert.deepEqual(deltas, ['```json\n{"ok"', ':true}\n```'], '届いた差分はそのまま画面へ流す');

  // 共通の指定が無い推論強度は、設定されていても画面へ出しません。
  assert.equal(chain.effort, null);
  assert.equal(chain.reviewEffort, null);
});

test('包まれていない答えは、そのまま返す', () => {
  assert.equal(stripJsonFence('  {"ok":true}  '), '{"ok":true}');
  assert.equal(stripJsonFence('```\n[1,2]\n```'), '[1,2]');
});

test('答えを待っている最中に、同じスレッドへもう1つ投げさせない', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const chain = new LangChainClient({
    models: { assistant: { model: 'llama3.1' }, review: { model: 'llama3.1' } },
    modelProvider: 'ollama',
    initChatModel: async () => ({ stream: async () => { await held; return chunks(['はい']); } })
  });
  const thread = await chain.createThread({ purpose: 'assistant' });

  const first = chain.runTurn({ threadId: thread, prompt: '1つ目' });
  await assert.rejects(chain.runTurn({ threadId: thread, prompt: '2つ目' }), /既に回答を生成中です/);
  release();
  assert.equal((await first).text, 'はい');
});

test('中断すると、中断として返る', async () => {
  const controller = new AbortController();
  const chain = new LangChainClient({
    models: { assistant: { model: 'llama3.1' }, review: { model: 'llama3.1' } },
    modelProvider: 'ollama',
    initChatModel: async () => ({
      stream: async () => { controller.abort(); throw new Error('aborted by provider'); }
    })
  });
  const thread = await chain.createThread({ purpose: 'assistant' });

  await assert.rejects(
    chain.runTurn({ threadId: thread, prompt: '読んで', signal: controller.signal }),
    (error) => error.name === 'AbortError' && /生成を中止しました/.test(error.message)
  );
});

/* ---------------------------------------------------------------- *
 * 差し替え用の作り物
 * ---------------------------------------------------------------- */

/** Anthropic SDK のうち、このアプリが使う `messages.stream` だけを真似ます。 */
function fakeClaude(answers, { retrieve } = {}) {
  const calls = [];
  const retrieved = [];
  const client = {
    models: {
      async retrieve(model) {
        retrieved.push(model);
        if (retrieve) return retrieve(model);
        return { id: model };
      }
    },
    messages: {
      stream(body) {
        calls.push(body);
        const text = answers[calls.length - 1] ?? '';
        const listeners = [];
        return {
          on(event, listener) { if (event === 'text') listeners.push(listener); },
          async finalMessage() {
            for (const listener of listeners) listener(text);
            return { content: [{ type: 'text', text }] };
          }
        };
      }
    }
  };
  return { client, calls, retrieved };
}

/** LangChainの `stream()` が返す、`text` を持つチャンクの並び。 */
function chunks(texts) {
  return (async function* stream() {
    for (const text of texts) yield { text };
  })();
}

async function testStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-providers-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-providers-data-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));
  return { root, store: new AiStore(root, { dataDir }) };
}
