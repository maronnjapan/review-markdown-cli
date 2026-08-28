import assert from 'node:assert/strict';
import test from 'node:test';
import { aiContextBlock, resolveAiContext } from '../src/aiContext.js';
import { MAX_BRIEF_FIELD_CHARS, MAX_BRIEF_INPUT_CHARS } from '../src/aiLimits.js';
import {
  buildBriefDraft,
  documentBriefBlock,
  hasDocumentBrief,
  isBriefSettled,
  missingBriefFields,
  normalizeBriefInput,
  normalizeDocumentBrief,
  readDocumentBrief
} from '../src/documentBrief.js';
import { briefPrompt } from '../src/prompts/manager.js';

const SETTLED = {
  purpose: '当番が手順書だけで再起動を完了できるようになる。',
  story: '止めてよい条件 → 止める手順 → 戻ったことの確かめ方。',
  expectation: '再起動についての問い合わせが来なくなる。'
};

test('the fields still to settle come back by name, and the gate opens only when none are left', () => {
  assert.deepEqual(missingBriefFields(null).map(({ id }) => id), ['purpose', 'story', 'expectation']);
  assert.deepEqual(missingBriefFields({ purpose: '目的' }).map(({ label }) => label), ['ストーリー', '期待値']);
  assert.deepEqual(missingBriefFields(SETTLED), []);

  // 関門を開けるのは3つとも埋まったときだけです。良い目的かどうかは見ません。
  assert.equal(isBriefSettled(SETTLED), true);
  assert.equal(isBriefSettled({ ...SETTLED, story: '' }), false);
  assert.equal(isBriefSettled({ purpose: 'あ', story: 'い', expectation: 'う' }), true);
});

test('readDocumentBrief never throws, so a hand edited review file still opens', () => {
  assert.equal(readDocumentBrief(undefined), null);
  assert.equal(readDocumentBrief('目的'), null);
  assert.equal(readDocumentBrief([]), null);
  assert.equal(readDocumentBrief({ purpose: 123, story: null }), null, '1つも文字列でなければ未設定');
  assert.equal(readDocumentBrief({ purpose: '   ' }), null, '空白だけは書かれていないのと同じ');

  const long = readDocumentBrief({ purpose: 'あ'.repeat(MAX_BRIEF_FIELD_CHARS + 10) });
  assert.equal(long.purpose.length, MAX_BRIEF_FIELD_CHARS, '読むときは切り詰めて通す');
});

test('normalizeDocumentBrief refuses a field it cannot carry instead of trimming it silently', () => {
  const brief = normalizeDocumentBrief({ ...SETTLED, updatedAt: '2026-08-01T00:00:00.000Z', stray: '捨てる' });
  assert.deepEqual(brief, { ...SETTLED, updatedAt: '2026-08-01T00:00:00.000Z' });

  // 黙って切ると、切れた目的の上でレビューが走ります。書いた人はそれに気づけません。
  assert.throws(
    () => normalizeDocumentBrief({ story: 'あ'.repeat(MAX_BRIEF_FIELD_CHARS + 1) }),
    /「ストーリー」が長すぎます/
  );
  assert.equal(normalizeDocumentBrief(null), null, 'null は「管理者を消す」');
  assert.throws(() => normalizeDocumentBrief('目的'), /オブジェクトで指定/);
});

test('normalizeBriefInput refuses notes longer than a prompt can carry', () => {
  assert.equal(normalizeBriefInput('  決まっていること  '), '決まっていること');
  assert.equal(normalizeBriefInput(undefined), '');
  assert.throws(() => normalizeBriefInput('あ'.repeat(MAX_BRIEF_INPUT_CHARS + 1)), /長すぎます/);
});

test('what the manager could not settle comes back empty, as a question', () => {
  const draft = buildBriefDraft({
    purpose: '当番が一人で再起動できるようになる。',
    story: '',
    expectation: '',
    questions: ['  止めてよい条件は誰が決めますか。  ', '', '読んだ人に何を判断してほしいですか。'],
    assumptions: ['「当番」を運用当番と読みました']
  }, new Date('2026-08-01T00:00:00.000Z'));

  assert.equal(draft.brief.purpose, '当番が一人で再起動できるようになる。');
  assert.equal(draft.brief.story, '', '書いていない項目は埋めさせない');
  assert.equal(draft.brief.updatedAt, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(draft.questions, ['止めてよい条件は誰が決めますか。', '読んだ人に何を判断してほしいですか。']);
  assert.deepEqual(draft.assumptions, ['「当番」を運用当番と読みました']);

  // 3つとも空の答えは「まだ何も決まっていない」で、保存できるブリーフにはなりません。
  const empty = buildBriefDraft({ purpose: '', story: '', expectation: '', questions: ['何のための資料ですか。'] });
  assert.equal(empty.brief, null);
  assert.equal(empty.questions.length, 1);
});

test('the composing prompt asks the manager to question a gap, never to fill it', () => {
  const prompt = briefPrompt('運用チームから当番向けの手順を頼まれた。', '');
  assert.match(prompt, /Leave a field as an empty string when they do not say it/);
  assert.match(prompt, /an invented purpose is worse than a missing one/);
  assert.match(prompt, /write one question in "questions" that would settle it/);
  assert.match(prompt, /Producing the document is not a purpose/);
  assert.match(prompt, /<settled_notes>\n運用チームから当番向けの手順を頼まれた。\n<\/settled_notes>/);
});

test('the settled three become the block every AI feature reads', () => {
  const block = documentBriefBlock(readDocumentBrief(SETTLED));
  assert.match(block, /<document_brief>/);
  assert.match(block, /<purpose>\n当番が手順書だけで再起動を完了できるようになる。\n<\/purpose>/);
  // 資料に書かれていないことを、書かれているものとして読ませないための一文です。
  assert.match(block, /not something the document says/);
  // これが無いと、3点から外れた箇所を指摘してよいという根拠が無くなります。
  assert.match(block, /the plan is grounds enough/);

  assert.equal(hasDocumentBrief(null), false);
  assert.equal(documentBriefBlock(null), '', '1つも決まっていなければ枠ごと出さない');

  // 決めていない項目の説明は出しません。宛先のない指示が毎回混ざるだけだからです。
  const purposeOnly = documentBriefBlock(readDocumentBrief({ purpose: SETTLED.purpose }));
  assert.match(purposeOnly, /"purpose" is what has to be true/);
  assert.equal(/"story" is the order/.test(purposeOnly), false);
});

test('the brief travels with the reading context, ahead of the context the reviewer wrote', () => {
  const context = resolveAiContext({ document: 'この文書の前提。', brief: SETTLED });
  const block = aiContextBlock(context);

  assert.ok(block.indexOf('<document_brief>') < block.indexOf('<reading_context>'),
    'あるべき姿を読んでから現物の読み方を読ませる');
  assert.notEqual(context.revision, resolveAiContext({ document: 'この文書の前提。' }).revision,
    '3点を決めれば、モデルが読む文面が変わる');

  // 3点を設定していない文書では、前提の文面はこの機能が入る前と一字も変わりません。
  // ここが変わると、利用者の手元の翻訳キャッシュが理由もなく全件無効になります。
  assert.equal(
    aiContextBlock(resolveAiContext({ document: 'この文書の前提。', brief: null })),
    aiContextBlock(resolveAiContext({ document: 'この文書の前提。' }))
  );
});
