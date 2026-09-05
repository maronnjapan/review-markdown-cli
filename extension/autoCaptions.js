// autoCaptions.js
//
// 会議に入ったら、Meetの字幕(CC)を自動でオンにします。
//
// この拡張機能が記録できるのは、字幕が出ているあいだだけです。オンにするのを忘れると、
// 会議は普通に進み、終わってからファイルが空だと気づきます。取り返しがつかない忘れ方
// なので、押す作業そのものを無くします。
//
// 押すのはMeetの字幕ボタンです。公開APIではないので、Google側のUI変更で見つからなく
// なることがあります。そのときは何も押さずに黙って諦めます（誤って別のボタンを押すと、
// 会議から抜けるなど取り返しのつかないことが起きるため、確信が持てないものは押しません）。
//
// content.js より先に読み込みます。字幕が出るより前にオンにしておけば、最初の一言から
// 記録できます。

(() => {
  const SETTINGS_KEY = 'meetCaptionsMemo_settings';

  const CHECK_INTERVAL_MS = 1500;
  /** 押したあと、効いたかどうかを見るまでの待ち時間。Meetの反応は一拍遅れます。 */
  const CLICK_COOLDOWN_MS = 5000;
  /** 1つの会議で押す回数の上限。効かないものを押し続けても、切り替えを繰り返すだけです。 */
  const MAX_CLICKS = 2;

  // ボタンの見分け方。Meetは表示言語でラベルが変わるので、日本語と英語の両方を見ます。
  // 「オフにする」と書いてあるボタンは、いまオンだという意味なので押しません。
  const TURN_ON_LABEL = /字幕をオン|キャプションをオン|turn on (?:captions|subtitles)/i;
  const TURN_OFF_LABEL = /字幕をオフ|キャプションをオフ|turn off (?:captions|subtitles)/i;
  const CAPTION_WORD = /字幕|キャプション|caption|subtitle/i;
  /** 表示言語に左右されない手掛かり。字幕ボタンのアイコン名です。 */
  const OFF_ICON = 'closed_caption_off';

  // 字幕が出ているかどうかは、字幕そのものを探して決めます（content.js と同じ見方です）。
  const CAPTIONS_REGION = '[role="region"][aria-label*="Captions" i], [role="region"][aria-label*="字幕"]';
  const CAPTION_ROW = '.nMcdL, .ygicle, .iTTPOb';

  let enabled = true;
  let meetingKey = '';
  let clicks = 0;
  /** 一度でも字幕が出たら、そこで終わりにします。人が消したものを押し返さないためです。 */
  let satisfied = false;
  let lastClickAt = 0;

  function inMeeting() {
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(location.pathname);
  }

  /** 会議が変わったら、数えていたものを戻します。同じタブで次の会議に入る使い方があります。 */
  function syncMeeting() {
    if (meetingKey === location.pathname) return;
    meetingKey = location.pathname;
    clicks = 0;
    satisfied = false;
    lastClickAt = 0;
  }

  /**
   * 押せる見込みのあるボタン。
   *
   * 見えているかどうかは、大きさではなくDOMの申告で決めます。Meetは開いていないメニューも
   * DOMに置いたままにするので、隠していると書いてあるものは外します。位置や大きさで
   * 絞らないのは、レイアウトの計算はブラウザの都合で変わるものだからです。
   */
  function usableControls() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).filter((element) => (
      !element.hidden
      && element.disabled !== true
      && element.getAttribute('aria-disabled') !== 'true'
      && !element.closest('[aria-hidden="true"], [hidden]')
    ));
  }

  /** ボタンが名乗っている名前。aria-labelが基本で、ツールチップも見ます。 */
  function labelOf(element) {
    const tooltipId = element.getAttribute('data-tooltip-id');
    const tooltip = tooltipId ? document.getElementById(tooltipId) : null;
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('data-tooltip'),
      tooltip ? tooltip.textContent : ''
    ].filter(Boolean).join(' ');
  }

  /** ボタンの中のアイコン名（`closed_caption_off` など）。 */
  function iconOf(element) {
    return Array.from(element.querySelectorAll('i'))
      .map((icon) => icon.textContent.trim())
      .find(Boolean) || '';
  }

  /**
   * 字幕ボタンが、いまどちらを向いているか。
   * 'off' …… 押せばオンになる／'on' …… すでにオン／'' …… 字幕のボタンではない、決められない
   */
  function captionState(element) {
    const label = labelOf(element);
    if (TURN_OFF_LABEL.test(label)) return 'on';
    if (TURN_ON_LABEL.test(label)) return 'off';
    // ここから先は、ラベルが読めない表示言語のための予備の手掛かりです。字幕のボタンだと
    // 分かるものだけを見ます（無関係なボタンをアイコン名だけで押さないため）。
    if (!CAPTION_WORD.test(label)) return '';
    const pressed = element.getAttribute('aria-pressed');
    if (pressed === 'true') return 'on';
    if (pressed === 'false') return 'off';
    return iconOf(element) === OFF_ICON ? 'off' : '';
  }

  function captionsAreOn() {
    if (document.querySelector(CAPTIONS_REGION) || document.querySelector(CAPTION_ROW)) return true;
    return usableControls().some((element) => captionState(element) === 'on');
  }

  function findTurnOnButton() {
    return usableControls().find((element) => captionState(element) === 'off') || null;
  }

  function tick() {
    if (!enabled) return;
    syncMeeting();
    if (!inMeeting() || satisfied) return;
    if (captionsAreOn()) {
      satisfied = true;
      return;
    }
    if (clicks >= MAX_CLICKS || Date.now() - lastClickAt < CLICK_COOLDOWN_MS) return;

    const button = findTurnOnButton();
    // 見つからないうちは待ちます（会議前の待機画面には字幕ボタンがありません）。
    // 待っただけでは回数を使いません。使うのは実際に押したときだけです。
    if (!button) return;
    button.click();
    clicks += 1;
    lastClickAt = Date.now();
  }

  function applySettings(settings) {
    enabled = settings?.autoCaptions !== false;
  }

  function start() {
    chrome.storage.local.get(SETTINGS_KEY, (stored) => {
      applySettings(stored && stored[SETTINGS_KEY]);
      tick();
      setInterval(tick, CHECK_INTERVAL_MS);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      applySettings(changes[SETTINGS_KEY].newValue);
      // 設定でオンにした人を、次の見回りまで待たせません。
      tick();
    });
  }

  // content.js と同じ分離環境で動くので、名前を1つだけ置きます。見回りを外から1回だけ
  // 回せるようにしてあるのは、時間を進めずに動きを確かめられるようにするためです。
  self.MeetCaptionsAutoCaptions = { tick };

  start();
})();
