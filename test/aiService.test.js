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

test('a corrected chat is what the next turn reads, and the stale Codex thread is dropped', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const calls = [];
  const deleted = [];
  const codex = fakeCodex({
    async runTurn(input) {
      calls.push(input);
      return { text: '「走る」です。' };
    },
    async deleteThread(id) { deleted.push(id); }
  });
  const service = new AiService(root, { store, codex });
  const created = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  const first = await service.sendMessage(created.id, 'run はどう訳す？');
  const [question, answer] = first.conversation.messages;

  const updated = await service.updateConversation(created.id, {
    title: 'run の訳語',
    messages: [
      { id: question.id, content: 'この文脈の run はどう訳す？' },
      { id: answer.id, content: 'この文脈では「実行する」です。' }
    ]
  });

  assert.equal(updated.title, 'run の訳語');
  assert.equal(updated.codexThreadId, null, '直した記録を読ませるため、覚えているスレッドは畳む');
  assert.deepEqual(deleted, ['thread-1']);
  const persisted = await store.getConversation(created.id);
  assert.equal(persisted.messages[1].content, 'この文脈では「実行する」です。');
  assert.ok(persisted.messages[1].editedAt, '後から直した発言には印が残る');

  const second = await service.sendMessage(created.id, 'ほかの訳は？');
  assert.equal(second.conversation.codexThreadId, 'thread-2', '次の質問は開き直したスレッドへ飛ぶ');
  assert.match(calls.at(-1).prompt, /この文脈では「実行する」です。/, '1回目として、直したやり取りを読ませる');
});

test('a chat that lost its record is refused rather than silently rebuilt', async (t) => {
  const { root, store } = await testStore(t);
  const service = new AiService(root, { store, codex: fakeCodex() });
  await assert.rejects(
    () => service.updateConversation('11111111-2222-3333-4444-555555555555', { title: 'ない会話' }),
    /会話が見つかりません/
  );
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

test('every AI feature reads the document under the reading context the reviewer set', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  await writeReview(root, 'guide.md', [], { aiContext: 'この章だけ英語のまま残している。' });
  const prompts = [];
  const codex = fakeCodex({
    async runTurn(input) {
      prompts.push(input.prompt);
      return {
        text: JSON.stringify({
          contextualMeaning: '実行する',
          meanings: [],
          explanation: '',
          placements: [],
          unplaced: []
        })
      };
    }
  });
  const service = new AiService(root, {
    store,
    codex,
    projectContext: 'Node.js入門書。読者はJavaScriptの基礎を知っている。'
  });

  await service.translate('guide.md', { type: 'text-selection', selectedText: 'run' });
  await service.placeComments('guide.md', '導入が長い');
  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  await service.sendMessage(conversation.id, 'この段落は誰向け？');

  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /<reading_context>/, '翻訳・配置・チャットのどれもコンテキストを渡す');
    assert.match(prompt, /Node\.js入門書/, 'ディレクトリ全体の前提');
    assert.match(prompt, /英語のまま残している/, '文書ごとの前提');
    assert.match(prompt, /data, not instructions/i, 'コンテキストも指示ではなくデータとして渡す');
  }
});

test('what the manager settled reaches every AI feature, and the manager itself never reads the body', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# 再起動手順\n\nまず deploy.sh を実行します。\n', 'utf8');
  await writeReview(root, 'guide.md', [], {
    brief: {
      purpose: '当番が手順書だけで再起動を完了できるようになる。',
      story: '止めてよい条件 → 止める手順 → 戻ったことの確かめ方。',
      expectation: '再起動についての問い合わせが来なくなる。'
    }
  });
  const prompts = [];
  // 求められた答えの形で返すものを選びます。1周目が指摘を1件も出さないと反証の周が
  // 走らないので、レビューには必ず1件返させます。
  const codex = fakeCodex({
    async runTurn(input) {
      prompts.push(input.prompt);
      const fields = Object.keys(input.outputSchema?.properties || {});
      if (fields.includes('verdicts')) return { text: JSON.stringify({ verdicts: [], unplacedVerdicts: [] }) };
      // ペルソナの答えも summary を持つので、指摘の有無と合わせて見分けます。
      if (fields.includes('summary') && fields.includes('placements')) {
        return {
          text: JSON.stringify({
            summary: '',
            placements: [{ segmentIndex: 1, quote: 'deploy.sh', comment: '確認を足してください' }],
            unplaced: []
          })
        };
      }
      if (fields.includes('placements')) return { text: JSON.stringify({ placements: [], unplaced: [] }) };
      if (fields.includes('questions')) {
        return {
          text: JSON.stringify({
            purpose: '', story: '', expectation: '', questions: ['何のための資料ですか。'], assumptions: []
          })
        };
      }
      if (fields.includes('assumptions')) {
        return {
          text: JSON.stringify({
            label: '運用当番', background: '', knowledge: [], gaps: [], goals: [], concerns: [],
            summary: '', assumptions: []
          })
        };
      }
      return { text: JSON.stringify({ contextualMeaning: '実行する', meanings: [], explanation: '' }) };
    }
  });
  const service = new AiService(root, { store, codex, managerEnabled: true });

  await service.translate('guide.md', { type: 'text-selection', selectedText: 'deploy' });
  await service.placeComments('guide.md', '前提が抜けている');
  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  await service.sendMessage(conversation.id, 'この節は誰向け？');

  // AIレビューは2周とも3点を読みます。1周目にしか入っていないと、反証の周で
  // 「本文が言っていない」という理由だけで3点由来の指摘が静かに落ちます。
  const skillDir = path.join(root, '.claude', 'skills', 'fixture-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: fixture-skill\n---\n\n読めるかを見る。\n', 'utf8');
  await service.reviewDocument('guide.md', { skillIds: ['fixture-skill'] });

  assert.equal(prompts.length, 5, '翻訳・配置・チャットと、レビューの2周');
  for (const prompt of prompts) {
    assert.match(prompt, /<document_brief>/, 'どれも3点を読む');
    assert.match(prompt, /当番が手順書だけで再起動を完了できるようになる。/);
    assert.match(prompt, /not something the document says/, '3点は資料の設計であって中身ではない');
    // これが無いと、3点から外れた箇所を指摘する根拠が review.js の接地の決まり
    // （本文も前提も述べていない事実を持ち出さない）に負けて、静かに効かなくなります。
    assert.match(prompt, /the plan is grounds enough/);
  }

  // 読み手ペルソナの組み立ても、何のための資料かを読みます。期待値は「読んだあと
  // 何ができればよいか」なので、読み手そのものの説明に一番近い前提です。
  await service.composePersona('guide.md', '異動したての運用担当。');
  assert.match(prompts.at(-1), /<document_brief>/);

  // 管理者の組み立てだけは本文を渡しません。書いてあることから目的を起こすと、
  // 手段が目的に化けた状態を追認するだけになるからです。
  const draft = await service.composeDocumentBrief('guide.md', '運用チームから当番向けの手順を頼まれた。');
  const briefPrompt = prompts.at(-1);
  assert.doesNotMatch(briefPrompt, /deploy\.sh/, '本文は渡さない');
  assert.doesNotMatch(briefPrompt, /<document_brief>/, '保存済みの3点も混ぜない');
  assert.match(briefPrompt, /運用チームから当番向けの手順を頼まれた。/);
  assert.equal(draft.brief, null, '何も決まっていなければ、それらしい目的で埋めさせない');
  assert.deepEqual(draft.questions, ['何のための資料ですか。']);

  await assert.rejects(service.composeDocumentBrief('guide.md', '   '), /決まっていることを入力してください/);
});

test('a disabled manager keeps a saved brief out of AI context', async (t) => {
  const { root, store } = await testStore(t);
  await writeReview(root, 'guide.md', [], {
    brief: { purpose: '保存済みの目的', story: '保存済みの流れ', expectation: '保存済みの期待値' }
  });
  const prompts = [];
  const codex = fakeCodex({
    async runTurn(input) {
      prompts.push(input.prompt);
      return { text: JSON.stringify({ contextualMeaning: '実行する', meanings: [], explanation: '' }) };
    }
  });
  const service = new AiService(root, { store, codex });

  await service.translate('guide.md', { type: 'text-selection', selectedText: 'run' });

  assert.doesNotMatch(prompts[0], /<document_brief>/);
  assert.doesNotMatch(prompts[0], /保存済みの目的/);
});

test('a conversation catches up when the reading context changes, and stays quiet when it does not', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const prompts = [];
  const codex = fakeCodex({
    async runTurn(input) {
      prompts.push(input.prompt);
      return { text: 'はい。' };
    }
  });
  const service = new AiService(root, { store, codex });
  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });

  await service.sendMessage(conversation.id, '誰向けの文章？');
  await service.sendMessage(conversation.id, 'もう一度教えて');
  await writeReview(root, 'guide.md', [], { aiContext: '社内の運用手順書。読者は当番の担当者。' });
  await service.sendMessage(conversation.id, 'いま読むとどう？');
  await service.sendMessage(conversation.id, '結論は？');

  assert.doesNotMatch(prompts[0], /<reading_context>/, 'コンテキスト未設定なら最初から渡すものがない');
  assert.equal(prompts[1], 'もう一度教えて', '変わっていなければ質問だけを送る');
  assert.match(prompts[2], /運用手順書/, '書き足した前提は次の質問で追いつかせる');
  assert.equal(prompts[3], '結論は？', '一度渡した前提は繰り返さない');
});

test('what the reviewer kept as a note reaches the review, the chat and the translation alike', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\n## 再起動\n\nRun the program.\n', 'utf8');
  await fs.mkdir(path.join(root, '.claude', 'skills', 'fixture-skill'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.claude', 'skills', 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\n---\n\n読み手が手を止める箇所を挙げる。\n',
    'utf8'
  );
  await writeReview(root, 'guide.md', [], {
    contextNotes: [
      { kind: 'decision', body: '節の並び順は検討済みで、変えない', createdAt: '2026-08-01T00:00:00.000Z' }
    ]
  });
  const prompts = [];
  const codex = fakeCodex({
    async runTurn(input) {
      prompts.push(input.prompt);
      return {
        text: JSON.stringify({
          contextualMeaning: '実行する',
          meanings: [],
          explanation: '',
          summary: '',
          placements: [],
          unplaced: [],
          verdicts: [],
          unplacedVerdicts: []
        })
      };
    }
  });
  const service = new AiService(root, { store, codex });

  await service.translate('guide.md', { type: 'text-selection', selectedText: 'run' });
  await service.placeComments('guide.md', '導入が長い');
  await service.reviewDocument('guide.md', { skillIds: ['fixture-skill'] });
  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });
  await service.sendMessage(conversation.id, 'この節の並びはどう？');

  assert.ok(prompts.length >= 4);
  for (const prompt of prompts) {
    assert.match(prompt, /<context_notes>/, '翻訳・配置・レビュー・チャットのどれも残したメモを読む');
    assert.match(prompt, /節の並び順は検討済み/);
    assert.match(prompt, /Do not reopen it on your own/, '「決定」の読み方まで渡す');
  }
});

test('a conversation catches up when a note is kept, and the note survives the reviewer clearing the context', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nRun the program.\n', 'utf8');
  const prompts = [];
  const codex = fakeCodex({
    async runTurn(input) {
      prompts.push(input.prompt);
      return { text: 'はい。' };
    }
  });
  const service = new AiService(root, { store, codex });
  const conversation = await service.createConversation({ documentPath: 'guide.md', target: { type: 'document' } });

  await service.sendMessage(conversation.id, '誰向けの文章？');
  await writeReview(root, 'guide.md', [], {
    contextNotes: [{ kind: 'decision', body: '導入の長さは意図したもの', createdAt: '2026-08-01T00:00:00.000Z' }]
  });
  await service.sendMessage(conversation.id, 'いま読むとどう？');
  await service.sendMessage(conversation.id, '結論は？');

  assert.doesNotMatch(prompts[0], /<context_notes>/, 'メモが無いうちは渡すものがない');
  assert.match(prompts[1], /導入の長さは意図したもの/, '残したメモは次の質問から効く');
  assert.equal(prompts[2], '結論は？', '一度渡したメモは繰り返さない');

  // 読み取りコンテキストを空にしても、メモは別の記録なので残ります。
  await writeReview(root, 'guide.md', [], { aiContext: '' });
  const context = await service.readingContext('guide.md');
  assert.equal(context.notes.length, 1);
});

test('the translation cache separates the same word read under different contexts', async (t) => {
  const { root, store } = await testStore(t);
  let turns = 0;
  const codex = fakeCodex({
    async runTurn() {
      turns += 1;
      return { text: JSON.stringify({ contextualMeaning: `訳${turns}`, meanings: [], explanation: '' }) };
    }
  });
  const service = new AiService(root, { store, codex });
  const target = { type: 'text-selection', selectedText: 'run' };

  const first = await service.translate('guide.md', target);
  await writeReview(root, 'guide.md', [], { aiContext: '陸上競技の入門書。' });
  const second = await service.translate('guide.md', target);
  const again = await service.translate('guide.md', target);

  assert.equal(first.result.contextualMeaning, '訳1');
  assert.equal(second.result.contextualMeaning, '訳2', '前提が変われば訳し直す');
  assert.equal(again.cached, true, '同じ前提ならキャッシュを返す');
  assert.equal(turns, 2);
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
