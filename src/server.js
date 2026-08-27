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
 * @param {{include?: string[], exclude?: string[], aiContext?: string}} [options]
 *   --include / --exclude globs, and the reading context AI features start from.
 */
export function createServer(targetDir = '.', options = {}) {
  const rootDir = path.resolve(targetDir);
  const filter = createPathFilter(options);
  const aiService = options.aiService || createAiService(rootDir, options);
  const aiToken = options.aiToken || crypto.randomBytes(24).toString('base64url');
  // What every document under this root is read under; a document adds its own.
  const projectAiContext = normalizeAiContext(options.aiContext, 'aiContext');
  const handleRequest = createRequestHandler({ rootDir, filter, aiService, aiToken, projectAiContext });

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
