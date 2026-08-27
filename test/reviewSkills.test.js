import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_SELECTED_SKILLS,
  listReviewSkills,
  parseSkillFile,
  readReviewSkill,
  readReviewSkills
} from '../src/reviewSkills.js';

test('review skills come from the reviewed directory first, then from the built-in ones', async (t) => {
  const root = await testRoot(t);
  await writeSkill(root, '.claude/skills/team-review', {
    title: 'チームのレビュー観点',
    description: 'この本のレビューで毎回見る観点。',
    body: '## 手順\n\n1. 用語の統一を見る'
  });
  await writeSkill(root, '.agents/skills/agents-only-review', {
    name: 'agents-only-review',
    description: '.agents 配下に置いたスキル。',
    body: '中身'
  });

  const skills = await listReviewSkills(root);
  const ids = skills.map((skill) => skill.id);

  assert.ok(ids.includes('team-review'), '原稿と同じディレクトリのスキルが選べる');
  assert.ok(ids.includes('agents-only-review'), '.agents/skills も探索する');
  assert.ok(ids.includes('reader-fit-review'), 'スキルを置いていなくても組み込みスキルは選べる');
  assert.equal(skills.find((skill) => skill.id === 'team-review').name, 'チームのレビュー観点');
  assert.equal(skills.find((skill) => skill.id === 'team-review').source, 'project');
  assert.equal(skills.find((skill) => skill.id === 'reader-fit-review').source, 'builtin');

  const skill = await readReviewSkill(root, 'team-review');
  assert.equal(skill.description, 'この本のレビューで毎回見る観点。');
  assert.match(skill.instructions, /用語の統一/);
  assert.doesNotMatch(skill.instructions, /^---/, '前書きは本文へ混ぜない');
});

test('a project skill replaces the built-in one of the same name', async (t) => {
  const root = await testRoot(t);
  await writeSkill(root, '.claude/skills/reader-fit-review', {
    title: '自前の読み手適合レビュー',
    description: '差し替えたスキル。',
    body: '自前の手順'
  });

  const skills = await listReviewSkills(root);
  const skill = await readReviewSkill(root, 'reader-fit-review');

  assert.equal(skills.filter((entry) => entry.id === 'reader-fit-review').length, 1);
  assert.equal(skill.name, '自前の読み手適合レビュー');
  assert.equal(skill.source, 'project');
  assert.match(skill.instructions, /自前の手順/);
});

test('an unknown or path-shaped skill id is refused rather than read', async (t) => {
  const root = await testRoot(t);
  await fs.mkdir(path.join(root, 'secret'), { recursive: true });
  await fs.writeFile(path.join(root, 'secret', 'SKILL.md'), '# 秘密\n', 'utf8');

  await assert.rejects(() => readReviewSkill(root, 'missing-skill'), /レビュースキルが見つかりません/);
  await assert.rejects(() => readReviewSkill(root, '../../secret'), /レビュースキルが見つかりません/);
  await assert.rejects(() => readReviewSkill(root, ''), /レビュースキルが見つかりません/);
});

test('the front matter of a SKILL.md is read without pulling in a YAML parser', () => {
  const parsed = parseSkillFile([
    '---',
    'name: concision-review',
    'description: "端的さを見る"',
    '---',
    '',
    '# 見出し',
    '',
    '本文',
    ''
  ].join('\n'));

  assert.deepEqual(parsed.meta, { name: 'concision-review', description: '端的さを見る' });
  assert.equal(parsed.body, '# 見出し\n\n本文');

  const withoutFrontMatter = parseSkillFile('# 見出しだけ\n');
  assert.deepEqual(withoutFrontMatter.meta, {});
  assert.equal(withoutFrontMatter.body, '# 見出しだけ');
});

test('several skills load together, in the order they were chosen', async (t) => {
  const root = await testRoot(t);
  await writeSkill(root, '.claude/skills/ops-review', { name: 'ops-review', description: '当番が実行できるか', body: '# 運用' });
  await writeSkill(root, '.claude/skills/flow-review', { name: 'flow-review', description: '並びを見る', body: '# 構成' });

  const skills = await readReviewSkills(root, ['flow-review', 'ops-review']);
  assert.deepEqual(skills.map(({ id }) => id), ['flow-review', 'ops-review']);
  assert.equal(skills[0].instructions, '# 構成');

  assert.deepEqual(
    (await readReviewSkills(root, ['ops-review', 'ops-review', ' '])).map(({ id }) => id),
    ['ops-review'],
    '同じスキルを二重に選んでも1つとして扱う'
  );
  assert.deepEqual((await readReviewSkills(root, 'ops-review')).map(({ id }) => id), ['ops-review']);

  await assert.rejects(() => readReviewSkills(root, []), /1つ以上選んでください/);
  await assert.rejects(
    () => readReviewSkills(root, Array.from({ length: MAX_SELECTED_SKILLS + 1 }, (_, i) => `skill-${i}`)),
    new RegExp(`${MAX_SELECTED_SKILLS}個まで`)
  );
  await assert.rejects(() => readReviewSkills(root, ['no-such-skill']), /見つかりません/);
});

async function testRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSkill(root, relativeDir, { name, title, description, body }) {
  const dir = path.join(root, ...relativeDir.split('/'));
  await fs.mkdir(dir, { recursive: true });
  const frontMatter = [
    '---',
    name ? `name: ${name}` : '',
    title ? `title: ${title}` : '',
    `description: ${description}`,
    '---'
  ].filter(Boolean).join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), `${frontMatter}\n\n${body}\n`, 'utf8');
}
