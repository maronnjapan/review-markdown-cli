import { PURPOSES } from './prompts/codexRole.js';

/**
 * どの機能を、どのモデルで、どれくらい考えさせて読ませるかの表です。
 *
 * 用途は2つだけです。
 *   - assistant: 翻訳・AIチャット・指摘の配置。待ち時間がそのまま使い心地になるので、
 *     速いモデルを低い推論強度で回します。
 *   - review   : AIレビューと、読み手ペルソナ・資料の管理者の組み立て。1回の読みで
 *     見落としたものはそのまま結果から抜けるので、深く読むモデルを高い推論強度で
 *     回します。ペルソナと管理者がこちら側にあるのは、そこで決めた読み手と目的が
 *     以後のレビューの判断基準そのものになるからです。
 *
 * 費用と待ち時間の一番大きなつまみは `EFFORT_PREFERENCE` です。
 * 設定ファイルから固定したいときは `aiModel` / `aiEffort` / `aiReviewModel` /
 * `aiReviewEffort` を書きます（README の「設定ファイル」を参照）。
 */

/** 機能ごとの用途。ここに無い機能は速い方で読みます。 */
const FEATURE_PURPOSE = {
  translate: 'assistant',
  chat: 'assistant',
  place: 'assistant',
  // 文字起こしの聞き直し。会議が進んでいる最中に押すもので、深く読ませて30秒待つ間に
  // 話は次へ行きます。速いほうで読ませるのは、この機能では速さが精度の一部だからです。
  recap: 'assistant',
  // 自動タスクの抽出。見守りが数分おきに回すもので、1回ごとの量は小さく回数が多いので
  // 速いほうで読ませます。拾い漏らしは次の回で拾えます。
  tasks: 'assistant',
  brief: 'review',
  persona: 'review',
  review: 'review',
  // 本文の修正案。書いた文がそのまま原稿になる候補なので、深く読む側で書かせます。
  revise: 'review',
  // 自動タスクの実行（調査メモ・コード例・回答案）。読んで採るかどうかを決めるのは
  // レビュアーですが、書かれたものがそのまま使われる候補なので、深く読む側で書かせます。
  taskRun: 'review'
};

/**
 * 速いモデルの名前。Codexのモデル名の付け方が変わったら、ここだけ直します。
 * 設定ファイルでモデルを名指ししていれば、この判定は使いません。
 */
export const FAST_MODEL_PATTERN = /(?:luna|spark|mini)/i;

/** 用途ごとの推論強度。モデルが持っているものを、この順で先頭から選びます。 */
export const EFFORT_PREFERENCE = {
  assistant: ['none', 'low'],
  review: ['high', 'medium']
};

/** Codexへ問い合わせるモデル一覧の範囲。 */
export const MODEL_LIST_QUERY = { limit: 50, includeHidden: false };

/** JSON-RPCの1要求あたりの待ち時間。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 機能名から用途を引きます。知らない機能は速い方です。 */
export function purposeFor(feature) {
  return FEATURE_PURPOSE[feature] || 'assistant';
}

/**
 * Codexが使えるモデルの一覧から、用途ごとのモデルと推論強度を決めます。
 *
 * `overrides` に `{ assistant: { model, effort }, review: { … } }` を渡すと、
 * その用途はそちらを使います。名指ししたモデルや推論強度をCodexが持っていなければ投げます。
 * 黙って別のものへ落とすと、設定したつもりの人が気づけないからです。
 *
 * @returns {{assistant: {model: string, effort: string|undefined},
 *            review: {model: string, effort: string|undefined}}}
 */
export function selectProfiles(models, overrides = {}) {
  const available = Array.isArray(models) ? models : [];
  const fallback = available.find((entry) => entry.isDefault) || available[0];
  if (!fallback) throw new Error('Codexで利用できるモデルが見つかりません');

  const chosen = {
    // 速いモデル。名前で見分けられなければ、既定のモデルで代用します。
    assistant: available.find((entry) => FAST_MODEL_PATTERN.test(modelId(entry))) || fallback,
    // 深く読むモデル。既定が速いモデルなら、速くないものを探し直します。
    review: available.find((entry) => entry.isDefault && !FAST_MODEL_PATTERN.test(modelId(entry)))
      || available.find((entry) => !FAST_MODEL_PATTERN.test(modelId(entry)))
      || fallback
  };

  const profiles = {};
  for (const purpose of PURPOSES) {
    const override = overrides[purpose] || {};
    const entry = override.model ? findModel(available, override.model, purpose) : chosen[purpose];
    profiles[purpose] = {
      model: modelId(entry),
      effort: override.effort
        ? checkEffort(entry, override.effort, purpose)
        : effortOf(entry, EFFORT_PREFERENCE[purpose])
    };
  }
  return profiles;
}

function findModel(models, wanted, purpose) {
  const entry = models.find((candidate) => modelId(candidate) === wanted);
  if (entry) return entry;
  const known = models.map(modelId).filter(Boolean).join(', ') || '(なし)';
  throw new Error(
    `設定した${purpose === 'review' ? 'aiReviewModel' : 'aiModel'} がCodexにありません: ${wanted}（使えるモデル: ${known}）`
  );
}

/**
 * 設定された推論強度。そのモデルが対応していなければ投げます。
 * Codexが対応する強度を申告していないモデルでは、確かめようがないのでそのまま通します。
 */
function checkEffort(entry, wanted, purpose) {
  const efforts = (entry?.supportedReasoningEfforts || []).map((item) => item.reasoningEffort);
  if (efforts.length === 0 || efforts.includes(wanted)) return wanted;
  throw new Error(
    `設定した${purpose === 'review' ? 'aiReviewEffort' : 'aiEffort'} を ${modelId(entry)} は受け付けません: `
    + `${wanted}（使える強度: ${efforts.join(', ')}）`
  );
}

function modelId(entry) {
  return entry?.id || entry?.model || '';
}

/**
 * 用途が求める推論強度のうち、そのモデルが持っている最初のもの。
 * どれも分からないときは undefined を返し、ターンの指定から落とします。
 */
function effortOf(entry, wanted) {
  const efforts = (entry?.supportedReasoningEfforts || []).map((item) => item.reasoningEffort);
  return wanted.find((effort) => efforts.includes(effort)) || entry?.defaultReasoningEffort || efforts[0];
}
