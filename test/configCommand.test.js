import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE_NAME } from '../src/config.js';
import { parseConfigArgs, runConfigCommand } from '../src/configCommand.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectDir, 'bin/markdown-review.js');

test('config init creates the project config file', async () => {
  const dir = await tempDir();
  const created = await run(['init', '--dir', dir]);

  assert.equal(created.exitCode, 0);
  assert.match(created.stdout.join('\n'), /設定ファイルを作成しました/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, CONFIG_FILE_NAME), 'utf8')), { exclude: [] });

  const again = await run(['init', '--dir', dir]);
  assert.match(again.stdout.join('\n'), /既にあります/);
});

test('config add, remove and list keep the exclude list in the config file', async () => {
  const dir = await tempDir();

  await run(['add', 'exclude', 'drafts/**', '**/*.wip.md', '--dir', dir]);
  await run(['add', 'exclude', 'tmp,archive', '--dir', dir]);
  assert.deepEqual(await readConfig(dir), { exclude: ['drafts/**', '**/*.wip.md', 'tmp', 'archive'] });

  await run(['add', 'exclude', 'tmp', '--dir', dir]);
  assert.deepEqual((await readConfig(dir)).exclude.filter((entry) => entry === 'tmp'), ['tmp'], 'no duplicates');

  await run(['remove', 'exclude', 'archive', '--dir', dir]);
  assert.deepEqual(await readConfig(dir), { exclude: ['drafts/**', '**/*.wip.md', 'tmp'] });

  const listed = await run(['list', '--dir', dir]);
  assert.match(listed.stdout.join('\n'), /exclude:\n {2}- drafts\/\*\*\n {2}- \*\*\/\*\.wip\.md\n {2}- tmp/);
  assert.match(listed.stdout.join('\n'), /include: \(未設定\)/);
});

test('config set and unset handle scalars, config get reads one key', async () => {
  const dir = await tempDir();

  await run(['set', 'port', '4300', '--dir', dir]);
  await run(['set', 'open', 'false', '--dir', dir]);
  assert.deepEqual(await readConfig(dir), { port: 4300, open: false });

  assert.deepEqual((await run(['get', 'port', '--dir', dir])).stdout, ['4300']);
  assert.deepEqual((await run(['get', 'exclude', '--dir', dir])).stdout, ['(未設定)']);
  assert.deepEqual((await run(['get', 'port', '--json', '--dir', dir])).stdout, ['4300']);

  await run(['set', 'exclude', 'drafts', 'tmp', '--dir', dir]);
  assert.deepEqual(await readConfig(dir), { exclude: ['drafts', 'tmp'], port: 4300, open: false });

  await run(['unset', 'port', '--dir', dir]);
  assert.deepEqual(await readConfig(dir), { exclude: ['drafts', 'tmp'], open: false });
});

test('config writes to the file it already found, wherever it sits above the directory', async () => {
  const dir = await tempDir();
  const nested = path.join(dir, 'docs', 'guide');
  await fs.mkdir(nested, { recursive: true });
  await run(['add', 'exclude', 'drafts', '--dir', dir]);

  const shown = await run(['path', '--dir', nested]);
  assert.deepEqual(shown.stdout, [path.join(dir, CONFIG_FILE_NAME)]);

  await run(['add', 'exclude', 'tmp', '--dir', nested]);
  assert.deepEqual(await readConfig(dir), { exclude: ['drafts', 'tmp'] });
  await assert.rejects(fs.stat(path.join(nested, CONFIG_FILE_NAME)), { code: 'ENOENT' });
});

test('--global writes the user wide config file', async () => {
  const home = await tempDir();
  const env = { REVIEW_MARKDOWN_CONFIG_HOME: home };
  const dir = await tempDir();

  await run(['add', 'exclude', 'node_modules', '--global', '--dir', dir], { env });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8')), { exclude: ['node_modules'] });
  await assert.rejects(fs.stat(path.join(dir, CONFIG_FILE_NAME)), { code: 'ENOENT' });

  const listed = await run(['list', '--json', '--dir', dir], { env });
  assert.deepEqual(JSON.parse(listed.stdout.join('\n')), { exclude: ['node_modules'] }, 'global settings apply anywhere');
});

test('config rejects unusable input instead of writing a broken file', async () => {
  const dir = await tempDir();

  assert.throws(() => parseConfigArgs(['nope']), /unknown config command: nope/);
  assert.throws(() => parseConfigArgs(['--nope']), /unknown option: --nope/);
  assert.throws(() => parseConfigArgs(['add']), /設定キーが必要です/);
  assert.throws(() => parseConfigArgs(['add', 'exclude']), /値が必要です/);
  assert.throws(() => parseConfigArgs(['list', 'exclude']), /引数を取りません/);
  assert.throws(() => parseConfigArgs(['--dir']), /--dir requires a value/);

  await assert.rejects(run(['get', 'nope', '--dir', dir]), /unknown config key: nope/);
  await assert.rejects(run(['set', 'port', 'abc', '--dir', dir]), /must be an integer/);
  await assert.rejects(run(['add', 'port', '1', '--dir', dir]), /一覧ではない/);
  await assert.rejects(fs.stat(path.join(dir, CONFIG_FILE_NAME)), { code: 'ENOENT' });
});

test('config --help explains the subcommand without touching the filesystem', async () => {
  const help = await run(['--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout.join('\n'), /Usage: review-markdown config <command>/);
  assert.deepEqual(parseConfigArgs([]).help, true);
});

test('the installed CLI honours the config file it wrote', async (t) => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'drafts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), '# Readme\n', 'utf8');
  await fs.writeFile(path.join(dir, 'drafts', 'wip.md'), '# WIP\n', 'utf8');

  const configured = await runCli(['config', 'add', 'exclude', 'drafts', '--dir', dir]);
  assert.equal(configured.code, 0, configured.stderr);

  const port = await getAvailablePort();
  const cli = spawn(process.execPath, [cliPath, dir, '--port', String(port), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
  });
  const startup = await waitForOutput(cli, 'Open http://localhost:');
  assert.match(startup, new RegExp(`config: ${escapeRegExp(path.join(dir, CONFIG_FILE_NAME))}`));
  assert.match(startup, /exclude: drafts/);

  const listed = await fetch(`http://127.0.0.1:${port}/api/files`).then((response) => response.json());
  assert.deepEqual(listed.files, ['README.md']);

  cli.kill('SIGINT');
});

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(argv, { env = {} } = {}) {
  return runConfigCommand(parseConfigArgs(argv), { env: { ...env }, platform: process.platform });
}

async function readConfig(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, CONFIG_FILE_NAME), 'utf8'));
}

function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'review-config-cmd-'));
}

function runCli(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
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
    child.once('exit', (code, signal) => reject(new Error(`CLI exited before startup (code=${code}, signal=${signal})`)));
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
