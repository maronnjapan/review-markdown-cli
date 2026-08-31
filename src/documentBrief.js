import { MAX_BRIEF_FIELD_CHARS, MAX_BRIEF_INPUT_CHARS } from './aiLimits.js';
import { plannedDocumentBlock } from './prompts/readingContext.js';

/**
 * 資料の管理者は、資料を作り始める前に3つを揃えさせる役です。
 *
 *   目的       この資料が終わったとき、読み手に何が起きていれば成功か
 *   ストーリー  何をどの順に示して、その結論まで連れて行くか
 *   期待値      読んだあと、読み手や頼んだ人が何を判断・実行できるか
 *
 * ── すでにある3つの前提と、どこが違うのか ──────────────────
 * 読み取りコンテキストは「この文書はこう読む」、コンテキストメモは「このとき、こう
 * 分かった」、読み手ペルソナは「誰が読むか」。3つとも、すでにある文書をどう読むかの
 * 話です。管理者が持つのはその手前で、「そもそもこの資料は何のために作るのか」です。
 * 資料が1行も無くても書けますし、無いまま資料を作り始めないためのものなので、
 * むしろ資料より先に書かれることを想定しています。
 *
 * ── 揃っているかの判定に、AIを使っていない理由 ────────────────
 * 見るのは「3つとも埋まっているか」だけです。良い目的かどうかは見ません。
 * AIに揃っているかを判定させると、同じ文書でも実行できたりできなかったりする関門に
 * なります。止まる理由が毎回変わる関門は、守るものではなく避けるものになります。
 * 中身の質を見るのはAIレビュー（目的定義をレビューするスキル）の仕事で、ここの
 * 仕事は「空欄のまま先へ行かせないこと」だけです。
 *
 * ── 読むときは通し、書くときだけ断る ──────────────────────
 * `readDocumentBrief` は保存済みの値を読むためのもので、何が入っていても投げません。
 * ここで投げると、レビューファイルを手で直した1文字で、その文書が画面から開けなく
 * なります（`readReview` は本文の表示にも通る道です）。断るのは、レビュアーが送って
 * きた値を受け取る `normalizeDocumentBrief` だけです。`contextNotes.js` と同じ
 * 切り分けです。
 *
 * このモジュールが持つのは検証と正規化だけです。モデルが読む文面は
 * `prompts/readingContext.js`、管理者に組み立てさせる文面は `prompts/manager.js`。
 */

/**
 * 管理者が求める3点。`id` がレビューファイルに入る値で、`label` が画面と
 * レビューMarkdownに出る日本語です。並び順がそのまま画面の並びで、決める順でもあります。
 *
 * 画面側（public/js/documentBrief.js）にも同じ表がもう一組あります。ビルドを持たない
 * 構成では `src/` を `public/` から import できないためで、`contextNotes.js` と
 * 同じ事情です。片方を変えたらもう片方も、という関係だけを覚えておいてください。
 *
 * 「どの項目がまだ決まっていないか」の判定は、こちらには置いていません。止めるかどうかは
 * 画面の中だけの話で、サーバは3点が揃っていようといまいと同じ扱いにするからです
 * （サーバで止めると、CLIやテストからの経路まで一緒に塞ぐことになります）。判定を
 * 両側に置くと、使われていないほうだけがテストされる状態になるので、
 * public/js/documentBrief.js の `missingBriefFields` 1か所だけにしてあります。
 */
export const BRIEF_FIELDS = Object.freeze([
  Object.freeze({ id: 'purpose', label: '目的' }),
  Object.freeze({ id: 'story', label: 'ストーリー' }),
  Object.freeze({ id: 'expectation', label: '期待値' })
]);

export const BRIEF_FIELD_LABELS = Object.freeze(
  Object.fromEntries(BRIEF_FIELDS.map(({ id, label }) => [id, label]))
);

/** ISO 8601 の日時が収まる長さ。長い文字列を書かれても切り詰めるためだけの上限です。 */
const TIMESTAMP_CHARS = 40;

/**
 * 管理者が返す問いと、補った点の上限。プロンプトは「4問まで」と頼んでいますが、
 * わずかに超えた答えを捨てるより切り詰めて受け取るほうが、レビュアーの手数が減ります。
 * モデルへ渡す量ではなく答えの検証なので、`aiLimits.js` ではなくここに置いています。
 */
const MAX_ANSWER_ITEMS = 6;
const MAX_ANSWER_ITEM_CHARS = 300;

/**
 * 保存済みのブリーフを読みます。何が入っていても投げず、長すぎても切りません。
 * 3つとも空なら null を返し、「管理者は未設定」として扱います。
 *
 * 読むときに切り詰めないのは、切ると往復1回で末尾が永久に消えるからです。画面は
 * `/api/file` で受け取った値をそのまま送り返すので、ここで上限に切ると、レビュー
 * ファイルへ手で書いた長い目的が、次の自動保存で黙って短くなります。長すぎる値は
 * `normalizeDocumentBrief` が保存のときに断り、画面はその手前で「1000文字までです」と
 * 出します。断るのも知らせるのも書くときだけ、というのがこのモジュールの決まりです。
 */
export function readDocumentBrief(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const brief = Object.fromEntries(BRIEF_FIELDS.map(({ id }) => [id, field(value[id])]));
  if (!hasDocumentBrief(brief)) return null;
  // 日時は補いません。無いものを読むたびに「今」で埋めると、日付をまたぐたびに前提が
  // 変わったことになり、翻訳キャッシュと会話が理由もなくやり直しになります。
  const updatedAt = timestamp(value.updatedAt);
  return updatedAt ? { ...brief, updatedAt } : brief;
}

/**
 * レビュアーが送ってきたブリーフを受け取ります。長すぎる欄は、切り詰めずに断ります。
 *
 * 黙って切らないのは、切れた目的の上でレビューが走ると、レビュアーは自分が書いた
 * つもりの前提が効いていないことに気づけないからです。`null` は「管理者を消す」で、
 * 未指定（`undefined`）の「据え置く」とは別の意味です。
 */
export function normalizeDocumentBrief(value, source = '資料の管理者') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} はオブジェクトで指定してください`);
  }
  for (const { id, label } of BRIEF_FIELDS) assertFieldFits(value[id], label, source);
  return readDocumentBrief(value);
}

/** 管理者へ渡す走り書き。長すぎるものは受け付けません。 */
export function normalizeBriefInput(value, source = '決まっていること') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${source} は文字列で入力してください`);
  const text = value.trim();
  if (text.length > MAX_BRIEF_INPUT_CHARS) {
    throw new Error(`${source} が長すぎます（${MAX_BRIEF_INPUT_CHARS}文字まで）`);
  }
  return text;
}

export function hasDocumentBrief(brief) {
  return BRIEF_FIELDS.some(({ id }) => Boolean(brief?.[id]));
}

/** ブリーフをモデルが読む形にしたもの。1つも決まっていなければ '' を返します。 */
export function documentBriefBlock(brief) {
  if (!hasDocumentBrief(brief)) return '';
  return plannedDocumentBlock(brief);
}

/**
 * 管理者が組み立てた答えを、画面が扱える形にします。保存はしません。
 *
 * 返すのは3点そのものだけではなく、埋まらなかった項目への問いも一緒です。
 * 管理者の仕事は埋めることではなく、埋まっていないことを見せて問うことなので、
 * 問いのほうが本体です。3つとも空なら `brief` は null で、「まだ何も決まって
 * いない」と管理者が言ったことになります。
 */
export function buildBriefDraft(answer, now = new Date()) {
  // モデルの答えは切り詰めて受け取ります。断ると、頼んだ長さをわずかに超えただけで
  // 管理者に聞けなくなります。レビュアーが書いた値を断るのとは別の話です。
  const brief = readDocumentBrief(Object.fromEntries(BRIEF_FIELDS.map(({ id }) => [
    id,
    typeof answer?.[id] === 'string' ? answer[id].slice(0, MAX_BRIEF_FIELD_CHARS) : ''
  ])));
  return {
    brief: brief ? { ...brief, updatedAt: now.toISOString() } : null,
    questions: answerList(answer?.questions),
    assumptions: answerList(answer?.assumptions)
  };
}

/** 1つの欄。長さで落とすのは書くときだけなので、ここでは整えるだけです。 */
function field(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function assertFieldFits(value, label, source) {
  if (typeof value !== 'string') return;
  if (value.trim().length > MAX_BRIEF_FIELD_CHARS) {
    throw new Error(`${source}の「${label}」が長すぎます（${MAX_BRIEF_FIELD_CHARS}文字まで）`);
  }
}

function answerList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim().slice(0, MAX_ANSWER_ITEM_CHARS) : ''))
    .filter(Boolean)
    .slice(0, MAX_ANSWER_ITEMS);
}

function timestamp(value) {
  return typeof value === 'string' ? value.trim().slice(0, TIMESTAMP_CHARS) : '';
}
