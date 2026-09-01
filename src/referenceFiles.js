import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_REFERENCE_FILES, MAX_REFERENCE_FILE_CHARS } from './aiLimits.js';
import { MARKDOWN_EXTENSIONS, TEXT_EXTENSIONS } from './links.js';
import { ALWAYS_EXCLUDED } from './pathFilter.js';
import { isPdfPath, readPdfText } from './pdf/index.js';
import { referencedFilesBlock } from './prompts/readingContext.js';

/**
 * 参照ファイルは、レビュー中の文書に添えて「これも読んでおいて」と渡す隣のファイルです。
 *
 * 用語集、前の章、元になった仕様書、隣に置いてあるコード。原稿には書かれていないが
 * 原稿を読むのに要るものは、たいてい同じディレクトリか、その下にあります。
 * 添えたファイルは読み取りコンテキストと同じ前提として、翻訳・AIチャット・指摘の配置・
 * AIレビューのすべてが本文より先に読みます。
 *
 * ── 選ぶのはレビュアーで、探すのはAIではありません ──────────────
 * このアプリはCodexを読み取り専用のサンドボックスに閉じ込めていて、モデルにファイルを
 * 探させる口をそもそも開けていません（`codexAppServer.js` の「緩めてはいけないもの」）。
 * なので「AIが隣を読める」は、こちらが読んでプロンプトへ載せる形で実現します。
 * どれを載せるかはレビュアーが1件ずつ選びます。自動で全部載せると、上限に当たった分が
 * 黙って落ち、レビュアーは何が読まれたのかを確かめられなくなります。
 *
 * ── 「同階層以下」の意味 ──────────────────────────────────
 * 選べるのは、その文書のあるディレクトリと、その下だけです。`docs/guide/intro.md` なら
 * `docs/guide/` 配下で、`docs/` の別の枝や、レビュー対象ディレクトリの外は選べません。
 * 上へ辿らせないのは、文書と一緒に動かせる範囲がそこまでだからです。章を別の本へ移した
 * ときに、隣にあったから添えたファイルは一緒に動きますが、上のほうにあったファイルは
 * 動きません。
 *
 * ── --include / --exclude は効きません ────────────────────
 * 画面のファイル一覧から外したファイルも、参照ファイルには選べます。あの2つは
 * 「どれをレビューするか」の設定で、「何を前提として読ませるか」ではないからです。
 * 下書きや資料を一覧から隠したまま前提として使えます。ただし `ALWAYS_EXCLUDED`
 * （`.git` / `node_modules` / `.review`）だけは、ここでも辿りません。
 *
 * このモジュールが持つのは、探す・確かめる・読むところまでです。モデルが読む文面は
 * `prompts/readingContext.js` の `referencedFilesBlock` にあります。
 */

/**
 * 原稿の隣に置かれるコードと設定。本文として読めるものだけを並べます。
 *
 * 拡張子の決め打ちにしているのは、拡張子の無いファイル（`Dockerfile`、`Makefile`）や
 * ドットファイル（`.env`）まで開けるようにすると、選べるものの一覧に秘密を置いた
 * ファイルが並ぶからです。選ぶのはレビュアーですが、一覧に出さなければ誤って選べません。
 */
export const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.php', '.cs',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.gql', '.proto', '.xml', '.svg', '.rst', '.tex'
]);

/**
 * 選べるものとして一覧に出すファイル数。溢れた分は件数だけ返し、画面が絞り込みを促します。
 *
 * `aiLimits.js` に置いていないのは、これがモデルの読む量ではなく、画面が受け取る一覧の
 * 大きさだからです。原稿の隣に数千ファイル置いてあるディレクトリで、選択欄が開かなく
 * ならないようにするためだけの頭打ちです。
 */
const MAX_REFERENCE_CANDIDATES = 500;

/** 添えたファイルを囲む枠の終わり。中身に同じ並びがあると枠が壊れるので、読むときに潰します。 */
const CLOSING_TAGS = ['</file>', '</reference_files>'];

/** ここへ長い文字列を書かれても切り詰めるためだけの上限です。 */
const PATH_CHARS = 400;

/** True when the file has a body this app can hand to a model as text. */
export function isReferenceFilePath(relativePath) {
  const name = path.posix.basename(String(relativePath ?? ''));
  // ドットファイルは拡張子で弾けません（`.env` の拡張子は `.env` ではありません）。
  if (!name || name.startsWith('.')) return false;
  const extension = path.posix.extname(name).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(extension)
    || TEXT_EXTENSIONS.has(extension)
    || SOURCE_EXTENSIONS.has(extension)
    || isPdfPath(name);
}

/**
 * 「同階層以下」の起点。レビュー対象ディレクトリ直下の文書なら `''`（= 対象全体）です。
 * @param {string} documentPath レビュー中の文書の、レビュー対象ディレクトリからの相対パス。
 */
export function referenceBaseDir(documentPath) {
  const directory = path.posix.dirname(toPosix(documentPath) || '.');
  return directory === '.' || directory === '/' ? '' : directory;
}

/**
 * 選べるファイルの一覧。その文書のディレクトリと、その下だけを辿ります。
 * 文書そのものは外します。自分を自分の前提として渡すことはできません。
 */
export async function listReferenceFiles(rootDir, documentPath) {
  const target = toPosix(documentPath);
  const base = referenceBaseDir(target);
  const files = [];
  await walk(path.join(rootDir, base), base);
  files.sort((a, b) => a.path.localeCompare(b.path));
  // 溢れた分は件数だけ返します。黙って切ると、探しているファイルが一覧に無い理由が
  // 「そこに無い」のか「多すぎて出ていない」のかを画面から区別できません。
  return { base, total: files.length, files: files.slice(0, MAX_REFERENCE_CANDIDATES) };

  async function walk(currentDir, relativeDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      // 消えた枝や読めない枝は飛ばします。一覧を出せないより、出せる分を出すほうが使えます。
      return;
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isAlwaysExcluded(entry.name)) await walk(path.join(currentDir, entry.name), relativePath);
      } else if (entry.isFile() && relativePath !== target && isReferenceFilePath(entry.name)) {
        files.push({ path: relativePath, kind: isPdfPath(entry.name) ? 'pdf' : 'text' });
      }
    }
  }
}

/**
 * 保存済みの選択を読みます。何が入っていても投げません。
 *
 * `readContextNotes` と同じ理由です。ここで投げると、レビューファイルを手で直した
 * 1文字で、その文書が画面から開けなくなります（`readReview` は本文の表示にも通る道です）。
 * 読めなかったものと、同階層以下から外れたものは落とします。
 */
export function readReferenceFilePaths(value, documentPath) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const paths = [];
  for (const entry of value) {
    const relativePath = resolveReferencePath(entry, documentPath);
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    paths.push(relativePath);
  }
  return paths;
}

/**
 * レビュアーが送ってきた選択を受け取ります。読めないパスと上限超過は断ります。
 *
 * 断るほうを選んだのは、コンテキストメモと同じです。何件か落ちた状態でレビューを
 * 走らせると、レビュアーは添えたはずのファイルが読まれていないことに気づけません。
 */
export function normalizeReferenceFiles(value, documentPath, source = '参照ファイル') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${source} は配列で指定してください`);
  if (value.length > MAX_REFERENCE_FILES) {
    throw new Error(`${source}は${MAX_REFERENCE_FILES}件までです。読ませないものを外してください`);
  }
  for (const entry of value) {
    if (resolveReferencePath(entry, documentPath)) continue;
    throw new Error(`${source}に選べないファイルが混ざっています: ${String(pathOf(entry)).slice(0, PATH_CHARS)}`);
  }
  return readReferenceFilePaths(value, documentPath);
}

/**
 * 添えたファイルを、モデルへ渡す形まで読みます。
 *
 * 途中で投げません。添えたファイルが消えていても、レビューも翻訳も走るべきだからです。
 * 読めなかったファイルは、黙って外さずに `unreadable` として枠へ残します。前提として
 * 添えたものが渡っていないことは、モデルにも画面にも分かる必要があります。
 */
export async function readReferenceFiles(rootDir, documentPath, value) {
  const paths = readReferenceFilePaths(value, documentPath);
  const entries = [];
  for (const relativePath of paths) {
    entries.push({ n: entries.length + 1, ...await readOne(rootDir, relativePath) });
  }
  return entries;
}

/**
 * すでに読んである参照ファイル。`resolveAiContext` が受け取った値を確かめるためだけの
 * 入り口で、ここではファイルを開きません（読むのは `readReferenceFiles` です）。
 */
export function readReferenceEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.path)
    .map((entry, index) => ({
      n: index + 1,
      path: String(entry.path).slice(0, PATH_CHARS),
      ...(entry.kind === 'pdf' ? { kind: 'pdf' } : {}),
      ...(entry.unreadable ? { unreadable: true } : { text: safeText(String(entry.text ?? '')) }),
      ...(entry.truncated ? { truncated: true } : {})
    }));
}

export function hasReferenceFiles(entries) {
  return Array.isArray(entries) && entries.length > 0;
}

/** 添えたファイルをモデルが読む形にしたもの。1件も無ければ '' を返します。 */
export function referenceFilesBlock(entries) {
  if (!hasReferenceFiles(entries)) return '';
  return referencedFilesBlock(entries);
}

/* ---------------------------------------------------------------- *
 * 内側
 * ---------------------------------------------------------------- */

/**
 * 1件ぶんの本文。読めなかったものは `unreadable` にして返します。
 *
 * PDFは文字を取り出して渡します。取り出せないPDF（画像だけのスキャン）は空になるので、
 * 読めなかったものと同じ扱いにします。空の枠だけ渡しても、モデルには
 * 「中身が無い資料」と「読めなかった資料」の区別が付かないからです。
 */
async function readOne(rootDir, relativePath) {
  const filePath = path.join(rootDir, relativePath);
  const pdf = isPdfPath(relativePath);
  try {
    const raw = pdf
      // 1文字ぶん余分に読ませて、切ったかどうかを長さで判定できるようにします。
      ? await readPdfText(filePath, MAX_REFERENCE_FILE_CHARS + 1)
      : await fs.readFile(filePath, 'utf8');
    const text = raw.trim();
    if (!text) return { path: relativePath, ...(pdf ? { kind: 'pdf' } : {}), unreadable: true };
    return {
      path: relativePath,
      ...(pdf ? { kind: 'pdf' } : {}),
      text: text.slice(0, MAX_REFERENCE_FILE_CHARS),
      ...(text.length > MAX_REFERENCE_FILE_CHARS ? { truncated: true } : {})
    };
  } catch {
    return { path: relativePath, ...(pdf ? { kind: 'pdf' } : {}), unreadable: true };
  }
}

/**
 * 枠の終わりと同じ並びを潰します。
 *
 * レビュアーが書いた前提と違って、参照ファイルにはHTMLやXMLの原文が入ります。中に
 * `</file>` があると、そこで枠が閉じたものとして読まれ、続きが枠の外の文——つまり
 * こちらからの指示——に見えます。空白を1つ入れて、区切りとして読めなくします。
 *
 * 読んだ直後ではなく `readReferenceEntries` で当てているのは、そこがプロンプトへ渡る
 * 前の一本道だからです。ファイルから読んだ文字も、呼ぶ側が組み立てた値も、必ずここを
 * 通ってから枠に入ります。
 */
function safeText(text) {
  return CLOSING_TAGS.reduce(
    (value, tag) => (value.includes(tag) ? value.replaceAll(tag, tag.replace('</', '</ ')) : value),
    text
  );
}

/**
 * 選択を1件、レビュー対象ディレクトリからの相対パスに直します。
 * 同階層以下から外れるもの、文書そのもの、読めない種類のファイルは `null` を返します。
 */
function resolveReferencePath(entry, documentPath) {
  const candidate = toPosix(pathOf(entry));
  if (!candidate || candidate.length > PATH_CHARS) return null;
  const target = toPosix(documentPath);
  const base = referenceBaseDir(target);
  // `..` を含むパスをここで畳んでから確かめます。畳む前に確かめると、
  // `docs/guide/../../etc/passwd` が同階層以下として通ります。
  const normalized = path.posix.normalize(candidate.replace(/^\/+/, ''));
  if (normalized.startsWith('../') || normalized === '..' || normalized === '.') return null;
  if (normalized === target) return null;
  if (base && !normalized.startsWith(`${base}/`)) return null;
  if (!isReferenceFilePath(normalized)) return null;
  if (normalized.split('/').some(isAlwaysExcluded)) return null;
  return normalized;
}

function pathOf(entry) {
  return typeof entry === 'string' ? entry : entry?.path;
}

/** `ALWAYS_EXCLUDED` はグロブなので、最後の区切りから先の名前だけを見ます。 */
function isAlwaysExcluded(name) {
  return ALWAYS_EXCLUDED.some((pattern) => pattern.slice(pattern.lastIndexOf('/') + 1) === name);
}

function toPosix(value) {
  return String(value ?? '').trim().replaceAll('\\', '/');
}
