import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extensionDir } from '../src/extensionCommand.js';

const SETTINGS_KEY = 'meetCaptionsMemo_settings';

/**
 * 字幕(CC)を押し忘れると、その会議は1行も記録されません。気づくのは終わってからで、
 * 取り返しがつきません。押す作業そのものが無くなっていることを、本物のスクリプトを
 * jsdomの上で動かして確かめます。
 */
test('会議に入っていて字幕が出ていなければ、字幕ボタンを押す', async (t) => {
  const meet = await openMeet(t, { captionButton: '字幕をオンにする' });

  assert.deepEqual(meet.clicked, ['字幕をオンにする'], '押すのは字幕のボタンだけ');
});

test('表示が英語でも押す', async (t) => {
  const meet = await openMeet(t, { captionButton: 'Turn on captions' });

  assert.deepEqual(meet.clicked, ['Turn on captions']);
});

test('すでにオンなら押さない（押すと消してしまう）', async (t) => {
  const meet = await openMeet(t, { captionButton: '字幕をオフにする' });

  assert.deepEqual(meet.clicked, []);
});

test('字幕が出ているなら押さない', async (t) => {
  const meet = await openMeet(t, { captionButton: '字幕をオンにする', captionsShowing: true });

  assert.deepEqual(meet.clicked, [], '出ているのに押すと、消してしまう');
});

test('字幕に関係のないボタンは押さない', async (t) => {
  const meet = await openMeet(t, { captionButton: '', otherButtons: ['通話から退出', 'マイクをオンにする'] });

  assert.deepEqual(meet.clicked, [], '見つからないときは黙って諦める');
});

test('会議に入っていなければ押さない', async (t) => {
  const meet = await openMeet(t, { captionButton: '字幕をオンにする', pathname: '/' });

  assert.deepEqual(meet.clicked, []);
});

test('一度オンになったら、人が消しても押し返さない', async (t) => {
  const meet = await openMeet(t, { captionButton: '字幕をオフにする' });

  // 人がMeet側で字幕を消した状態にして、見回りをもう一度回します。
  meet.setCaptionButton('字幕をオンにする');
  meet.tick();

  assert.deepEqual(meet.clicked, [], '消したのは人の意思なので、押し返さない');
});

test('押したあとは間を置く（効くまでに一拍かかる）', async (t) => {
  const meet = await openMeet(t, { captionButton: '字幕をオンにする' });

  meet.tick();
  meet.tick();

  assert.deepEqual(meet.clicked, ['字幕をオンにする'], '効いたかを見る前に押し直さない');
});

test('設定で切っていたら押さない', async (t) => {
  const meet = await openMeet(t, {
    captionButton: '字幕をオンにする',
    storage: { [SETTINGS_KEY]: { autoCaptions: false } }
  });

  assert.deepEqual(meet.clicked, [], '自分で押したい人の邪魔をしない');
});

test('設定でオンに戻したら、次の見回りを待たずに押す', async (t) => {
  const meet = await openMeet(t, {
    captionButton: '字幕をオンにする',
    storage: { [SETTINGS_KEY]: { autoCaptions: false } }
  });
  assert.deepEqual(meet.clicked, []);

  meet.changeSettings({ autoCaptions: true });

  assert.deepEqual(meet.clicked, ['字幕をオンにする']);
});

/* ---------------------------------------------------------------- *
 * 差し替え口
 * ---------------------------------------------------------------- */

/**
 * Meetの画面を最小限だけ作り、本物の autoCaptions.js をその上で動かします。
 *
 * @param {object} t テストコンテキスト（後片付け用）。
 * @param {object} [options]
 * @param {string} [options.captionButton] 字幕ボタンのラベル。空文字なら字幕ボタン自体を置きません。
 * @param {string[]} [options.otherButtons] 一緒に並んでいる、字幕とは関係のないボタン。
 * @param {boolean} [options.captionsShowing] 画面に字幕が出ている状態にする。
 * @param {string} [options.pathname] Meetのパス。既定は会議中のURL。
 * @param {object} [options.storage] chrome.storage.local の初期値。
 */
async function openMeet(t, {
  captionButton = '',
  otherButtons = [],
  captionsShowing = false,
  pathname = '/abc-defg-hij',
  storage = {}
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: `https://meet.google.com${pathname}`
  });
  const { window } = dom;
  const { document } = window;
  t.after(() => window.close());

  const clicked = [];
  const addButton = (label) => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => clicked.push(label));
    document.body.appendChild(button);
    return button;
  };

  for (const label of otherButtons) addButton(label);
  let toggle = captionButton ? addButton(captionButton) : null;

  if (captionsShowing) {
    const region = document.createElement('div');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Captions');
    document.body.appendChild(region);
  }

  const stored = { ...storage };
  let onChanged;
  window.chrome = {
    storage: {
      local: {
        get(key, callback) {
          callback(key in stored ? { [key]: stored[key] } : {});
        }
      },
      onChanged: { addListener(fn) { onChanged = fn; } }
    }
  };

  window.eval(await fs.readFile(path.join(extensionDir(), 'autoCaptions.js'), 'utf8'));

  return {
    clicked,
    document,
    tick: () => window.MeetCaptionsAutoCaptions.tick(),
    /** Meet側でボタンの向きが変わった状態にします（人が字幕を消した、など）。 */
    setCaptionButton(label) {
      if (toggle) toggle.remove();
      toggle = addButton(label);
    },
    /** ポップアップから設定を変えたときと同じ知らせ方をします。 */
    changeSettings(values) {
      stored[SETTINGS_KEY] = { ...stored[SETTINGS_KEY], ...values };
      onChanged({ [SETTINGS_KEY]: { newValue: stored[SETTINGS_KEY] } }, 'local');
    }
  };
}
