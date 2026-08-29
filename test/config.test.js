import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/cli.js';
import {
  aiModelsFromConfig,
  applyConfigToOptions,
  globalConfigPath,
  loadConfig,
  mergeConfigs,
  normalizeConfig,
  readConfigFile
} from '../src/config.js';
import { createPathFilter } from '../src/pathFilter.js';
import { createServer, listMarkdownFiles } from '../src/server.js';

test('the config file is found by walking up from the target directory', async () => {
  const root = await seedProject({ exclude: ['drafts'] });
  const { config, sources } = await loadConfig({ targetDir: path.join(root, 'docs'), env: emptyEnv(root) });

  assert.deepEqual(config.exclude, ['drafts']);
  assert.deepEqual(sources, [path.join(root, '.review-markdown.json')]);
});

test('config exclude patterns hide the directory and everything under it', async () => {
  const root = await seedProject({ exclude: ['drafts', '**/*.wip.md'] });
  const { config } = await loadConfig({ targetDir: root, env: emptyEnv(root) });
  const filter = createPathFilter(config);

  assert.deepEqual(await listMarkdownFiles(root, filter), ['docs/guide/intro.md', 'docs/plan.md', 'README.md']);
  assert.equal(filter.matchesFile('drafts/wip.md'), false);
  assert.equal(filter.allowsDirectory('drafts'), false);
});

test('a pattern without a slash is ignored at every depth', async () => {
  const root = await seedProject({ exclude: ['drafts'] });
  await fs.mkdir(path.join(root, 'docs', 'drafts'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'drafts', 'later.md'), '# Later\n', 'utf8');

  const { config } = await loadConfig({ targetDir: root, env: emptyEnv(root) });
  assert.deepEqual(
    await listMarkdownFiles(root, createPathFilter(config)),
    ['docs/guide/intro.md', 'docs/plan.md', 'docs/plan.wip.md', 'README.md'],
    'both drafts/ and docs/drafts/ are gone'
  );
});

test('wildcards give partial matches on names and on whole subtrees', () => {
  const filter = createPathFilter({ exclude: ['*draft*', 'tmp-?', '{build,dist}'] });

  assert.equal(filter.matchesFile('book/my-draft-2.md'), false);
  assert.equal(filter.matchesFile('book/old-drafts/intro.md'), false);
  assert.equal(filter.matchesFile('tmp-1/notes.md'), false);
  assert.equal(filter.matchesFile('deep/nested/dist/readme.md'), false);
  assert.equal(filter.matchesFile('book/intro.md'), true);
});

test('the global config applies everywhere and the project config adds to it', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-home-'));
  const globalFile = path.join(home, 'review-markdown', 'config.json');
  await fs.mkdir(path.dirname(globalFile), { recursive: true });
  await fs.writeFile(globalFile, JSON.stringify({ exclude: ['node_modules'], port: 4100 }), 'utf8');

  const root = await seedProject({ exclude: ['drafts'], port: 4200 });
  const env = { XDG_CONFIG_HOME: home, HOME: home };
  const { config, sources } = await loadConfig({ targetDir: root, env, platform: 'linux' });

  assert.deepEqual(config.exclude, ['node_modules', 'drafts']);
  assert.equal(config.port, 4200, 'the project config wins for scalars');
  assert.deepEqual(sources, [globalFile, path.join(root, '.review-markdown.json')]);
});

test('command line options win over the config file, patterns are merged', async () => {
  const root = await seedProject({
    exclude: ['drafts'], port: 4200, open: true, manager: true, translation: true
  });
  const { config } = await loadConfig({ targetDir: root, env: emptyEnv(root) });

  const merged = applyConfigToOptions(parseArgs([root, '--exclude', 'tmp']), config);
  assert.deepEqual(merged.exclude, ['drafts', 'tmp']);
  assert.equal(merged.port, 4200, 'the config fills in the port nobody asked for');
  assert.equal(merged.open, true);
  assert.equal(merged.manager, true);
  assert.equal(merged.translation, true);

  const explicit = applyConfigToOptions(parseArgs([
    root, '--port', '5000', '--no-open', '--no-manager', '--no-translation'
  ]), config);
  assert.equal(explicit.port, 5000);
  assert.equal(explicit.open, false);
  assert.equal(explicit.manager, false);
  assert.equal(explicit.translation, false);
  assert.equal(applyConfigToOptions(parseArgs([root], { PORT: '5100' }), config).port, 5100, 'PORT beats the config');
});

test('the manager and translation are disabled until explicitly enabled', () => {
  const defaults = applyConfigToOptions(parseArgs(['.']), {});
  assert.equal(defaults.manager, false);
  assert.equal(defaults.translation, false);

  const flags = applyConfigToOptions(parseArgs(['.', '--enable-manager', '--enable-translation']), {});
  assert.equal(flags.manager, true);
  assert.equal(flags.translation, true);

  const { config } = normalizeConfig({ manager: 'on', translation: true });
  assert.deepEqual(config, { manager: true, translation: true });
});

test('--no-config and --config pick which file is read', async () => {
  const root = await seedProject({ exclude: ['drafts'] });
  const other = path.join(root, 'other-config.json');
  await fs.writeFile(other, JSON.stringify({ exclude: ['docs'] }), 'utf8');

  assert.deepEqual(await loadConfig({ targetDir: root, useConfig: false, env: emptyEnv(root) }), {
    config: {},
    sources: [],
    warnings: []
  });

  const picked = await loadConfig({ targetDir: root, configPath: other, env: emptyEnv(root) });
  assert.deepEqual(picked.config.exclude, ['docs']);
  await assert.rejects(
    loadConfig({ targetDir: root, configPath: path.join(root, 'missing.json'), env: emptyEnv(root) }),
    /設定ファイルが見つかりません/
  );
});

test('a broken config file is reported instead of silently ignored', async () => {
  const root = await seedProject({ exclude: ['drafts'] });
  const configFile = path.join(root, '.review-markdown.json');

  await fs.writeFile(configFile, '{ "exclude": [', 'utf8');
  await assert.rejects(readConfigFile(configFile), /JSONとして読めません/);

  await fs.writeFile(configFile, JSON.stringify({ exclude: [42] }), 'utf8');
  await assert.rejects(readConfigFile(configFile), /文字列の配列で指定してください/);

  await fs.writeFile(configFile, JSON.stringify({ port: 'abc' }), 'utf8');
  await assert.rejects(readConfigFile(configFile), /must be an integer between 1 and 65535/);

  await fs.writeFile(configFile, JSON.stringify({ exclude: ['a'], nope: 1 }), 'utf8');
  const loaded = await readConfigFile(configFile);
  assert.deepEqual(loaded.config, { exclude: ['a'] });
  assert.match(loaded.warnings[0], /不明な設定キー.*nope/);
});

test('config values are normalized the same way CLI patterns are', () => {
  const { config } = normalizeConfig({ exclude: './drafts/, notes\\private/', include: 'docs/**', open: true });

  assert.deepEqual(config.exclude, ['drafts', 'notes/private']);
  assert.deepEqual(config.include, ['docs/**']);
  assert.equal(config.open, true);
  assert.deepEqual(mergeConfigs({ exclude: ['a'] }, { exclude: ['a', 'b'], port: 1 }), { exclude: ['a', 'b'], port: 1 });
});

test('globalConfigPath follows the platform convention', () => {
  assert.equal(
    globalConfigPath({ XDG_CONFIG_HOME: '/x/config' }, 'linux'),
    path.join('/x/config', 'review-markdown', 'config.json')
  );
  assert.equal(
    globalConfigPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'),
    path.join('C:\\Users\\me\\AppData\\Roaming', 'review-markdown', 'config.json')
  );
  assert.equal(
    globalConfigPath({ REVIEW_MARKDOWN_CONFIG_HOME: '/custom' }, 'linux'),
    path.join('/custom', 'config.json')
  );
});

test('files the config file hides are refused by the API as well', async (t) => {
  const root = await seedProject({ exclude: ['drafts'] });
  const { config } = await loadConfig({ targetDir: root, env: emptyEnv(root) });
  const { app } = createServer(root, config);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listed = await fetch(`${baseUrl}/api/files`).then((response) => response.json());
  assert.deepEqual(listed.files, ['docs/guide/intro.md', 'docs/plan.md', 'docs/plan.wip.md', 'README.md']);
  assert.deepEqual(listed.filters, { include: [], exclude: ['drafts'] });
  assert.equal((await fetch(`${baseUrl}/api/file?path=drafts/wip.md`)).status, 404);
});

/** A home directory nobody wrote a global config into, so only the project file counts. */
test('the reading context comes from the config file, and the flag replaces it', async () => {
  const root = await seedProject({ aiContext: '入門書。読者は初学者。' });
  const { config } = await loadConfig({ targetDir: root, env: emptyEnv(root) });

  assert.equal(config.aiContext, '入門書。読者は初学者。');
  assert.equal(applyConfigToOptions(parseArgs([root]), config).aiContext, '入門書。読者は初学者。');
  assert.equal(
    applyConfigToOptions(parseArgs([root, '--ai-context', '社内の運用手順書。']), config).aiContext,
    '社内の運用手順書。',
    'コマンドラインの指定が設定ファイルより優先される'
  );
  assert.equal(applyConfigToOptions(parseArgs([root]), {}).aiContext, '', '未設定なら前提なしで読ませる');
});

test('an unusable reading context is refused instead of reaching the AI', async () => {
  const root = await seedProject({ aiContext: ['入門書'] });

  await assert.rejects(loadConfig({ targetDir: root, env: emptyEnv(root) }), /文字列で指定してください/);
  assert.throws(() => parseArgs(['.', '--ai-context', 'あ'.repeat(4001)]), /長すぎます/);
});

function emptyEnv(root) {
  return { XDG_CONFIG_HOME: path.join(root, 'empty-home'), HOME: path.join(root, 'empty-home') };
}

async function seedProject(config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-'));
  await fs.mkdir(path.join(root, 'docs', 'guide'), { recursive: true });
  await fs.mkdir(path.join(root, 'drafts'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Readme\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'plan.md'), '# Plan\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'guide', 'intro.md'), '# Intro\n', 'utf8');
  await fs.writeFile(path.join(root, 'drafts', 'wip.md'), '# WIP\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'plan.wip.md'), '# Plan WIP\n', 'utf8');
  if (config) await fs.writeFile(path.join(root, '.review-markdown.json'), JSON.stringify(config, null, 2), 'utf8');
  return root;
}

test('AIのモデルと推論強度を設定ファイルから決められる', async () => {
  const root = await seedProject({
    aiModel: 'gpt-5.6-luna',
    aiEffort: 'low',
    aiReviewModel: 'gpt-5.6-codex',
    aiReviewEffort: 'high'
  });
  const { config } = await loadConfig({ targetDir: root, env: {}, platform: 'linux' });

  assert.deepEqual(aiModelsFromConfig(config), {
    assistant: { model: 'gpt-5.6-luna', effort: 'low' },
    review: { model: 'gpt-5.6-codex', effort: 'high' }
  });
  // 起動時のオプションへ、そのまま乗って CodexAppServer まで届きます。
  assert.deepEqual(
    applyConfigToOptions(parseArgs([root]), config).aiModels.review,
    { model: 'gpt-5.6-codex', effort: 'high' }
  );
});

test('設定していない用途は、Codexが持っているものから自動で選ばせる', async () => {
  const root = await seedProject({ aiReviewEffort: 'high' });
  const { config } = await loadConfig({ targetDir: root, env: {}, platform: 'linux' });

  assert.deepEqual(aiModelsFromConfig(config), {
    assistant: { model: undefined, effort: undefined },
    review: { model: undefined, effort: 'high' }
  });
});

test('モデル名に空白は書けない。値を取り違えたまま起動させないため', async () => {
  const root = await seedProject({ aiModel: 'gpt 5.6 luna' });
  await assert.rejects(
    loadConfig({ targetDir: root, env: {}, platform: 'linux' }),
    /aiModel に空白は含められません/
  );
});
