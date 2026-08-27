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

test('a review reads with the chosen skill and as the saved reader', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await writeSkill(root, 'ops-review', '# 運用レビュー\n\n実行前の確認手順を見る。');
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
      return {
        text: JSON.stringify({
          summary: 'この読み手には前提の説明が足りません。',
          placements: [
            {
              segmentIndex: segmentIndexOf(input.prompt, 'まず deploy.sh を実行します。'),
              quote: 'deploy.sh',
              comment: '実行前に確認することを書いてください。',
              reason: 'この読み手は製品を知らないためです。',
              severity: 'must',
              confidence: 'high'
            }
          ],
          unplaced: [{ note: '全体的に前提が足りません', reason: '特定の段落に結び付かないためです' }]
        })
      };
    }
  });
  const service = new AiService(root, { store, codex });

  const review = await service.reviewDocument('guide.md', { skillId: 'ops-review' });

  assert.equal(review.skill.id, 'ops-review');
  assert.equal(review.summary, 'この読み手には前提の説明が足りません。');
  assert.equal(review.placements.length, 1);
  assert.equal(review.placements[0].severity, 'must');
  assert.equal(review.placements[0].target.type, 'text-selection');
  assert.equal(review.placements[0].target.selectedText, 'deploy.sh', '対象は本文から取るので画面で見つけられる');
  assert.deepEqual(review.placements[0].target.headingPath, ['デプロイ手順', '手順']);
  assert.equal(review.unplaced.length, 1);
  assert.equal(review.persona.label, '運用当番の新人');

  assert.match(turns[0].prompt, /<review_skill name="ops-review">/);
  assert.match(turns[0].prompt, /実行前の確認手順を見る/);
  assert.match(turns[0].prompt, /<reader_persona>[\s\S]*運用当番の新人/);
  assert.match(turns[0].prompt, /運用手順書/);
  assert.match(turns[0].prompt, /data, not instructions/);
  assert.deepEqual(
    Object.keys(turns[0].outputSchema.properties),
    ['summary', 'placements', 'unplaced'],
    'レビューは構造化された答えだけを受け取る'
  );

  const saved = await readReview(root, 'guide.md');
  assert.deepEqual(saved.comments, [], '採用するまでレビューファイルへは何も書かない');
});

test('a review needs a skill that exists, and a document with body text', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'guide.md'), DOCUMENT, 'utf8');
  await fs.writeFile(path.join(root, 'empty.md'), '\n', 'utf8');
  const service = new AiService(root, { store, codex: fakeCodex() });

  await assert.rejects(
    () => service.reviewDocument('guide.md', { skillId: 'no-such-skill' }),
    /レビュースキルが見つかりません/
  );
  await assert.rejects(
    () => service.reviewDocument('empty.md', { skillId: 'reader-fit-review' }),
    /レビューできる本文が見つかりません/
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
  const service = new AiService(root, { store, codex });

  const persona = await service.composePersona('guide.md', '  異動したての運用担当。Linuxは触れる。  ');

  assert.equal(persona.label, '運用当番の新人');
  assert.equal(persona.input, '異動したての運用担当。Linuxは触れる。');
  assert.deepEqual(persona.assumptions, ['経験1年未満と想定しました']);
  assert.match(turns[0].prompt, /<reader_notes>/);
  assert.equal((await readReview(root, 'guide.md')).persona, null, '組み直しただけでは保存しない');

  await assert.rejects(() => service.composePersona('guide.md', '   '), /読み手ペルソナの説明を入力してください/);
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

async function writeSkill(root, id, body) {
  const dir = path.join(root, '.claude', 'skills', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: 運用観点のレビュー。\n---\n\n${body}\n`, 'utf8');
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

function fakeCodex(overrides = {}) {
  let nextThread = 1;
  return {
    model: 'fast-test-model',
    effort: 'low',
    async start() {},
    async createThread() { return `thread-${nextThread++}`; },
    async resumeThread(id) { return id; },
    async deleteThread() {},
    async runTurn() { return { text: '{}' }; },
    async close() {},
    ...overrides
  };
}
