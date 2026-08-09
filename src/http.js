import path from 'node:path';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf']
]);

export function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

export function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function sendJson(response, payload, statusCode = 200) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

export function sendBuffer(response, data, headers, headOnly) {
  response.writeHead(200, { 'Content-Length': data.length, ...headers });
  response.end(headOnly ? undefined : data);
}

export function sendError(response, error) {
  const statusCode = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
  sendJson(response, { error: error.message || 'Internal Server Error' }, statusCode);
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(httpError('Request body too large', 413));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(httpError('Invalid JSON body', 400));
      }
    });
    request.on('error', reject);
  });
}
