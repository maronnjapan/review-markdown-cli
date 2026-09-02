// content.js
//
// Google MeetのライブCaption(字幕)をDOMから読み取り、
// chrome.storage.local に「メモ」として保存するコンテンツスクリプト。
//
// 前提と注意:
// - Google Meetの字幕表示は公開APIではなく、内部DOM構造を推測して読み取っている。
//   Google側のUI変更で突然動かなくなることがある。
//   動かなくなった場合は README.md の「字幕が取得できなくなったとき」を参照。
// - 字幕自体の精度はGoogle側の音声認識に依存する(誤変換・省略・句読点なしなど)。
// - 記録は「字幕(CC)がオンになっている間」だけ行われる。CCのオン/オフは
//   Meetの通常のUIから手動で行う(この拡張機能は自動でCCをオンにはしない)。

(() => {
  const INDEX_KEY = 'meetCaptionsMemo_index';
  const MEMO_KEY_PREFIX = 'meetCaptionsMemo_memo_';
  const SETTINGS_KEY = 'meetCaptionsMemo_settings';
  // review-markdown-cli(ローカルCLI)と連携するときの設定。ポップアップから保存する。
  const SYNC_SETTINGS_KEY = 'meetCaptionsMemo_liveSync';
  const SYNC_TOKEN_HEADER = 'X-Review-Markdown-Live-Captions-Token';

  const POLL_INTERVAL_MS = 400;
  const STABLE_MS = 1300; // この時間だけテキストが変化しなければ「確定」として記録する

  let currentMemoId = null;
  // rowId -> { speaker, text, lastChangedAt, committed }
  const activeEntries = new Map();
  let recording = true;
  let badgeEl = null;
  let rowIdCounter = 0;

  // Google Meetの内部クラス名(難読化されており、Meet側のUI変更で
  // 変わることがある)。複数のバージョン/ロールアウトに対応するため、
  // 候補を並べて順に試す。これらが見つからない場合は、より一般的な
  // ヒューリスティック(アバター画像や要素構造からの推測)にフォールバックする。
  const ROW_SELECTOR = '.nMcdL';
  const TEXT_SELECTOR = '.ygicle, .iTTPOb';
  const SPEAKER_SELECTOR = '.NWpY1d, .zs7s8d.jxFHg';
  let syncSettings = null; // 未読み込みの間はnull。読み込み後は { enabled, serverUrl, token, path, autoPath }
  let lastSyncFailed = false;
  // 直し方が違うので、トークン切れ（403）だけは分けて覚えます。
  let lastSyncStale = false;

  // ---------- ストレージ ----------

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  // ---------- ユーティリティ ----------

  function getMeetingCode() {
    const m = location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return m ? m[1] : location.pathname.replace(/\//g, '') || 'unknown';
  }

  function nowTimeLabel() {
    return new Date().toLocaleTimeString('ja-JP', { hour12: false });
  }

  // 字幕の行要素(DOM要素)に安定したIDを付与する。
  // 話者名をキーにすると、同じ話者が短時間に連続して発言した場合に
  // 前の行がまだ確定していないうちに新しい行のテキストで上書きされ、
  // 発言が失われてしまう。行要素そのものをキーにすることでこれを防ぐ。
  function getRowId(el) {
    if (!el.dataset.mcmRowId) {
      el.dataset.mcmRowId = String(++rowIdCounter);
    }
    return el.dataset.mcmRowId;
  }

  // ---------- 字幕領域の検出 ----------
  // Meetの内部クラス名は難読化されており変わりやすいため、
  // 1) セマンティックなaria属性 → 2) 構造的なヒューリスティック の順で探す。

  function findCaptionsRegion() {
    const byRole = document.querySelector(
      '[role="region"][aria-label*="Captions" i], [role="region"][aria-label*="字幕"]'
    );
    if (byRole) return byRole;

    // 既知のクラス名(難読化・変更されやすいが、他の字幕取得ツールでも
    // 広く確認されている)が画面のどこかに存在すれば、documentを
    // そのまま「領域」として返す。実際の絞り込みはparseRows側で行う。
    if (document.querySelector(ROW_SELECTOR) || document.querySelector(TEXT_SELECTOR)) {
      return document.body;
    }

    // アバター画像(googleusercontent.com)を手掛かりに、
    // 発言者アイコン+テキストの行がまとまっている祖先要素を推測する
    const avatarImgs = Array.from(document.querySelectorAll('img')).filter((img) =>
      (img.src || '').includes('googleusercontent.com')
    );
    for (const img of avatarImgs) {
      let el = img.parentElement;
      for (let depth = 0; depth < 6 && el; depth++) {
        if (el.textContent && el.textContent.trim().length > 0 && el.querySelectorAll('img').length <= 4) {
          return el;
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  function parseRows(region) {
    // 1) 既知の行クラス(.nMcdL)があれば最優先で使う。
    //    話者名・テキストとも専用要素から取得できるため、
    //    テキストが複数のspanに分割されていても正しく結合できる。
    const knownRows = Array.from(region.querySelectorAll(ROW_SELECTOR));
    if (knownRows.length > 0) {
      return knownRows
        .map((container) => {
          const speakerEl = container.querySelector(SPEAKER_SELECTOR);
          const textEl = container.querySelector(TEXT_SELECTOR);
          const speaker = speakerEl ? speakerEl.textContent.trim() : '';
          const text = textEl ? textEl.textContent.trim() : '';
          return { el: container, speaker: speaker || '話者', text };
        })
        .filter((row) => row.text);
    }

    // 2) 行クラスは見つからないが、既知のテキストクラスは見つかる場合。
    //    テキスト要素から祖先を辿り、話者名要素も含む行コンテナを推測する。
    const knownTextEls = Array.from(region.querySelectorAll(TEXT_SELECTOR));
    if (knownTextEls.length > 0) {
      const rows = [];
      const seenContainers = new Set();
      for (const textEl of knownTextEls) {
        let container = textEl.parentElement;
        for (let depth = 0; depth < 4 && container; depth++) {
          if (container.querySelector(SPEAKER_SELECTOR)) break;
          container = container.parentElement;
        }
        container = container || textEl.parentElement || textEl;
        if (seenContainers.has(container)) continue;
        seenContainers.add(container);

        const speakerEl = container.querySelector(SPEAKER_SELECTOR);
        const speaker = speakerEl ? speakerEl.textContent.trim() : '話者';
        const text = textEl.textContent.trim();
        if (text) rows.push({ el: container, speaker, text });
      }
      return rows;
    }

    // 3) 最終フォールバック: アバター画像を含む最小の祖先divを1行とみなす
    const imgs = Array.from(region.querySelectorAll('img'));
    const containers = new Set();
    imgs.forEach((img) => {
      let el = img.parentElement;
      for (let depth = 0; depth < 4 && el; depth++) {
        if (el.textContent && el.textContent.trim().length > 0) {
          containers.add(el);
          break;
        }
        el = el.parentElement;
      }
    });

    const rowEls = containers.size > 0 ? Array.from(containers) : Array.from(region.children);

    const rows = [];
    rowEls.forEach((container, idx) => {
      const spanText = Array.from(container.querySelectorAll('span'))
        .map((s) => s.textContent.trim())
        .find(Boolean);
      const speaker = spanText || `話者${idx + 1}`;

      const textDivs = Array.from(container.querySelectorAll('div')).filter(
        (d) => d.children.length === 0 && d.textContent.trim().length > 0 && !d.querySelector('img')
      );
      let text = textDivs.length
        ? textDivs[textDivs.length - 1].textContent.trim()
        : container.textContent.trim();

      if (speaker && text.startsWith(speaker)) {
        text = text.slice(speaker.length).trim();
      }
      if (text) rows.push({ el: container, speaker, text });
    });
    return rows;
  }

  // ---------- メモの保存 ----------

  async function ensureMemoStarted() {
    if (currentMemoId) return;
    const code = getMeetingCode();
    const id = `${code}_${Date.now()}`;
    currentMemoId = id;
    const title = document.title.replace(/^Meet\s*[-–]\s*/i, '').trim() || code;
    const memo = {
      id,
      title,
      meetingCode: code,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lines: [],
    };
    const { [INDEX_KEY]: index = [] } = await storageGet(INDEX_KEY);
    index.unshift({ id, title, meetingCode: code, startedAt: memo.startedAt, lineCount: 0 });
    await storageSet({ [INDEX_KEY]: index, [MEMO_KEY_PREFIX + id]: memo });
  }

  async function commitLine(speaker, text) {
    if (!text) return;
    await ensureMemoStarted();
    const key = MEMO_KEY_PREFIX + currentMemoId;
    const got = await storageGet(key);
    const memo = got[key];
    if (!memo) return;

    const last = memo.lines[memo.lines.length - 1];
    if (last && last.speaker === speaker && last.text === text) return; // 重複防止

    const time = nowTimeLabel();
    memo.lines.push({ speaker, text, time });
    memo.updatedAt = new Date().toISOString();
    await storageSet({ [key]: memo });

    const { [INDEX_KEY]: index = [] } = await storageGet(INDEX_KEY);
    const entry = index.find((m) => m.id === currentMemoId);
    if (entry) {
      entry.lineCount = memo.lines.length;
      entry.updatedAt = memo.updatedAt;
      await storageSet({ [INDEX_KEY]: index });
    }
    updateBadge(memo.lines.length);
    syncLineToReviewMarkdown(memo, { speaker, text, time });
  }

  // ---------- review-markdown-cliへのリアルタイム連携 ----------
  // 外部サーバーへの送信は既定では行わない（README参照）。ポップアップで明示的に
  // 有効化し、サーバーURL・トークン・書き込み先パスを設定した場合だけ、確定した
  // 発言を1行ずつローカルのreview-markdown-cliサーバーへ送る。失敗しても記録
  // そのもの（chrome.storage.localへの保存）は止めない。

  async function syncLineToReviewMarkdown(memo, { speaker, text, time }) {
    if (!syncSettings || !syncSettings.enabled) return;
    const { serverUrl, token } = syncSettings;
    const targetPath = resolveTargetPath(memo);
    // 有効なのに設定が不完全な場合を「連携中」と表示しないでください。旧版では空の
    // 手動パスを保存でき、このreturnによって通信せず、成功したように見えていました。
    if (!serverUrl || !token || !targetPath) {
      lastSyncFailed = true;
      lastSyncStale = false;
      updateBadge();
      return;
    }

    try {
      const response = await fetch(`${serverUrl}/api/live-captions/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SYNC_TOKEN_HEADER]: token },
        body: JSON.stringify({
          path: targetPath,
          speaker,
          text,
          time,
          title: memo.title,
          meetingCode: memo.meetingCode,
          startedAt: memo.startedAt
        })
      });
      lastSyncFailed = !response.ok;
      // 403だけは直し方が違います（コードの貼り直し）。同じ「連携エラー」に混ぜると、
      // 立ち上げ直したせいでトークンが変わっただけなのに、原因を探すことになります。
      lastSyncStale = response.status === 403;
    } catch {
      lastSyncFailed = true;
      lastSyncStale = false;
    }
    updateBadge();
  }

  /**
   * 書き込み先のファイル。
   *
   * 「会議ごとに自動で作る」を選んだときは、会議の日付と会議コードから決めます。以前は
   * 会議のたびに手でパスを書き換える必要があり、書き換え忘れると前の会議の記録へ続きが
   * 混ざりました。日付と会議コードで分かれていれば、そのまま次の会議でも使えます。
   */
  function resolveTargetPath(memo) {
    if (!syncSettings.autoPath) return syncSettings.path || '';
    const date = (memo.startedAt || new Date().toISOString()).slice(0, 10);
    const code = safeFileName(memo.meetingCode || 'meet');
    return `meet-captions/${date}-${code}.md`;
  }

  /** パスの区切りや、ファイル名に使えない字を落とします。 */
  function safeFileName(value) {
    return String(value).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'meet';
  }

  async function flushActive() {
    for (const entry of activeEntries.values()) {
      if (!entry.committed && entry.text.trim()) {
        await commitLine(entry.speaker, entry.text.trim());
        entry.committed = true;
      }
    }
  }

  // ---------- ポーリングループ ----------
  // 字幕は音声認識の途中経過で何度も書き換わるため、
  // 一定時間(STABLE_MS)変化がなくなってから初めて「確定」として保存する。

  async function tick() {
    if (!recording) return;
    const region = findCaptionsRegion();
    if (!region) {
      await flushActive();
      activeEntries.clear();
      return;
    }

    const rows = parseRows(region);
    const seen = new Set();

    for (const { el, speaker, text } of rows) {
      const rowId = getRowId(el);
      seen.add(rowId);
      const existing = activeEntries.get(rowId);
      if (!existing) {
        activeEntries.set(rowId, { speaker, text, lastChangedAt: Date.now(), committed: false });
      } else if (existing.text !== text || existing.speaker !== speaker) {
        existing.speaker = speaker;
        existing.text = text;
        existing.lastChangedAt = Date.now();
        existing.committed = false;
      } else if (!existing.committed && Date.now() - existing.lastChangedAt >= STABLE_MS) {
        await commitLine(existing.speaker, existing.text.trim());
        existing.committed = true;
      }
    }

    for (const [rowId, entry] of Array.from(activeEntries.entries())) {
      if (!seen.has(rowId)) {
        if (!entry.committed && entry.text.trim()) {
          await commitLine(entry.speaker, entry.text.trim());
        }
        activeEntries.delete(rowId);
      }
    }
  }

  // ---------- 画面上のバッジ(状態表示・一時停止トグル) ----------
  // 自分の画面にだけ表示され、他の参加者には見えない。

  function createBadge() {
    badgeEl = document.createElement('div');
    badgeEl.id = 'meet-captions-memo-badge';
    Object.assign(badgeEl.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: 999999,
      background: '#ffffff',
      color: '#000000',
      border: '1px solid #000000',
      borderRadius: '4px',
      padding: '6px 10px',
      font: '12px sans-serif',
      cursor: 'pointer',
      userSelect: 'none',
    });
    document.body.appendChild(badgeEl);
    badgeEl.addEventListener('click', async () => {
      recording = !recording;
      await storageSet({ [SETTINGS_KEY]: { recording } });
      updateBadge();
    });
    updateBadge();
  }

  /** バッジに出す連携の状態。直し方の分かる言葉にします。 */
  function syncLabel() {
    if (lastSyncStale) return '連携コードを貼り直してください';
    return lastSyncFailed ? '連携エラー' : '連携中';
  }

  function updateBadge(lineCount) {
    if (!badgeEl) return;
    const count = typeof lineCount === 'number' ? lineCount : activeEntries.size;
    const syncSuffix = syncSettings?.enabled ? ` ・${syncLabel()}` : '';
    badgeEl.textContent = recording
      ? `字幕メモ: 記録中 (${count}行)${syncSuffix}`
      : '字幕メモ: 一時停止中(クリックで再開)';
  }

  // ---------- ポップアップからの状態取得 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'GET_STATUS') {
      sendResponse({ recording, memoId: currentMemoId, meetingCode: getMeetingCode() });
    }
  });

  // ---------- 初期化 ----------

  async function init() {
    const { [SETTINGS_KEY]: settings, [SYNC_SETTINGS_KEY]: sync } = await storageGet([
      SETTINGS_KEY,
      SYNC_SETTINGS_KEY
    ]);
    if (settings && typeof settings.recording === 'boolean') {
      recording = settings.recording;
    }
    syncSettings = sync || null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SETTINGS_KEY]) {
        recording = changes[SETTINGS_KEY].newValue?.recording ?? true;
        updateBadge();
      }
      if (changes[SYNC_SETTINGS_KEY]) {
        syncSettings = changes[SYNC_SETTINGS_KEY].newValue || null;
        lastSyncFailed = false;
        lastSyncStale = false;
        updateBadge();
      }
    });
    createBadge();
    setInterval(tick, POLL_INTERVAL_MS);
    window.addEventListener('pagehide', () => {
      flushActive();
    });
  }

  init();
})();
