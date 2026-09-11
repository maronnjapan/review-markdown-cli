/**
 * HTTPのごく薄い道具です。
 *
 * CLI側（`src/http.js`）にも似たものがありますが、共有しません。このサービスは
 * CLIとは別に動き、別に配れるものなので、CLIのファイルを1つでも読みに行くと、
 * 「別プロセスで動かせる」が「同じリポジトリを丸ごと置かないと動かせない」に変わります。
 * 30行ぶんの重複で、その独立を買っています。
 */

export function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function sendJson(response, payload, statusCode = 200) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

export function sendError(response, error) {
  const statusCode = error.statusCode || 500;
  sendJson(response, { error: error.message || 'Internal Server Error' }, statusCode);
}

/** 受け取る本文の上限。Contextの本文は8000文字までなので、これで十分に余ります。 */
const MAX_BODY_BYTES = 1024 * 1024;

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
