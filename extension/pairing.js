// pairing.js
//
// review-markdown-cli が出す「連携コード」を読み書きします。
// 形式は CLI 側の src/pairing.js と同じものです。片方だけ変えると繋がらなくなるので、
// 形を変えるときは両方の PAIRING_PREFIX を一緒に上げてください。
//
// この拡張機能はビルド無しで読み込ませる前提なので、モジュールではなくグローバルへ
// 1つだけ置きます。使うのはポップアップだけです（content.js は保存済みのURLとトークンを
// 読むだけで、コードそのものは扱いません）。

(() => {
  const PAIRING_PREFIX = 'rmc1';
  const MAX_CODE_CHARS = 4000;
  // 話してよい相手。連携コードは貼り付けた文字列なので、どこを指しているかは人には
  // 読めません。読めないものを信じさせないために、行き先はここで絞ります。
  const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

  function normalizeServerUrl(value) {
    const text = String(value == null ? '' : value).trim().replace(/\/+$/, '');
    if (!text) return '';
    let url;
    try {
      url = new URL(text);
    } catch {
      return '';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!LOCAL_HOSTNAMES.includes(url.hostname)) return '';
    return `${url.protocol}//${url.host}`;
  }

  function encodePairingCode({ url, token }) {
    const serverUrl = normalizeServerUrl(url);
    if (!serverUrl || !token) return '';
    return `${PAIRING_PREFIX}.${toBase64Url(JSON.stringify({ u: serverUrl, t: token }))}`;
  }

  // 読めないコードは、なぜ読めないかを言って断ります。黙って空を返すと、貼り間違えたのか
  // コードが古いのかを、ポップアップの表示から区別できません。
  function decodePairingCode(code) {
    const text = String(code == null ? '' : code).trim();
    if (!text) throw new Error('連携コードが空です');
    if (text.length > MAX_CODE_CHARS) throw new Error('連携コードが長すぎます');
    const separator = text.indexOf('.');
    const prefix = separator === -1 ? text : text.slice(0, separator);
    const payload = separator === -1 ? '' : text.slice(separator + 1);
    if (prefix !== PAIRING_PREFIX || !payload) {
      throw new Error('連携コードの形式が違います。review-markdownの画面から貼り直してください');
    }

    let parsed;
    try {
      parsed = JSON.parse(fromBase64Url(payload));
    } catch {
      throw new Error('連携コードが壊れています。review-markdownの画面から貼り直してください');
    }

    const url = normalizeServerUrl(parsed && parsed.u);
    const token = parsed && typeof parsed.t === 'string' ? parsed.t.trim() : '';
    if (!url || !token) throw new Error('連携コードにURLかトークンが入っていません');
    return { url, token };
  }

  function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    // atob は詰め物の無い文字列を受け付けないので、4の倍数へ戻してから渡します。
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  self.MeetCaptionsPairing = { encodePairingCode, decodePairingCode, normalizeServerUrl };
})();
