import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeAiContext } from './aiContext.js';
import { createAiService } from './aiService.js';
import { sendError } from './http.js';
import { createPathFilter } from './pathFilter.js';
import { createRequestHandler } from './routes.js';
import { createSettings, settingsFromOptions } from './settings.js';

export { listMarkdownFiles } from './markdownFiles.js';

/**
 * @param {string} targetDir directory being reviewed.
 * @param {object} [options]
 *
 * レビューの設定:
 * @param {string[]} [options.include] レビュー対象に含めるグロブ。
 * @param {string[]} [options.exclude] レビュー対象から外すグロブ。
 * @param {string} [options.aiContext] 全文書に効く読み取りコンテキスト。
 * @param {string} [options.aiProvider] どのAIで走らせるか（`codex` / `claude` / `langchain`）。
 * @param {string} [options.aiModelProvider] LangChainのプロバイダ名（`aiProvider` が `langchain` のときだけ）。
 * @param {object} [options.aiModels] 用途ごとのモデル指定（`config.js` の `aiModelsFromConfig`）。
 * @param {boolean} [options.manager] 資料の管理者を有効にする。既定は無効。
 * @param {boolean} [options.translation] 翻訳機能を有効にする。既定は無効。既定値であって、
 *   画面の設定から入り切りできます（`src/settings.js`）。
 * @param {object} [options.settingsFile] 画面から変えた設定の保存先（`createSettingsFile`）。
 *   渡さないと、変更は今回の起動のあいだだけ効きます。
 *
 * テストのための差し替え口:
 * @param {object} [options.aiService] AiService そのもの。渡すと下の3つは見ません。
 * @param {object} [options.aiStore] 会話と翻訳キャッシュの保存先。
 * @param {object} [options.aiClient] AIクライアント。渡すと `aiProvider` は見ません。
 * @param {string} [options.aiDataDir] 端末側の保存ディレクトリ。
 * @param {string} [options.aiToken] AIエンドポイントのトークン。既定は起動ごとの乱数。
 */
export function createServer(targetDir = '.', options = {}) {
  const rootDir = path.resolve(targetDir);
  const filter = createPathFilter(options);
  // 起動時の値を起点に、画面から変えられるぶんだけを持ちます。ルートは要求のたびに
  // ここを読むので、翻訳機能の入り切りは立ち上げ直さなくても次の要求から効きます。
  const settings = createSettings({
    values: settingsFromOptions(options),
    manager: options.manager === true,
    file: options.settingsFile || null
  });
  const aiService = options.aiService
    || createAiService(rootDir, { ...options, features: settings.features });
  const aiToken = options.aiToken || crypto.randomBytes(24).toString('base64url');
  // Meet Captions Memoなど、この画面と同一オリジンではない呼び出し元向けの別トークン。
  // aiTokenと分けているのは、AI機能のオリジン制限（同一オリジンのみ）をこの用途には
  // 適用できないためです（`src/routes.js` の `appendLiveCaption` を参照）。
  const liveCaptionsToken = options.liveCaptionsToken || crypto.randomBytes(24).toString('base64url');
  // What every document under this root is read under; a document adds its own.
  const projectAiContext = normalizeAiContext(options.aiContext, 'aiContext');
  const handleRequest = createRequestHandler({
    rootDir, filter, aiService, aiToken, liveCaptionsToken, projectAiContext, settings
  });

  const app = {
    listen(port, callback) {
      const server = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => sendError(response, error));
      });
      server.once('close', () => aiService.close?.());
      return server.listen(port, '127.0.0.1', callback);
    }
  };
  return { app, rootDir, filter, aiService, settings, liveCaptionsToken };
}

/**
 * Starts the app on the preferred port, moving upward until a port is free.
 * If the search reaches the end of the valid port range, let the OS choose an
 * available ephemeral port.
 */
export async function listenOnAvailablePort(app, preferredPort) {
  let port = preferredPort;

  while (true) {
    try {
      const server = await listen(app, port);
      return { server, port: server.address().port };
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port === 0) throw error;
      port = port < 65535 ? port + 1 : 0;
    }
  }
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);

    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
