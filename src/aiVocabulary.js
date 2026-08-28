/**
 * AIレビューが使う語彙の、唯一の定義です。
 *
 * 重大度と確信度は、出力スキーマの enum・答えを受け取るときの検証・並べ替えの順序・
 * 画面とレビューMarkdownに出る日本語、の4か所へ同時に効きます。ばらばらに書くと、
 * enum に足した値を検証が落とす、といった食い違いが起きます。
 *
 * 画面側（public/js/comments.js と proposalList.js）には同じ表がもう一組ありますが、
 * ビルドを持たない構成では `src/` を `public/` から import できないので、こちらへは
 * 寄せていません。片方を変えたらもう片方も、という関係だけを覚えておいてください。
 *
 * 凍らせてあるのは、この配列がそのまま出力スキーマの enum として複数のスキーマに
 * 共有されるからです。1か所で書き換えると、書き換えたつもりのないスキーマまで変わります。
 */

/**
 * 指摘の重さ。値の意味そのものはプロンプト（src/prompts/review.js）が定義し、
 * ここはその語彙と、レビュアーに見せる順序・日本語だけを持ちます。
 */
export const SEVERITIES = Object.freeze(['must', 'should', 'idea']);

/** 指摘をレビュアーに見せる順序。上から読んで手を止められるかは並び順だけで決まります。 */
export const SEVERITY_ORDER = Object.freeze({ must: 0, should: 1, idea: 2 });

/** レビューMarkdownへ書き出すときの日本語。 */
export const SEVERITY_LABELS = Object.freeze({ must: '要対応', should: '検討', idea: '提案' });

/** その指摘が本当に問題かどうかについての、モデル自身の確信の度合い。 */
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);

/** 重大度が同じ指摘どうしは、確信の高い順に並べます。 */
export const CONFIDENCE_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

/** 答えの確信度が語彙にないときに使う値。捨てるほどではないが、鵜呑みにもしません。 */
export const DEFAULT_CONFIDENCE = 'medium';

export function isSeverity(value) {
  return SEVERITIES.includes(value);
}

export function isConfidence(value) {
  return CONFIDENCES.includes(value);
}
