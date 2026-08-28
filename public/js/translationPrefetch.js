/**
 * 文字を選び終えた時点で、翻訳を先に頼んでおく仕組みです。
 *
 * レビュアーが選択してから「翻訳」を押すまでには、必ず一拍あります。その一拍で
 * 頼んでおけば、押した時点で答えが出ているか、少なくとも出かかっています。
 *
 * ただし、選んだだけで押さないことのほうが多いので、押されなければ取り消します。
 * 取り消せるのは「まだ送っていないうち」だけです。送ってしまったものを中断すると、
 * その直後に押されたときに、もう一度最初から頼むことになるからです。
 *
 * @param {object} options
 * @param {string} options.key どの選択に対する先読みか。別の場所を選んだら作り直します。
 * @param {Function} options.request 実際に翻訳を頼む関数。`(signal, onEvent)` を受け取ります。
 * @param {object} options.progress 途中経過の受け取り口。`onEvent` を `request` へ渡し、
 *   押されたときに `show()` でそこまでの結果を画面へ出せるようにします。
 * @param {number} [options.delayMs] 送るまでの待ち時間。
 * @returns {{key: string, promise: Promise, progress: object, start: Function, cancel: Function}}
 *   `start()` は送り始め（2回目以降は何もしません）、`cancel()` はまだ送っていなければ
 *   取り消して true を返します。
 */
export function createTranslationPrefetch({ key, request, progress, delayMs = 0 }) {
  const controller = new AbortController();
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const prefetch = {
    key,
    promise,
    controller,
    progress,
    started: false,
    settled: false,
    timer: null,
    start() {
      if (prefetch.started || prefetch.settled || controller.signal.aborted) return;
      prefetch.started = true;
      clearTimeout(prefetch.timer);
      request(controller.signal, progress.onEvent).then(
        (event) => finish('resolve', event),
        (error) => finish('reject', error)
      );
    },
    cancel() {
      if (prefetch.started || prefetch.settled) return false;
      controller.abort();
      return true;
    }
  };

  function finish(outcome, value) {
    if (prefetch.settled) return;
    prefetch.settled = true;
    clearTimeout(prefetch.timer);
    settle[outcome](value);
  }

  // 送る前に取り消されたら、待っている側にも中止として伝えます。
  controller.signal.addEventListener('abort', () => {
    if (!prefetch.started) finish('reject', abortError());
  }, { once: true });

  prefetch.timer = setTimeout(prefetch.start, delayMs);
  return prefetch;
}

function abortError() {
  return Object.assign(new Error('翻訳を中止しました'), { name: 'AbortError' });
}
