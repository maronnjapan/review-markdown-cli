/**
 * まだ閉じていないJSONから、書き終わったフィールドだけを取り出します。
 *
 * 翻訳の答えはストリームで届くので、全部そろうのを待つと数秒間なにも出せません。
 * 一方で途中の文字列をそのまま出すと、書きかけの語が画面でちらつきます。
 * そこで「値として完成しているフィールド」だけを見つけて、それを出します。
 *
 * これが成り立つのは、答えのスキーマが「先に知りたいものを先頭へ」並べてあるからです
 * （src/prompts/translate.js の TERM_SCHEMA）。届いた順に確定するので、
 * `contextualMeaning` が読めた時点で、一番知りたい答えは出せます。
 */

/**
 * @param {string} text ここまでに届いたJSONの断片。
 * @param {string} field 取り出したいフィールド名。
 * @returns {*} 値が書き終わっていればその値、まだなら undefined。
 */
export function completeJsonField(text, field) {
  const marker = `"${field}"`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const colonIndex = text.indexOf(':', markerIndex + marker.length);
  if (colonIndex < 0) return undefined;
  let start = colonIndex + 1;
  while (/\s/.test(text[start] || '')) start += 1;
  const end = valueEnd(text, start);
  if (end === null) return undefined;
  try {
    return JSON.parse(text.slice(start, end));
  } catch {
    return undefined;
  }
}

/**
 * 値が閉じている位置。閉じていなければ null。
 * 扱うのは文字列・配列・オブジェクトだけです。数値や true/false は末尾が
 * 「区切りが来るまで分からない」ので、届ききったかを判断できません。
 */
function valueEnd(text, start) {
  const opening = text[start];
  if (opening === '"') return stringEnd(text, start);
  if (opening !== '[' && opening !== '{') return null;
  return nestedEnd(text, start, opening === '[' ? ']' : '}');
}

function stringEnd(text, start) {
  for (let index = start + 1, escaped = false; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return null;
}

/** 入れ子の深さを数えます。文字列の中の括弧は数えません。 */
function nestedEnd(text, start, closing) {
  const opening = text[start];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}
