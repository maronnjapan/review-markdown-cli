import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectDir, 'bin/markdown-review.js');

test('uses an available port when the requested port is already in use', async (t) => {
  const blocker = net.createServer();
  await listen(blocker, 0);
  const requestedPort = blocker.address().port;
  t.after(() => blocker.close());

  const cli = spawn(process.execPath, [cliPath, projectDir, '--port', String(requestedPort), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
  });

  const output = await waitForOutput(cli, 'Open http://localhost:');
  const match = output.match(new RegExp(`Port ${requestedPort} is already in use; using (\\d+) instead\\.`));
  assert.ok(match, output);

  const selectedPort = Number(match[1]);
  assert.notEqual(selectedPort, requestedPort);
  assert.match(output, new RegExp(`Open http://localhost:${selectedPort}`));

  const response = await fetch(`http://127.0.0.1:${selectedPort}`);
  assert.equal(response.status, 200);

  const exited = waitForExit(cli);
  cli.kill('SIGINT');
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test('SIGINT exits promptly even while a request is still active', async (t) => {
  const port = await getAvailablePort();
  const cli = spawn(process.execPath, [cliPath, projectDir, '--port', String(port), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  cli.stderr.setEncoding('utf8');
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  t.after(() => {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
  });

  await waitForOutput(cli, `Open http://localhost:${port}`);

  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  await new Promise((resolve, reject) => {
    socket.write([
      'POST /api/review HTTP/1.1',
      `Host: localhost:${port}`,
      'Content-Type: application/json',
      'Content-Length: 100',
      '',
      '{'
    ].join('\r\n'), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const exited = waitForExit(cli);
  cli.kill('SIGINT');
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('CLI did not exit within 1 second')), 1000))
  ]);

  assert.deepEqual(result, { code: 0, signal: null }, stderr);
});

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes(expected)) resolve(stdout);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`CLI exited before startup (code=${code}, signal=${signal})`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
