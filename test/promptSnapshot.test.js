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
import { contextNotesBlock, normalizeContextNotes } from '../src/contextNotes.js';
import { documentBriefBlock, readDocumentBrief } from '../src/documentBrief.js';
import { personaBlock } from '../src/persona.js';
import { referenceFilesBlock } from '../src/referenceFiles.js';
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

/** 文字起こし。聞き直しの窓は時刻で切るので、時刻まで固定しておきます。 */
const MEETING = [
  '# 定例会議',
  '',
  '---',
  '',
  '**田中** `[10:00:00]`',
  '今日は再起動手順の確認です。',
  '',
  '**鈴木** `[10:20:00]`',
  '手順の前提が書かれていないので、当番は読めません。',
  '',
  '**鈴木** `[10:21:30]`',
  '来週の水曜までに直してください。',
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

/** 資料の管理者が決めた3点。一部だけ決まっている場合の枠も、別に固定します。 */
const BRIEF = {
  purpose: '当番が手順書だけで再起動を完了できるようになる。',
  story: '止めてよい条件 → 止める手順 → 戻ったことの確かめ方。',
  expectation: '再起動についての問い合わせが来なくなる。'
};

const MANUAL_PERSONA = {
  source: 'manual',
  input: '運用当番の新人。\n製品は初めてで、手順書だけが頼り。'
};

/** 4種類のうち2つを使った固定のメモ。種類ごとの読み方の説明は枠の中に必ず全部出ます。 */
const CONTEXT_NOTES = [
  {
    id: 'note-fixed-1',
    kind: 'decision',
    body: '節の並び順は検討済みで、変えない。',
    createdAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'note-fixed-2',
    kind: 'constraint',
    body: '用語は原著の訳語に合わせる。',
    source: 'chat',
    createdAt: '2026-01-02T00:00:00.000Z'
  }
];

/**
 * 添えた参照ファイル。読めたもの・切れたもの・読めなかったものを1件ずつ並べます。
 * 3つとも入れてあるのは、種類ごとの読み方の説明が全部この枠に出るようにするためです。
 */
const REFERENCE_FILES = [
  { n: 1, path: 'ops/glossary.md', text: '# 用語集\n\n当番: その日の担当者。' },
  { n: 2, path: 'ops/spec.pdf', kind: 'pdf', text: '再起動は手順書に従うこと。', truncated: true },
  { n: 3, path: 'ops/missing.md', unreadable: true }
];

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
  'block:readingContext(projectOnly)': '877599c333be65abdb7248add31320e3352bbddd35b8f6e6394bd7c2b6a7ecbf',
  'block:readingContext(documentOnly)': '57287b0d3fdf96e694a91d96fec58039f2eaa9571d95618f82c4633270835f4a',
  'block:readingContext(manualPersona)': 'd31794a0268a8ebf93e47aaf1839bb2000c7cd2e14dd14d1366a1002911d4ebd',
  'block:readingContext(none)': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'block:readingContext(notesOnly)': 'ec66165825c5638c0d8fb36800a95c3ec6de967840fc431e5707e003f53c87b7',
  'block:readingContext(document+notes+persona)': '66535d11fc88b6f66e0dbe25f21756c9937e12160bbbdef3a1705ddfe0f4b2f9',
  'block:readingContext(brief+document)': '534f0c6951e2ad153a95e8fc09d2b3cb54dde88a7f8b64e678005dde31880006',
  'block:documentBrief(settled)': '6e22b5ca4958a0ac40b126bc6373fe8c0364e6a0da69622646fbfa48505225ac',
  'block:documentBrief(purposeOnly)': '72266f101ac329a0a7e330c531bbebb7348222c0e7b9bbdbc6dc00b6086fca6d',
  'block:contextNotes(kinds)': 'ec66165825c5638c0d8fb36800a95c3ec6de967840fc431e5707e003f53c87b7',
  'block:readingContext(filesOnly)': '18e2f071e2747cf9cc4c95241b6a21c73660fc45c198485e65935cbb965dc01b',
  'block:readingContext(document+files)': '45a4c13bb43cfbfbf8acf8b73b9a36720903ded2258e764addeaa9422ac5b42c',
  'block:referenceFiles(kinds)': '18e2f071e2747cf9cc4c95241b6a21c73660fc45c198485e65935cbb965dc01b',
  'block:referenceFiles(readableOnly)': '52be6eeade0dbcf190d24695e58ea2e53addb5d1ff1cf300be2ca6a04d38904c',
  'block:persona(ai)': '23fb353a8c9e17eb35bf275869a4acdfe1983a907b08c3d19fa97c9309513113',
  'block:persona(manual)': '91367577d26fcb16e2d1ed21d839e8b27d8ad5f4b51fb138c1499d2d84fa791b',
  'block:commentContext(some)': 'bd8844700f7878e71d277d2903d9f6dda7b142d9ab6511ac4d77b0cc4d4cb1ff',
  'block:commentContext(none)': '59de2b9ab17bcec9deb36fef0c2ac08d14e8797d5080fc11b197a8906847e892',
  'block:commentContext(dropped)': '7d9537128afe2173e8ea1a742b44075ae9a8eb7ced638eb434c675f3840b8f26',
  'prompt:translate(term)': 'b04375003c0f8cd71bea48b3b28ff7d7947b96e549531caa74660081910ca6f3',
  'prompt:translate(passage)': '8fda0a37aa7b6e4d1059e1cacb05b5847d749359a1f12b54892969f57d008716',
  'prompt:placement': '12a4649889aa467e1d1d1c39f1a9eb416d36b5d93e01869c413ac166087ddd74',
  'prompt:brief': '05d5c458ae68189881e4fa42532a548b9aeffe594e4c6e7f0a4cd328e0ab1e6b',
  'prompt:persona': '79d8352d6e49d101ade501f53ec6c7aab30dc2e0fa2abbf02b38fd59f0dc8618',
  'prompt:review(oneSkill)': 'b1713fdaceaf22569c590925adebc754ccb95e1ab13b6b8c2637aa4d09e19f93',
  'prompt:review(twoSkills,noPersona)': '4854674eaaea50e2dc4658668e2e0c4eb83910a8b6d8230910a09c4bc3b04d39',
  'prompt:verification': '92aee8dde5f7995a1f09d36ef462a3b4b7502a0128a9cb745394745d45d47310',
  'prompt:verification(noUnplaced)': '335c145ccc4a6d3e65200bcfe9e7c6b92fa632453071f7b558989ea94b2c0e82',
  'prompt:revise(comments+instruction)': 'ac2101a054acf608fa7e1a85c4687c147ae2771ef2d67e12535330fdf67657b2',
  'prompt:revise(instructionOnly)': '12ef15b2376365bf02deb839eb0933154e210738ee48a72886c0eb166072f7fa',
  'prompt:recap(all)': 'bb869aff908996bbdf353a55cc99824a388c9bca39cc94ebd7ba84cda8b95699',
  'prompt:recap(minutes+question)': 'e43bfc4ee1ae2ae0d4fc633be3a3034da9781b233166b88e474cf35788fdbdff',
  'prompt:tasks(transcript,first)': 'bf4956cf6f2847fca28b0f0d9a2487bfe007b768819899c1f54634afbc1533d3',
  'prompt:tasks(transcript,appended+instructions)': '2c893b46b9bb42c3e7c2db2e0f857072cc0e8bbaa716a3faec3b306d3a8264d3',
  'prompt:tasks(document,extractOnly)': '9099d3eccce9ab5130a61ebe3d36a0298ceb13b7fefc0ecf6e32ecac9b734823',
  'prompt:taskRun(research)': '1b360b603666e5b146e7d53fb3bed3fc06ffed8da5677b9b703b5e172fe6eec2',
  'prompt:taskRun(sample+instructions)': '84f21e3710a655e76a33163790ae5f7c98f3e98dc1d22c67a83fb661c3ff03bf',
  'prompt:chat(first)': 'eca6465f453c6d1cd1845608167f881f915bdd589c8057ce9d2b63e63f1a9ef5',
  'prompt:chat(firstWithTranscript)': 'ac2b844af404254f9372d41794a5b7d60b1f07f1010a9f32f5aa7dc896a68ca1',
  'prompt:chat(followUpUnchanged)': 'a2847a54fee98149f0221be22f89814e6e08aac58d56453beec780756bcbed5f',
  'prompt:chat(followUpChanged)': '5eedb900e26380c5cdffa879c10160dd930c2816c90298aadee00a27be3b264c',
  'prompt:chat(followUpContextChanged)': 'a442cba0b9cd679a0b82b2dece86ff05ed2f096ca76d34fc0f1b5cb8ca247e34',
  'prompt:chat(followUpContextCleared)': '13205ad768095fb501aff55a801f6930bf5539e7f11e8fc4baeb2285995c86ba',
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
  record('block:readingContext(projectOnly)', aiContextBlock(resolveAiContext({ project: 'ディレクトリ全体の前提。' })));
  record('block:readingContext(documentOnly)', aiContextBlock(resolveAiContext({ document: 'この文書の前提。' })));
  record('block:readingContext(manualPersona)', aiContextBlock(resolveAiContext({
    document: 'この文書の前提。',
    persona: MANUAL_PERSONA
  })));
  // 前提を何も設定していない文書では、枠ごと出しません。ここが空文字であることも約束です。
  record('block:readingContext(none)', aiContextBlock(resolveAiContext({})));
  // 残したメモは、書いた前提とペルソナの間の別の枠で渡します。1件も無ければ枠ごと出しません。
  record('block:readingContext(notesOnly)', aiContextBlock(resolveAiContext({ notes: CONTEXT_NOTES })));
  record('block:readingContext(document+notes+persona)', aiContextBlock(resolveAiContext({
    document: 'この文書の前提。',
    notes: CONTEXT_NOTES,
    persona: PERSONA
  })));
  // 決めた3点は書いた前提より先に並びます。1つも決めていない文書では枠ごと出ないので、
  // この機能より前に書かれた文書の文面は一字も変わりません（= 翻訳キャッシュは生きたままです）。
  record('block:readingContext(brief+document)', aiContextBlock(resolveAiContext({
    document: 'この文書の前提。',
    brief: BRIEF
  })));
  record('block:documentBrief(settled)', documentBriefBlock(readDocumentBrief(BRIEF)));
  // 決めていない項目の説明は出しません。宛先のない指示が毎回混ざるだけだからです。
  record('block:documentBrief(purposeOnly)', documentBriefBlock(readDocumentBrief({ purpose: BRIEF.purpose })));
  record('block:contextNotes(kinds)', contextNotesBlock(normalizeContextNotes(CONTEXT_NOTES)));
  // 添えた参照ファイルは、書いた前提より後ろの別の枠で渡します。1件も添えていない文書では
  // 枠ごと出ないので、この機能より前に書かれた文書の文面は一字も変わりません。
  record('block:readingContext(filesOnly)', aiContextBlock(resolveAiContext({ files: REFERENCE_FILES })));
  record('block:readingContext(document+files)', aiContextBlock(resolveAiContext({
    document: 'この文書の前提。',
    files: REFERENCE_FILES
  })));
  record('block:referenceFiles(kinds)', referenceFilesBlock(REFERENCE_FILES));
  // 種類ごとの説明は、当てはまるファイルがあるぶんだけ出します。読めて切れていない
  // ファイルだけを添えた文書に、切れたときの読み方まで並べても宛先がありません。
  record('block:referenceFiles(readableOnly)', referenceFilesBlock([REFERENCE_FILES[0]]));
  record('block:persona(ai)', personaBlock(PERSONA));
  record('block:persona(manual)', personaBlock(MANUAL_PERSONA));

  record('block:commentContext(some)', commentContextBlock(
    await collectCommentContext(root, 'guide.md', TARGET)
  ));
  record('block:commentContext(none)', commentContextBlock({ entries: [], dropped: 0, revision: '' }));
  // 「渡しきれなかった件数」は、モデルがコメントを全部見たと思い込まないための唯一の合図です。
  record('block:commentContext(dropped)', commentContextBlock({
    entries: [{ n: 1, attached: true, type: 'text-selection', status: 'open', comment: '確認を足してください。' }],
    dropped: 11,
    revision: ''
  }));

  /* ---- 各機能のプロンプト（AiService を通して、実際に送る形で取ります） ---- */

  const prompts = [];
  const codex = fakeCodex(prompts);
  const service = new AiService(root, { store, client: codex, projectContext: 'ディレクトリ全体の前提。' });

  await service.translate('guide.md', TARGET);
  record('prompt:translate(term)', prompts.at(-1));
  await service.translate('guide.md', PASSAGE_TARGET);
  record('prompt:translate(passage)', prompts.at(-1));

  await service.placeComments('guide.md', '再起動の前に確認することが抜けています。');
  record('prompt:placement', prompts.at(-1));

  await service.composeDocumentBrief('guide.md', '運用チームから当番向けの再起動手順を頼まれた。');
  record('prompt:brief', prompts.at(-1));

  await service.composePersona('guide.md', '運用当番の新人。製品は初めて。');
  record('prompt:persona', prompts.at(-1));

  // 本文の修正案。残っている未解決のコメントが、そのまま修正の依頼として付きます。
  await service.proposeEdits('guide.md', '止める前の確認を足してください。');
  record('prompt:revise(comments+instruction)', prompts.at(-1));
  // コメントの無い文書では、依頼はレビュアーが書いた指示だけです。
  await service.proposeEdits('no-persona.md', '見出しの言い回しを揃えてください。');
  record('prompt:revise(instructionOnly)', prompts.at(-1));

  await service.reviewDocument('guide.md', { skillIds: ['fixture-skill'] });
  record('prompt:review(oneSkill)', prompts.at(-2));
  record('prompt:verification', prompts.at(-1));

  await service.reviewDocument('no-persona.md', { skillIds: ['fixture-skill', 'other-skill'] });
  record('prompt:review(twoSkills,noPersona)', prompts.at(-2));

  // 箇所を持たない指摘が1件も出なかったレビュー。反証の指示文が別の一文へ切り替わります。
  const placedOnly = new AiService(root, { store, client: fakeCodex(prompts, PLACED_ONLY_ANSWER), projectContext: 'ディレクトリ全体の前提。' });
  await placedOnly.reviewDocument('guide.md', { skillIds: ['fixture-skill'] });
  record('prompt:verification(noUnplaced)', prompts.at(-1));

  // 文字起こしの聞き直し。会議の最初からと、直近◯分＋聞きたいことの2通りで文面が変わります。
  await service.recapCaptions('meeting.md', { scope: 'all' });
  record('prompt:recap(all)', prompts.at(-1));
  await service.recapCaptions('meeting.md', { scope: 'minutes', minutes: 5, question: '「前提」は何を指していますか？' });
  record('prompt:recap(minutes+question)', prompts.at(-1));

  // 自動タスク。文字起こしを最初から読む形、追記だけを読む形（既存タスクと特にしてほしいこと付き）、
  // 資料を整理も今すべきことも無しで読む形、そして実行の2種類で文面が変わります。
  const noTasks = { tasks: [], analysis: null };
  await service.extractTasks('meeting.md', { record: noTasks, actions: ['organize', 'focus', 'research'] });
  record('prompt:tasks(transcript,first)', prompts.at(-1));
  const readSoFar = MEETING.indexOf('**鈴木** `[10:21:30]`');
  await service.extractTasks('meeting.md', {
    record: {
      tasks: [{ id: 'task-fixed-1', title: '手順の前提を書く', kind: 'action', status: 'open', priority: 'now' }],
      analysis: { revision: crypto.createHash('sha256').update(MEETING.slice(0, readSoFar)).digest('hex'), length: readSoFar }
    },
    actions: ['organize', 'focus'],
    instructions: 'サンプル実装はTypeScriptで書く。'
  });
  record('prompt:tasks(transcript,appended+instructions)', prompts.at(-1));
  await service.extractTasks('guide.md', { record: noTasks, actions: [] });
  record('prompt:tasks(document,extractOnly)', prompts.at(-1));
  await service.performTask('guide.md', {
    title: '再起動の前提条件を調べる', detail: '当番が知らない前提を洗い出す。', kind: 'research', quote: 'この手順は当番が読みます。'
  });
  record('prompt:taskRun(research)', prompts.at(-1));
  await service.performTask('guide.md', { title: '再起動スクリプトの例', detail: '', kind: 'sample', quote: '' }, { instructions: 'サンプル実装はTypeScriptで書く。' });
  record('prompt:taskRun(sample+instructions)', prompts.at(-1));

  const { conversation } = await createConversation(service, 'guide.md');
  await service.sendMessage(conversation.id, 'ここはどう直しますか？');
  record('prompt:chat(first)', prompts.at(-1));
  await service.sendMessage(conversation.id, '別の言い方はありますか？');
  record('prompt:chat(followUpUnchanged)', prompts.at(-1));
  await writeReview(root, 'guide.md', [COMMENT, { ...COMMENT, id: 'comment-fixed-2', comment: '確認手順を足してください。' }]);
  await service.sendMessage(conversation.id, 'コメントを踏まえるとどうですか？');
  record('prompt:chat(followUpChanged)', prompts.at(-1));

  // 会話の途中で前提を書き換えたときと、消したとき。文面が別々に切り替わります。
  await writeReview(root, 'guide.md', [COMMENT], { aiContext: '書き換えた前提。', persona: PERSONA });
  await service.sendMessage(conversation.id, '前提が変わりました。');
  record('prompt:chat(followUpContextChanged)', prompts.at(-1));
  await writeReview(root, 'guide.md', [COMMENT], { aiContext: '', persona: null });
  const cleared = new AiService(root, { store, client: codex, projectContext: '' });
  const clearedConversation = await service.store.getConversation(conversation.id);
  await cleared.sendMessage(clearedConversation.id, '前提を消しました。');
  record('prompt:chat(followUpContextCleared)', prompts.at(-1));

  // 会話を開き直したとき、それまでのやり取りを1回目のプロンプトへ載せ直します。
  const reopened = await service.createConversation({ documentPath: 'guide.md', target: TARGET });
  reopened.messages.push(
    { id: 'm1', role: 'user', content: '前の質問。', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: '前の答え。', createdAt: '2026-01-01T00:00:01.000Z' }
  );
  await service.store.saveConversation(reopened);
  await service.sendMessage(reopened.id, '続きを聞かせてください。');
  record('prompt:chat(firstWithTranscript)', prompts.at(-1));

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
  await fs.writeFile(path.join(root, 'meeting.md'), MEETING, 'utf8');
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

/** 箇所に結び付いた指摘だけを返す答え。反証の「箇所なし指摘は無い」分岐を通します。 */
const PLACED_ONLY_ANSWER = JSON.stringify({
  ...JSON.parse(REVIEW_ANSWER),
  unplaced: []
});

const VERIFICATION_ANSWER = JSON.stringify({ summary: '1件残しました。', verdicts: [], unplacedVerdicts: [] });

/** 修正案の固定の答え。ここで固定しているのは送る文面なので、答えは形だけ合わせます。 */
const REVISE_ANSWER = JSON.stringify({ summary: '書き換えはありません。', edits: [], skipped: [] });

const TRANSLATION_ANSWER = JSON.stringify({
  contextualMeaning: '再起動する',
  meanings: [{ translation: '再起動する', nuance: 'サービスを止めて起動し直す' }],
  explanation: 'service が目的語だからです。',
  source: 'restart',
  translation: 'サービスを止めてから起動し直します。',
  notes: []
});

const PLACEMENT_ANSWER = JSON.stringify({ placements: [], unplaced: [] });

/** 聞き直しの固定の答え。ここで固定しているのは送る文面なので、答えは形だけ合わせます。 */
const RECAP_ANSWER = JSON.stringify({ summary: '前提の記述を求められました。', answer: '', points: [], actions: [] });

/** 自動タスクの固定の答え。抽出と実行の2つで、どちらも形だけ合わせます。 */
const TASKS_ANSWER = JSON.stringify({ summary: '前提が足りません。', focus: { now: '', reason: '' }, tasks: [], updates: [] });
const TASK_RESULT_ANSWER = JSON.stringify({ summary: '前提は3つです。', body: '# 調査メモ', followUps: [], questions: [] });

/** 管理者の答え。埋まらなかった項目は空のまま、問いだけが返るのが普通の形です。 */
const BRIEF_ANSWER = JSON.stringify({
  purpose: '当番が手順書だけで再起動を完了できるようになる。',
  story: '',
  expectation: '',
  questions: ['止めてよい条件は誰が決めますか。'],
  assumptions: []
});

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
function fakeCodex(prompts, reviewAnswer = REVIEW_ANSWER) {
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
      return { text: answerFor(outputSchema, reviewAnswer) };
    },
    async close() {}
  };
}

/** 求められた答えの形から、返すべき固定の答えを選びます。 */
function answerFor(outputSchema, reviewAnswer) {
  const fields = Object.keys(outputSchema?.properties || {});
  if (fields.includes('verdicts')) return VERIFICATION_ANSWER;
  if (fields.includes('edits')) return REVISE_ANSWER;
  if (fields.includes('summary') && fields.includes('placements')) return reviewAnswer;
  if (fields.includes('placements')) return PLACEMENT_ANSWER;
  if (fields.includes('points')) return RECAP_ANSWER;
  // 自動タスクの実行は questions を返すので、管理者より先に見分けます。
  if (fields.includes('updates')) return TASKS_ANSWER;
  if (fields.includes('followUps')) return TASK_RESULT_ANSWER;
  // 管理者もペルソナも assumptions を返すので、先に問いの有無で見分けます。
  if (fields.includes('questions')) return BRIEF_ANSWER;
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
