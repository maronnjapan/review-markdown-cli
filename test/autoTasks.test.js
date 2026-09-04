import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_NEW_TASKS_PER_RUN, MAX_TASK_RUNS_PER_TICK, MAX_TASK_SOURCE_CHARS, MIN_TASK_SOURCE_GROWTH_CHARS } from '../src/aiLimits.js';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import { createAutoTaskRunner } from '../src/autoTaskRunner.js';
import {
  applyExtraction,
  applyTaskFailure,
  applyTaskResult,
  applyTasksChange,
  committedTasks,
  detectSourceKind,
  listWatchedFiles,
  normalizeAutoTaskActions,
  normalizeTasksChange,
  readTaskResult,
  readTasks,
  readTasksRecord,
  runnableTasks,
  shouldAnalyze,
  sliceTaskSource,
  sortTasksForDisplay,
  tasksPathFor,
  updateTasks
} from '../src/autoTasks.js';
import { DEFAULT_AUTO_TASK_ACTIONS } from '../src/autoTaskVocabulary.js';
import { appendCaptionEntry, normalizeCaptionEntry } from '../src/liveCaptions.js';
import { buildReviewMarkdown } from '../src/reviewStore.js';
import { createServer } from '../src/server.js';

const TRANSCRIPT = [
  '# 定例会議',
  '',
  '---',
  '',
  '**田中** `[10:00:00]`',
  '今日は再起動手順の確認です。',
  '',
  '**鈴木** `[10:02:00]`',
  '手順の前提が書かれていないので、当番は読めません。前提を調べて書いてください。',
  '',
  '**田中** `[10:03:00]`',
  '分かりました。停止条件は運用チームに確認します。',
  ''
].join('\n');

/* ---------------------------------------------------------------- *
 * 記録の読み書き
 * ---------------------------------------------------------------- */

test('保存済みの記録は、何が入っていても投げずに読める', () => {
  assert.deepEqual(readTasksRecord(undefined, 'a.md').tasks, []);
  assert.deepEqual(readTasksRecord('壊れている', 'a.md').tasks, []);

  const record = readTasksRecord({
    watch: true,
    analysis: { revision: 'abc', length: 12, sourceKind: 'transcript', analyzedAt: '2026-09-01T00:00:00.000Z' },
    focus: { now: '前提を書く', reason: '鈴木さんの依頼' },
    tasks: [
      { id: 't1', title: '前提を調べる', kind: 'research', status: 'running', priority: 'now' },
      { id: 't2', title: '', kind: 'action' },
      { id: 't3', title: '種類不明', kind: 'deploy', status: 'weird', priority: '?' }
    ]
  }, 'a.md');
  assert.equal(record.watch, true);
  assert.equal(record.analysis.sourceKind, 'transcript');
  assert.equal(record.focus.now, '前提を書く');
  assert.equal(record.tasks.length, 2, '題名の無いタスクは落とす');
  // 実行中のまま保存されたタスクは途中で落ちたものなので、未着手へ戻して読みます。
  assert.equal(record.tasks[0].status, 'open');
  assert.deepEqual([record.tasks[1].kind, record.tasks[1].status, record.tasks[1].priority], ['action', 'open', 'next']);
});

test('画面からの変更は、変えたいことだけを受け取り、無いidは黙って飛ばす', async () => {
  assert.throws(() => normalizeTasksChange({ watch: 'yes' }), /true \/ false/);
  assert.throws(() => normalizeTasksChange({ setStatus: [{ id: 't1', status: 'running' }] }), /open \/ done \/ dismissed/);
  assert.throws(() => normalizeTasksChange({ add: [{ title: '' }] }), /題名を入力/);
  assert.throws(() => normalizeTasksChange({ add: [{ title: 'x', kind: 'deploy' }] }), /種類が読めません/);

  const change = normalizeTasksChange({
    watch: true,
    setStatus: [{ id: 't1', status: 'done' }, { id: 'missing', status: 'done' }],
    add: [{ title: ' 停止条件を確認する ', kind: 'action' }],
    remove: ['t2']
  });
  const record = readTasksRecord({
    tasks: [
      { id: 't1', title: '前提を調べる', kind: 'research', status: 'open' },
      { id: 't2', title: '消すもの', kind: 'action', status: 'open' }
    ]
  }, 'a.md');
  const next = applyTasksChange(record, change, new Date('2026-09-03T00:00:00.000Z'));
  assert.equal(next.watch, true);
  assert.equal(next.tasks.find((task) => task.id === 't1').status, 'done');
  assert.equal(next.tasks.some((task) => task.id === 't2'), false);
  const added = next.tasks.find((task) => task.title === '停止条件を確認する');
  assert.equal(added.source, 'reviewer');
  assert.equal(added.status, 'open');
  assert.equal(added.createdAt, '2026-09-03T00:00:00.000Z');
});

/* ---------------------------------------------------------------- *
 * やると決めたタスク
 * ---------------------------------------------------------------- */

test('やると決めると段取りを持ち、見送っていたタスクは未着手へ戻る', () => {
  assert.throws(() => normalizeTasksChange({ plan: [{ commitment: 'committed' }] }), /idが要ります/);
  assert.throws(() => normalizeTasksChange({ plan: [{ id: 't1', commitment: 'maybe' }] }), /採否が読めません/);
  assert.throws(() => normalizeTasksChange({ plan: [{ id: 't1', due: '9/10' }] }), /YYYY-MM-DD/);
  assert.throws(() => normalizeTasksChange({ plan: [{ id: 't1', due: '2026-13-40' }] }), /日付として読めません/);
  assert.throws(() => normalizeTasksChange({ plan: [{ id: 't1', priority: 'urgent' }] }), /優先度が読めません/);
  assert.throws(() => normalizeTasksChange({ plan: [{ id: 't1', note: 'あ'.repeat(1001) }] }), /メモが長すぎます/);

  const record = readTasksRecord({
    tasks: [
      { id: 't1', title: '前提を調べる', kind: 'research', status: 'open', priority: 'later' },
      { id: 't2', title: '見送ったもの', kind: 'action', status: 'dismissed', priority: 'next' }
    ]
  }, 'a.md');
  const at = new Date('2026-09-03T00:00:00.000Z');
  const decided = applyTasksChange(record, normalizeTasksChange({
    plan: [
      { id: 't1', commitment: 'committed', due: '2026-09-10', note: ' 停止条件が決まってから ', priority: 'now', owner: '自分' },
      { id: 't2', commitment: 'committed' }
    ]
  }), at);

  const [first, second] = decided.tasks;
  assert.deepEqual(first.plan, {
    commitment: 'committed', due: '2026-09-10', note: '停止条件が決まってから', decidedAt: at.toISOString()
  });
  assert.deepEqual([first.priority, first.owner], ['now', '自分'], '優先度と担当は、決めたあとに動かすのでタスク本体へ書く');
  assert.equal(second.status, 'open', 'やると決め直したタスクは、見送りのままにしない');
  assert.deepEqual(committedTasks(decided.tasks).map((task) => task.id), ['t1', 't2']);

  // 期限とメモだけを直しても、決めた日は決めた日のまま。
  const later = applyTasksChange(decided, normalizeTasksChange({ plan: [{ id: 't1', due: '2026-09-12' }] }), new Date('2026-09-05T00:00:00.000Z'));
  assert.deepEqual(
    [later.tasks[0].plan.due, later.tasks[0].plan.note, later.tasks[0].plan.decidedAt],
    ['2026-09-12', '停止条件が決まってから', at.toISOString()]
  );

  // 見送るのは「やっぱりやらない」ので、やると決めた印もここで外れる。
  const dropped = applyTasksChange(later, normalizeTasksChange({ setStatus: [{ id: 't1', status: 'dismissed' }] }), at);
  assert.equal(dropped.tasks[0].plan.commitment, 'undecided');
  assert.deepEqual(committedTasks(dropped.tasks).map((task) => task.id), ['t2']);

  // 決めていない状態へ戻し、期限もメモも空にすると、段取りごと消える。
  const cleared = applyTasksChange(decided, normalizeTasksChange({ plan: [{ id: 't1', commitment: 'undecided', due: '', note: '' }] }), at);
  assert.equal(cleared.tasks[0].plan, undefined);
});

test('やると決めたタスクは、AIの整理で見送られない', () => {
  const record = readTasksRecord({
    tasks: [
      { id: 't1', title: '前提を調べる', kind: 'research', status: 'open', priority: 'now', plan: { commitment: 'committed', due: '2026-09-10' } },
      { id: 't2', title: '決めていないもの', kind: 'action', status: 'open', priority: 'now' }
    ]
  }, 'a.md');
  const source = { revision: 'rev', length: 10, sourceKind: 'transcript' };
  const at = new Date('2026-09-03T00:00:00.000Z');

  const dismissed = applyExtraction(record, {
    summary: '', focus: { now: '', reason: '' }, tasks: [],
    updates: [{ id: 't1', status: 'dismissed', reason: '話に出なくなった' }, { id: 't2', status: 'dismissed', reason: '同上' }]
  }, source, { organize: true, focus: false }, at);
  assert.equal(dismissed.tasks[0].status, 'open', 'レビュアーが決めたことを、整理で打ち消さない');
  assert.equal(dismissed.tasks[1].status, 'dismissed', '決めていないタスクは、これまでどおり見送られる');

  const done = applyExtraction(record, {
    summary: '', focus: { now: '', reason: '' }, tasks: [],
    updates: [{ id: 't1', status: 'done', reason: '調べ終えたと言った' }]
  }, source, { organize: true, focus: false }, at);
  assert.equal(done.tasks[0].status, 'done', '済んだという事実は通す（間違いなら画面から戻せる）');
  assert.equal(done.tasks[0].plan.commitment, 'committed', '完了にしても、決めたことは残る');
});

test('やると決めたタスクは、AIの実行でも画面の並びでも先に来る', () => {
  const record = readTasksRecord({
    tasks: [
      { id: 'a', title: '優先度の高い候補', kind: 'research', status: 'open', priority: 'now', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'b', title: '決めたもの', kind: 'research', status: 'open', priority: 'later', createdAt: '2026-09-02T00:00:00.000Z', plan: { commitment: 'committed', due: '2026-09-20' } },
      { id: 'c', title: '期限の近い決めたもの', kind: 'research', status: 'open', priority: 'later', createdAt: '2026-09-03T00:00:00.000Z', plan: { commitment: 'committed', due: '2026-09-10' } }
    ]
  }, 'a.md');
  assert.deepEqual(runnableTasks(record, ['research']).map((task) => task.id), ['b', 'c', 'a'], '決めたものから片付けさせる');
  assert.deepEqual(sortTasksForDisplay(record.tasks).map((task) => task.id), ['c', 'b', 'a'], '決めたものが先で、期限の近い順');
});

test('同じファイルへの書き込みは1本の列に並ぶので、同時の変更が消えない', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-tasks-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await Promise.all([
    updateTasks(root, 'docs/plan.md', (current) => ({ ...current, watch: true })),
    updateTasks(root, 'docs/plan.md', (current) => applyTasksChange(current, { add: [{ title: 'A', kind: 'action', detail: '', priority: 'next' }] })),
    updateTasks(root, 'docs/plan.md', (current) => applyTasksChange(current, { add: [{ title: 'B', kind: 'action', detail: '', priority: 'next' }] }))
  ]);

  const record = await readTasks(root, 'docs/plan.md');
  assert.equal(record.watch, true);
  assert.deepEqual(record.tasks.map((task) => task.title).sort(), ['A', 'B']);
  assert.equal(tasksPathFor(root, 'docs/plan.md'), path.join(root, '.review', 'docs', 'plan.md.tasks.json'));
  assert.deepEqual(await listWatchedFiles(root), ['docs/plan.md'], '見守りを付けた文書は .review から拾える');
});

/* ---------------------------------------------------------------- *
 * 何を読ませるか
 * ---------------------------------------------------------------- */

test('追記だけなら増えた分だけを渡し、途中が変われば全体を渡す', () => {
  const first = sliceTaskSource(TRANSCRIPT, null);
  assert.equal(first.appended, false);
  assert.equal(first.text, TRANSCRIPT);
  assert.equal(first.omitted, 0);
  const analysis = { revision: first.revision, length: first.length, analyzedAt: '2026-09-03T00:00:00.000Z' };

  assert.equal(shouldAnalyze(TRANSCRIPT, analysis), false, '変わっていなければ読まない');
  const tiny = `${TRANSCRIPT}**田中** \`[10:04:00]\`\nはい。\n\n`;
  assert.equal(shouldAnalyze(tiny, analysis), false, '増え方が小さければ待つ');
  assert.equal(
    shouldAnalyze(tiny, analysis, { now: Date.parse('2026-09-03T01:00:00.000Z'), staleAfterMs: 10 * 60 * 1000 }),
    true,
    '待ちが長引けば、小さな増え方でも読む'
  );

  const appended = `${TRANSCRIPT}**鈴木** \`[10:05:00]\`\n${'図の単位も抜けています。'.repeat(12)}\n\n`;
  assert.equal(shouldAnalyze(appended, analysis), true);
  const sliced = sliceTaskSource(appended, analysis);
  assert.equal(sliced.appended, true);
  assert.match(sliced.text, /^\*\*鈴木\*\* `\[10:05:00\]`/, '増えた分だけ');
  assert.equal(sliced.text.includes('今日は再起動手順の確認です。'), false);
  assert.match(sliced.recent, /停止条件は運用チームに確認します。/, '手前の少しを添える');

  const edited = TRANSCRIPT.replace('当番は読めません', '当番は読めない');
  assert.equal(shouldAnalyze(edited, analysis), true);
  assert.equal(sliceTaskSource(edited, analysis).appended, false, '途中が変われば全体');

  const long = 'あ'.repeat(MAX_TASK_SOURCE_CHARS + 500);
  const tail = sliceTaskSource(long, null);
  assert.equal(tail.text.length, MAX_TASK_SOURCE_CHARS);
  assert.equal(tail.omitted, 500);
  assert.equal(MIN_TASK_SOURCE_GROWTH_CHARS > 0, true);
});

test('文字起こしかどうかは、字幕の発言が数件あるかで決まる', () => {
  assert.equal(detectSourceKind(TRANSCRIPT), 'transcript');
  assert.equal(detectSourceKind('# 設計メモ\n\n**太字**の段落です。\n'), 'document');
  assert.equal(detectSourceKind('# 設計メモ\n', { captioned: true }), 'transcript', '字幕が届いていれば形を見なくても文字起こし');
});

/* ---------------------------------------------------------------- *
 * モデルの答えを重ねる
 * ---------------------------------------------------------------- */

test('抽出の答えは、同じ題名の残っているタスクを重ねず、整理と今すべきことは任せたときだけ当てる', () => {
  const record = readTasksRecord({
    tasks: [
      { id: 't1', title: '前提を調べる', kind: 'research', status: 'open', priority: 'now', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 't2', title: '単位を書く', kind: 'action', status: 'done', priority: 'next' }
    ]
  }, 'meeting.md');
  const answer = {
    summary: '前提と停止条件が残っています。',
    focus: { now: '停止条件を運用チームに確認する', reason: '田中さんが引き受けた直後だから' },
    tasks: [
      { title: '前提を調べる', detail: '重複', kind: 'research', priority: 'now', quote: '', owner: '' },
      { title: '単位を書く', detail: '蒸し返し', kind: 'action', priority: 'later', quote: '単位', owner: '' },
      { title: '停止条件を運用チームに確認する', detail: '田中さんが引き受けた。', kind: 'action', priority: 'now', quote: '停止条件は運用チームに確認します。', owner: '田中' }
    ],
    updates: [{ id: 't1', status: 'done', reason: '調べ終えたと言った' }, { id: 'missing', status: 'done', reason: '' }]
  };
  const source = { revision: 'rev-2', length: 300, sourceKind: 'transcript' };
  const at = new Date('2026-09-03T00:00:00.000Z');

  const organized = applyExtraction(record, answer, source, { organize: true, focus: true }, at);
  assert.deepEqual(
    organized.tasks.map((task) => task.title),
    ['前提を調べる', '単位を書く', '単位を書く', '停止条件を運用チームに確認する'],
    '残っているものと同じ題名は足さないが、済んだものと同じ題名は新しいタスクとして足す'
  );
  assert.equal(organized.tasks[0].status, 'done', '整理を任せていれば、済んだタスクは完了になる');
  assert.equal(organized.tasks[0].statusReason, '調べ終えたと言った');
  assert.equal(organized.focus.now, '停止条件を運用チームに確認する');
  assert.deepEqual(organized.analysis, { revision: 'rev-2', length: 300, sourceKind: 'transcript', analyzedAt: at.toISOString(), summary: answer.summary });
  const added = organized.tasks.at(-1);
  assert.deepEqual([added.source, added.status, added.owner, added.createdAt], ['ai', 'open', '田中', at.toISOString()]);

  const extractOnly = applyExtraction(record, answer, source, { organize: false, focus: false }, at);
  assert.equal(extractOnly.tasks[0].status, 'open', '整理を任せていなければ状態は変えない');
  assert.equal(extractOnly.focus, null);

  const many = { ...answer, tasks: Array.from({ length: MAX_NEW_TASKS_PER_RUN + 5 }, (_, i) => ({ title: `T${i}`, detail: '', kind: 'action', priority: 'later', quote: '', owner: '' })) };
  assert.equal(applyExtraction(readTasksRecord({}, 'x.md'), many, source, {}, at).tasks.length, MAX_NEW_TASKS_PER_RUN);
});

test('実行の結果は確認待ちとして入り、次のタスクを親付きで足し、失敗は未着手へ戻す', () => {
  const record = readTasksRecord({
    tasks: [{ id: 't1', title: '前提を調べる', kind: 'research', status: 'running', priority: 'now' }]
  }, 'meeting.md');
  const result = readTaskResult({
    summary: '前提は3つです。',
    body: '# 調査メモ\n\n- OSの版\n- 権限\n- 停止条件（未確認）',
    followUps: ['停止条件を確認する', ''],
    questions: ['どの環境の手順か']
  }, new Date('2026-09-03T00:00:00.000Z'));
  assert.equal(result.truncated, false);
  assert.deepEqual(result.followUps, ['停止条件を確認する']);

  const ready = applyTaskResult(record, 't1', result, new Date('2026-09-03T00:01:00.000Z'));
  assert.equal(ready.tasks[0].status, 'ready');
  assert.equal(ready.tasks[0].result.summary, '前提は3つです。');
  assert.equal(ready.tasks[1].title, '停止条件を確認する');
  assert.equal(ready.tasks[1].parentId, 't1');
  assert.equal(ready.tasks[1].status, 'open');

  const failed = applyTaskFailure(record, 't1', 'AIが落ちました');
  assert.equal(failed.tasks[0].status, 'open');
  assert.equal(failed.tasks[0].error, 'AIが落ちました');

  // 実行できるのは、未着手でAIが実行できる種類で、その自動化を任せられているものだけ。
  const candidates = readTasksRecord({
    tasks: [
      { id: 'a', title: '連絡する', kind: 'action', status: 'open', priority: 'now' },
      { id: 'b', title: '調べる', kind: 'research', status: 'open', priority: 'later', createdAt: '2026-09-02T00:00:00.000Z' },
      { id: 'c', title: '答える', kind: 'inquiry', status: 'open', priority: 'now', createdAt: '2026-09-03T00:00:00.000Z' },
      { id: 'd', title: '書く', kind: 'sample', status: 'ready', priority: 'now' }
    ]
  }, 'x.md');
  assert.deepEqual(runnableTasks(candidates, ['research', 'inquiry']).map((task) => task.id), ['c', 'b']);
  assert.deepEqual(runnableTasks(candidates, ['organize']).map((task) => task.id), []);
  assert.deepEqual(normalizeAutoTaskActions(undefined), [...DEFAULT_AUTO_TASK_ACTIONS]);
});

/* ---------------------------------------------------------------- *
 * AIへの依頼
 * ---------------------------------------------------------------- */

test('抽出は前提と既存タスクを添え、追記のときは増えた分だけをモデルへ渡す', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'meeting.md'), TRANSCRIPT, 'utf8');
  const turns = [];
  const service = new AiService(root, { store, client: fakeCodex(turns) });
  const empty = readTasksRecord({}, 'meeting.md');

  const first = await service.extractTasks('meeting.md', { record: empty, actions: ['organize', 'focus', 'research'], instructions: '顧客の質問は必ず拾う' });
  assert.equal(first.source.sourceKind, 'transcript');
  assert.equal(first.source.appended, false);
  assert.equal(first.answer.tasks.length, 2);
  assert.equal(first.answer.tasks[0].kind, 'research');
  assert.match(turns[0].prompt, /live transcript/);
  assert.match(turns[0].prompt, /<material>/);
  assert.match(turns[0].prompt, /<automation_instructions>\n顧客の質問は必ず拾う/);
  assert.match(turns[0].prompt, /report it in "updates"/, '整理を任せていれば更新を頼む');
  assert.match(turns[0].prompt, /"focus\.now" to the one thing/);
  assert.equal(turns[0].outputSchema.properties.updates.items.properties.id.enum, undefined, '既存タスクが無ければ enum を置かない');

  const record = applyExtraction(empty, first.answer, first.source, { organize: true, focus: true });
  await appendCaptionEntry(root, 'meeting.md', normalizeCaptionEntry({
    speaker: '鈴木', text: `${'図の単位も抜けています。'.repeat(12)}`, time: '10:05:00'
  }));
  const second = await service.extractTasks('meeting.md', { record, actions: [] });
  assert.equal(second.source.appended, true);
  assert.match(turns[1].prompt, /<new_material>\n\*\*鈴木\*\* `\[10:05:00\]`/);
  const newMaterial = /<new_material>\n([\s\S]*?)<\/new_material>/.exec(turns[1].prompt)[1];
  assert.equal(newMaterial.includes('今日は再起動手順の確認です'), false, '前に読んだ分は渡さない');
  assert.match(turns[1].prompt, /<recent_material>[\s\S]*停止条件は運用チームに確認します/);
  assert.match(turns[1].prompt, /Leave "updates" empty/, '整理を任せていなければ頼まない');
  assert.deepEqual(
    turns[1].outputSchema.properties.updates.items.properties.id.enum,
    record.tasks.map((task) => task.id),
    '更新できるのは渡した既存タスクだけ'
  );
  const existing = JSON.parse(/<existing_tasks>(\[.*?\])<\/existing_tasks>/s.exec(turns[1].prompt)[1]);
  assert.deepEqual(Object.keys(existing[0]), ['id', 'title', 'kind', 'status', 'priority'], '既存タスクは要点だけ渡す');

  const performed = await service.performTask('meeting.md', record.tasks[0], { instructions: 'TypeScriptで' });
  assert.equal(performed.summary, '前提は3つです。');
  assert.match(turns[2].prompt, /<task kind="research">/);
  assert.match(turns[2].prompt, /research memo/);
  assert.match(turns[2].prompt, /cannot run code/);
  assert.match(turns[2].prompt, /<automation_instructions>\nTypeScriptで/);
});

/* ---------------------------------------------------------------- *
 * 実行係
 * ---------------------------------------------------------------- */

test('見守りは変わった文書だけを読み、任せた種類を上限まで実行し、変わっていなければAIへ送らない', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-tasks-runner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'meeting.md'), TRANSCRIPT, 'utf8');
  await fs.writeFile(path.join(root, 'plan.md'), '# 計画\n\n来週までに設計書を仕上げる。\n', 'utf8');
  await updateTasks(root, 'plan.md', (current) => ({ ...current, watch: true }));

  const calls = [];
  const logs = [];
  const aiService = {
    async extractTasks(documentPath, input) {
      calls.push(['extract', documentPath, input.captioned, input.actions]);
      return {
        answer: {
          summary: '要約',
          focus: { now: '前提を書く', reason: '依頼されたから' },
          tasks: [
            { title: `${documentPath} 調査1`, detail: '', kind: 'research', priority: 'now', quote: '', owner: '' },
            { title: `${documentPath} 調査2`, detail: '', kind: 'research', priority: 'next', quote: '', owner: '' },
            { title: `${documentPath} 調査3`, detail: '', kind: 'research', priority: 'next', quote: '', owner: '' },
            { title: `${documentPath} 調査4`, detail: '', kind: 'research', priority: 'later', quote: '', owner: '' },
            { title: `${documentPath} 連絡`, detail: '', kind: 'action', priority: 'now', quote: '', owner: '' }
          ],
          updates: []
        },
        source: { ...sliceTaskSource(await fs.readFile(path.join(root, documentPath), 'utf8'), input.record.analysis), sourceKind: 'transcript' }
      };
    },
    async performTask(documentPath, task) {
      calls.push(['perform', documentPath, task.title]);
      if (task.title.endsWith('調査2')) throw new Error('AIが落ちました');
      return { summary: `${task.title} の結果`, body: '本文', truncated: false, followUps: [], questions: [], completedAt: '2026-09-03T00:00:00.000Z' };
    }
  };
  const settings = { autoTasks: { enabled: true, intervalSeconds: 120, actions: ['organize', 'focus', 'research'], instructions: '' } };
  const runner = createAutoTaskRunner({ rootDir: root, aiService, settings, log: (line) => logs.push(line), setTimer: () => null, clearTimer: () => {} });
  runner.noteActivity('meeting.md');

  const first = await runner.tick();
  assert.deepEqual(first.ran, ['meeting.md', 'plan.md']);
  assert.deepEqual(calls.filter(([kind]) => kind === 'extract').map(([, file, captioned]) => [file, captioned]), [['meeting.md', true], ['plan.md', false]]);
  const performed = calls.filter(([kind]) => kind === 'perform');
  assert.equal(performed.filter(([, file]) => file === 'meeting.md').length, MAX_TASK_RUNS_PER_TICK, '1回の見守りで実行するのは上限まで');
  assert.deepEqual(performed.filter(([, file]) => file === 'meeting.md').map(([, , title]) => title), ['meeting.md 調査1', 'meeting.md 調査2', 'meeting.md 調査3'], '優先度の高い順');

  const meeting = await readTasks(root, 'meeting.md');
  assert.equal(meeting.focus.now, '前提を書く');
  assert.equal(meeting.tasks.find((task) => task.title === 'meeting.md 調査1').status, 'ready');
  assert.equal(meeting.tasks.find((task) => task.title === 'meeting.md 調査1').result.summary, 'meeting.md 調査1 の結果');
  const failed = meeting.tasks.find((task) => task.title === 'meeting.md 調査2');
  assert.equal(failed.status, 'open', '失敗したタスクは未着手へ戻る');
  assert.equal(failed.error, 'AIが落ちました');
  assert.equal(meeting.tasks.find((task) => task.title === 'meeting.md 調査4').status, 'open', '上限を超えた分は次の回へ');
  assert.equal(meeting.tasks.find((task) => task.title === 'meeting.md 連絡').status, 'open', '人がやる種類は実行しない');
  assert.equal(meeting.analysis.length, TRANSCRIPT.length);
  assert.ok(logs.some((line) => /meeting\.md: タスクを5件起こしました/.test(line)), 'ターミナルにも残す');

  // 変わっていなければ読まず、無効にすれば何もしません。
  calls.length = 0;
  const second = await runner.tick();
  assert.deepEqual(second.ran, []);
  assert.deepEqual(calls, []);
  settings.autoTasks = { ...settings.autoTasks, enabled: false };
  await appendCaptionEntry(root, 'meeting.md', normalizeCaptionEntry({ speaker: '鈴木', text: '単位'.repeat(80), time: '10:06:00' }));
  assert.deepEqual((await runner.tick()).ran, []);
  assert.deepEqual(calls, [], '無効のあいだはAIへ送らない');

  const status = runner.status('meeting.md', await readTasks(root, 'meeting.md'));
  assert.equal(status.captioned, true);
  assert.equal(status.watching, false, '無効なら見守っていない');
});

test('画面の「整理する」は変わっていなくても読み直し、1つのタスクの実行は確認待ちにする', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-tasks-runnow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'plan.md'), '# 計画\n\n来週までに設計書を仕上げる。\n', 'utf8');
  const phases = [];
  const aiService = {
    async extractTasks(documentPath, input) {
      const markdown = await fs.readFile(path.join(root, documentPath), 'utf8');
      return {
        answer: { summary: '', focus: { now: '', reason: '' }, tasks: [{ title: '設計書の構成を決める', detail: '', kind: 'decision', priority: 'now', quote: '', owner: '' }], updates: [] },
        source: { ...sliceTaskSource(markdown, input.record.analysis), sourceKind: 'document' }
      };
    },
    async performTask(documentPath, task) {
      return { summary: `${task.title} の段取り`, body: '1. 章立て', truncated: false, followUps: ['レビュー依頼を出す'], questions: [], completedAt: '2026-09-03T00:00:00.000Z' };
    }
  };
  const settings = { autoTasks: { enabled: true, intervalSeconds: 120, actions: [], instructions: '' } };
  const runner = createAutoTaskRunner({ rootDir: root, aiService, settings, setTimer: () => null, clearTimer: () => {} });

  const first = await runner.runNow('plan.md', { onPhase: (phase) => phases.push(phase) });
  assert.deepEqual(phases, ['extracting']);
  assert.equal(first.tasks.length, 1);
  const again = await runner.runNow('plan.md');
  assert.equal(again.tasks.length, 1, '同じ題名は重ねない');

  const ran = await runner.runTask('plan.md', first.tasks[0].id);
  assert.equal(ran.tasks[0].status, 'ready');
  assert.equal(ran.tasks[0].result.body, '1. 章立て');
  assert.equal(ran.tasks[1].title, 'レビュー依頼を出す', '結果から出た次のタスクが足される');
  await assert.rejects(runner.runTask('plan.md', 'no-such-task'), /見つかりません/);
});

/* ---------------------------------------------------------------- *
 * ルート
 * ---------------------------------------------------------------- */

test('自動タスクのルートは有効にするまで断り、有効なら記録と見守りの状態を返し、整理は流れてくる', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-tasks-routes-'));
  await fs.writeFile(path.join(root, 'meeting.md'), TRANSCRIPT, 'utf8');
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async extractTasks(documentPath, input, { onDelta }) {
      onDelta('{"summary":');
      const markdown = await fs.readFile(path.join(root, documentPath), 'utf8');
      return {
        answer: { summary: '前提が足りません。', focus: { now: '前提を書く', reason: '依頼' }, tasks: [{ title: '前提を調べる', detail: '', kind: 'research', priority: 'now', quote: '', owner: '' }], updates: [] },
        source: { ...sliceTaskSource(markdown, input.record.analysis), sourceKind: 'transcript' }
      };
    },
    async performTask(documentPath, task) {
      return { summary: `${task.title} の結果`, body: '本文', truncated: false, followUps: [], questions: [], completedAt: '2026-09-03T00:00:00.000Z' };
    },
    close() {}
  };
  const disabled = await startServer(t, root, { aiService, aiToken: 'tasks-token', liveCaptionsToken: 'captions-token' });
  const headers = { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'tasks-token' };
  assert.equal((await fetch(`${disabled}/api/tasks?path=meeting.md`, { headers })).status, 404, '無効のうちは断る');
  assert.equal((await fetch(`${disabled}/api/ai/tasks/extract`, { method: 'POST', headers, body: JSON.stringify({ path: 'meeting.md' }) })).status, 404);

  const baseUrl = await startServer(t, root, { aiService, aiToken: 'tasks-token', liveCaptionsToken: 'captions-token', autoTasks: true, autoTasksActions: ['focus', 'research'] });
  assert.equal((await fetch(`${baseUrl}/api/tasks?path=meeting.md`)).status, 403, 'トークン無しでは読めない');

  const opened = await fetch(`${baseUrl}/api/file?path=meeting.md`).then((response) => response.json());
  assert.equal(opened.features.autoTasks, true);

  const empty = await fetch(`${baseUrl}/api/tasks?path=meeting.md`, { headers }).then((response) => response.json());
  assert.deepEqual(empty.tasks.tasks, []);
  assert.equal(empty.tasksFile, '.review/meeting.md.tasks.json');
  assert.equal(empty.runner.enabled, true);
  assert.deepEqual(empty.runner.actions, ['focus', 'research']);
  assert.equal(empty.runner.watching, false);

  // 字幕が届いた文書は見守りの対象になります。
  await fetch(`${baseUrl}/api/live-captions/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Review-Markdown-Live-Captions-Token': 'captions-token' },
    body: JSON.stringify({ path: 'meeting.md', speaker: '鈴木', text: '単位も抜けています', time: '10:05:00' })
  });
  const captioned = await fetch(`${baseUrl}/api/tasks?path=meeting.md`, { headers }).then((response) => response.json());
  assert.equal(captioned.runner.captioned, true);
  assert.equal(captioned.runner.watching, true);

  const streamed = await fetch(`${baseUrl}/api/ai/tasks/extract`, { method: 'POST', headers, body: JSON.stringify({ path: 'meeting.md' }) });
  assert.equal(streamed.status, 200);
  const events = (await streamed.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['started', 'phase', 'delta', 'phase', 'result']);
  assert.equal(events[1].phase, 'extracting');
  assert.equal(events[3].phase, 'performing:前提を調べる');
  const result = events.at(-1);
  assert.equal(result.tasks.tasks[0].status, 'ready', '任せた種類は続けて実行される');
  assert.equal(result.tasks.focus.now, '前提を書く');

  const changed = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers, body: JSON.stringify({ path: 'meeting.md', watch: true, setStatus: [{ id: result.tasks.tasks[0].id, status: 'done' }] })
  }).then((response) => response.json());
  assert.equal(changed.tasks.watch, true);
  assert.equal(changed.tasks.tasks[0].status, 'done');
  const saved = JSON.parse(await fs.readFile(path.join(root, '.review', 'meeting.md.tasks.json'), 'utf8'));
  assert.equal(saved.watch, true);

  const bad = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ path: 'meeting.md', watch: 'yes' }) });
  assert.equal(bad.status, 400);

  // 出力するレビューMarkdownにも、今すべきことと残っているタスクが載ります。
  const exported = await fetch(`${baseUrl}/api/export?path=meeting.md`).then((response) => response.text());
  assert.match(exported, /## 自動タスク/);
  assert.match(exported, /今すべきこと: 前提を書く/);
  assert.match(exported, /\[x\] 前提を調べる（完了／調査／いま）/);
});

test('レビューMarkdownの自動タスクの節は、有効でないときは出ない', () => {
  const base = { targetFile: 'a.md', comments: [] };
  assert.equal(/自動タスク/.test(buildReviewMarkdown(base)), false);
  assert.equal(/自動タスク/.test(buildReviewMarkdown({ ...base, tasks: { focus: null, tasks: [] } })), false, '何も無ければ節ごと出ない');
  const withTasks = buildReviewMarkdown({
    ...base,
    tasks: {
      focus: { now: '前提を書く', reason: '' },
      tasks: [{ id: 't', title: '調べる', kind: 'research', status: 'ready', priority: 'now', owner: '田中', detail: '前提を洗う', quote: '当番は読めません', result: { summary: '3つ' } }]
    }
  });
  assert.match(withTasks, /- \[ \] 調べる（確認待ち／調査／いま／担当: 田中）\n  前提を洗う\n  引用: 当番は読めません\n  AIの結果: 3つ/);
  assert.equal(/やると決めたこと/.test(withTasks), false, '決めたものが1件も無ければ、その見出しは出ない');
});

test('レビューMarkdownは、やると決めたことを先に書き出す', () => {
  const markdown = buildReviewMarkdown({
    targetFile: 'a.md',
    comments: [],
    tasks: {
      focus: null,
      tasks: [
        { id: 't1', title: '停止条件を確認する', kind: 'action', status: 'open', priority: 'later', detail: '運用チームへ', quote: '', owner: '田中', plan: { commitment: 'committed', due: '2026-09-10', note: '手順を出す前に' } },
        { id: 't2', title: '決めていないもの', kind: 'research', status: 'open', priority: 'now', detail: '', quote: '', owner: '' },
        { id: 't3', title: '済んだもの', kind: 'action', status: 'done', priority: 'now', detail: '', quote: '', owner: '', plan: { commitment: 'committed', due: '', note: '' } }
      ]
    }
  });
  assert.match(markdown, /### やると決めたこと\n\n- \[ \] 停止条件を確認する（未着手／対応／あとで／やる／期限: 2026-09-10／担当: 田中）\n  手順を出す前に/);
  assert.equal(/### やると決めたこと\n\n[\s\S]*決めていないもの[\s\S]*### すべてのタスク/.test(markdown), false, '決めたものだけを先に出す');
  assert.equal(/### やると決めたこと\n\n[\s\S]*済んだもの[\s\S]*### すべてのタスク/.test(markdown), false, '済んだものは、やることとしては出さない');
  const all = markdown.slice(markdown.indexOf('### すべてのタスク'));
  assert.match(all, /- \[ \] 停止条件を確認する（未着手／対応／あとで／やる／期限: 2026-09-10／担当: 田中）/, '下の一覧でも「やる」と期限が分かる');
  assert.match(all, /自分のメモ: 手順を出す前に/);
  assert.match(all, /- \[x\] 済んだもの/);
});

/* ---------------------------------------------------------------- *
 * 差し替え口
 * ---------------------------------------------------------------- */

function fakeCodex(turns) {
  let nextThread = 1;
  return {
    model: 'fast-test-model',
    effort: 'low',
    async start() {},
    async createThread() { return `thread-${nextThread++}`; },
    async resumeThread(id) { return id; },
    async deleteThread() {},
    async runTurn(input) {
      turns.push(input);
      const fields = Object.keys(input.outputSchema?.properties || {});
      if (fields.includes('followUps')) {
        return { text: JSON.stringify({ summary: '前提は3つです。', body: '# 調査メモ', followUps: [], questions: [] }) };
      }
      return {
        text: JSON.stringify({
          summary: '前提と停止条件が残っています。',
          focus: { now: '前提を書く', reason: '鈴木さんの依頼' },
          tasks: [
            { title: '手順の前提を調べる', detail: '当番が知らない前提を洗い出す。', kind: 'research', priority: 'now', quote: '前提を調べて書いてください。', owner: '' },
            { title: '停止条件を運用チームに確認する', detail: '', kind: 'action', priority: 'now', quote: '停止条件は運用チームに確認します。', owner: '田中' }
          ],
          updates: []
        })
      };
    },
    async close() {}
  };
}

async function testStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-tasks-service-root-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-tasks-service-data-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));
  return { root, store: new AiStore(root, { dataDir }) };
}

async function startServer(t, root, options) {
  const { app } = createServer(root, options);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
