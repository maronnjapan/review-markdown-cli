/** The only place that knows the server's URL shapes. */

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

let aiToken = null;

export const api = {
  listFiles: () => fetchJson('/api/files'),

  openFile: (path) => fetchJson(`/api/file?path=${encodeURIComponent(path)}`),

  saveFile: (payload) => postJson('/api/file', payload),

  saveComments: (payload) => postJson('/api/review', payload),

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
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
    const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    return navigator.sendBeacon('/api/review', body);
  },

  async prepareAi() {
    const status = await fetchJson('/api/ai/status');
    aiToken = status.token;
    return status;
  },

  async listAiConversations(path) {
    await ensureAiToken();
    return fetchJson(`/api/ai/conversations?path=${encodeURIComponent(path)}`, aiOptions());
  },

  async createAiConversation(payload) {
    await ensureAiToken();
    return postJson('/api/ai/conversation', payload, aiHeaders());
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

  async listReviewSkills() {
    await ensureAiToken();
    return fetchJson('/api/ai/review-skills', aiOptions());
  },

  async composeAiPersona(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/persona', payload, { ...options, headers: aiHeaders() });
  },

  async reviewWithAi(payload, options = {}) {
    await ensureAiToken();
    return streamNdjson('/api/ai/review', payload, { ...options, headers: aiHeaders() });
  }
};

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
