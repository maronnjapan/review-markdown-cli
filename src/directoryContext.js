import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeAiContext } from './aiContext.js';
import { REVIEW_DIR } from './reviewStore.js';

/**
 * コマンドを実行したディレクトリ配下すべてに効く読み取りコンテキストです。
 *
 * 読み取りコンテキストには効く範囲が2つあります。この文書だけに効くもの
 * （レビューファイルの `aiContext`）と、対象ディレクトリ配下のすべての文書に効くもの
 * （ここ）です。どちらを書くかは画面で選べます。同じ本の章を1つずつ開いてレビューする
 * ような使い方だと、「この本は入門者向け」という前提を文書の数だけ書き写すことになり、
 * 直すときも同じ数だけ直すことになるからです。
 *
 * ── 設定ファイルの `aiContext` との違い ──────────────────────
 * 効く範囲は同じです。違うのは決める場所と、決める人です。設定ファイル（`--ai-context`）は
 * 起動のしかたを決める場所なので、書き換えるには立ち上げ直しが要ります。こちらはレビューの
 * 最中に気づいた前提を、その場で足すためのものです。モデルへは同じ「ディレクトリ全体の前提」
 * として、1つの枠にまとめて渡します（`prompts/readingContext.js`）。
 *
 * ── 保存先をレビューファイルの隣にした理由 ─────────────────
 * 書き込む先は対象ディレクトリの `.review/context.json` で、設定ファイルではありません。
 * ここに書くのはレビュアーが原稿について書いた前提であって、その端末の設定ではないからです。
 * 設定ファイルへ書くと、どのディレクトリを開いても付いてくる前提になります
 * （`settings.js` が対象ディレクトリへ書かない理由の裏返しです）。
 *
 * ── 親ディレクトリは探しません ────────────────────────────
 * レビューファイルは親の `.review` まで遡って探しますが（`reviewStore.js`）、こちらは
 * 対象ディレクトリの1か所だけを見ます。「コマンドを実行したディレクトリ配下に一律で効く」
 * という約束が、開き方によって変わらないようにするためです。
 */

/** `.review` の中のファイル名。レビューファイルは `<target>.review.json` なので、名前は衝突しません。 */
export const DIRECTORY_CONTEXT_FILE = 'context.json';

/** 画面とレビューMarkdownに出す保存先（対象ディレクトリからの相対パス）。 */
export const DIRECTORY_CONTEXT_PATH = `${REVIEW_DIR}/${DIRECTORY_CONTEXT_FILE}`;

export function directoryContextPathFor(rootDir) {
  return path.join(rootDir, REVIEW_DIR, DIRECTORY_CONTEXT_FILE);
}

/**
 * 保存済みの前提を読みます。何が入っていても投げません。
 *
 * 読めない1文字で、そのディレクトリの文書がまとめて開けなくなるのを避けるためです
 * （`contextNotes.js` の `readContextNotes` と同じ考え方です）。この関数は文書を開くたび、
 * AIへ渡すたびに通ります。
 */
export async function readDirectoryContext(rootDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(directoryContextPathFor(rootDir), 'utf8'));
    return typeof parsed?.aiContext === 'string' ? parsed.aiContext.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 画面から届いた前提を保存します。長すぎるものは切り詰めずに断ります。
 *
 * 空文字は「消した」なので、キーごと落とします。読み取りコンテキストを保存しない
 * レビューファイルと同じ形です（`reviewStore.js` の `writeReview`）。
 */
export async function writeDirectoryContext(rootDir, value) {
  const aiContext = normalizeAiContext(value, 'ディレクトリ全体の読み取りコンテキスト');
  const filePath = directoryContextPathFor(rootDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    ...(aiContext ? { aiContext } : {})
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return aiContext;
}
