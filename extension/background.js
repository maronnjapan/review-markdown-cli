// Google Meet上のcontent scriptは、Chrome拡張機能の分離環境で動いていても、
// cross-originのfetchにはMeetページ側のCORS制約が適用されます。そのためlocalhostへの
// 通信は、host_permissionsを持つ拡張機能のservice workerから行います。

const APPEND_MESSAGE = 'APPEND_LIVE_CAPTION';
const TOKEN_HEADER = 'X-Review-Markdown-Live-Captions-Token';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== APPEND_MESSAGE) return false;

  appendCaption(message).then(sendResponse);
  // Promiseが終わるまでsendResponseの通信路を開いておきます。
  return true;
});

async function appendCaption({ serverUrl, token, body }) {
  const url = localServerUrl(serverUrl);
  if (!url || typeof token !== 'string' || !token || !body) {
    return { ok: false, status: 0, error: '連携設定が不正です' };
  }

  try {
    const response = await fetch(`${url}/api/live-captions/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify(body)
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0, error: 'review-markdownへ接続できません' };
  }
}

function localServerUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || !LOCAL_HOSTNAMES.has(url.hostname)) return '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}
