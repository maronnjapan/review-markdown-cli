import http from 'node:http';
import path from 'node:path';
import { sendError } from './http.js';
import { createPathFilter } from './pathFilter.js';
import { createRequestHandler } from './routes.js';

export { listMarkdownFiles } from './markdownFiles.js';

/**
 * @param {string} targetDir directory being reviewed.
 * @param {{include?: string[], exclude?: string[]}} [options] --include / --exclude globs.
 */
export function createServer(targetDir = '.', options = {}) {
  const rootDir = path.resolve(targetDir);
  const filter = createPathFilter(options);
  const handleRequest = createRequestHandler({ rootDir, filter });

  const app = {
    listen(port, callback) {
      const server = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => sendError(response, error));
      });
      return server.listen(port, callback);
    }
  };
  return { app, rootDir, filter };
}
