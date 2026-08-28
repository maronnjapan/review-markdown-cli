import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import { CodexAppServer } from '../src/codexAppServer.js';
import { aiContextBlock, resolveAiContext } from '../src/aiContext.js';
import { collectCommentContext, commentContextBlock } from '../src/commentContext.js';
import { personaBlock } from '../src/persona.js';
import { writeReview } from '../src/reviewStore.js';

/**
 * AIへ渡す文面そのものを固定するテストです。
 *
 * 文面は、書き換えるまで一字も変わってはいけません。読み取りコンテキストの描画は
 * `aiContext.js` が sha256 にして `revision` にし、それが翻訳キャッシュの鍵の一部に
 * なります（`aiStore.js` の `translationCacheKey`）。うっかり空白1つ変えただけで、
 * 利用者の手元のキャッシュは全件無効になり、同じ語をもう一度Codexへ聞きに行きます。
 *
 * そのため「意図した変更」と「事故」を、ここで分けます。プロンプトを整理しただけの
 * 変更ならハッシュは動きません。ハッシュが落ちたときは、文面を本当に変えたのか、
 * それとも移動の途中で崩したのかを必ず確かめてください。本当に変えたのなら、
 * 落ちたハッシュを書き換えるのが正しい直し方です。
 */

/** 固定入力。ここを変えるとすべてのハッシュが動くので、増やすときは追加だけにします。 */
const DOCUMENT = [
  '# 運用手順',
  '',
  'この手順は当番が読みます。',
  '',
  '## 再起動',
  '',
  'サービスを止めてから起動します。',
  ''
].join('\n');

const PERSONA = {
  source: 'ai',
  label: '運用当番の新人',
  background: '他チームから異動したばかりの運用担当。',
  knowledge: ['Linuxの基本操作'],
  gaps: ['この製品の構成'],
  goals: ['当番中に手順を見ながら作業する'],
  concerns: ['取り返しのつかない操作を踏まないか'],
  summary: '製品は初めてだが、手順があれば作業できる運用担当。',
  assumptions: ['「新人」から経験1年未満と想定しました'],
  input: '運用当番の新人。製品は初めて。'
};

const MANUAL_PERSONA = {
  source: 'manual',
  input: '運用当番の新人。\n製品は初めてで、手順書だけが頼り。'
};

const COMMENT = {
  id: 'comment-fixed-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  type: 'text-selection',
  status: 'open',
  selectedText: 'サービスを止めてから起動します。',
  headingPath: ['運用手順', '再起動'],
  comment: '止める前に確認することを書いてください。'
};

const SKILL = [
  '---',
  'name: fixture-skill',
  'title: 固定スキル',
  'description: スナップショット用の固定スキル。',
  '---',
  '',
  '# 見るところ',
  '',
  '読み手が手を止める箇所だけを挙げる。'
].join('\n');

const TARGET = {
  type: 'text-selection',
  selectedText: 'restart',
  contextBefore: 'You have to',
  contextAfter: 'the service.',
  headingPath: ['Operations', 'Restart']
};

const PASSAGE_TARGET = {
  type: 'paragraph',
  selectedText: 'Stop the service, then start it again. Check the log before you leave.',
  contextBefore: 'Restart procedure.',
  contextAfter: 'Escalate if it fails.',
  headingPath: ['Operations']
};

/**
 * 期待するハッシュ。左が「何の文面か」、右が sha256 です。
 * 文面を意図して変えたときだけ、ここを書き換えます。
 */
const EXPECTED = {
  'block:readingContext(project+document)': '0f0ecfe3f89bcc882ded3d7ef83c5e0b010d70f4b06d67edbd57cdac0e22deb1',
  'block:readingContext(all)': '14a622b3e6354b5453df1ff68160555b64496b78aa41a3483248b02c9f3e4a1e',
  'block:readingContext(personaOnly)': '23fb353a8c9e17eb35bf275869a4acdfe1983a907b08c3d19fa97c9309513113',
  'block:persona(ai)': '23fb353a8c9e17eb35bf275869a4acdfe1983a907b08c3d19fa97c9309513113',
  'block:persona(manual)': '91367577d26fcb16e2d1ed21d839e8b27d8ad5f4b51fb138c1499d2d84fa791b',
  'block:commentContext(some)': 'bd8844700f7878e71d277d2903d9f6dda7b142d9ab6511ac4d77b0cc4d4cb1ff',
  'block:commentContext(none)': '59de2b9ab17bcec9deb36fef0c2ac08d14e8797d5080fc11b197a8906847e892',
  'prompt:translate(term)': 'b04375003c0f8cd71bea48b3b28ff7d7947b96e549531caa74660081910ca6f3',
  'prompt:translate(passage)': '8fda0a37aa7b6e4d1059e1cacb05b5847d749359a1f12b54892969f57d008716',
  'prompt:placement': '12a4649889aa467e1d1d1c39f1a9eb416d36b5d93e01869c413ac166087ddd74',
  'prompt:persona': '79d8352d6e49d101ade501f53ec6c7aab30dc2e0fa2abbf02b38fd59f0dc8618',
  'prompt:review(oneSkill)': '9e62fad91221b85710e0d5ef0bb0b00a373c03752dd8c8f575b861ae315aecab',
  'prompt:review(twoSkills,noPersona)': '5db8840bf69e002938263bec953e4c1421f0ad569445c79c81a3d7ef9f091453',
  'prompt:verification': '085ff7a7bb8519eb23c60bd6720d192218b793e50898f04251c03cfc2529d07f',
  'prompt:chat(first)': 'eca6465f453c6d1cd1845608167f881f915bdd589c8057ce9d2b63e63f1a9ef5',
  'prompt:chat(followUpUnchanged)': 'a2847a54fee98149f0221be22f89814e6e08aac58d56453beec780756bcbed5f',
  'prompt:chat(followUpChanged)': '5eedb900e26380c5cdffa879c10160dd930c2816c90298aadee00a27be3b264c',
  'role:base(assistant)': '80a799a840228f8753fdb0cfac2384317128936feb6924acb28639e11a43cec9',
  'role:base(review)': 'c6f201881e6e1b690222781e27a251ab3a3c174778c917964edb2dabc0fc3fe6',
  'role:developer(assistant)': '8cb12fbc7dd880763fef5459ed33eb3e56dc594df510454e1b8cf831dcc2d250',
  'role:developer(review)': '8b5e9946f9460b595d6019c0733ed9ffad0f727b3d74aa69ed9443ebee88cea1'
};

test('AIへ渡す文面は、書き換えるまで一字も変わらない', async (t) => {
  const rendered = new Map();
  const record = (name, text) => {
    assert.equal(typeof text, 'string', `${name} が文字列ではありません`);
    rendered.set(name, text);
  };

  const { root, store } = await fixtureRoot(t);

  /* ---- 前提の枠（読み取りコンテキスト・ペルソナ・コメント） ---- */

  record('block:readingContext(project+document)', aiContextBlock(resolveAiContext({
    project: 'ディレクトリ全体の前提。',
    document: 'この文書の前提。'
  })));
  record('block:readingContext(all)', aiContextBlock(resolveAiContext({
    project: 'ディレクトリ全体の前提。',
    document: 'この文書の前提。',
    persona: PERSONA
  })));
  record('block:readingContext(personaOnly)', aiContextBlock(resolveAiContext({ persona: PERSONA })));
  record('block:persona(ai)', personaBlock(PERSONA));
  record('block:persona(manual)', personaBlock(MANUAL_PERSONA));

  record('block:commentContext(some)', commentContextBlock(
    await collectCommentContext(root, 'guide.md', TARGET)
  ));
  record('block:commentContext(none)', commentContextBlock({ entries: [], dropped: 0, revision: '' }));

  /* ---- 各機能のプロンプト（AiService を通して、実際に送る形で取ります） ---- */

  const prompts = [];
  const codex = fakeCodex(prompts);
  const service = new AiService(root, { store, codex, projectContext: 'ディレクトリ全体の前提。' });

  await service.translate('guide.md', TARGET);
  record('prompt:translate(term)', prompts.at(-1));
  await service.translate('guide.md', PASSAGE_TARGET);
  record('prompt:translate(passage)', prompts.at(-1));

  await service.placeComments('guide.md', '再起動の前に確認することが抜けています。');
  record('prompt:placement', prompts.at(-1));

  await service.composePersona('guide.md', '運用当番の新人。製品は初めて。');
  record('prompt:persona', prompts.at(-1));

  await service.reviewDocument('guide.md', { skillIds: ['fixture-skill'] });
  record('prompt:review(oneSkill)', prompts.at(-2));
  record('prompt:verification', prompts.at(-1));

  await service.reviewDocument('no-persona.md', { skillIds: ['fixture-skill', 'other-skill'] });
  record('prompt:review(twoSkills,noPersona)', prompts.at(-2));

  const { conversation } = await createConversation(service, 'guide.md');
  await service.sendMessage(conversation.id, 'ここはどう直しますか？');
  record('prompt:chat(first)', prompts.at(-1));
  await service.sendMessage(conversation.id, '別の言い方はありますか？');
  record('prompt:chat(followUpUnchanged)', prompts.at(-1));
  await writeReview(root, 'guide.md', [COMMENT, { ...COMMENT, id: 'comment-fixed-2', comment: '確認手順を足してください。' }]);
  await service.sendMessage(conversation.id, 'コメントを踏まえるとどうですか？');
  record('prompt:chat(followUpChanged)', prompts.at(-1));

  /* ---- スレッドを開くときにモデルへ渡す立場 ---- */

  for (const purpose of ['assistant', 'review']) {
    const { base, developer } = await threadInstructions(t, purpose);
    record(`role:base(${purpose})`, base);
    record(`role:developer(${purpose})`, developer);
  }

  assertSnapshots(rendered);
});

/**
 * 落ちたときに「どの文面が」「どう変わったか」を1回で見せます。
 * 名前ごとにばらばらに assert すると、最初の1件で止まって残りが分かりません。
 */
function assertSnapshots(rendered) {
  const drifted = [];
  for (const [name, text] of rendered) {
    const actual = crypto.createHash('sha256').update(text).digest('hex');
    if (EXPECTED[name] !== actual) drifted.push({ name, actual, text });
  }
  const missing = Object.keys(EXPECTED).filter((name) => !rendered.has(name));

  assert.deepEqual(missing, [], '固定していた文面が描画されなくなっています');
  if (drifted.length === 0) return;
  assert.fail([
    'AIへ渡す文面が変わりました。意図した変更なら、下のハッシュを EXPECTED へ書き写してください。',
    '意図していないなら、移動の途中で文面を崩しています。',
    ...drifted.map(({ name, actual, text }) => [
      `  '${name}': '${actual}',`,
      ...text.split('\n').map((line) => `      | ${line}`)
    ].join('\n'))
  ].join('\n'));
}

async function fixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-prompt-snapshot-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-prompt-snapshot-data-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));

  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await fs.writeFile(path.join(root, 'no-persona.md'), DOCUMENT, 'utf8');
  for (const id of ['fixture-skill', 'other-skill']) {
    const skillDir = path.join(root, '.claude', 'skills', id);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), SKILL.replace('fixture-skill', id), 'utf8');
  }
  await writeReview(root, 'guide.md', [COMMENT], {
    aiContext: 'この文書の前提。',
    persona: PERSONA
  });
  return { root, store: new AiStore(root, { dataDir }) };
}

async function createConversation(service, documentPath) {
  return { conversation: await service.createConversation({ documentPath, target: TARGET }) };
}

/** 1周目の指摘を1件だけ返す固定の答え。反証の入力を決めるために要ります。 */
const REVIEW_ANSWER = JSON.stringify({
  summary: '手順は追えるが、確認の一手が抜けています。',
  placements: [{
    segmentIndex: 3,
    quote: 'サービスを止めてから起動します。',
    comment: '止める前の確認を書いてください。',
    impact: '当番が確認せずに止めてしまいます。',
    suggestion: '接続中の利用者がいないことを確かめる手順を足してください。',
    reason: 'ここが止める操作を指示している唯一の箇所だからです。',
    skillId: 'fixture-skill',
    severity: 'must',
    confidence: 'high'
  }],
  unplaced: [{ note: '全体の前置きが欲しいです。', reason: '特定の段落に結び付きません。' }]
});

const VERIFICATION_ANSWER = JSON.stringify({ summary: '1件残しました。', verdicts: [], unplacedVerdicts: [] });

const TRANSLATION_ANSWER = JSON.stringify({
  contextualMeaning: '再起動する',
  meanings: [{ translation: '再起動する', nuance: 'サービスを止めて起動し直す' }],
  explanation: 'service が目的語だからです。',
  source: 'restart',
  translation: 'サービスを止めてから起動し直します。',
  notes: []
});

const PLACEMENT_ANSWER = JSON.stringify({ placements: [], unplaced: [] });

const PERSONA_ANSWER = JSON.stringify({
  label: '運用当番の新人',
  background: '他チームから異動したばかりの運用担当。',
  knowledge: ['Linuxの基本操作'],
  gaps: ['この製品の構成'],
  goals: ['当番中に手順を見ながら作業する'],
  concerns: ['取り返しのつかない操作を踏まないか'],
  summary: '製品は初めてだが、手順があれば作業できる運用担当。',
  assumptions: []
});

/** 送られたプロンプトを順に集めるだけの Codex。答えは形が合っていれば中身は問いません。 */
function fakeCodex(prompts) {
  let nextThread = 1;
  return {
    model: 'fast-test-model',
    effort: 'low',
    reviewModel: 'deep-test-model',
    reviewEffort: 'high',
    async start() {},
    async createThread() { return `thread-${nextThread++}`; },
    async resumeThread(id) { return id; },
    async deleteThread() {},
    async runTurn({ prompt, outputSchema }) {
      prompts.push(prompt);
      return { text: answerFor(outputSchema) };
    },
    async close() {}
  };
}

/** 求められた答えの形から、返すべき固定の答えを選びます。 */
function answerFor(outputSchema) {
  const fields = Object.keys(outputSchema?.properties || {});
  if (fields.includes('verdicts')) return VERIFICATION_ANSWER;
  if (fields.includes('summary') && fields.includes('placements')) return REVIEW_ANSWER;
  if (fields.includes('placements')) return PLACEMENT_ANSWER;
  if (fields.includes('assumptions')) return PERSONA_ANSWER;
  if (fields.length) return TRANSLATION_ANSWER;
  return 'ここは自由文の回答です。';
}

/** スレッドを1つ開いて、Codexへ渡した立場の説明を取り出します。 */
async function threadInstructions(t, purpose) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-prompt-snapshot-runtime-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const protocol = createFakeProtocol();
  const client = new CodexAppServer({ runtimeDir, spawnProcess: () => protocol.child });
  await client.createThread({ ephemeral: true, purpose });
  const { params } = protocol.messages.find(({ method }) => method === 'thread/start');
  await client.close();
  return { base: params.baseInstructions, developer: params.developerInstructions };
}

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

  function respond(message) {
    if (message.id === undefined) return;
    const send = (result) => stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    if (message.method === 'initialize') send({});
    if (message.method === 'model/list') {
      send({
        data: [{
          id: 'gpt-5.6-luna',
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          defaultReasoningEffort: 'low'
        }]
      });
    }
    if (message.method === 'thread/start') send({ thread: { id: 'thread-snapshot' } });
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
