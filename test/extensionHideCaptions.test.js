import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extensionDir } from '../src/extensionCommand.js';

const SETTINGS_KEY = 'meetCaptionsMemo_settings';

/**
 * 記録のためにオンにした字幕が画面に出ていると、共有された資料はその分だけ隠れます。
 * 読むために出した字幕ではないので、画面からは外します。外しても記録が続くことまでを
 * 込みで、本物のスクリプトをjsdomの上で動かして確かめます。
 */
test('字幕は画面の場所を取らない（共有画面が隠れない）', async (t) => {
  const meet = await openMeet(t);

  const captions = meet.style(meet.captionsRegion());
  assert.equal(captions.position, 'fixed', '流れから外さないと、その分だけ画面が縮む');
  assert.equal(captions.left, '-20000px', '見えない場所へ出す');
  assert.equal(captions.opacity, '0', '出しきれなくても見えない');
  assert.equal(captions.pointerEvents, 'none', '見えないものを触ってしまわない');
});

/**
 * 字幕そのものを流れから外しても、Meetが字幕のために作った箱が残っていれば、その高さは
 * 残ります。文字だけが消えて、共有された資料は狭いままです。箱ごと外します。
 */
test('字幕を入れている箱も、画面の場所を取らない（高さが残らない）', async (t) => {
  const meet = await openMeet(t);

  assert.equal(
    meet.style(meet.captionsBox()).position,
    'fixed',
    '箱が流れに残ると、文字は消えても高さは残る'
  );
});

/**
 * 箱は名前ではなく「中に字幕が入っていること」で選びます。選びすぎれば会議の画面ごと
 * 畳んでしまうので、字幕以外のものが入っている箱には触りません。
 */
test('映像や操作ボタンが入っている箱は縮めない', async (t) => {
  const meet = await openMeet(t);

  for (const part of meet.meetingParts()) {
    assert.equal(meet.style(part).position, 'static', `${part.id} は会議の画面そのもの`);
  }
});

/**
 * 箱を中身で選ぶ以上、選びすぎることはあり得ます。巻き込む先がページそのものだと、
 * 会議の画面ごと消えて戻せません。字幕しか無い画面でも、そこまでは広がらないことを見ます。
 */
test('選びすぎても、ページそのものは畳まない', async (t) => {
  const meet = await openMeet(t, { bare: true });

  for (const element of [meet.document.body, meet.document.documentElement]) {
    assert.equal(meet.style(element).position, 'static');
  }
});

test('aria-labelを読めない表示言語でも、字幕は画面から外れる', async (t) => {
  // Meetの表示言語を変えるとaria-labelは変わりますが、行のクラス名は変わりません。
  const meet = await openMeet(t, { regionLabel: 'Sous-titres' });

  assert.equal(meet.style(meet.captionRow()).position, 'fixed');
  assert.equal(meet.style(meet.captionsRegion()).position, 'fixed', '字幕領域は中身から見つける');
  assert.equal(meet.style(meet.captionsBox()).position, 'fixed', '入れている箱も同じように外れる');
});

test('隠していても、発言は記録される', async (t) => {
  const meet = await openMeet(t, { withRecorder: true });

  const line = await meet.firstRecordedLine();
  assert.equal(line.speaker, '佐藤');
  assert.equal(line.text, '来週の予定を決めましょう', '画面から外しても、読み取りは続く');
});

test('設定で切っていれば、字幕はこれまで通り出る', async (t) => {
  const meet = await openMeet(t, { storage: { [SETTINGS_KEY]: { hideCaptions: false } } });

  assert.equal(meet.style(meet.captionsRegion()).position, 'static', '字幕を読みたい人の邪魔をしない');
});

test('設定を戻したら、次の会議を待たずにその場で出る', async (t) => {
  const meet = await openMeet(t);
  assert.equal(meet.style(meet.captionsRegion()).position, 'fixed');

  meet.changeSettings({ hideCaptions: false });
  assert.equal(meet.style(meet.captionsRegion()).position, 'static');

  meet.changeSettings({ hideCaptions: true });
  assert.equal(meet.style(meet.captionsRegion()).position, 'fixed', '切り替えは何度でも効く');
});

/**
 * 隠すのはCSSだけで、Meetの要素には触りません。属性を書き換えたりDOMを動かしたりすると、
 * Meet側の作り直しとぶつかったときに、何が起きているのか見当がつかなくなります。
 */
test('Meetの要素そのものには触らない', async (t) => {
  const meet = await openMeet(t);

  const region = meet.captionsRegion();
  assert.equal(region.getAttribute('aria-hidden'), null);
  assert.equal(region.hasAttribute('hidden'), false);
  assert.equal(region.getAttribute('style'), null, '要素へ直接書かない（外せば元に戻る）');
  assert.equal(region.parentElement, meet.captionsBox(), 'DOMの場所も動かさない');
  assert.match(region.textContent, /来週の予定を決めましょう/);
});

/* ---------------------------------------------------------------- *
 * 差し替え口
 * ---------------------------------------------------------------- */

/**
 * 字幕が出ているMeetの画面を最小限だけ作り、本物の hideCaptions.js をその上で動かします。
 *
 * @param {object} t テストコンテキスト（後片付け用）。
 * @param {object} [options]
 * @param {string} [options.regionLabel] 字幕領域のaria-label（表示言語で変わります）。
 * @param {object} [options.storage] chrome.storage.local の初期値。
 * @param {boolean} [options.withRecorder] content.js も一緒に動かして、記録まで見る。
 * @param {boolean} [options.bare] 字幕のほかに何も無い画面にする（巻き込む範囲を見る用）。
 */
async function openMeet(t, { regionLabel = 'Captions', storage = {}, withRecorder = false, bare = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://meet.google.com/abc-defg-hij'
  });
  const { window } = dom;
  const { document } = window;
  t.after(() => window.close());

  const captions = `
    <div role="region" aria-label="${regionLabel}">
      <div id="captions-scroll">
        <div class="nMcdL">
          <div class="NWpY1d">佐藤</div>
          <div class="ygicle">来週の予定を決めましょう</div>
        </div>
      </div>
    </div>
  `;

  // Meetは字幕そのものだけでなく、その外側にも箱を作って画面の下側をそこへ譲ります。
  // 字幕だけを外しても箱の高さは残るので、会議の画面（映像・操作ボタン）と並べて置き、
  // 「字幕の箱は畳む・会議の画面は畳まない」の両方を見られるようにします。
  document.body.innerHTML = bare
    ? captions
    : `
    <div id="layout">
      <div id="video-area"><video></video></div>
      <div id="captions-box">${captions}</div>
      <div id="controls"><button>マイク</button></div>
    </div>
  `;

  const stored = { ...storage };
  const listeners = [];
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
      onChanged: { addListener: (fn) => listeners.push(fn) }
    },
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      // 連携先を探すのはこの確認の対象ではありません。見つからなかったことにします。
      sendMessage: (_message, callback) => callback({ ok: false, reason: 'not-found' })
    }
  };

  const directory = extensionDir();
  const files = withRecorder ? ['hideCaptions.js', 'content.js'] : ['hideCaptions.js'];
  for (const file of files) {
    window.eval(await fs.readFile(path.join(directory, file), 'utf8'));
  }
  await settled(window);

  return {
    document,
    captionsRegion: () => document.querySelector('[role="region"]'),
    captionRow: () => document.querySelector('.nMcdL'),
    /** Meetが字幕のために作る箱（名前は難読化されていて当てにできない側）。 */
    captionsBox: () => document.getElementById('captions-box'),
    /** 会議の画面。字幕を外すために縮めてはいけないもの。 */
    meetingParts: () => ['layout', 'video-area', 'controls'].map((id) => document.getElementById(id)),
    style: (element) => window.getComputedStyle(element),
    /** ポップアップから設定を変えたときと同じ知らせ方をします。 */
    changeSettings(values) {
      stored[SETTINGS_KEY] = { ...stored[SETTINGS_KEY], ...values };
      for (const listener of listeners) {
        listener({ [SETTINGS_KEY]: { newValue: stored[SETTINGS_KEY] } }, 'local');
      }
    },
    /**
     * 記録された最初の1行。字幕は「しばらく変わらなければ確定」なので、確定を待ちます
     * （content.js の STABLE_MS）。
     */
    async firstRecordedLine() {
      const memoKey = () => Object.keys(stored).find((key) => key.startsWith('meetCaptionsMemo_memo_'));
      await waitFor(() => stored[memoKey()]?.lines?.length > 0, 5000);
      const [line] = stored[memoKey()].lines;
      return { speaker: line.speaker, text: line.text };
    }
  };
}

/** 立て続けに走るPromiseが片付くまで待ちます（初期化は何段か非同期です）。 */
async function settled(window) {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the caption to be recorded');
}
