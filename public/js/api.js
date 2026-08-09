/** The only place that knows the server's URL shapes. */

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

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
  }
};

function postJson(url, payload) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function errorMessage(response) {
  try {
    return (await response.json()).error || response.statusText;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}
