import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * レビュースキルは「この原稿を何の観点で読むか」を書いた Markdown です。
 *
 * 1ディレクトリ1スキルで、`SKILL.md` の先頭に name と description を書きます。
 * 探索先は次の3か所で、先に見つかったものが同じ id のスキルより優先します。
 *
 *   1. レビュー対象ディレクトリの `.claude/skills`
 *   2. レビュー対象ディレクトリの `.agents/skills`
 *   3. このパッケージへ同梱した `skills`（組み込みスキル）
 *
 * つまり、原稿と同じリポジトリに置いたスキルが常に勝ちます。同じ id で置き直せば
 * 組み込みスキルの内容も差し替えられます。
 */

export const SKILL_FILE_NAME = 'SKILL.md';
/** プロンプトへ載せる本文の上限。これを超えたスキルは末尾を落とします。 */
export const MAX_SKILL_INSTRUCTION_CHARS = 12_000;
/**
 * 一度に使えるスキルの数。観点を増やすほど1件あたりの読みは浅くなるので、
 * 「同時に持てる観点」として現実的なところで止めます。
 */
export const MAX_SELECTED_SKILLS = 5;

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PROJECT_SKILL_DIRS = ['.claude/skills', '.agents/skills'];
const BUILTIN_SKILL_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

/**
 * 選べるスキルの一覧。読めないディレクトリは「スキルなし」として黙って飛ばします。
 */
export async function listReviewSkills(rootDir) {
  const skills = new Map();
  for (const { dir, source } of skillDirectories(rootDir)) {
    for (const entry of await readSkillDirectory(dir)) {
      if (skills.has(entry.id)) continue;
      const summary = await readSkillSummary(dir, entry.id, source);
      if (summary) skills.set(summary.id, summary);
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/** 選ばれた1つのスキルを、プロンプトへ載せられる形で読み込みます。 */
export async function readReviewSkill(rootDir, skillId) {
  const id = String(skillId || '').trim();
  if (!SKILL_ID_PATTERN.test(id)) throw new Error(`レビュースキルが見つかりません: ${skillId}`);

  for (const { dir, source } of skillDirectories(rootDir)) {
    const filePath = skillFilePath(dir, id);
    if (!filePath) continue;
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    const { meta, body } = parseSkillFile(raw);
    return {
      id,
      name: displayName(meta, id),
      description: meta.description || '',
      source,
      instructions: body.slice(0, MAX_SKILL_INSTRUCTION_CHARS)
    };
  }
  throw new Error(`レビュースキルが見つかりません: ${id}`);
}

/**
 * `SKILL.md` の前書き（`---` で挟んだ `key: value`）と本文を分けます。
 * 使うのは title / name / description だけなので、YAMLは1行値だけを読みます。
 */
export function parseSkillFile(raw) {
  const text = String(raw || '');
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const body = frontMatter ? text.slice(frontMatter[0].length) : text;
  const meta = {};
  if (frontMatter) {
    for (const line of frontMatter[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (pair) meta[pair[1]] = unquote(pair[2].trim());
    }
  }
  return { meta, body: body.trim() };
}

/**
 * 選ばれたスキルをまとめて読み込みます。順番は選ばれた順のままで、
 * 同じスキルを二重に渡しても1つとして扱います。
 */
export async function readReviewSkills(rootDir, skillIds) {
  const ids = [...new Set((Array.isArray(skillIds) ? skillIds : [skillIds]).map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error('レビュースキルを1つ以上選んでください');
  if (ids.length > MAX_SELECTED_SKILLS) {
    throw new Error(`レビュースキルは一度に${MAX_SELECTED_SKILLS}個まで選べます`);
  }
  const skills = [];
  for (const id of ids) skills.push(await readReviewSkill(rootDir, id));
  return skills;
}

function skillDirectories(rootDir) {
  const root = path.resolve(rootDir);
  return [
    ...PROJECT_SKILL_DIRS.map((relative) => ({ dir: path.join(root, ...relative.split('/')), source: 'project' })),
    { dir: BUILTIN_SKILL_DIR, source: 'builtin' }
  ];
}

async function readSkillDirectory(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name))
      .map((entry) => ({ id: entry.name }));
  } catch {
    // スキルを置いていないディレクトリは、選べるスキルが無いだけです。
    return [];
  }
}

async function readSkillSummary(dir, id, source) {
  const filePath = skillFilePath(dir, id);
  if (!filePath) return null;
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    // SKILL.md の無いディレクトリは、スキルではありません。
    return null;
  }
  const { meta } = parseSkillFile(raw);
  return {
    id,
    name: displayName(meta, id),
    description: meta.description || '',
    source
  };
}

/**
 * 画面に出す名前。`name` はスラッグを書く慣習なので、日本語の見出しを付けたい
 * スキルは `title` を書けます。
 */
function displayName(meta, id) {
  return meta.title || meta.name || id;
}

/** ディレクトリ名がそのままidなので、探索先の外へ出るidは受け付けません。 */
function skillFilePath(dir, id) {
  const filePath = path.join(dir, id, SKILL_FILE_NAME);
  const relative = path.relative(dir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return filePath;
}

function unquote(value) {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}
