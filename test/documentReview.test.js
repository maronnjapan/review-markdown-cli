import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import { buildReviewMarkdown, readReview, writeReview } from '../src/reviewStore.js';

const DOCUMENT = [
  '# デプロイ手順',
  '',
  '## 前提',
  '',
  'この手順は本番環境でのみ実行します。',
  '',
  '## 手順',
  '',
  'まず deploy.sh を実行します。',
  ''
].join('\n');

test('a review reads with the chosen skill and as the saved reader, then checks its own findings', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await writeSkill(root, 'ops-review', '# 運用レビュー\n\n1. references/checklist.md を全文読む。', {
    'checklist.md': '# 確認するもの\n\n- 対象ホスト\n- 稼働中のジョブ'
  });
  await writeReview(root, 'guide.md', [], {
    aiContext: '運用手順書。',
    persona: {
      label: '運用当番の新人',
      gaps: ['この製品の構成'],
      goals: ['当番中に手順どおり作業する'],
      summary: '製品は初めての運用担当。'
    }
  });

  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      if (isVerification(input)) {
        return {
          text: JSON.stringify({
            summary: 'この読み手には前提の説明が足りません。',
            verdicts: [{
              index: 0,
              keep: true,
              reason: '引用した手順に確認方法が無いことを本文で確かめました。',
              comment: '実行前に確認することを書いてください。',
              impact: 'この読み手は、実行してよい状態かを判断できないまま deploy.sh を叩きます。',
              suggestion: '「対象ホストと稼働中のジョブを確認する」を、この手順の前に足してください。',
              severity: 'must',
              confidence: 'high'
            }],
            unplacedVerdicts: []
          })
        };
      }
      return {
        text: JSON.stringify({
          summary: 'この読み手には前提の説明が足りません。',
          placements: [
            {
              segmentIndex: segmentIndexOf(input.prompt, 'まず deploy.sh を実行します。'),
              quote: 'deploy.sh',
              comment: '実行前に確認することを書いてください。',
              impact: 'この読み手は、実行してよい状態かを判断できないまま deploy.sh を叩きます。',
              suggestion: '「対象ホストと稼働中のジョブを確認する」を、この手順の前に足してください。',
              reason: 'この読み手は製品を知らないためです。',
              skillId: 'ops-review',
              severity: 'must',
              confidence: 'high'
            }
          ],
          unplaced: [{ note: '全体的に前提が足りません', reason: '特定の段落に結び付かないためです' }]
        })
      };
    }
  });
  const service = new AiService(root, { store, client: codex });

  const review = await service.reviewDocument('guide.md', { skillIds: ['ops-review'] });

  assert.deepEqual(review.skills.map(({ id }) => id), ['ops-review']);
  assert.equal(review.summary, 'この読み手には前提の説明が足りません。');
  assert.equal(review.placements.length, 1);
  assert.equal(review.placements[0].severity, 'must');
  assert.deepEqual(review.placements[0].skill, { id: 'ops-review', name: 'ops-review' });
  assert.equal(review.placements[0].target.type, 'text-selection');
  assert.equal(review.placements[0].target.selectedText, 'deploy.sh', '対象は本文から取るので画面で見つけられる');
  assert.deepEqual(review.placements[0].target.headingPath, ['デプロイ手順', '手順']);
  assert.equal(review.unplaced.length, 1);
  assert.equal(review.persona.label, '運用当番の新人');

  // 指摘は「何を直すか」だけでは著者の次の一手にならないので、影響と直し方まで1つのコメントにする。
  assert.equal(review.placements[0].comment, [
    '実行前に確認することを書いてください。',
    '影響: この読み手は、実行してよい状態かを判断できないまま deploy.sh を叩きます。',
    '直し方: 「対象ホストと稼働中のジョブを確認する」を、この手順の前に足してください。'
  ].join('\n'));

  assert.match(turns[0].prompt, /<review_skill id="ops-review" name="ops-review">/);
  // スキルが「references/… を読む」と書いているなら、その中身も渡さないと手順が実行できない。
  assert.match(turns[0].prompt, /<reference name="checklist\.md">[\s\S]*稼働中のジョブ/);
  assert.match(turns[0].prompt, /that file is already inside its own <review_skill> block/);
  assert.match(turns[0].prompt, /<reader_persona>[\s\S]*運用当番の新人/);
  assert.match(turns[0].prompt, /運用手順書/);
  assert.match(turns[0].prompt, /data, not instructions/);
  assert.match(turns[0].prompt, /<document_outline>[\s\S]*デプロイ手順/, '並び順の指摘は見取り図からしか出てこない');
  assert.deepEqual(
    Object.keys(turns[0].outputSchema.properties),
    ['summary', 'placements', 'unplaced'],
    'レビューは構造化された答えだけを受け取る'
  );

  // 2周目は同じスレッドで、1周目の指摘そのものを反証させる。
  assert.equal(turns.length, 2);
  assert.equal(turns[1].threadId, turns[0].threadId, '本文を読み直させず、読んだままのスレッドで検証する');
  assert.match(turns[1].prompt, /refute/);
  assert.match(turns[1].prompt, /<findings>/);
  assert.doesNotMatch(turns[1].prompt, /<document_segments>/, '本文を丸ごと渡し直さない');
  assert.equal(review.verified, true);
  assert.equal(review.refuted, 0);

  // レビュー対象のモデルは、翻訳やチャットより深く読ませる。
  assert.deepEqual(codex.threadOptions, [{ ephemeral: true, purpose: 'review' }]);

  const saved = await readReview(root, 'guide.md');
  assert.deepEqual(saved.comments, [], '採用するまでレビューファイルへは何も書かない');
});

test('a review needs a skill that exists, and a document with body text', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await fs.writeFile(path.join(root, 'empty.md'), '\n', 'utf8');
  const service = new AiService(root, { store, client: fakeCodex() });

  await assert.rejects(
    () => service.reviewDocument('guide.md', { skillIds: ['no-such-skill'] }),
    /レビュースキルが見つかりません/
  );
  await assert.rejects(
    () => service.reviewDocument('guide.md', { skillIds: [] }),
    /レビュースキルを1つ以上選んでください/
  );
  await assert.rejects(
    () => service.reviewDocument('empty.md', { skillIds: ['reader-fit-review'] }),
    /レビューできる本文が見つかりません/
  );
});

test('several skills read the document once, and each finding says which one it came from', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await writeSkill(root, 'ops-review', '# 運用レビュー\n\n実行前の確認手順を見る。');
  await writeSkill(root, 'flow-review', '# 構成レビュー\n\n見出しの並びを見る。');

  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      if (isVerification(input)) {
        return {
          text: JSON.stringify({
            summary: '前提と並びの両方に直すところがあります。',
            verdicts: [0, 1].map((index) => ({
              index,
              keep: true,
              reason: '本文で確かめました。',
              comment: '',
              impact: '',
              suggestion: '',
              severity: '',
              confidence: ''
            }))
          })
        };
      }
      return {
        text: JSON.stringify({
          summary: '前提と並びの両方に直すところがあります。',
          placements: [
            {
              segmentIndex: segmentIndexOf(input.prompt, 'まず deploy.sh を実行します。'),
              quote: 'deploy.sh',
              comment: '実行前に確認することを書いてください。',
              impact: 'この読み手は失敗に気づけません。',
              suggestion: '確認するコマンドを手順の前に足してください。',
              reason: 'この読み手は製品を知らないためです。',
              skillId: 'ops-review',
              severity: 'must',
              confidence: 'high'
            },
            {
              segmentIndex: segmentIndexOf(input.prompt, 'この手順は本番環境でのみ実行します。'),
              quote: '',
              comment: '前提は手順の直前へ移してください。',
              impact: 'この読み手は前提を忘れたまま手順へ進みます。',
              suggestion: '「前提」節を「手順」節の直前へ移してください。',
              reason: '読む順序が入れ替わっているためです。',
              skillId: 'flow-review',
              severity: 'should',
              confidence: 'medium'
            }
          ],
          unplaced: []
        })
      };
    }
  });
  const service = new AiService(root, { store, client: codex });

  const review = await service.reviewDocument('guide.md', { skillIds: ['ops-review', 'flow-review'] });

  assert.deepEqual(review.skills.map(({ id }) => id), ['ops-review', 'flow-review']);
  assert.equal(turns.filter((turn) => turn.prompt.includes('<document_segments>')).length, 1,
    '観点ごとに読み直さず、1回で読ませる');
  assert.deepEqual(review.placements.map(({ skill }) => skill.id), ['ops-review', 'flow-review']);
  // 空で返ってきた判定は1周目のままにする。反証は指摘を消すための工程で、書き直させるためではない。
  assert.equal(review.placements[0].severity, 'must');
  assert.match(review.placements[1].comment, /前提は手順の直前へ移してください。/);
  assert.deepEqual(turns[0].outputSchema.properties.placements.items.properties.skillId.enum,
    ['ops-review', 'flow-review'], '出どころは選んだスキルからしか選べない');
  assert.match(turns[0].prompt, /<review_skill id="ops-review"/);
  assert.match(turns[0].prompt, /<review_skill id="flow-review"/);
  assert.match(turns[0].prompt, /実行前の確認手順を見る/);
  assert.match(turns[0].prompt, /見出しの並びを見る/);
});

test('the second pass drops findings it cannot stand behind, and the rest arrive heaviest first', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await writeSkill(root, 'ops-review', '# 運用レビュー\n\n実行前の確認手順を見る。');

  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      if (isVerification(input)) {
        return {
          text: JSON.stringify({
            summary: '残ったのは実行前の確認だけです。',
            verdicts: [
              {
                index: 0,
                keep: true,
                reason: '読み手には確かに読みにくいので残しました。',
                comment: '見出しの語を本文と揃えてください。',
                impact: 'この読み手は同じものを指しているか確かめ直します。',
                suggestion: '「前提」を「実行前の前提」に変えてください。',
                severity: 'idea',
                confidence: 'high'
              },
              {
                index: 1,
                keep: true,
                reason: '本文に確認方法が無いことを確かめたので、確度を上げました。',
                comment: '実行前に確認することを書いてください。',
                impact: 'この読み手は、実行してよい状態かを判断できません。',
                suggestion: '「稼働中のジョブを確認する」を手順の前に足してください。',
                severity: 'must',
                confidence: 'high'
              },
              {
                index: 2,
                keep: false,
                reason: '本文がその通り書いており、指摘の前提が成り立ちません。',
                comment: '本番環境かどうかを書いてください。',
                impact: '',
                suggestion: '',
                severity: 'should',
                confidence: 'high'
              }
            ],
            unplacedVerdicts: [{
              index: 0,
              keep: false,
              reason: 'この原稿の何を指しているか言えないため落としました。',
              note: '全体的に読みやすさを意識してください'
            }]
          })
        };
      }
      return {
        text: JSON.stringify({
          summary: '直すところが3つあります。',
          placements: [
            {
              segmentIndex: segmentIndexOf(input.prompt, '前提'),
              quote: '',
              comment: '見出しの語を本文と揃えてください。',
              impact: 'この読み手は同じものを指しているか確かめ直します。',
              suggestion: '「前提」を「実行前の前提」に変えてください。',
              reason: '本文と見出しで語が違うためです。',
              skillId: 'ops-review',
              severity: 'idea',
              confidence: 'high'
            },
            {
              segmentIndex: segmentIndexOf(input.prompt, 'まず deploy.sh を実行します。'),
              quote: 'deploy.sh',
              comment: '実行前に確認することを書いてください。',
              impact: 'この読み手は、実行してよい状態かを判断できません。',
              suggestion: '確認するコマンドを足してください。',
              reason: 'この読み手は製品を知らないためです。',
              skillId: 'ops-review',
              severity: 'must',
              confidence: 'low'
            },
            {
              segmentIndex: segmentIndexOf(input.prompt, 'この手順は本番環境でのみ実行します。'),
              quote: '',
              comment: '本番環境かどうかを書いてください。',
              impact: 'この読み手はどこで実行するか迷います。',
              suggestion: '実行環境を書いてください。',
              reason: '実行場所が書かれていないためです。',
              skillId: 'ops-review',
              severity: 'should',
              confidence: 'high'
            }
          ],
          unplaced: [{ note: '全体的に読みやすさを意識してください', reason: '特定の段落に結び付かないためです' }]
        })
      };
    }
  });

  const review = await new AiService(root, { store, client: codex }).reviewDocument('guide.md', { skillIds: ['ops-review'] });

  assert.equal(review.refuted, 2, '本文がその通り書いている指摘も、どの原稿にも言える指摘も、レビュアーの前に落とす');
  assert.deepEqual(review.unplaced, [], '箇所を持たない指摘こそ一般論になりやすいので、同じ目で見る');
  assert.equal(review.summary, '残ったのは実行前の確認だけです。', '要約も残った指摘だけのものへ差し替える');
  assert.deepEqual(review.placements.map(({ severity }) => severity), ['must', 'idea'],
    '重い指摘から並べる。上から読んで手を止められるかは並び順で決まる');
  assert.equal(review.placements[0].confidence, 'high', '反証で直した確度が候補へ載る');
  assert.match(review.placements[0].comment, /稼働中のジョブを確認する/, '反証で直した直し方が候補へ載る');
  assert.equal(review.placements.some(({ comment }) => comment.includes('本番環境かどうか')), false);

  // 反証には、指摘とその根拠になった本文だけを渡す。
  const findings = JSON.parse(turns[1].prompt.match(/<findings>(.*)<\/findings>/)[1]);
  assert.deepEqual(findings.map(({ index }) => index), [0, 1, 2]);
  assert.equal(findings[1].quote, 'deploy.sh');
  assert.equal(findings[1].segmentText, 'まず deploy.sh を実行します。');
});

test('a review that finds nothing does not run a second pass, and does not report a failed one', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await writeSkill(root, 'ops-review', '# 運用レビュー\n\n実行前の確認手順を見る。');

  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      return { text: JSON.stringify({ summary: 'この読み手なら手順どおり進められます。', placements: [], unplaced: [] }) };
    }
  });

  const review = await new AiService(root, { store, client: codex }).reviewDocument('guide.md', { skillIds: ['ops-review'] });

  assert.equal(turns.length, 1, '確かめる指摘が無いなら、2周目を回す理由も無い');
  assert.equal(review.verified, true, '検証する対象が無かったことは、検証に失敗したことではない');
  assert.equal(review.refuted, 0);
  assert.deepEqual(review.placements, []);
});

test('a second pass that fails still hands the reviewer the findings from the first', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await writeSkill(root, 'ops-review', '# 運用レビュー\n\n実行前の確認手順を見る。');

  const answer = (prompt) => JSON.stringify({
    summary: '実行前の前提が足りません。',
    placements: [{
      segmentIndex: segmentIndexOf(prompt, 'まず deploy.sh を実行します。'),
      quote: 'deploy.sh',
      comment: '実行前に確認することを書いてください。',
      impact: 'この読み手は失敗に気づけません。',
      suggestion: '確認するコマンドを足してください。',
      reason: 'この読み手は製品を知らないためです。',
      skillId: 'ops-review',
      severity: 'must',
      confidence: 'high'
    }],
    unplaced: []
  });

  const failing = fakeCodex({
    async runTurn(input) {
      if (isVerification(input)) throw new Error('Codex turn failed: 検証が落ちました');
      return { text: answer(input.prompt) };
    }
  });
  const review = await new AiService(root, { store, client: failing }).reviewDocument('guide.md', { skillIds: ['ops-review'] });

  assert.equal(review.verified, false, '検証できたかどうかは隠さない');
  assert.equal(review.refuted, 0);
  assert.equal(review.placements.length, 1, '検証は指摘の精度を上げる工程で、レビューそのものではない');

  // 止めたときだけは別で、レビュアーが止めた以上そこで終わる。
  const stopped = fakeCodex({
    async runTurn(input) {
      if (isVerification(input)) throw Object.assign(new Error('生成を中止しました'), { name: 'AbortError' });
      return { text: answer(input.prompt) };
    }
  });
  await assert.rejects(
    () => new AiService(root, { store, client: stopped }).reviewDocument('guide.md', { skillIds: ['ops-review'] }),
    /生成を中止しました/
  );
});

test('the reviewer\'s notes about the reader are rebuilt into a persona, and saved only on request', async (t) => {
  const { root, store } = await testStore(t);
  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      return {
        text: JSON.stringify({
          label: '運用当番の新人',
          background: '異動したての運用担当。',
          knowledge: ['Linuxの基本操作'],
          gaps: ['この製品の構成'],
          goals: ['手順どおりに作業する'],
          concerns: ['危険な操作を踏まないか'],
          summary: '製品は初めての運用担当。',
          assumptions: ['経験1年未満と想定しました']
        })
      };
    }
  });
  const service = new AiService(root, { store, client: codex });

  const persona = await service.composePersona('guide.md', '  異動したての運用担当。Linuxは触れる。  ');

  assert.equal(persona.label, '運用当番の新人');
  assert.equal(persona.input, '異動したての運用担当。Linuxは触れる。');
  assert.deepEqual(persona.assumptions, ['経験1年未満と想定しました']);
  assert.match(turns[0].prompt, /<reader_notes>/);
  assert.equal((await readReview(root, 'guide.md')).persona, null, '組み直しただけでは保存しない');

  await assert.rejects(() => service.composePersona('guide.md', '   '), /読み手ペルソナの説明を入力してください/);
});

test('a reader written by hand is used as written, without asking the AI to rebuild it', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await writeSkill(root, 'ops-review', '# 運用レビュー\n\n実行前の確認手順を見る。');
  await writeReview(root, 'guide.md', [], {
    persona: { source: 'manual', input: '当番の新人。\nこの製品は初めて。' }
  });

  const saved = await readReview(root, 'guide.md');
  assert.equal(saved.persona.source, 'manual');
  assert.equal(saved.persona.label, '当番の新人。', '呼び名は書き出しから付く');
  assert.equal(saved.persona.input, '当番の新人。\nこの製品は初めて。');

  const turns = [];
  const codex = fakeCodex({
    async runTurn(input) {
      turns.push(input);
      return { text: JSON.stringify({ summary: '', placements: [], unplaced: [] }) };
    }
  });
  await new AiService(root, { store, client: codex }).reviewDocument('guide.md', { skillIds: ['ops-review'] });

  assert.match(turns[0].prompt, /<reader_persona>\n<notes>\n当番の新人。\nこの製品は初めて。\n<\/notes>/,
    '書いた文章をそのまま渡す');
  assert.doesNotMatch(turns[0].prompt, /<knows>/, '書いていない項目は足さない');

  const markdown = buildReviewMarkdown(await readReview(root, 'guide.md'));
  assert.match(markdown, /## 読み手ペルソナ/);
  assert.match(markdown, /> 当番の新人。\n> この製品は初めて。/);
});

test('the review file keeps the persona through a plain comment save, and exports it', async (t) => {
  const { root } = await testStore(t);
  const persona = {
    label: '運用当番の新人',
    background: '異動したての運用担当。',
    knowledge: ['Linuxの基本操作'],
    gaps: ['この製品の構成'],
    goals: ['手順どおりに作業する'],
    concerns: ['危険な操作を踏まないか'],
    summary: '製品は初めての運用担当。',
    assumptions: ['経験1年未満と想定しました'],
    input: '異動したての運用担当。'
  };

  await writeReview(root, 'guide.md', [], { persona });
  await writeReview(root, 'guide.md', [{ type: 'document', comment: '書き足してほしい' }]);
  const saved = await readReview(root, 'guide.md');

  assert.equal(saved.persona.label, '運用当番の新人');
  assert.equal(saved.comments.length, 1, 'コメントだけの保存でペルソナは消えない');

  const markdown = buildReviewMarkdown(saved);
  assert.match(markdown, /## 読み手ペルソナ/);
  assert.match(markdown, /- 読み手: 運用当番の新人/);
  assert.match(markdown, /- AIが補った前提: 経験1年未満と想定しました/);

  await writeReview(root, 'guide.md', [], { persona: null });
  assert.equal((await readReview(root, 'guide.md')).persona, null, 'null は削除として扱う');
});

test('a comment added from a review carries the reviewed part into the exported Markdown', async (t) => {
  const { root } = await testStore(t);
  await writeReview(root, 'guide.md', [{
    type: 'text-selection',
    selectedText: 'deploy.sh',
    headingPath: ['デプロイ手順', '手順'],
    comment: '実行前に確認することを書いてください',
    source: 'ai-review',
    review: {
      skillId: 'ops-review',
      skillName: '運用レビュー',
      persona: '運用当番の新人',
      severity: 'must',
      reason: 'この読み手は製品を知らないためです'
    }
  }]);
  const saved = await readReview(root, 'guide.md');

  assert.equal(saved.comments[0].review.skillName, '運用レビュー', 'レビューの出どころはレビューファイルへ残る');

  const markdown = buildReviewMarkdown(saved);
  assert.match(markdown, /AIレビュー: スキル: 運用レビュー \/ 読み手: 運用当番の新人 \/ 重大度: 要対応/);
  assert.match(markdown, /判断理由: この読み手は製品を知らないためです/);
  assert.match(markdown, /対象テキスト:\n\n> deploy\.sh/, 'レビューされた部分そのものも書き出す');
});

function segmentIndexOf(prompt, text) {
  const segments = JSON.parse(prompt.match(/<document_segments>(.*)<\/document_segments>/)[1]);
  return segments.find((segment) => segment.text === text).i;
}

async function writeSkill(root, id, body, references = {}) {
  const dir = path.join(root, '.claude', 'skills', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: 運用観点のレビュー。\n---\n\n${body}\n`, 'utf8');
  for (const [name, text] of Object.entries(references)) {
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'references', name), text, 'utf8');
  }
}

async function testStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-document-review-root-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-document-review-data-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));
  return { root, store: new AiStore(root, { dataDir }) };
}

/** 反証のターンかどうか。1周目と2周目は、受け取る答えの形で見分けられます。 */
function isVerification(input) {
  return Boolean(input.outputSchema?.properties?.verdicts);
}

function fakeCodex(overrides = {}) {
  let nextThread = 1;
  const threadOptions = [];
  return {
    model: 'fast-test-model',
    effort: 'low',
    reviewModel: 'deep-test-model',
    reviewEffort: 'high',
    threadOptions,
    async start() {},
    async createThread(options = {}) {
      threadOptions.push(options);
      return `thread-${nextThread++}`;
    },
    async resumeThread(id) { return id; },
    async deleteThread() {},
    async runTurn() { return { text: '{}' }; },
    async close() {},
    ...overrides
  };
}
