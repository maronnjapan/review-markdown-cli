import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extensionDir } from '../src/extensionCommand.js';

const SYNC_SETTINGS_KEY = 'meetCaptionsMemo_liveSync';

/**
 * Meetのタブを開いた時点で繋ぎ直します。会議が始まってから探し始めると、探しているあいだの
 * 発言が落ちます。連携コードは起動のたびに変わるので、繋ぎ直す用事は毎回あります。
 */
test('Meetを開いた時点で、連携先を探してもらう', async (t) => {
  const meet = await openMeetTab(t);

  assert.deepEqual(
    meet.messages.map((message) => ({ ...message })),
    [{ type: 'REQUEST_PAIRING', force: true }]
  );
});

test('探しているあいだは、バッジにそう出す', async (t) => {
  // 答えを保留すると、探している最中の見え方をそのまま確かめられます。
  const meet = await openMeetTab(t, { answerPairing: false });

  assert.match(meet.badgeText(), /review-markdownを探しています/);

  meet.answerPairing({ ok: false, reason: 'not-found' });
  await meet.settled();
  assert.doesNotMatch(meet.badgeText(), /探しています/, '探し終わったら消える');
});

test('自動で探すのを切っていたら、Meetを開いても探しに行かない', async (t) => {
  const meet = await openMeetTab(t, { storage: { [SYNC_SETTINGS_KEY]: { autoPair: false } } });

  assert.deepEqual(meet.messages, []);
});

/* ---------------------------------------------------------------- *
 * 差し替え口
 * ---------------------------------------------------------------- */

/**
 * Meetのタブで content.js を動かします。字幕そのものは置かないので、記録は始まりません
 * （ここで確かめたいのは、繋ぎ直しの声かけだけです）。
 *
 * @param {object} t テストコンテキスト（後片付け用）。
 * @param {object} [options]
 * @param {object} [options.storage] chrome.storage.local の初期値。
 * @param {boolean} [options.answerPairing] 探した結果をすぐ返すか。falseなら保留します。
 */
async function openMeetTab(t, { storage = {}, answerPairing = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://meet.google.com/abc-defg-hij'
  });
  const { window } = dom;
  t.after(() => window.close());

  const stored = { ...storage };
  const messages = [];
  let pendingReply = null;

  window.chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const names = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(names.filter((key) => key in stored).map((key) => [key, stored[key]])));
        },
        set(values, callback) {
          Object.assign(stored, values);
          callback?.();
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        messages.push(message);
        if (answerPairing) callback({ ok: false, reason: 'not-found' });
        else pendingReply = callback;
      }
    }
  };

  window.eval(await fs.readFile(path.join(extensionDir(), 'content.js'), 'utf8'));
  await settled(window);

  return {
    messages,
    badgeText: () => window.document.getElementById('meet-captions-memo-badge').textContent,
    answerPairing: (result) => pendingReply(result),
    settled: () => settled(window)
  };
}

/** 立て続けに走るPromiseが片付くまで待ちます（content.jsの初期化は何段か非同期です）。 */
async function settled(window) {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}
