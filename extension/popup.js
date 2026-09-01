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

async function loadSyncSettings() {
  const { [SYNC_SETTINGS_KEY]: sync = {} } = await storageGet(SYNC_SETTINGS_KEY);
  document.getElementById('syncEnabled').checked = sync.enabled === true;
  document.getElementById('syncServerUrl').value = sync.serverUrl || '';
  document.getElementById('syncToken').value = sync.token || '';
  document.getElementById('syncPath').value = sync.path || '';
}

function bindSyncSettingsForm() {
  const form = document.getElementById('syncForm');
  const savedLabel = document.getElementById('syncSaved');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sync = {
      enabled: document.getElementById('syncEnabled').checked,
      serverUrl: document.getElementById('syncServerUrl').value.trim().replace(/\/+$/, ''),
      token: document.getElementById('syncToken').value.trim(),
      path: document.getElementById('syncPath').value.trim()
    };
    await storageSet({ [SYNC_SETTINGS_KEY]: sync });
    savedLabel.hidden = false;
    setTimeout(() => (savedLabel.hidden = true), 1500);
  });
}

loadStatus();
loadMemoList();
loadSyncSettings();
bindSyncSettingsForm();
