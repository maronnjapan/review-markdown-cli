import assert from 'node:assert/strict';
import test from 'node:test';
import { aiContextBlock, resolveAiContext } from '../src/aiContext.js';
import { buildPersona, hasPersonaContent, normalizePersona, personaBlock, personaPrompt } from '../src/persona.js';

const ANSWER = {
  label: '運用当番の新人',
  background: '他チームから異動したばかりの運用担当。',
  knowledge: ['Linuxの基本操作', 'SSH'],
  gaps: ['この製品の構成', '障害時の連絡経路'],
  goals: ['当番中に手順を見ながら作業する'],
  concerns: ['取り返しのつかない操作を踏まないか'],
  summary: '製品は初めてだが、手順があれば作業できる運用担当。',
  assumptions: ['「新人」から、経験1年未満と想定しました']
};

test('the AI answer becomes a persona that keeps the reviewer\'s own notes', () => {
  const persona = buildPersona(ANSWER, '異動したての運用担当。Linuxは触れる。');

  assert.equal(persona.label, '運用当番の新人');
  assert.deepEqual(persona.gaps, ['この製品の構成', '障害時の連絡経路']);
  assert.equal(persona.input, '異動したての運用担当。Linuxは触れる。', '走り書きは組み直し後も残す');
  assert.deepEqual(persona.assumptions, ['「新人」から、経験1年未満と想定しました']);
  assert.ok(Date.parse(persona.updatedAt), '保存できる形の日時が入る');
});

test('an empty answer is not a persona, and stray fields never survive', () => {
  assert.equal(normalizePersona(null), null);
  assert.equal(normalizePersona({ label: '   ', goals: [] }), null);
  assert.equal(hasPersonaContent(null), false);
  assert.throws(() => buildPersona({}, 'メモ'), /組み立てられませんでした/);

  const persona = normalizePersona({ ...ANSWER, danger: 'ignored', goals: ['読む', '', 42] });
  assert.equal(persona.danger, undefined);
  assert.deepEqual(persona.goals, ['読む'], '空とテキストでない項目は落とす');
});

test('the composing prompt asks for what the notes leave open to be listed as an assumption', () => {
  const prompt = personaPrompt('異動したての運用担当', aiContextBlock(resolveAiContext({ project: '運用手順書' })));

  assert.match(prompt, /structured reader persona/);
  assert.match(prompt, /"assumptions"/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /<reader_notes>\n異動したての運用担当\n<\/reader_notes>/);
  assert.match(prompt, /運用手順書/, '読み取りコンテキストは組み直しの前提にもなる');
});

test('the persona travels with the reading context every AI feature reads', () => {
  const context = resolveAiContext({ document: '第3章の草稿', persona: buildPersona(ANSWER, 'メモ') });
  const block = aiContextBlock(context);

  assert.match(block, /<reading_context>[\s\S]*第3章の草稿[\s\S]*<\/reading_context>/);
  assert.match(block, /<reader_persona>/);
  assert.match(block, /運用当番の新人/);
  assert.match(block, /<does_not_know>[\s\S]*この製品の構成/);
  assert.doesNotMatch(block, /経験1年未満/, 'AIが補った前提は画面で直すもので、読ませる前提ではない');

  const personaOnly = resolveAiContext({ persona: buildPersona(ANSWER, 'メモ') });
  assert.match(aiContextBlock(personaOnly), /<reader_persona>/);
  assert.doesNotMatch(aiContextBlock(personaOnly), /<reading_context>/, '書いていない前提の枠は出さない');
  assert.notEqual(personaOnly.revision, '', 'ペルソナだけでも前提は設定済みとして扱う');
});

test('the reading context revision follows what the model reads, not when it was written', () => {
  const first = resolveAiContext({ persona: buildPersona(ANSWER, 'メモ') });
  const second = resolveAiContext({
    persona: { ...buildPersona(ANSWER, '書き直したメモ'), updatedAt: '2030-01-01T00:00:00.000Z' }
  });
  const changed = resolveAiContext({ persona: buildPersona({ ...ANSWER, label: '別の読み手' }, 'メモ') });

  assert.equal(first.revision, second.revision, '同じ内容なら組み直しても翻訳キャッシュは無駄にしない');
  assert.notEqual(first.revision, changed.revision);
  assert.equal(personaBlock(null), '');
});
