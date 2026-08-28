/**
 * AIへ1回頼むときの、毎回同じ段取りです。
 *
 * 指摘の配置・読み手ペルソナの組み立て・AIレビューは、どれも次の順で動きます。
 *
 *   1. 走っている最中なら、二重に頼まない
 *   2. Codexが使えるか確かめる。使えなければ、その理由を画面へ出して終わる
 *   3. いま開いている文書を覚えておく
 *   4. 画面の内容を先に保存する（AIは保存済みの前提とコメントを読むので）
 *   5. 中断できるように AbortController を持つ
 *   6. 返ってきたら、まだ同じ文書を開いているときだけ画面へ反映する
 *   7. 中断は失敗ではないので、エラーとしては扱わない
 *
 * 6番と7番が要点です。返事を待っている間にレビュアーが別の文書へ移ることがあり、
 * そこで前の文書の結果を書き込むと、開いている文書と画面の中身が食い違います。
 *
 * @param {object} options
 * @param {string} options.controllerKey `state` のどこに AbortController を置くか。
 * @param {Function} options.run ({ documentPath, signal }) で実際の呼び出しを行います。
 * @param {Function} options.onStart Codexを確かめる前の画面。待ちの表示を先に出す機能が使います。
 * @param {Function} options.onPrepared Codexが使えると分かった後の画面。待ちの表示を
 *   起動の成否が分かってから出す機能が使います（読み手ペルソナ）。
 * @param {Function} options.onResult 結果を画面へ反映します。文書が変わっていれば呼びません。
 * @param {Function} options.onUnavailable Codexが使えないとき。
 * @param {Function} options.onAbort 中断されたとき。省略すると何もしません。
 * @param {Function} options.onError 失敗したとき。
 * @param {Function} options.onSettled 頼んだあとの後始末。中断でも失敗でも呼びます。
 *   ただしCodexが使えずに頼めなかったときは呼びません（後始末する対象が無いので）。
 */
export async function runAiRequest({
  state,
  prepareAi,
  flushComments = async () => true,
  controllerKey,
  run,
  onStart = () => {},
  onPrepared = () => {},
  onResult,
  onUnavailable,
  onAbort = () => {},
  onError,
  onSettled = () => {}
}) {
  if (!state.currentPath || state[controllerKey]) return;

  onStart();
  if (!(await prepareAi())) {
    onUnavailable(state.aiStatus?.error || 'Codexを利用できません');
    return;
  }

  const documentPath = state.currentPath;
  const controller = new AbortController();
  state[controllerKey] = controller;
  onPrepared();
  try {
    // AIは保存済みの読み取りコンテキストとコメントを読むので、先に画面の内容を保存します。
    await flushComments();
    const result = await run({ documentPath, signal: controller.signal });
    // 待っている間に別の文書へ移っていたら、その結果はもう画面のものではありません。
    if (state.currentPath === documentPath) onResult(result);
  } catch (error) {
    if (state.currentPath !== documentPath) return;
    if (error.name === 'AbortError') onAbort();
    else onError(error);
  } finally {
    if (state[controllerKey] === controller) state[controllerKey] = null;
    onSettled();
  }
}
