/**
 * Context APIが使うディレクトリです。
 *
 * CLIのデータディレクトリ（`src/aiStore.js` の `defaultAiDataDir`）とは別に決めます。
 * 同じ端末の中の話なので隣に置いてもよいのですが、置き場所まで共有すると、CLI側の
 * 都合でデータの場所が動いたときに、保存済みのContextが行方不明になります。
 * Context APIはCLIから切り離してあるので、置き場所も自分で決めます（仕様3.2）。
 */

import os from 'node:os';
import path from 'node:path';

/** Contextの正本と索引の置き場所。`REVIEW_MARKDOWN_CONTEXT_DIR` で移せます。 */
export function defaultContextDataDir(env = process.env, platform = process.platform) {
  if (env.REVIEW_MARKDOWN_CONTEXT_DIR) return path.resolve(env.REVIEW_MARKDOWN_CONTEXT_DIR);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'review-markdown', 'context');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'review-markdown', 'context');
  }
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'review-markdown', 'context');
}
