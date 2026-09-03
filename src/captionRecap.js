import crypto from 'node:crypto';
import {
  DEFAULT_RECAP_MINUTES,
  MAX_RECAP_CHARS,
  MAX_RECAP_LEAD_IN_CHARS,
  MAX_RECAP_LEAD_IN_ENTRIES,
  MAX_RECAP_MINUTES,
  MAX_RECAP_QUESTION_CHARS
} from './aiLimits.js';
import { aiContextBlock } from './aiContext.js';
import { RECAP_POINT_KINDS, RECAP_SCHEMA, recapPrompt as buildRecapPrompt } from './prompts/recap.js';

/**
 * 会議中の「いまの話、何を言われた？」に答えるための、文字起こしの切り出しです。
 *
 * 書き込む側は `liveCaptions.js` で、こちらは読み直す側です。同じ1行の形
 * （`**話者** \`[時刻]\`` と、続く本文）を、あちらは書き、ここは読みます。
 *
 * ── 「直近」をどう決めるか ─────────────────────────────────
 * 終わりはいつも最新の発言です。迷うのは始まりだけなので、決め方を3つに絞りました。
 *
 *   since-last  前回聞いたところから（既定）
 *   minutes     直近◯分
 *   all         会議の最初から
 *
 * 既定を「前回聞いたところから」にしたのは、これだけが取りこぼしも重複も出さない
 * 決め方だからです。◯分で切ると、前回から◯分以上経っていればその間が抜け、
 * 続けて2回押せば同じ話をもう一度読まされます。「どこまで聞いたか」を覚えておけば、
 * 境目は「まだ聞いていない最初の発言」に自動的に決まります。
 *
 * ただし初回は覚えていることがありません。そのときだけ直近◯分へ落とします
 * （落ちたことは `fallback` で返し、画面にも出します。黙って別の範囲を読むと、
 * 「前回から」と思ったまま会議の最初からの要約を読むことになります）。
 *
 * 前回の位置は番号ではなく発言の指紋で覚えます。文字起こしは追記されるだけなので
 * 番号でもたいていは合いますが、あとから手で行を消せばずれます。ずれた番号は、
 * 黙って別の場所を指します。指紋なら「見つからなかった」と分かるので、そのときも
 * ◯分へ落として、落ちた理由を画面へ出せます。
 *
 * ── 助走（leadIn） ────────────────────────────────────
 * 窓の先頭の発言は、たいてい何かを受けています（「それは違う」「さっきの件ですが」）。
 * 受け先を切り落とすと、要約は指示語のまま出てきます。そこで窓の手前の数発言を
 * 「読むが、ここからは何も報告しない」枠として添えます。要約の対象を広げるのとは
 * 別のことなので、渡す枠も分けています（`prompts/recap.js`）。
 *
 * このモジュールが持つのは、切り出しと、返ってきた答えの検証だけです。
 * モデルへ渡す文面と答えの形は `prompts/recap.js` にあります。
 */

export { RECAP_SCHEMA };

/** 「直近」の決め方。画面の選択肢と、受け取るときの検証の両方がこれを見ます。 */
export const RECAP_SCOPES = Object.freeze(['since-last', 'minutes', 'all']);

/** 既定の決め方。理由はこのファイルの冒頭にあります。 */
export const DEFAULT_RECAP_SCOPE = 'since-last';

/**
 * 1行の発言の始まり。`liveCaptions.js` の `formatCaptionLine` が書く形です。
 * 片方を変えたらもう片方も、という関係にあります。
 */
const SPEAKER_LINE = /^\*\*(.+?)\*\*\s+`\[([^\]]*)\]`\s*$/;

/** 答えとして受け取る件数と長さ。モデルへ渡す量ではないので `aiLimits.js` には置きません。 */
const MAX_ANSWER_POINTS = 12;
const MAX_ANSWER_ACTIONS = 8;
const MAX_ANSWER_ITEM_CHARS = 400;
const MAX_ANSWER_TEXT_CHARS = 1_000;

/**
 * Markdownを発言の並びに戻します。文字起こしでない文書では空の配列になります。
 *
 * 見出しや会議コードの行は落とします。読ませたいのは発言だけで、先頭の見出しは
 * どの窓を切っても同じものが混ざるだけだからです。
 */
export function parseCaptionEntries(markdown) {
  const entries = [];
  let current = null;
  for (const line of String(markdown || '').split('\n')) {
    const match = SPEAKER_LINE.exec(line);
    if (match) {
      current = { speaker: match[1].trim(), time: match[2].trim(), lines: [] };
      entries.push(current);
      continue;
    }
    // 話者の行より前（見出しなど）と、発言と発言の間の空行は読み飛ばします。
    if (!current) continue;
    if (line.trim() === '') {
      current = null;
      continue;
    }
    current.lines.push(line.trim());
  }
  return entries
    .map(({ speaker, time, lines }) => ({ speaker, time, text: lines.join('\n').trim() }))
    .filter((entry) => entry.text)
    .map((entry, index) => ({ index, ...entry }));
}

/**
 * レビュアーが送ってきた「直近」の指定を受け取ります。
 * 知らない決め方は既定へ、分は 1〜`MAX_RECAP_MINUTES` へ収めます。
 */
export function normalizeRecapRequest(body = {}) {
  const scope = RECAP_SCOPES.includes(body.scope) ? body.scope : DEFAULT_RECAP_SCOPE;
  // `Number('')` も `Number(null)` も 0 になるので、空と未指定は先に NaN へ寄せます。
  // ここを分けないと、分を送ってこない呼び出し（範囲の問い合わせ）が1分になります。
  const requested = Number(String(body.minutes ?? '').trim() || NaN);
  const minutes = Number.isFinite(requested)
    ? Math.min(MAX_RECAP_MINUTES, Math.max(1, Math.round(requested)))
    : DEFAULT_RECAP_MINUTES;
  const question = String(body.question || '').trim();
  if (question.length > MAX_RECAP_QUESTION_CHARS) {
    throw new Error(`聞きたいことが長すぎます（${MAX_RECAP_QUESTION_CHARS}文字まで）`);
  }
  return { scope, minutes, question };
}

/**
 * 読ませる範囲を決めます。AIは使いません。押す前に「どこからどこまで読むか」を
 * 画面へ出すのも、実際に読ませるのも、同じこの関数です。2か所で別々に決めると、
 * 画面に出した範囲と読ませた範囲が食い違います。
 *
 * @param {ReturnType<typeof parseCaptionEntries>} entries 文書の全発言。
 * @param {object} options
 * @param {string} options.scope 決め方（`RECAP_SCOPES`）。
 * @param {number} options.minutes `minutes` のときの分数。
 * @param {{index: number, fingerprint: string}|null} options.mark 前回どこまで聞いたか。
 */
export function selectRecapWindow(entries, { scope = DEFAULT_RECAP_SCOPE, minutes = DEFAULT_RECAP_MINUTES, mark = null } = {}) {
  const total = entries.length;
  if (total === 0) return emptyWindow({ scope, minutes, total });

  const { start, appliedScope, fallback } = startIndexFor(entries, { scope, minutes, mark });
  // 前回の続きが1件も無いときだけ、空の窓を返します。ここで直近◯分へ落とすと、
  // 「新しい発言はありません」と言えずに、さっき読んだ話をもう一度読ませることになります。
  if (start >= total) {
    return { ...emptyWindow({ scope, minutes, total }), appliedScope, fallback, reason: 'no-new-entries' };
  }

  const { window, dropped } = fitToBudget(entries.slice(start));
  const leadIn = leadInFor(entries, window[0].index);
  return {
    scope,
    appliedScope,
    fallback,
    minutes: appliedScope === 'minutes' ? minutes : null,
    reason: '',
    total,
    entries: window,
    leadIn,
    dropped,
    chars: charsOf(window),
    from: window[0].time,
    to: window.at(-1).time,
    mark: recapMarkFor(window.at(-1))
  };
}

/**
 * 窓の始まりを決めます。決め方ごとに違うのはここだけです。
 * 落ちたときは、落ちた先（`appliedScope`）と理由（`fallback`）を一緒に返します。
 */
function startIndexFor(entries, { scope, minutes, mark }) {
  if (scope === 'all') return { start: 0, appliedScope: 'all', fallback: '' };
  if (scope === 'minutes') return { start: minutesStart(entries, minutes), appliedScope: 'minutes', fallback: '' };

  if (!mark) {
    // 初回。この文書をまだ一度も聞いていないので、覚えている位置がありません。
    return { start: minutesStart(entries, minutes), appliedScope: 'minutes', fallback: 'no-mark' };
  }
  const found = findMark(entries, mark);
  if (found === -1) {
    // 覚えていた発言が見つかりません（あとから手で消されたなど）。番号で当てにいくと
    // 黙って別の場所から読むので、ここも◯分へ落として、落ちたことを伝えます。
    return { start: minutesStart(entries, minutes), appliedScope: 'minutes', fallback: 'mark-missing' };
  }
  return { start: found + 1, appliedScope: 'since-last', fallback: '' };
}

/**
 * 最新の発言から遡って、◯分より前に出た発言の手前まで。
 *
 * 時刻は `10:31:02` のような文字列で、日付を持ちません。日をまたぐと数字が戻るので、
 * 戻ったぶんは24時間足して数えます。時刻を読めない行は、その次の発言と同じ時刻として
 * 扱います（読めないという理由だけで、話の途中で切りたくないからです）。
 * どれも◯分の中に入るときは、会議の最初からになります。
 */
function minutesStart(entries, minutes) {
  const limit = Math.max(1, minutes) * 60;
  const seconds = elapsedSeconds(entries);
  const newest = seconds.filter((second) => second !== null).at(-1);
  // 時刻が1行も読めない文字起こしでは、◯分では切れません。切れないまま適当な位置で
  // 切るより、会議の最初から読ませて「全部読んだ」と分かるほうが間違えません。
  if (newest === undefined) return 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const second = seconds[index];
    if (second === null) continue;
    if (newest - second > limit) return index + 1;
  }
  return 0;
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * 各発言の時刻を、先頭からの通し秒に直します。前の発言より数字が小さくなったら
 * 日をまたいだとみなして1日ぶん足します。読めない時刻は null のままにして、
 * 切る位置の判断から外します。
 */
function elapsedSeconds(entries) {
  let offset = 0;
  let previous = null;
  return entries.map((entry) => {
    const raw = timeSeconds(entry.time);
    if (raw === null) return null;
    if (previous !== null && raw < previous) offset += DAY_SECONDS;
    previous = raw;
    return raw + offset;
  });
}

function timeSeconds(time) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time || '').trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
}

/**
 * 上限に収まるところまで、古い側から落とします。
 *
 * 落とすのを古い側にしているのは、新しいほうが「直近」だからです。落とした件数は
 * 隠さずに返します。黙って切ると、会議の最初から読ませたつもりの人は、
 * 前半が渡っていないことに気づけません。
 */
function fitToBudget(entries) {
  let start = 0;
  while (start < entries.length - 1 && charsOf(entries.slice(start)) > MAX_RECAP_CHARS) start += 1;
  return { window: entries.slice(start), dropped: start };
}

/**
 * 窓の手前の数発言。指示語の受け先を渡すためだけのもので、要約の対象ではありません。
 * 助走まで上限で膨らませないように、件数と長さの両方で止めます。
 */
function leadInFor(entries, firstIndex) {
  const lead = entries.slice(Math.max(0, firstIndex - MAX_RECAP_LEAD_IN_ENTRIES), firstIndex);
  while (lead.length > 0 && charsOf(lead) > MAX_RECAP_LEAD_IN_CHARS) lead.shift();
  return lead;
}

function charsOf(entries) {
  return entries.reduce((total, entry) => total + entry.speaker.length + entry.text.length, 0);
}

function emptyWindow({ scope, minutes, total }) {
  return {
    scope,
    appliedScope: scope,
    fallback: '',
    minutes: scope === 'minutes' ? minutes : null,
    reason: total === 0 ? 'no-entries' : '',
    total,
    entries: [],
    leadIn: [],
    dropped: 0,
    chars: 0,
    from: '',
    to: '',
    mark: null
  };
}

/**
 * 切り出した窓を、モデルへ渡す文面にします。
 * 発言に振る番号は文書の通し番号です。窓の中で振り直すと、続けて聞き直したときに
 * 同じ番号が別の発言を指します。
 */
export function recapPrompt(window, question, readingContext) {
  return buildRecapPrompt(
    JSON.stringify(promptEntries(window.entries)),
    window.leadIn.length ? JSON.stringify(promptEntries(window.leadIn)) : '',
    question,
    aiContextBlock(readingContext)
  );
}

function promptEntries(entries) {
  return entries.map(({ index, speaker, time, text }) => ({ n: index + 1, speaker, time, text }));
}

/* ---------------------------------------------------------------- *
 * どこまで聞いたか
 * ---------------------------------------------------------------- */

/**
 * 発言1件の指紋。番号ではなくこれで覚えるので、あとから前のほうの行を消しても
 * 「前回のここまで」は同じ発言を指し続けます。
 */
export function recapMarkFor(entry) {
  return {
    index: entry.index,
    fingerprint: crypto.createHash('sha256')
      .update(`${entry.speaker}\n${entry.time}\n${entry.text}`)
      .digest('hex')
      .slice(0, 32)
  };
}

/**
 * 覚えていた発言を探します。覚えた番号から見るのは、追記しかされていない普通の
 * 文字起こしなら1回で当たるからです。当たらなければ全体を探し、それでも無ければ -1。
 */
function findMark(entries, mark) {
  const at = entries[mark.index];
  if (at && recapMarkFor(at).fingerprint === mark.fingerprint) return mark.index;
  return entries.findIndex((entry) => recapMarkFor(entry).fingerprint === mark.fingerprint);
}

/** 保存されていた印を読みます。壊れていても投げません（読むだけで開けなくなるからです）。 */
export function readRecapMark(value) {
  if (!value || typeof value !== 'object') return null;
  const index = Number(value.index);
  const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint.trim() : '';
  if (!Number.isInteger(index) || index < 0 || !fingerprint) return null;
  return { index, fingerprint };
}

/* ---------------------------------------------------------------- *
 * 返ってきた答え
 * ---------------------------------------------------------------- */

/**
 * モデルの答えを、画面が扱える形にします。長すぎるものは切り、多すぎるものは捨てます。
 *
 * 断らずに切るのは、レビュアーが書いた値ではなくモデルの答えだからです
 * （`documentBrief.js` の `buildBriefDraft` と同じ切り分けです）。
 *
 * 窓の情報を一緒に返すのは、答えだけを見せると「どこまでの話なのか」が画面から
 * 消えるからです。会議中に読むものなので、範囲の分からない要約は使えません。
 */
export function buildRecap(answer, window, { question = '' } = {}) {
  return {
    summary: text(answer?.summary, MAX_ANSWER_TEXT_CHARS),
    // 聞きたいことを書かなかったときは、答えの欄も出しません。
    answer: question ? text(answer?.answer, MAX_ANSWER_TEXT_CHARS) : '',
    question,
    points: list(answer?.points, MAX_ANSWER_POINTS, (point) => {
      const summary = text(point?.point, MAX_ANSWER_ITEM_CHARS);
      if (!summary) return null;
      return {
        kind: RECAP_POINT_KINDS.includes(point?.kind) ? point.kind : 'comment',
        speaker: text(point?.speaker, 100),
        point: summary,
        quote: text(point?.quote, MAX_ANSWER_ITEM_CHARS)
      };
    }),
    actions: list(answer?.actions, MAX_ANSWER_ACTIONS, (action) => {
      const what = text(action?.action, MAX_ANSWER_ITEM_CHARS);
      if (!what) return null;
      return { action: what, reason: text(action?.reason, MAX_ANSWER_ITEM_CHARS) };
    }),
    range: {
      scope: window.scope,
      appliedScope: window.appliedScope,
      fallback: window.fallback,
      minutes: window.minutes,
      entries: window.entries.length,
      leadIn: window.leadIn.length,
      dropped: window.dropped,
      total: window.total,
      from: window.from,
      to: window.to
    }
  };
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function list(value, max, build) {
  if (!Array.isArray(value)) return [];
  return value.map(build).filter(Boolean).slice(0, max);
}
