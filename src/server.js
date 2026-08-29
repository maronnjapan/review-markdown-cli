import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeAiContext } from './aiContext.js';
import { createAiService } from './aiService.js';
import { sendError } from './http.js';
import { createPathFilter } from './pathFilter.js';
import { createRequestHandler } from './routes.js';

export { listMarkdownFiles } from './markdownFiles.js';

/**
 * @param {string} targetDir directory being reviewed.
 * @param {object} [options]
 *
 * レビューの設定:
 * @param {string[]} [options.include] レビュー対象に含めるグロブ。
 * @param {string[]} [options.exclude] レビュー対象から外すグロブ。
 * @param {string} [options.aiContext] 全文書に効く読み取りコンテキスト。
 * @param {object} [options.aiModels] 用途ごとのモデル指定（`config.js` の `aiModelsFromConfig`）。
 * @param {boolean} [options.manager] 資料の管理者を有効にする。既定は無効。
 * @param {boolean} [options.translation] 翻訳機能を有効にする。既定は無効。
 *
 * テストのための差し替え口:
 * @param {object} [options.aiService] AiService そのもの。渡すと下の3つは見ません。
 * @param {object} [options.aiStore] 会話と翻訳キャッシュの保存先。
 * @param {object} [options.codexClient] Codexクライアント。
 * @param {string} [options.aiDataDir] 端末側の保存ディレクトリ。
 * @param {string} [options.aiToken] AIエンドポイントのトークン。既定は起動ごとの乱数。
 */
export function createServer(targetDir = '.', options = {}) {
  const rootDir = path.resolve(targetDir);
  const filter = createPathFilter(options);
  const features = Object.freeze({
    manager: options.manager === true,
    translation: options.translation === true
  });
  const aiService = options.aiService || createAiService(rootDir, { ...options, features });
  const aiToken = options.aiToken || crypto.randomBytes(24).toString('base64url');
  // What every document under this root is read under; a document adds its own.
  const projectAiContext = normalizeAiContext(options.aiContext, 'aiContext');
  const handleRequest = createRequestHandler({ rootDir, filter, aiService, aiToken, projectAiContext, features });

  const app = {
    listen(port, callback) {
      const server = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => sendError(response, error));
      });
      server.once('close', () => aiService.close?.());
      return server.listen(port, '127.0.0.1', callback);
    }
  };
  return { app, rootDir, filter, aiService };
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
