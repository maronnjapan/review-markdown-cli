/** The only place that knows the server's URL shapes. */

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  // 状態コードを添えるのは、呼ぶ側が文面ではなく種類で分けられるようにするためです。
  // 本文の修正案は 409（作ったときから本文が変わった）だけを別の扱いにします。
  if (!response.ok) throw Object.assign(new Error(await errorMessage(response)), { status: response.status });
  return response.json();
}

let aiToken = null;

export const api = {
  listFiles: () => fetchJson('/api/files'),

  openFile: (path) => fetchJson(`/api/file?path=${encodeURIComponent(path)}`),

  saveFile: (payload) => postJson('/api/file', payload),

  saveComments: (payload) => postJson('/api/review', payload),

  /** ディレクトリ全体に効く前提。行き先が文書のレビューファイルではないので、窓口も別です。 */
  saveDirectoryContext: (payload) => postJson('/api/context/directory', payload),

  async exportReview(path) {
    const response = await fetch(`/api/export?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.text();
  },

  /**
   * A reload or tab close can beat the debounce timer, so hand the browser one
   * last copy on the way out. Beacons outlive the page; a fetch would be cancelled.
   */
  beaconComments(payload) {
    return beacon('/api/review', payload);
  },

  /** 同じく、閉じる間際のディレクトリ全体の前提。行き先だけが違います。 */
  beaconDirectoryContext(payload) {
    return beacon('/api/context/directory', payload);
  },

  async prepareAi() {
    const status = await fetchJson('/api/ai/status');
    aiToken = status.token;
    return status;
  },

  /** 画面から変えられる設定と、その選択肢。AIの起動もサーバー側でここまでに済みます。 */
  async readSettings() {
    await ensureAiToken();
    return fetchJson('/api/settings', aiOptions());
  },

  async saveSettings(payload) {
    await ensureAiToken();
    return postJson('/api/settings', payload, aiHeaders());
  },

  /**
   * Meet Captions Memo拡張機能へ渡す連携コードと、その内訳。
   * AIのトークンは要りません。この窓口はlocalhostの同一オリジンからだけ答えます
   * （`src/routes.js` の `liveCaptionsTokenInfo`）。
   */
  readLiveCaptions: () => fetchJson('/api/live-captions/token'),

  async listAiConversations(path) {
    await ensureAiToken();
    return fetchJson(`/api/ai/conversations?path=${encodeURIComponent(path)}`, aiOptions());
  },

  async createAiConversation(payload) {
    await ensureAiToken();
    return postJson('/api/ai/conversation', payload, aiHeaders());
  },

  /** 保存した会話の題名と、残すやり取りを置き換えます。 */
  async updateAiConversation(payload) {
    await ensureAiToken();
    return fetchJson('/api/ai/conversation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...aiHeaders() },
      body: JSON.stringify(payload)
    });
  },

  async deleteAiConversation(id) {
    await ensureAiToken();
    return fetchJson('/api/ai/conversation', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...aiHeaders() },
      body: JSON.stringify({ id })
    });
  },

  async translateWithAi(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/translate', payload, { ...options, headers: aiHeaders() });
  },

  async sendAiMessage(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/message', payload, { ...options, headers: aiHeaders() });
  },

  async placeAiComments(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/place-comments', payload, { ...options, headers: aiHeaders() });
  },

  /** その文書に添えられるファイル（同階層以下）。AIの起動は要りません。 */
  async listReferenceFiles(path) {
    await ensureAiToken();
    return fetchJson(`/api/ai/reference-files?path=${encodeURIComponent(path)}`, aiOptions());
  },

  async listReviewSkills() {
    await ensureAiToken();
    return fetchJson('/api/ai/review-skills', aiOptions());
  },

  async readReviewSkill(id) {
    await ensureAiToken();
    return fetchJson(`/api/ai/review-skill?id=${encodeURIComponent(id)}`, aiOptions());
  },

  async saveReviewSkill(skill) {
    await ensureAiToken();
    return postJson('/api/ai/review-skill', skill, aiHeaders());
  },

  async deleteReviewSkill(id) {
    await ensureAiToken();
    return fetchJson('/api/ai/review-skill', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', ...aiHeaders() }, body: JSON.stringify({ id })
    });
  },

  async composeAiBrief(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/brief', payload, { ...options, headers: aiHeaders() });
  },

  async composeAiPersona(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/persona', payload, { ...options, headers: aiHeaders() });
  },

  async reviewWithAi(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/review', payload, { ...options, headers: aiHeaders() });
  },

  /** 本文の修正案。作るだけで、書き込みは承認後の `saveFile` が行います。 */
  async reviseWithAi(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/revise', payload, { ...options, headers: aiHeaders() });
  },

  /**
   * いま「直近」がどこからどこまでになるか。AIは起動しないので、聞く前に引けます。
   * 読むのはファイルの中身なので、画面に出ている本文より新しい発言も数に入ります。
   */
  async readRecapWindow({ path, scope, minutes }) {
    await ensureAiToken();
    const query = new URLSearchParams({ path, scope, minutes: String(minutes) });
    return fetchJson(`/api/ai/recap-window?${query}`, aiOptions());
  },

  /** 直近の文字起こしの要約と、次にすること。本文にもコメントにも書き込みません。 */
  async recapWithAi(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/recap', payload, { ...options, headers: aiHeaders() });
  },

  /** その文書の自動タスクと、見守りの状態。AIは起動しません。 */
  async readTasks(path) {
    await ensureAiToken();
    return fetchJson(`/api/tasks?path=${encodeURIComponent(path)}`, aiOptions());
  },

  /**
   * 自動タスクへの変更。一覧まるごとではなく、変えたいこと（見守り・状態・手で足す・消す・
   * タスクに添える参考）だけを送ります。裏で足されたタスクを、この保存で消さないためです。
   */
  async changeTasks(payload) {
    await ensureAiToken();
    return postJson('/api/tasks', payload, aiHeaders());
  },

  /** 「タスクを整理する」。いまの本文を読み直してタスクを起こし、任せた種類は実行します。 */
  async extractTasksWithAi(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/tasks/extract', payload, { ...options, headers: aiHeaders() });
  },

  /** タスクを1つ実行します。結果は「確認待ち」として記録に入ります。 */
  async runTaskWithAi(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/tasks/run', payload, { ...options, headers: aiHeaders() });
  }
};

function beacon(url, payload) {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
  const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  return navigator.sendBeacon(url, body);
}

function postJson(url, payload, extraHeaders = {}) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

async function ensureAiToken() {
  if (!aiToken) await api.prepareAi();
}

function aiHeaders() {
  return { 'X-Review-Markdown-Token': aiToken };
}

function aiOptions() {
  return { headers: aiHeaders() };
}

async function streamNdjson(url, payload, { signal, onEvent = () => {}, headers = {} } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error('AI response stream is unavailable');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      onEvent(event);
      if (event.type === 'error') throw new Error(event.error || 'AI request failed');
      if (event.type === 'result') result = event;
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    onEvent(event);
    if (event.type === 'error') throw new Error(event.error || 'AI request failed');
    if (event.type === 'result') result = event;
  }
  if (!result) throw new Error('AI response ended without a result');
  return result;
}

async function errorMessage(response) {
  try {
    return (await response.json()).error || response.statusText;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}
