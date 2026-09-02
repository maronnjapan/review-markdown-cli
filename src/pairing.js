/**
 * 拡張機能（`extension/`）とこのCLIを繋ぐための「連携コード」です。
 *
 * 繋ぐのに要るのは、サーバーのURLと、起動のたびに変わるトークンの2つです。以前は
 * どちらも人が運びました。起動ログからトークンを目で拾い、ポートを思い出して打ち込み、
 * 打ち間違えれば拡張機能のバッジが「連携エラー」になるだけで、どちらを間違えたのかは
 * 分かりませんでした。
 *
 * そこで2つを1本の文字列にまとめ、貼り付ける先も1つにします。運ぶものが1つになれば、
 * 片方だけ古いという食い違いも起きません。トークンは起動ごとに変わるので、この文字列も
 * 起動ごとに変わります。
 *
 * 中身は隠していません。base64urlは短くして貼りやすくするためのもので、秘密を守るのは
 * トークンそのものです。だから、この文字列はトークンと同じ扱い——同じ端末の自分の
 * 拡張機能にだけ渡すもの——として扱ってください。
 */

/** どの形式かを見分ける印。形を変えるときはここを上げます。 */
const PAIRING_PREFIX = 'rmc1';

/** 貼り付け事故を防ぐための頭打ち。URLもトークンもこれよりずっと短いはずです。 */
const MAX_CODE_CHARS = 4000;

/** 拡張機能が話してよい相手。localhost以外へ原稿を送らせないための一覧です。 */
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * URLとトークンを1本の連携コードにします。
 *
 * @param {object} params
 * @param {string} params.url サーバーのURL（`http://localhost:3000`）。
 * @param {string} params.token `liveCaptionsToken`。
 */
export function encodePairingCode({ url, token }) {
  const serverUrl = normalizeServerUrl(url);
  if (!serverUrl) throw new Error(`連携コードにできないURLです: ${url}`);
  if (!token) throw new Error('連携コードにはトークンが要ります');
  return `${PAIRING_PREFIX}.${toBase64Url(JSON.stringify({ u: serverUrl, t: token }))}`;
}

/**
 * 連携コードをURLとトークンへ戻します。読めないコードは、なぜ読めないかを言って断ります。
 * 黙って空を返すと、貼り間違えたのか、コードが古いのかを画面から区別できません。
 */
export function decodePairingCode(code) {
  const text = String(code ?? '').trim();
  if (!text) throw new Error('連携コードが空です');
  if (text.length > MAX_CODE_CHARS) throw new Error('連携コードが長すぎます');
  const [prefix, payload] = splitOnce(text, '.');
  if (prefix !== PAIRING_PREFIX || !payload) {
    throw new Error('連携コードの形式が違います。CLIの画面またはターミナルから貼り直してください');
  }

  let parsed;
  try {
    parsed = JSON.parse(fromBase64Url(payload));
  } catch {
    throw new Error('連携コードが壊れています。CLIの画面またはターミナルから貼り直してください');
  }

  const url = normalizeServerUrl(parsed?.u);
  const token = typeof parsed?.t === 'string' ? parsed.t.trim() : '';
  if (!url || !token) throw new Error('連携コードにURLかトークンが入っていません');
  return { url, token };
}

/**
 * 話してよいURLだけを通します。
 *
 * localhost以外を弾くのは、この連携が「同じ端末で動いているCLIへ書き足す」ためのもの
 * だからです。コードを1本にまとめた以上、貼り付けた文字列がどこを指しているかは人には
 * 読めません。読めないものを信じさせないために、行き先はここで絞ります。
 */
export function normalizeServerUrl(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!LOCAL_HOSTNAMES.includes(url.hostname)) return '';
  // パスや検索文字列は使いません。付いていたら、そこは連携コードの居場所ではありません。
  return `${url.protocol}//${url.host}`;
}

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  return index === -1 ? [text, ''] : [text.slice(0, index), text.slice(index + 1)];
}

function toBase64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64Url(text) {
  return Buffer.from(text, 'base64url').toString('utf8');
}
