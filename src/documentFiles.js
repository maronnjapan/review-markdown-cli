import fs from 'node:fs/promises';
import path from 'node:path';
import { TASKS_FILE_SUFFIX } from './autoTasks.js';
import { httpError } from './http.js';
import { isMarkdownPath } from './links.js';
import { isPdfPath } from './pdf/index.js';
import { REVIEW_DIR, findExistingReviewLocation, normalizeRelativePath } from './reviewStore.js';

/**
 * 一覧に出ているファイルそのものを、画面から作る・名前を変える・消すための操作です。
 *
 * ── 扱えるのは一覧に出るファイルだけ ──────────────────────
 * 対象ディレクトリの中でも、画面が一覧に出すのは Markdown と PDF だけです
 * （`markdownFiles.js` と `pdf/index.js`）。ここもその2つに限ります。パスを送れば
 * 何でも消せる窓口にすると、画面からは見えないソースや画像まで、押し間違いの
 * 一手で消せる場所になるからです。include / exclude で隠れているファイルを断るのも
 * 同じ理由です（見えていないものは、消すかどうかを決められません）。
 *
 * ── レビューデータを置いていかない ────────────────────────
 * コメント・出力・タスクは、本文とは別に `.review/<target>.*` にあります。名前だけを
 * 変えると、書いたコメントは前の名前に付いたまま画面から辿れなくなり、消しても
 * `.review` の中には残り続けます。どちらも画面からは掃除できないので、本文と一緒に
 * 動かし、一緒に消します（`moveDocumentData` / `removeDocumentData`）。
 */

/**
 * `.review` に置く、その文書だけのデータ。名前の変更で一緒に動かし、削除で一緒に消します。
 *
 * レビューファイル（`.review.json`）と出力（`.review.md`）は対象ディレクトリの上に
 * あることがあるので、置き場所は `findExistingReviewLocation` に聞きます。タスクは
 * 必ず対象ディレクトリの `.review` です（`autoTasks.js` の `tasksPathFor`）。
 */
const REVIEW_DATA_SUFFIXES = ['.review.json', '.review.md'];

/** ファイル名1つ分の上限。これを超えると、ほとんどのファイルシステムが受け取りません。 */
const MAX_NAME_CHARS = 255;

/**
 * 新しく作るファイルの中身です。
 *
 * 見出し1行だけにしているのは、目次と題名がすぐ付くからです。「まだ本文の無い資料」の
 * 判定（`public/js/documentBrief.js` の `hasWrittenBody`）は見出しを本文と数えないので、
 * 作った直後の文書でも、資料の管理者の関門はそのまま働きます。
 */
function newDocumentBody(relativeFile) {
  return `# ${path.posix.basename(relativeFile, path.posix.extname(relativeFile))}\n`;
}

/**
 * 新しいMarkdownファイルを作ります。
 *
 * @param {string} rootDir レビュー対象ディレクトリ。
 * @param {object} filter --include / --exclude（`pathFilter.js`）。
 * @param {string} requestedPath 画面が送ってきた、対象ディレクトリからのパス。
 *   拡張子が無ければ `.md` を付けます。
 */
export async function createDocument(rootDir, filter, requestedPath) {
  const relativeFile = documentTarget(rootDir, filter, withMarkdownExtension(requestedPath));
  if (!isMarkdownPath(relativeFile)) throw httpError('新しく作れるのはMarkdownファイルだけです', 400);

  const filePath = path.join(rootDir, relativeFile);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // `wx` は、すでにあるファイルを空で上書きしないためのものです。先に存在を確かめてから
    // 書くと、確かめてから書くまでの間に置かれたファイルを消してしまいます。
    await fs.writeFile(filePath, newDocumentBody(relativeFile), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw pathInUse(error, relativeFile) || error;
  }
  return { path: relativeFile };
}

/**
 * 名前を変えます。パスごと変えられるので、別のディレクトリへ移すのも同じ操作です。
 * 途中のディレクトリは必要なら作ります。
 *
 * @param {string} requestedTo 新しいパス。対象ディレクトリからの相対で受け取ります。
 */
export async function renameDocument(rootDir, filter, requestedPath, requestedTo) {
  const from = documentTarget(rootDir, filter, requestedPath);
  const to = documentTarget(rootDir, filter, requestedTo);
  if (from === to) throw httpError('名前が変わっていません', 400);
  // Markdownを `.pdf` に、PDFを `.md` にする改名は断ります。名前だけが変わっても中身は
  // 変わらないので、開いた先で「壊れたPDF」を見せることになります。
  if (isMarkdownPath(from) !== isMarkdownPath(to)) {
    throw httpError('MarkdownとPDFの間で拡張子は変えられません', 400);
  }

  const fromPath = path.join(rootDir, from);
  const toPath = path.join(rootDir, to);
  const source = await statFile(fromPath);
  if (!source) throw httpError(`ファイルが見つかりません: ${from}`, 404);
  const existing = await statFile(toPath);
  // 大文字と小文字を区別しないファイルシステムでは、`Guide.md` を `guide.md` にするときの
  // 移す先として、自分自身が見つかります。別のファイルのときだけ断ります。
  if (existing && !isSameFile(existing, source)) {
    throw httpError(`同じ名前のファイルがすでにあります: ${to}`, 409);
  }

  try {
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
  } catch (error) {
    throw pathInUse(error, to) || error;
  }
  const data = await moveDocumentData(rootDir, from, to);
  return { path: to, from, data };
}

/**
 * ファイルと、`.review` に置いたそのファイルのデータを消します。
 *
 * 端末側に残る保存済みのAIチャットは消しません。プロジェクトの外（`aiStore.js` の
 * 保存先）にあるもので、消してよいかはレビューの終わりとは別に決まるからです。
 * 要らない会話は、その画面から1件ずつ消せます。
 */
export async function deleteDocument(rootDir, filter, requestedPath) {
  const relativeFile = documentTarget(rootDir, filter, requestedPath);
  const filePath = path.join(rootDir, relativeFile);
  if (!await statFile(filePath)) throw httpError(`ファイルが見つかりません: ${relativeFile}`, 404);

  await fs.unlink(filePath);
  const data = await removeDocumentData(rootDir, relativeFile);
  return { path: relativeFile, data };
}

/**
 * 画面から送られてきたパスを、扱ってよい1ファイルとして受け取ります。
 *
 * `normalizeRelativePath` が対象ディレクトリの外を断り、ここでは「一覧に出せる場所か」を
 * 見ます。include / exclude で隠れる場所を通すと、作った直後に一覧から消えたように
 * 見えます。`.review` や `node_modules` も同じ関門で断ります（`pathFilter.js` の
 * `ALWAYS_EXCLUDED`）。
 */
function documentTarget(rootDir, filter, requestedPath) {
  const relativeFile = normalizeRelativePath(rootDir, requestedPath);
  if (!isMarkdownPath(relativeFile) && !isPdfPath(relativeFile)) {
    throw httpError(`扱えるのは一覧に出るファイル（Markdown / PDF）だけです: ${relativeFile}`, 400);
  }
  if (relativeFile.split('/').some((segment) => segment.length > MAX_NAME_CHARS)) {
    throw httpError(`ファイル名が長すぎます（${MAX_NAME_CHARS}文字まで）`, 400);
  }
  if (!filter.matchesFile(relativeFile)) {
    throw httpError(`このパスは include / exclude の設定によりレビュー対象から外れています: ${relativeFile}`, 400);
  }
  return relativeFile;
}

/** 拡張子を書かずに送られたときの補い。「メモ」と打てば `メモ.md` になります。 */
function withMarkdownExtension(requestedPath) {
  const trimmed = String(requestedPath ?? '').trim();
  if (!trimmed || trimmed.endsWith('/')) return trimmed;
  return path.posix.extname(path.posix.basename(trimmed)) ? trimmed : `${trimmed}.md`;
}

/**
 * `.review` に置いたその文書のデータを、名前の変更に付いていかせます。
 *
 * 動かしたあとに中の対象名も書き換えます。レビューファイルもタスクも「どの文書のものか」を
 * 自分の中に持っていて（`targetFile`）、出力の1行目にも書いてあるので、そのままにすると
 * 前の名前を指し続けます。
 *
 * @returns {Promise<string[]>} 動かしたファイル（表示用のパス）。
 */
async function moveDocumentData(rootDir, from, to) {
  const moved = [];
  for (const location of await dataLocations(rootDir, from)) {
    const fromDataPath = dataPathOf(location, location.targetFile);
    if (!await statFile(fromDataPath)) continue;
    const toTargetFile = targetFileIn(location.baseDir, rootDir, to);
    const toDataPath = dataPathOf(location, toTargetFile);
    await fs.mkdir(path.dirname(toDataPath), { recursive: true });
    await fs.rename(fromDataPath, toDataPath);
    await retargetDataFile(toDataPath, toTargetFile);
    moved.push(displayPath(rootDir, toDataPath));
  }
  return moved;
}

/** @returns {Promise<string[]>} 消したファイル（表示用のパス）。 */
async function removeDocumentData(rootDir, relativeFile) {
  const removed = [];
  for (const location of await dataLocations(rootDir, relativeFile)) {
    const dataPath = dataPathOf(location, location.targetFile);
    if (!await statFile(dataPath)) continue;
    await fs.unlink(dataPath);
    removed.push(displayPath(rootDir, dataPath));
  }
  return removed;
}

/**
 * その文書のデータがどこにあるか。レビューファイルと出力だけは対象ディレクトリより
 * 上にあることがあるので、置き場所を探してから組み立てます。
 */
async function dataLocations(rootDir, relativeFile) {
  const review = await findExistingReviewLocation(rootDir, relativeFile);
  return [
    ...REVIEW_DATA_SUFFIXES.map((suffix) => ({
      baseDir: review.baseDir,
      targetFile: review.targetFile,
      suffix
    })),
    { baseDir: path.resolve(rootDir), targetFile: relativeFile, suffix: TASKS_FILE_SUFFIX }
  ];
}

function dataPathOf({ baseDir, suffix }, targetFile) {
  return path.join(baseDir, REVIEW_DIR, `${targetFile}${suffix}`);
}

/** `baseDir` から見た、対象ディレクトリの中のファイルのパス。 */
function targetFileIn(baseDir, rootDir, relativeFile) {
  return path.relative(baseDir, path.resolve(rootDir, relativeFile)).split(path.sep).join('/');
}

/**
 * 動かしたデータが指す対象名を、新しい名前へ書き換えます。
 *
 * 読めない中身でも投げません。ここで投げると、本文だけ名前が変わってデータは古い名前の
 * ままという、どちらから直せばいいのか分からない状態で止まります。書き換えられなくても
 * 中身はそのまま残るので、開けば読めます。
 */
async function retargetDataFile(dataPath, targetFile) {
  try {
    const raw = await fs.readFile(dataPath, 'utf8');
    if (dataPath.endsWith('.md')) {
      // 出力の1行目だけが対象名です（`reviewStore.js` の `buildReviewMarkdown`）。
      return await fs.writeFile(dataPath, raw.replace(/^# Review for .*$/m, `# Review for ${targetFile}`), 'utf8');
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    await fs.writeFile(dataPath, `${JSON.stringify({ ...parsed, targetFile }, null, 2)}\n`, 'utf8');
  } catch {
    // 読めなかった、あるいはJSONとして壊れていたデータ。対象名だけが古いまま残ります。
  }
}

/** 画面とテストに出すパス。対象ディレクトリの外にあるデータは、そこからの相対で出します。 */
function displayPath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

/**
 * その名前が、すでに何かに使われているときの断り。
 *
 * 生の errno（`EEXIST: file already exists, rename ...`）をそのまま画面へ出すと、
 * 何を直せばいいのかが分かりません。書き手が直せるのは名前だけなので、そう伝えます。
 */
function pathInUse(error, relativeFile) {
  if (error.code === 'EEXIST') return httpError(`同じ名前のファイルがすでにあります: ${relativeFile}`, 409);
  if (['EISDIR', 'ENOTEMPTY', 'EPERM'].includes(error.code)) {
    return httpError(`同じ名前のディレクトリがあります: ${relativeFile}`, 409);
  }
  if (error.code === 'ENOTDIR') return httpError(`途中にディレクトリではないものがあります: ${relativeFile}`, 400);
  return null;
}

async function statFile(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
