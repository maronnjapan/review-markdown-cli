// Google Meet上のcontent scriptは、Chrome拡張機能の分離環境で動いていても、
// cross-originのfetchにはMeetページ側のCORS制約が適用されます。そのためlocalhostへの
// 通信は、host_permissionsを持つ拡張機能のservice workerから行います。
//
// もう1つ、このservice workerは連携先を自分で探します。連携コードはreview-markdownの
// 起動ごとに変わるので、人が貼って運ぶ限り「貼り直し忘れた回だけ記録が残らない」が
// 必ず起きます。探して取りに行けば、忘れる場所そのものが無くなります。

const APPEND_MESSAGE = 'APPEND_LIVE_CAPTION';
const PAIRING_MESSAGE = 'REQUEST_PAIRING';
const SYNC_SETTINGS_KEY = 'meetCaptionsMemo_liveSync';
const TOKEN_HEADER = 'X-Review-Markdown-Live-Captions-Token';
const APPEND_PATH = '/api/live-captions/append';
const PAIRING_PATH = '/api/live-captions/pairing';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** CLIの既定ポートと、そこから探す範囲。塞がっていると1つずつ上げていくので、その分だけ見ます。 */
const DEFAULT_PORT = 3000;
const PORT_SEARCH_COUNT = 10;
/** 動いていない相手を待ち続けないための頭打ち。localhost宛てなので、繋がるなら即答です。 */
const PROBE_TIMEOUT_MS = 700;
/** 探し直しの間隔。1回の会議で何度も失敗しても、localhostを叩くのはこの間隔までです。 */
const REDISCOVER_INTERVAL_MS = 3000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === APPEND_MESSAGE) {
    appendCaption(message).then(sendResponse);
    // Promiseが終わるまでsendResponseの通信路を開いておきます。
    return true;
  }
  if (message?.type === PAIRING_MESSAGE) {
    discoverPairing({ force: message.force === true }).then(sendResponse);
    return true;
  }
  return false;
});

// ブラウザを開いた直後と、拡張機能を入れ直した直後。会議に入る前に済ませておけば、
// 最初の一言から記録できます。
chrome.runtime.onStartup.addListener(() => discoverPairing({ force: true }));
chrome.runtime.onInstalled.addListener(() => discoverPairing({ force: true }));

/**
 * 字幕1行の送信です。
 *
 * 断られたら、その場で連携先を探し直してもう一度だけ送ります。review-markdownを
 * 会議中に立ち上げ直すと、トークンもポートも変わります。次の起動まで待たせると、
 * 気づいて貼り直すまでの発言が丸ごと落ちます。
 */
async function appendCaption({ serverUrl, token, body }) {
  const first = await postCaption({ serverUrl, token, body });
  if (first.ok || !first.retryable) return first;

  const paired = await discoverPairing();
  if (!paired.ok || (paired.serverUrl === serverUrl && paired.token === token)) return first;
  return { ...await postCaption({ serverUrl: paired.serverUrl, token: paired.token, body }), repaired: true };
}

async function postCaption({ serverUrl, token, body }) {
  const url = localServerUrl(serverUrl);
  if (!url || typeof token !== 'string' || !token || !body) {
    // 設定が空なのは、探し直しても直りません（探した結果がまだ入っていない状態です）。
    return { ok: false, status: 0, error: '連携設定が不正です', retryable: false };
  }

  try {
    const response = await fetch(`${url}${APPEND_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify(body)
    });
    // 403は「立ち上げ直してトークンが変わった」です。繋がらないのと合わせて、探し直せば直ります。
    return { ok: response.ok, status: response.status, retryable: response.status === 403 };
  } catch {
    return { ok: false, status: 0, error: 'review-markdownへ接続できません', retryable: true };
  }
}

// ---------- 連携先を探す ----------

/** 同じ瞬間に何本も走らせないための、実行中の1本。 */
let discovering = null;
let lastDiscoveredAt = 0;
/** 最後に見つけた連携先。続けて失敗したときに、探し直さずそのまま答えるために持ちます。 */
let lastFound = null;

/**
 * 動いているreview-markdownを探し、見つけたら連携設定へ書き込みます。
 *
 * @param {object} [options]
 * @param {boolean} [options.force] 直前に探していても、もう一度探す。
 */
function discoverPairing({ force = false } = {}) {
  if (discovering) return discovering;
  discovering = runDiscovery({ force }).finally(() => {
    discovering = null;
    lastDiscoveredAt = Date.now();
  });
  return discovering;
}

async function runDiscovery({ force }) {
  const sync = await readSyncSettings();
  // 自動で探すのを切っている人の端末では、localhostを一切叩きません。
  if (sync.autoPair === false) return { ok: false, reason: 'off' };
  // 続けて失敗しても、localhostを叩くのは間隔を空けてからです。その間は、直前に
  // 見つけた連携先をそのまま答えます（探し直さないことと、答えないことは別です）。
  if (!force && Date.now() - lastDiscoveredAt < REDISCOVER_INTERVAL_MS) {
    return lastFound ? { ok: true, ...lastFound } : { ok: false, reason: 'cooldown' };
  }

  const found = await findServer(sync);
  if (!found) return { ok: false, reason: 'not-found' };
  lastFound = found;
  await savePairing(found, sync);
  return { ok: true, ...found };
}

/**
 * 探す順番は「知っている場所 → 既定のポート」です。
 *
 * 前に繋がった場所と、いま開いているreview-markdownのタブは、ポートまで分かっています。
 * ほとんどの場合はここで当たるので、他のポートは叩きません。当たらなかったときだけ、
 * 既定のポートから順に探します（CLIは3000が塞がっていると1つずつ上げていきます）。
 */
async function findServer(sync) {
  const known = uniqueOrigins([sync.serverUrl, ...await openLocalTabUrls()]);
  for (const origin of known) {
    const found = await probeServer(origin);
    if (found) return found;
  }

  const range = uniqueOrigins(
    Array.from({ length: PORT_SEARCH_COUNT }, (_, index) => `http://127.0.0.1:${DEFAULT_PORT + index}`)
  ).filter((origin) => !known.includes(origin));
  // 範囲はまとめて当たります。1つずつ待つと、動いていないポートの数だけ待つことになります。
  const results = await Promise.all(range.map((origin) => probeServer(origin)));
  return results.find(Boolean) || null;
}

/**
 * 1つのlocalhostに「review-markdownですか」と聞きます。
 * 違うものが動いていても、答えの形が違えば連携先にはしません。
 */
async function probeServer(origin) {
  try {
    const response = await fetch(`${origin}${PAIRING_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const info = await response.json();
    const serverUrl = localServerUrl(info?.serverUrl);
    const token = typeof info?.token === 'string' ? info.token.trim() : '';
    // 名乗ったURLと、こちらが叩いた先が違うなら、その答えは信じません。
    if (!serverUrl || serverUrl !== origin || !token) return null;
    return {
      serverUrl,
      token,
      rootDir: typeof info.rootDir === 'string' ? info.rootDir : '',
      transcriptFiles: Array.isArray(info.transcriptFiles) ? info.transcriptFiles : []
    };
  } catch {
    return null;
  }
}

/**
 * 見つけた連携先を設定へ書き込みます。
 *
 * 書き換えるのはURLとトークンだけです。書き込み先ファイルの決め方は、その人が選んだ
 * ものが残ります。連携そのものは、まだ一度も選んでいない人にだけ有効にします
 * （`enabledByUser`）。切った人の設定を、探し当てるたびに戻してしまわないためです。
 */
async function savePairing(found, sync) {
  const next = {
    ...sync,
    enabled: sync.enabledByUser === true ? sync.enabled === true : true,
    serverUrl: found.serverUrl,
    token: found.token,
    path: typeof sync.path === 'string' ? sync.path : '',
    autoPath: sync.autoPath ?? true
  };
  const unchanged = sync.enabled === next.enabled
    && sync.serverUrl === next.serverUrl
    && sync.token === next.token
    && sync.path === next.path
    && sync.autoPath === next.autoPath;
  if (unchanged) return;
  await chrome.storage.local.set({ [SYNC_SETTINGS_KEY]: next });
}

/** 開いているreview-markdownのタブ。URLにポートが書いてあるので、探さずに済みます。 */
async function openLocalTabUrls() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] });
    return tabs.map((tab) => tab?.url).filter(Boolean);
  } catch {
    // タブが読めなくても、既定のポートから探せます。
    return [];
  }
}

function uniqueOrigins(values) {
  const origins = [];
  for (const value of values) {
    const origin = localServerUrl(value);
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

async function readSyncSettings() {
  try {
    const stored = await chrome.storage.local.get(SYNC_SETTINGS_KEY);
    return stored?.[SYNC_SETTINGS_KEY] || {};
  } catch {
    return {};
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
