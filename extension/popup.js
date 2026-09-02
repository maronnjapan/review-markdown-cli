const INDEX_KEY = 'meetCaptionsMemo_index';
const MEMO_KEY_PREFIX = 'meetCaptionsMemo_memo_';
const SYNC_SETTINGS_KEY = 'meetCaptionsMemo_liveSync';

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}
function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ja-JP', { hour12: false });
}

function memoToMarkdown(memo) {
  const lines = [
    `# ${memo.title}`,
    '',
    `- 会議コード: ${memo.meetingCode}`,
    `- 開始: ${formatDate(memo.startedAt)}`,
    '',
    '---',
    '',
  ];
  for (const line of memo.lines) {
    lines.push(`## ${line.speaker} [${line.time}]`);
    lines.push('');
    lines.push(line.text);
    lines.push('');
  }
  return lines.join('\n');
}

async function loadStatus() {
  const statusEl = document.getElementById('status');
  const tabs = await new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, resolve)
  );
  const tab = tabs && tabs[0];
  if (!tab || !tab.url || !tab.url.includes('meet.google.com')) {
    statusEl.textContent = 'Google Meetのタブを開くと記録状況が表示されます';
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      statusEl.textContent = 'このMeetタブではまだ字幕を検出していません(CCをオンにしてください)';
      return;
    }
    statusEl.textContent = res.recording
      ? `記録中: ${res.meetingCode}`
      : `一時停止中: ${res.meetingCode}`;
  });
}

async function loadMemoList() {
  const listEl = document.getElementById('memoList');
  const template = document.getElementById('memoItemTemplate');
  const { [INDEX_KEY]: index = [] } = await storageGet(INDEX_KEY);

  listEl.innerHTML = '';
  if (index.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'まだ保存されたメモはありません。Meetで字幕(CC)をオンにすると自動で記録が始まります。';
    listEl.appendChild(p);
    return;
  }

  for (const meta of index) {
    const node = template.content.cloneNode(true);
    const item = node.querySelector('.memo-item');
    node.querySelector('.memo-item__title').textContent = meta.title || meta.meetingCode;
    node.querySelector('.memo-item__meta').textContent =
      `${formatDate(meta.startedAt)} ・ ${meta.lineCount || 0}行`;

    const body = node.querySelector('.memo-item__body');
    const toggleBtn = node.querySelector('.btn--toggle');
    const copyBtn = node.querySelector('.btn--copy');
    const downloadBtn = node.querySelector('.btn--download');
    const deleteBtn = node.querySelector('.btn--delete');

    let memoCache = null;
    async function getMemo() {
      if (memoCache) return memoCache;
      const key = MEMO_KEY_PREFIX + meta.id;
      const got = await storageGet(key);
      memoCache = got[key];
      return memoCache;
    }

    toggleBtn.addEventListener('click', async () => {
      const hidden = body.hasAttribute('hidden');
      if (hidden) {
        const memo = await getMemo();
        body.textContent = memo ? memoToMarkdown(memo) : '(データが見つかりません)';
        body.removeAttribute('hidden');
        toggleBtn.textContent = '隠す';
      } else {
        body.setAttribute('hidden', '');
        toggleBtn.textContent = '表示';
      }
    });

    copyBtn.addEventListener('click', async () => {
      const memo = await getMemo();
      if (!memo) return;
      await navigator.clipboard.writeText(memoToMarkdown(memo));
      copyBtn.textContent = 'コピー済';
      setTimeout(() => (copyBtn.textContent = 'コピー'), 1200);
    });

    downloadBtn.addEventListener('click', async () => {
      const memo = await getMemo();
      if (!memo) return;
      const md = memoToMarkdown(memo);
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const filenameSafe = (memo.title || memo.meetingCode).replace(/[\\/:*?"<>|]/g, '_');
      chrome.downloads.download(
        { url, filename: `meet-captions/${filenameSafe}_${meta.id}.md`, saveAs: false },
        () => URL.revokeObjectURL(url)
      );
    });

    deleteBtn.addEventListener('click', async () => {
      if (!confirm('このメモを削除しますか？')) return;
      const key = MEMO_KEY_PREFIX + meta.id;
      await storageRemove(key);
      const { [INDEX_KEY]: currentIndex = [] } = await storageGet(INDEX_KEY);
      const nextIndex = currentIndex.filter((m) => m.id !== meta.id);
      await storageSet({ [INDEX_KEY]: nextIndex });
      item.remove();
    });

    listEl.appendChild(node);
  }
}

const SYNC_TOKEN_HEADER = 'X-Review-Markdown-Live-Captions-Token';

/**
 * 連携の設定です。
 *
 * 人が運ぶのは連携コード1本だけにしてあります。以前はURLとトークンを別々に打ち込んで
 * いて、どちらを間違えても結果は同じ「連携エラー」でした。1本にまとめれば片方だけ古い
 * という食い違いは起きませんし、「接続を確認」でその場で確かめられます。
 */
function readPairing() {
  const code = document.getElementById('syncCode').value.trim();
  if (!code) return { url: '', token: '', error: '' };
  try {
    return { ...MeetCaptionsPairing.decodePairingCode(code), error: '' };
  } catch (error) {
    return { url: '', token: '', error: error.message };
  }
}

/** 連携コードから読み取れたものを、貼った人にも見えるようにします。 */
function renderPairing() {
  const note = document.getElementById('syncPairing');
  const { url, error } = readPairing();
  if (error) {
    note.textContent = error;
    note.style.color = '#a11212';
    return;
  }
  note.style.color = '';
  note.textContent = url ? `接続先: ${url}` : '連携コードを貼ると、接続先がここに出ます';
}

function setSyncStatus(text, state) {
  const status = document.getElementById('syncStatus');
  status.textContent = text;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

/** 自動で作るときはパスを決めさせません。決めた値が使われないのに残るのは紛らわしいので。 */
function renderPathField() {
  const auto = document.getElementById('syncAutoPath').checked;
  document.getElementById('syncPathField').hidden = auto;
}

async function loadSyncSettings() {
  const { [SYNC_SETTINGS_KEY]: sync = {} } = await storageGet(SYNC_SETTINGS_KEY);
  document.getElementById('syncEnabled').checked = sync.enabled === true;
  // 保存済みのURLとトークンからコードを組み直して出します。前に貼ったコードがそのまま
  // 見えるので、立ち上げ直したあと「貼り直したか」を見分けられます。
  document.getElementById('syncCode').value = sync.serverUrl && sync.token
    ? MeetCaptionsPairing.encodePairingCode({ url: sync.serverUrl, token: sync.token })
    : '';
  document.getElementById('syncPath').value = sync.path || '';
  document.getElementById('syncAutoPath').checked = sync.autoPath === true;
  renderPairing();
  renderPathField();
}

/**
 * 繋がるかどうかを、保存する前に確かめます。
 *
 * 追記のエンドポイントで試すと、確かめるだけでファイルが1行増えるので、確認専用の
 * 窓口（/api/live-captions/ping）を叩きます。ついでに書き込み先の候補も引いてきて、
 * パスの打ち間違いも減らします。
 */
async function testConnection() {
  const { url, token, error } = readPairing();
  if (error || !url) {
    setSyncStatus(error || '連携コードを貼ってください', 'error');
    return;
  }
  setSyncStatus('確認中…');
  try {
    const response = await fetch(`${url}/api/live-captions/ping`, {
      headers: { [SYNC_TOKEN_HEADER]: token }
    });
    if (response.status === 403) {
      setSyncStatus('トークンが合いません。review-markdownを立ち上げ直したら、連携コードを貼り直してください', 'error');
      return;
    }
    if (!response.ok) {
      setSyncStatus(`繋がりません（HTTP ${response.status}）`, 'error');
      return;
    }
    const info = await response.json();
    setSyncStatus(`繋がりました: ${info.rootDir} に書き込みます`, 'ok');
    await loadTargets(url, token);
  } catch {
    setSyncStatus('繋がりません。review-markdownが起動しているか確認してください', 'error');
  }
}

/**
 * 書き込み先の候補。引けなくても黙って通します。候補はパスを楽に選ぶためのもので、
 * 無くても手で書けば書き込めます（存在しないパスは最初の発言で作られます）。
 */
async function loadTargets(url, token) {
  try {
    const response = await fetch(`${url}/api/live-captions/targets`, {
      headers: { [SYNC_TOKEN_HEADER]: token }
    });
    if (!response.ok) return;
    const { files = [] } = await response.json();
    document.getElementById('syncPathOptions').innerHTML = files
      .map((file) => `<option value="${file.replace(/"/g, '&quot;')}"></option>`)
      .join('');
  } catch {
    // 候補が出ないだけなので、確認の結果は上書きしません。
  }
}

function bindSyncSettingsForm() {
  const form = document.getElementById('syncForm');
  const savedLabel = document.getElementById('syncSaved');
  document.getElementById('syncCode').addEventListener('input', renderPairing);
  document.getElementById('syncAutoPath').addEventListener('change', renderPathField);
  document.getElementById('syncTest').addEventListener('click', testConnection);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { url, token, error } = readPairing();
    const enabled = document.getElementById('syncEnabled').checked;
    // 有効にしたのに繋ぎ先が読めないままだと、記録が始まってから初めて気づくことになります。
    if (enabled && (error || !url)) {
      setSyncStatus(error || '連携を有効にするには、連携コードが要ります', 'error');
      return;
    }
    const sync = {
      enabled,
      serverUrl: url,
      token,
      path: document.getElementById('syncPath').value.trim(),
      autoPath: document.getElementById('syncAutoPath').checked
    };
    await storageSet({ [SYNC_SETTINGS_KEY]: sync });
    setSyncStatus('');
    savedLabel.hidden = false;
    setTimeout(() => (savedLabel.hidden = true), 1500);
  });
}

loadStatus();
loadMemoList();
loadSyncSettings();
bindSyncSettingsForm();
