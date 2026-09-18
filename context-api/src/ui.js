/**
 * 画面（Notion風のアプリ）の静的ファイルを配るところです。
 *
 * ── 同じプロセスから配る理由 ───────────────────────────
 * 画面は `public/` にある素のHTMLとJavaScriptで、ビルドを持ちません。別のサーバを
 * 立てて配ると、使い始めるのに2つのプロセスとCORSの設定が要ります。このサービスは
 * `docker compose up` の1回で使い始められることを大事にしているので、同じ口から配ります。
 *
 * ── 画面はAPIの「一利用者」でしかない ─────────────────────
 * 画面が使うのは、外部のツールにも公開しているHTTPの口だけです。画面のためだけの
 * 道や、画面だけが通れる近道は作りません。こうしておくと、画面を別の場所へ移すことに
 * なっても、サーバ側を直さずに済みます。`CONTEXT_API_UI=off` にすると配りません。
 *
 * ── 配るのは `/` と `/ui/` の下だけ ────────────────────
 * APIの口（`/contexts`, `/pages` など）と同じ場所にファイルを置くと、どちらが答えるかが
 * ファイルの有無で変わります。画面の入口は `/`、部品は `/ui/...` に固定します。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from './http.js';

const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8']
]);

export function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

/**
 * @param {object} [options]
 * @param {string} [options.publicDir] 配るディレクトリ。既定は `context-api/public`。
 */
export function createUiServer({ publicDir = DEFAULT_PUBLIC_DIR } = {}) {
  const root = path.resolve(publicDir);

  /** 配れる道かどうか。`/` と `/ui/...` だけです。 */
  function resolvePath(pathname) {
    if (pathname === '/' || pathname === '/index.html') return path.join(root, 'index.html');
    if (!pathname.startsWith('/ui/')) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname.slice('/ui/'.length));
    } catch {
      throw httpError('Invalid static path', 400);
    }
    const filePath = path.resolve(root, decoded);
    const relative = path.relative(root, filePath);
    // `..` で外へ出ようとしたものは、無いものとして扱います。
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw httpError('Not found', 404);
    return filePath;
  }

  return {
    publicDir: root,

    /** その道を画面が受け持つかどうか。受け持たない道はAPIの404です。 */
    handles(pathname) {
      return pathname === '/' || pathname === '/index.html' || pathname.startsWith('/ui/');
    },

    /**
     * @param {string} pathname
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    async serve(pathname, request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw httpError('Method not allowed', 405);
      const filePath = resolvePath(pathname);
      if (!filePath) throw httpError('Not found', 404);
      let data;
      let stat;
      try {
        [data, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') throw httpError('Not found', 404);
        throw error;
      }
      // 変わったかどうかだけをブラウザに確かめさせます。画面を直したのに古いままで動く、を避けるためです。
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': contentTypeFor(filePath),
        'Cache-Control': 'no-cache',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff'
      };
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
    }
  };
}
