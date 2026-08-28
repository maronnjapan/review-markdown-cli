/**
 * コマンドライン引数の読み取りのうち、`review-markdown` と `review-markdown config` が
 * 同じように書いていた部分です。
 *
 * どちらも `--flag value` と `--flag=value` の両方を受け付け、値を取り違えないために
 * 「次が別のフラグに見えるなら値ではない」と判断します。同じ規則を2か所に書くと、
 * 片方だけ直したときに片方だけ挙動が変わります。
 */

/**
 * `--flag=value` を分けます。`=` を含まない引数や、`-` 1つで始まる短縮形はそのままです。
 * @returns {[string, string|undefined]} フラグ名と、`=` の後ろの値。
 */
export function splitFlag(arg) {
  if (!arg.startsWith('--') || !arg.includes('=')) return [arg, undefined];
  const separator = arg.indexOf('=');
  return [arg.slice(0, separator), arg.slice(separator + 1)];
}

/**
 * 値を取るフラグの値を1つ読みます。
 *
 * `--flag=value` なら `=` の後ろを、`--flag value` なら次の引数を使います。
 * 次の引数が `-` で始まるときは値として扱いません。`--exclude --no-open` のような
 * 書き間違いで、後ろのフラグを値として飲み込んでしまわないためです。
 * （`--flag=-1` のように `=` で明示した場合は、`-` で始まっていても値です。）
 *
 * @returns {{value: string, nextIndex: number}} 読んだ値と、次に見るべき位置。
 */
export function takeValue(argv, index, flag, inlineValue) {
  const value = inlineValue ?? argv[index + 1];
  const nextIndex = inlineValue === undefined ? index + 1 : index;
  if (value === undefined || (inlineValue === undefined && value.startsWith('-'))) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex };
}
