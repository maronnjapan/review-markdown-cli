/**
 * 画面からContext APIを呼ぶところです。
 *
 * ここにある口は、外部のツール（review-markdown CLI、MCPのクライアント）が使うものと同じです。
 * 画面のためだけの近道は持ちません（`src/server.js` 冒頭の説明）。
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {Function} options.getToken `CONTEXT_API_TOKEN` を設定したサーバへ送るトークン。
 * @param {Function} [options.onUnauthorized] 401 が返ったときに呼びます（トークンの入力を促す）。
 */
export function createApi({ getToken = () => null, onUnauthorized = () => {} } = {}) {
  async function request(method, path, body) {
    const token = getToken();
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new ApiError(`サーバへ繋がりません（${error.message}）`, 0);
    }
    if (response.status === 401) onUnauthorized();
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text.slice(0, 200) };
      }
    }
    if (!response.ok) throw new ApiError(payload.error || `HTTP ${response.status}`, response.status);
    return payload;
  }

  const encode = encodeURIComponent;

  return {
    request,
    health: () => request('GET', '/health'),

    listWorkspaces: () => request('GET', '/workspaces').then((payload) => payload.results),
    createWorkspace: (body) => request('POST', '/workspaces', body).then((payload) => payload.workspace),
    patchWorkspace: (id, body) => request('PATCH', `/workspaces/${encode(id)}`, body).then((payload) => payload.workspace),
    deleteWorkspace: (id) => request('DELETE', `/workspaces/${encode(id)}`),
    exportWorkspace: (id) => request('GET', `/workspaces/${encode(id)}/export`),
    importPages: (id, pages) => request('POST', `/workspaces/${encode(id)}/import`, { pages }),

    tree: (workspaceId) => request('GET', `/workspaces/${encode(workspaceId)}/pages`).then((payload) => payload.results),
    page: (id) => request('GET', `/pages/${encode(id)}`).then((payload) => payload.page),
    createPage: (body) => request('POST', '/pages', body).then((payload) => payload.page),
    patchPage: (id, body) => request('PATCH', `/pages/${encode(id)}`, body),
    deletePage: (id) => request('DELETE', `/pages/${encode(id)}`),
    retryIndex: () => request('POST', '/index/retry', {}),

    search: (body) => request('POST', '/search', body).then((payload) => payload.results),

    listContexts: (workspaceId) => request('GET', `/contexts?${new URLSearchParams({ ...(workspaceId ? { workspace_id: workspaceId } : {}), limit: '200' })}`)
      .then((payload) => payload.results),
    createContext: (body) => request('POST', '/contexts', body),
    patchContext: (id, body) => request('PATCH', `/contexts/${encode(id)}`, body).then((payload) => payload.context),
    deleteContext: (id) => request('DELETE', `/contexts/${encode(id)}`),

    /**
     * 資料を根拠にした回答を、少しずつ受け取ります（`/ask` の `stream: true`）。
     * @param {object} body `{ question, workspace_id, ... }`
     * @param {object} handlers `{ onSources, onDelta, onDone, signal }`
     */
    async ask(body, { onSources = () => {}, onDelta = () => {}, onDone = () => {}, signal } = {}) {
      const token = getToken();
      let response;
      try {
        response = await fetch('/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ ...body, stream: true }),
          signal
        });
      } catch (error) {
        if (error.name === 'AbortError') return null;
        throw new ApiError(`サーバへ繋がりません（${error.message}）`, 0);
      }
      if (response.status === 401) onUnauthorized();
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new ApiError(payload.error || `HTTP ${response.status}`, response.status);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let done = null;
      while (true) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffered += decoder.decode(value, { stream: true });
        let boundary = buffered.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const event = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          const parsed = data ? JSON.parse(data) : {};
          if (event === 'sources') onSources(parsed);
          else if (event === 'delta') onDelta(parsed.text || '');
          else if (event === 'done') {
            done = parsed;
            onDone(parsed);
          } else if (event === 'error') throw new ApiError(parsed.error || '回答の生成に失敗しました', 500);
          boundary = buffered.indexOf('\n\n');
        }
      }
      return done;
    }
  };
}
