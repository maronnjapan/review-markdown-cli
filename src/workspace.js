/**
 * CLIを起動したディレクトリを、Contextの持ち主として識別するためのidです。
 *
 * ── パスではなくidにする理由（仕様4.1） ────────────────────
 * 同じプロジェクトでも、PCが変わればパスは変わります（`C:\Users\a\project` と
 * `/home/b/project`）。パスで識別すると、別のPCで開いた同じプロジェクトが別物になり、
 * 保存した判断が出てこなくなります。だからidを1つ振って、それをディレクトリの中へ
 * 置いておきます。リポジトリへコミットすれば、チームでも同じWorkspaceになります。
 *
 * ── いつ作るか（仕様4.2の【要確認3】への回答） ────────────────
 * 起動時には作りません。Contextを保存する、または検索するときに初めて作ります。
 *
 * 起動のたびに作ると、原稿を1つ読むだけのつもりで開いたディレクトリにも、
 * `.review/workspace.json` が置かれます。このCLIは他人のリポジトリを開いて読むのにも
 * 使うので、開いただけで書き込むのは行儀が悪いと判断しました。Contextを使うのは
 * 「このプロジェクトについて判断を残す」と決めたときなので、そのときに作れば足ります。
 *
 * 確認は挟みません。挟んでも、ユーザーに聞いているのは「idを振ってよいか」であって、
 * 断られたらContextが使えないだけです。判断の余地がある問いではないので、黙って作り、
 * どこに作ったかを結果として返します（画面はそれをContextの保存先として出します）。
 *
 * ── 置き場所 ────────────────────────────────────────
 * `.review/workspace.json` です。レビューファイルやディレクトリ全体の前提と同じ場所で、
 * 仕様4.2の `.tool/workspace.json` にあたります（仕様は「正式なCLI名へ変更してよい」と
 * 書いているので、このCLIが既に持っている `.review` に合わせました）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REVIEW_DIR } from './reviewStore.js';

export const WORKSPACE_FILE = 'workspace.json';

/** 画面とREADMEに出す保存先（対象ディレクトリからの相対パス）。 */
export const WORKSPACE_PATH = `${REVIEW_DIR}/${WORKSPACE_FILE}`;

/** Crockford Base32。ULIDが使う32文字で、紛らわしい I / L / O / U を外したものです。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function workspaceFilePathFor(rootDir) {
  return path.join(rootDir, REVIEW_DIR, WORKSPACE_FILE);
}

/**
 * 保存済みのWorkspace idを読みます。無ければ null です。作りません。
 * 何が入っていても投げません。壊れた1文字で、原稿が開けなくなるのを避けるためです。
 */
export async function readWorkspaceId(rootDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(workspaceFilePathFor(rootDir), 'utf8'));
    const id = typeof parsed?.workspace_id === 'string' ? parsed.workspace_id.trim() : '';
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Workspace idを読み、無ければ振って書きます。Contextを使うときだけ呼びます。
 * @returns {Promise<{workspaceId: string, created: boolean, path: string}>}
 */
export async function ensureWorkspaceId(rootDir) {
  const filePath = workspaceFilePathFor(rootDir);
  const existing = await readWorkspaceId(rootDir);
  if (existing) return { workspaceId: existing, created: false, path: filePath };

  const workspaceId = createWorkspaceId();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ workspace_id: workspaceId }, null, 2)}\n`, 'utf8');
  return { workspaceId, created: true, path: filePath };
}

/**
 * ULID（26文字）。前半が作った時刻なので、並べると作った順になります。
 * UUIDでもよいのですが、画面に出したときに読み比べやすいほうを選びました。
 */
export function createWorkspaceId(now = Date.now(), random = crypto.randomBytes(10)) {
  return encodeTime(now) + encodeRandom(random);
}

function encodeTime(now) {
  let time = now;
  const characters = new Array(10);
  for (let index = 9; index >= 0; index -= 1) {
    characters[index] = CROCKFORD[time % 32];
    time = Math.floor(time / 32);
  }
  return characters.join('');
}

/** 10バイト（80ビット）を16文字へ。5ビットずつ切り出します。 */
function encodeRandom(bytes) {
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += CROCKFORD[(value >> bits) & 31];
    }
  }
  return text;
}

/**
 * いま開いているファイルから、Context検索に渡すディレクトリを作ります。
 *
 * 渡すのは1つだけです。祖先へ遡るのはContext API側の仕事なので（`src/context/scope.js`）、
 * ここで列挙しません。同じ決まりを2か所に持つと、片方だけ直したときに、保存したのに
 * 出てこないContextができます。
 *
 * @param {string} documentPath Workspace Rootからの相対パス。文書を開いていなければ空。
 * @returns {string|null} そのファイルがあるディレクトリ。ルート直下なら null。
 */
export function scopePathFor(documentPath) {
  const directory = path.posix.dirname(String(documentPath || '').replace(/\\/g, '/'));
  return !directory || directory === '.' || directory === '/' ? null : directory;
}
