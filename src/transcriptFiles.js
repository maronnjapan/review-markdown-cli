import { createPathFilter, normalizePatterns } from './pathFilter.js';

/**
 * 文字起こしに使うファイルの範囲です。
 *
 * 字幕の追記（`liveCaptions.js`）と聞き直し（`captionRecap.js`）は、レビュー対象
 * ディレクトリの中ならどのMarkdownでも使えるようにしてありました。使えることと、
 * 使ってよいことは別です。会議のあいだ、拡張機能は数秒ごとに1行ずつ書き足します。
 * 書き込み先を打ち間違えたまま繋ぐと、原稿の途中に発言が挟まっていくことになり、
 * 気づくのは会議が終わってからです。
 *
 * そこで「文字起こし用のファイル」をパターンで決めて、そこだけに限ります。決めるのは
 * パスなので、まだ無いファイル（会議ごとに作るファイル）にも書き込む前に効きます。
 *
 * ── 既定を2つにした理由 ────────────────────────────────
 *   meet-captions      拡張機能が「会議ごとにファイルを自動で作る」で書く場所です。
 *                      1段の名前なのでどの階層の meet-captions/ も当たります。
 *   *.transcript.md    決まったファイルへ書きたい人のための名前です。ディレクトリを
 *                      分けなくても、名前だけで文字起こし用だと分かります。
 *
 * どちらも使わない置き場所（`docs/meetings/**` など）は、設定に足せば増やせます。
 * 空にすれば、どのファイルも文字起こしには使えません（機能ごと閉じるのと同じです）。
 *
 * ── 断り方 ─────────────────────────────────────────
 * 外れたファイルは、黙って無視するのではなく理由を返します（`transcriptScopeMessage`）。
 * 拡張機能の側は書き込めたかどうかしか見ていないので、断る理由を文にして返さないと、
 * 「繋がっているのに1行も増えない」という形で現れます。
 */

/** 何も設定していないときに文字起こしとして扱うパターン。理由はこのファイルの冒頭にあります。 */
export const DEFAULT_TRANSCRIPT_PATTERNS = Object.freeze(['meet-captions', '*.transcript.md']);

/**
 * 設定ファイルから受け取ったパターンを整えます。`include` / `exclude` と同じ書き方
 * （`*` `**` `?` `{a,b}`、1段の名前はどの階層でも、先頭の `/` で対象ディレクトリ直下に固定）です。
 */
export function normalizeTranscriptPatterns(value, source = 'transcriptFiles') {
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (typeof entry !== 'string') throw new Error(`${source} は文字列の配列で指定してください: ${JSON.stringify(entry)}`);
  }
  return normalizePatterns(values);
}

/**
 * 文字起こしに使える範囲。
 *
 * @param {string[]|undefined} patterns 設定の `transcriptFiles`。未設定なら既定を使います。
 *   空の配列は「1件も無い」という指定で、既定へは戻しません。
 */
export function createTranscriptScope(patterns) {
  const list = patterns === undefined || patterns === null
    ? [...DEFAULT_TRANSCRIPT_PATTERNS]
    : normalizePatterns(patterns);
  // `include` が空のフィルターは全部を通すので、空の指定はここで先に断ち切ります。
  const filter = createPathFilter({ include: list });

  return {
    patterns: Object.freeze([...list]),
    /** 既定のままか（画面と起動ログで「決めていない」と「決めた」を書き分けるため）。 */
    isDefault: patterns === undefined || patterns === null,
    /** このファイルを文字起こしとして使ってよいか。拡張子は見ません（見るのは呼び出し側です）。 */
    matches(relativePath) {
      return list.length > 0 && filter.matchesFile(relativePath);
    }
  };
}

/** 断るときの1行。使えるパターンと、増やし方をそのまま出します。 */
export function transcriptScopeMessage(scope, relativeFile = '') {
  const target = relativeFile ? `${relativeFile} は文字起こし用のファイルではありません。` : '';
  if (scope.patterns.length === 0) {
    return `${target}文字起こしに使えるファイルが設定されていません`
      + '（review-markdown config add transcriptFiles \'meet-captions\' で足せます）';
  }
  return `${target}文字起こしに使えるのは ${scope.patterns.join(' / ')} に当たるファイルだけです`
    + '（review-markdown config add transcriptFiles \'<パターン>\' で足せます）';
}
