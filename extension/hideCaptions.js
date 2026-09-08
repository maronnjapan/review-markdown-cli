// hideCaptions.js
//
// 記録のために出している字幕を、画面には出しません。
//
// この拡張機能は、記録できるようにするためにMeetの字幕(CC)をオンにします
// (autoCaptions.js)。ところが字幕が出ると、Meetは画面の下側をその表示に使います。
// 共有された資料を見ているあいだは、隠れた分だけ読めなくなります。読むために出した
// 字幕ではなく、記録するために出した字幕なので、見えている必要はありません。
//
// 消すのではなく、画面の外へ出します。字幕の要素はそのまま残るので、content.js は
// これまで通り読み取れます。`display: none` で描画ごと止めないのは、止めた結果として
// 記録まで止まったときに、いちばん困るからです(字幕は公開APIではないので、描画を
// 止めたMeetが何をするかは確かめられません)。記録が止まったことに気づくのは会議が
// 終わってからで、やり直せません。
//
// Meetの要素そのものには触りません。足すのは自分の<style>1つだけで、外せば元に戻ります。
// 属性を書き換えたりDOMを動かしたりすると、Meet側の作り直しとぶつかったときに、何が
// 起きているのか見当がつかなくなります。

(() => {
  const SETTINGS_KEY = 'meetCaptionsMemo_settings';
  const STYLE_ID = 'meet-captions-memo-hide-captions';

  // 隠す相手は、content.js が字幕を探すときと同じ見方で選びます。片方だけ変えると
  // 「読めているのに見えている」「見えていないのに読めていない」がすぐ起きます。
  // クラス名は難読化されていますが表示言語には左右されないので、aria-labelを
  // 読めない言語で使っている人にも、こちらが効きます。
  const CAPTION_SELECTORS = [
    '[role="region"][aria-label*="Captions" i]',
    '[role="region"][aria-label*="字幕"]',
    '.nMcdL'
  ];

  // 画面の外への出し方。
  // - position/top/left/right/bottom …… 流れから外して、見えない場所へ移します。
  //   高さを取らなくなる(共有画面が戻る)のは、流れから外れるからです。
  // - opacity/pointer-events …… 出しきれなかったときの用心です。何かの拍子に画面へ
  //   残っても、見えず、触ってしまうこともありません。
  // Meetが要素へ直接書く指定に負けないよう、!important を付けます。
  const HIDDEN_STYLE = [
    'position: fixed !important',
    'top: 0 !important',
    'left: -20000px !important',
    'right: auto !important',
    'bottom: auto !important',
    'opacity: 0 !important',
    'pointer-events: none !important'
  ].join('; ');

  const CSS = `${CAPTION_SELECTORS.join(',\n')} {\n  ${HIDDEN_STYLE};\n}`;

  /** 設定を読めないうちは隠す側に倒します。記録のために出した字幕だからです。 */
  function hides(settings) {
    return settings?.hideCaptions !== false;
  }

  function apply(hide) {
    const existing = document.getElementById(STYLE_ID);
    if (!hide) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function start() {
    chrome.storage.local.get(SETTINGS_KEY, (stored) => {
      apply(hides(stored && stored[SETTINGS_KEY]));
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      // 字幕を読みたくなった人を、会議が終わるまで待たせません。設定を戻したその場で出します。
      apply(hides(changes[SETTINGS_KEY].newValue));
    });
  }

  // content.js と同じ分離環境で動くので、名前を1つだけ置きます。
  self.MeetCaptionsHideCaptions = { apply };

  start();
})();
