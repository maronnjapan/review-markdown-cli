import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../src/aiService.js';
import { AiStore } from '../src/aiStore.js';
import {
  buildRecap,
  normalizeRecapRequest,
  parseCaptionEntries,
  recapMarkFor,
  selectRecapWindow
} from '../src/captionRecap.js';
import { appendCaptionEntry, normalizeCaptionEntry } from '../src/liveCaptions.js';
import { createServer } from '../src/server.js';

const TRANSCRIPT = [
  '# 定例会議',
  '',
  '- 会議コード: abc-defg-hij',
  '',
  '---',
  '',
  '**田中** `[10:00:00]`',
  'よろしくお願いします',
  '',
  '**鈴木** `[10:02:00]`',
  '3章の前提が書かれていないので、初見だと読めません。',
  '',
  '**田中** `[10:20:00]`',
  'そこは次の版で直します。',
  '',
  '**鈴木** `[10:21:30]`',
  '来週の水曜までにお願いします。',
  'あと、図の単位も抜けています。',
  ''
].join('\n');

test('文字起こしの1行は、書いた形のまま発言として読み戻せる', () => {
  const entries = parseCaptionEntries(TRANSCRIPT);

  assert.deepEqual(entries.map((entry) => entry.speaker), ['田中', '鈴木', '田中', '鈴木']);
  assert.deepEqual(entries.map((entry) => entry.index), [0, 1, 2, 3]);
  assert.equal(entries[0].time, '10:00:00');
  assert.equal(
    entries[3].text,
    '来週の水曜までにお願いします。\nあと、図の単位も抜けています。',
    '複数行の発言は1件のまま読む'
  );
  // 見出しと会議コードは発言ではないので、どの窓を切っても混ざりません。
  assert.equal(entries.some((entry) => entry.text.includes('会議コード')), false);
});

test('書き込んだ字幕を、そのまま発言として読み戻せる', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-roundtrip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await appendCaptionEntry(root, 'meeting.md', normalizeCaptionEntry({
    speaker: '鈴木', text: '前提が抜けています', time: '10:02:00', title: '定例会議'
  }));

  const entries = parseCaptionEntries(await fs.readFile(path.join(root, 'meeting.md'), 'utf8'));

  assert.deepEqual(entries, [{ index: 0, speaker: '鈴木', time: '10:02:00', text: '前提が抜けています' }]);
});

test('文字起こしでない文書には、聞き直せる発言が1件も無い', () => {
  assert.deepEqual(parseCaptionEntries('# 設計メモ\n\n**太字**の段落です。\n'), []);
  const window = selectRecapWindow([], { scope: 'all' });
  assert.deepEqual(window.entries, []);
  assert.equal(window.reason, 'no-entries');
});

test('直近は分でも切れるし、時刻を読めない行があっても途中で切れない', () => {
  const entries = parseCaptionEntries(TRANSCRIPT);

  const fiveMinutes = selectRecapWindow(entries, { scope: 'minutes', minutes: 5 });
  assert.deepEqual(fiveMinutes.entries.map((entry) => entry.index), [2, 3]);
  assert.equal(fiveMinutes.from, '10:20:00');
  assert.equal(fiveMinutes.to, '10:21:30');
  assert.deepEqual(fiveMinutes.leadIn.map((entry) => entry.index), [0, 1], '手前の発言は助走として添える');

  const halfHour = selectRecapWindow(entries, { scope: 'minutes', minutes: 30 });
  assert.deepEqual(halfHour.entries.map((entry) => entry.index), [0, 1, 2, 3]);
  assert.deepEqual(halfHour.leadIn, [], '会議の頭まで届いたら助走は要らない');

  // 時刻の無い行は「切る位置」にしません。切ると、話の途中で窓が始まります。
  const noTime = parseCaptionEntries([
    '**田中** `[]`',
    'メモだけの行',
    '',
    '**鈴木** `[10:21:00]`',
    'いまの話です',
    ''
  ].join('\n'));
  assert.deepEqual(selectRecapWindow(noTime, { scope: 'minutes', minutes: 5 }).entries.map((e) => e.index), [0, 1]);
});

test('日をまたいでも、直近◯分は戻った時刻に引きずられない', () => {
  const entries = parseCaptionEntries([
    '**田中** `[23:40:00]`',
    '日付をまたぐ前の話',
    '',
    '**鈴木** `[23:58:00]`',
    'そろそろ日付が変わります',
    '',
    '**田中** `[00:01:00]`',
    'いまの指摘です',
    ''
  ].join('\n'));

  const window = selectRecapWindow(entries, { scope: 'minutes', minutes: 5 });

  assert.deepEqual(window.entries.map((entry) => entry.index), [1, 2], '23:58 と 00:01 は3分差として数える');
});

test('前回聞いたところからは、続きだけを読み、続きが無ければそう言う', () => {
  const entries = parseCaptionEntries(TRANSCRIPT);

  const continued = selectRecapWindow(entries, { scope: 'since-last', mark: recapMarkFor(entries[1]) });
  assert.equal(continued.appliedScope, 'since-last');
  assert.equal(continued.fallback, '');
  assert.deepEqual(continued.entries.map((entry) => entry.index), [2, 3]);
  assert.deepEqual(continued.mark, recapMarkFor(entries[3]), '読んだ最後の発言が次の「前回」になる');

  const nothingNew = selectRecapWindow(entries, { scope: 'since-last', mark: recapMarkFor(entries[3]) });
  assert.deepEqual(nothingNew.entries, []);
  assert.equal(nothingNew.reason, 'no-new-entries');
});

test('前回の位置が無い・見つからないときは直近◯分へ落ちて、落ちたことを言う', () => {
  const entries = parseCaptionEntries(TRANSCRIPT);

  const first = selectRecapWindow(entries, { scope: 'since-last', minutes: 5 });
  assert.equal(first.appliedScope, 'minutes');
  assert.equal(first.fallback, 'no-mark');
  assert.deepEqual(first.entries.map((entry) => entry.index), [2, 3]);

  // 覚えていた発言が消されていたら、番号で当てにいかず落ちます。黙って別の場所から
  // 読み始めると、「前回の続き」だと思ったまま別の範囲の要約を読むことになります。
  const lost = selectRecapWindow(entries, {
    scope: 'since-last',
    minutes: 5,
    mark: { index: 1, fingerprint: 'いまはもう無い発言' }
  });
  assert.equal(lost.appliedScope, 'minutes');
  assert.equal(lost.fallback, 'mark-missing');

  // 前のほうの行が消えて番号がずれても、指紋が同じなら同じ発言を指し続けます。
  const shifted = parseCaptionEntries(TRANSCRIPT.replace('**田中** `[10:00:00]`\nよろしくお願いします\n\n', ''));
  const moved = selectRecapWindow(shifted, { scope: 'since-last', mark: recapMarkFor(entries[1]) });
  assert.equal(moved.appliedScope, 'since-last');
  assert.deepEqual(moved.entries.map((entry) => entry.text), ['そこは次の版で直します。', shifted[2].text]);
});

test('長すぎる直近は古い側から落とし、落とした件数を隠さない', () => {
  const long = Array.from({ length: 40 }, (unused, index) => [
    `**話者${index}** \`[10:${String(index).padStart(2, '0')}:00]\``,
    'あ'.repeat(500),
    ''
  ].join('\n')).join('\n');

  const window = selectRecapWindow(parseCaptionEntries(long), { scope: 'all' });

  assert.ok(window.dropped > 0, '上限を超えたぶんは落とす');
  assert.equal(window.entries.length + window.dropped, 40);
  assert.equal(window.entries.at(-1).index, 39, '落とすのは古い側だけ');
  assert.ok(window.chars <= 12_000);
});

test('「直近」の指定は、知らない値でも既定へ収まる', () => {
  assert.deepEqual(
    normalizeRecapRequest({ scope: '会議全部', minutes: '9999', question: '  なぜ  ' }),
    { scope: 'since-last', minutes: 180, question: 'なぜ' }
  );
  assert.deepEqual(normalizeRecapRequest({}), { scope: 'since-last', minutes: 10, question: '' });
  // 分を送ってこない呼び出し（範囲の問い合わせ）が「1分」にならないこと。
  assert.equal(normalizeRecapRequest({ scope: 'minutes', minutes: null }).minutes, 10);
  assert.equal(normalizeRecapRequest({ scope: 'minutes', minutes: '' }).minutes, 10);
  assert.throws(() => normalizeRecapRequest({ question: 'あ'.repeat(501) }), /聞きたいことが長すぎます/);
});

test('返ってきた答えは、切り詰めて受け取り、読んだ範囲を必ず添える', () => {
  const window = selectRecapWindow(parseCaptionEntries(TRANSCRIPT), { scope: 'minutes', minutes: 5 });
  const recap = buildRecap({
    summary: ' 図の単位と前提が足りないと言われました。 ',
    answer: '答えです',
    points: [
      { kind: '知らない種類', speaker: '鈴木', point: '単位が抜けている', quote: '図の単位も抜けています。' },
      { kind: 'request', speaker: '鈴木', point: '   ', quote: '' }
    ],
    actions: [{ action: '図に単位を足す', reason: '鈴木さんの指摘' }, { action: '' }]
  }, window, { question: '単位の話が分かりませんでした' });

  assert.equal(recap.summary, '図の単位と前提が足りないと言われました。');
  assert.equal(recap.points.length, 1, '中身の無い指摘は捨てる');
  assert.equal(recap.points[0].kind, 'comment', '知らない種類は既定へ寄せる');
  assert.equal(recap.actions.length, 1);
  assert.equal(recap.question, '単位の話が分かりませんでした');
  assert.deepEqual(recap.range, {
    scope: 'minutes',
    appliedScope: 'minutes',
    fallback: '',
    minutes: 5,
    entries: 2,
    leadIn: 2,
    dropped: 0,
    total: 4,
    from: '10:20:00',
    to: '10:21:30'
  });

  // 何も聞いていないのに答えの欄が埋まっていても、画面へは出しません。
  assert.equal(buildRecap({ answer: '聞かれてもいない答え' }, window).answer, '');
});

test('聞き直すと、読ませるのは直近だけで、次からは続きだけになる', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'meeting.md'), TRANSCRIPT, 'utf8');
  const turns = [];
  const service = new AiService(root, { store, client: fakeCodex(turns) });

  const first = await service.recapCaptions('meeting.md', { scope: 'minutes', minutes: 5 });

  assert.equal(turns.length, 1);
  assert.match(turns[0].prompt, /そこは次の版で直します。/);
  assert.match(turns[0].prompt, /<lead_in>/, '助走は別の枠で渡す');
  assert.equal(/<transcript>[\s\S]*よろしくお願いします/.test(turns[0].prompt), false, '窓の外は渡さない');
  assert.equal(first.range.entries, 2);
  assert.equal(first.actions[0].action, '図に単位を足す');

  // 2回目は「前回の続き」。まだ何も足されていないので、続きはありません。
  await assert.rejects(
    service.recapCaptions('meeting.md', { scope: 'since-last' }),
    /新しい発言はありません/
  );

  await appendCaptionEntry(root, 'meeting.md', normalizeCaptionEntry({
    speaker: '鈴木', text: '単位はSIで揃えてください。', time: '10:23:00'
  }));
  const second = await service.recapCaptions('meeting.md', { scope: 'since-last' });

  assert.equal(second.range.entries, 1, '足された1件だけが続き');
  assert.equal(second.range.appliedScope, 'since-last');
  assert.match(turns.at(-1).prompt, /単位はSIで揃えてください。/);
});

test('聞き直しが失敗したぶんは「聞いた」ことにしない', async (t) => {
  const { root, store } = await testStore(t);
  await fs.writeFile(path.join(root, 'meeting.md'), TRANSCRIPT, 'utf8');
  const service = new AiService(root, {
    store,
    client: { ...fakeCodex([]), async runTurn() { throw new Error('AIが落ちました'); } }
  });

  await assert.rejects(service.recapCaptions('meeting.md', { scope: 'all' }), /AIが落ちました/);

  const window = await service.recapWindow('meeting.md', { scope: 'since-last', minutes: 5 });
  assert.equal(window.fallback, 'no-mark', '失敗した回で位置は進まない');
});

test('聞き直しの範囲は聞く前に引けて、聞くと要約と行動が流れてくる', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-routes-'));
  await fs.writeFile(path.join(root, 'meeting.md'), TRANSCRIPT, 'utf8');
  const calls = [];
  const aiService = {
    async status() { return { available: true, provider: 'codex' }; },
    async recapWindow(documentPath, input) {
      calls.push(['window', documentPath, input]);
      return { scope: input.scope, appliedScope: 'minutes', entries: [{ index: 3 }], leadIn: [], dropped: 0 };
    },
    async recapCaptions(documentPath, body, { onDelta }) {
      calls.push(['recap', documentPath, body]);
      onDelta('{"summary":');
      return { summary: '単位が抜けていると言われました。', points: [], actions: [] };
    },
    close() {}
  };
  const { app } = createServer(root, { aiService, aiToken: 'recap-token' });
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Review-Markdown-Token': 'recap-token' };

  assert.equal(
    (await fetch(`${baseUrl}/api/ai/recap-window?path=meeting.md&scope=all&minutes=10`)).status,
    403,
    'トークン無しでは範囲も引けない'
  );

  const window = await fetch(`${baseUrl}/api/ai/recap-window?path=meeting.md&scope=all&minutes=10`, { headers })
    .then((response) => response.json());
  assert.equal(window.window.appliedScope, 'minutes');
  assert.deepEqual(calls.at(-1), ['window', 'meeting.md', { scope: 'all', minutes: '10' }]);

  const streamed = await fetch(`${baseUrl}/api/ai/recap`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: 'meeting.md', scope: 'since-last', minutes: 10, question: '単位の話です' })
  });
  assert.equal(streamed.status, 200);
  const events = (await streamed.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['started', 'delta', 'result']);
  assert.equal(events.at(-1).recap.summary, '単位が抜けていると言われました。');
  assert.equal(calls.at(-1)[2].question, '単位の話です');
});

/** 直近の要約の固定の答え。ここで確かめるのは配線なので、中身は形だけ合わせます。 */
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
      return {
        text: JSON.stringify({
          summary: '図の単位と前提が足りないと言われました。',
          answer: '',
          points: [{ kind: 'request', speaker: '鈴木', point: '図に単位を書く', quote: '図の単位も抜けています。' }],
          actions: [{ action: '図に単位を足す', reason: '鈴木さんの指摘' }]
        })
      };
    },
    async close() {}
  };
}

async function testStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-service-root-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-service-data-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]));
  return { root, store: new AiStore(root, { dataDir }) };
}
