/**
 * ページとWorkspaceの形と、受け取った値の検証です。
 *
 * ── ページはContextとは別の物 ───────────────────────────
 * Context（`../model.js`）は「次の会話でも前提にしたい」と決めた判断1件で、短く、
 * 効く範囲を持ちます。ページは、人が読み書きする文書で、長く、階層を持ちます。
 * 同じ索引に載せて意味で引けるようにしますが（`store.js`）、正本の形は分けています。
 * 判断に階層を持たせても、文書に「効く範囲」を持たせても、使う人が決めることが増えるだけだからです。
 *
 * ── Workspace ──────────────────────────────────────
 * ページはWorkspaceに属します。Workspaceのidは、CLIが `.review/workspace.json` に振るものと
 * 同じ文字種（ULID）で作ります。画面で作ったWorkspaceのidをそのファイルに書けば、
 * そのリポジトリを開いたCLIのAIが、ここに書いたページも引けるようになります。
 *
 * ── 題名が空でもよい ─────────────────────────────────
 * 「新しいページ」を押した瞬間に題名を求めると、書き始める前に一度止まります。
 * 空のまま置けるようにして、画面が「無題」と表示します。
 */

import crypto from 'node:crypto';
import { contextApiError } from '../model.js';

export const MAX_TITLE_CHARS = 200;
/** 1ページの本文の上限。Contextの8000文字より長いのは、文書だからです。 */
export const MAX_PAGE_CONTENT_CHARS = 200_000;
export const MAX_WORKSPACE_NAME_CHARS = 80;
const MAX_ID_CHARS = 128;

/** Workspace idに使える文字。CLIのULID（大文字英数）と、人が付けた短い名前の両方を通します。 */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Crockford Base32。ULIDが使う32文字で、紛らわしい I / L / O / U を外したものです（CLIの `workspace.js` と同じ）。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function createPageId() {
  return `pg_${crypto.randomBytes(12).toString('hex')}`;
}

/** ULID（26文字）。CLIが振るWorkspace idと同じ形にして、どちらで作ったかで見た目が変わらないようにします。 */
export function createWorkspaceId(now = Date.now(), random = crypto.randomBytes(10)) {
  let time = now;
  const characters = new Array(10);
  for (let index = 9; index >= 0; index -= 1) {
    characters[index] = CROCKFORD[time % 32];
    time = Math.floor(time / 32);
  }
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += CROCKFORD[(value >> bits) & 31];
    }
  }
  return characters.join('') + text;
}

export function normalizeWorkspaceId(value, field = 'workspace_id') {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw contextApiError(`${field} を指定してください`);
  if (id.length > MAX_ID_CHARS) throw contextApiError(`${field} が長すぎます`);
  if (!WORKSPACE_ID_PATTERN.test(id)) {
    throw contextApiError(`${field} に使えるのは英数字と . _ - だけです: ${id}`);
  }
  return id;
}

export function normalizeWorkspaceName(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw contextApiError('name は文字列で指定してください');
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length > MAX_WORKSPACE_NAME_CHARS) {
    throw contextApiError(`name が長すぎます（${MAX_WORKSPACE_NAME_CHARS}文字まで）`);
  }
  return name || fallback;
}

export function normalizeTitle(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw contextApiError('title は文字列で指定してください');
  const title = value.replace(/[\r\n]+/g, ' ').trim();
  if (title.length > MAX_TITLE_CHARS) throw contextApiError(`title が長すぎます（${MAX_TITLE_CHARS}文字まで）`);
  return title;
}

export function normalizePageContent(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw contextApiError('content は文字列で指定してください');
  const content = value.replace(/\r\n?/g, '\n');
  if (content.length > MAX_PAGE_CONTENT_CHARS) {
    throw contextApiError(`content が長すぎます（${MAX_PAGE_CONTENT_CHARS}文字まで）。ページを分けてください`);
  }
  return content;
}

export function normalizePageId(value, field = 'page_id') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw contextApiError(`${field} は文字列で指定してください`);
  const id = value.trim();
  if (!id) return null;
  if (id.length > MAX_ID_CHARS) throw contextApiError(`${field} が長すぎます`);
  return id;
}

/**
 * 並び順の指定。兄弟の中で何番目に置くかで、0始まりです。省略すると末尾です。
 */
export function normalizePosition(value) {
  if (value === undefined || value === null || value === '') return null;
  const position = Number(value);
  if (!Number.isInteger(position) || position < 0) {
    throw contextApiError(`position は0以上の整数で指定してください: ${value}`);
  }
  return position;
}

/**
 * `POST /pages` が受け取った値をページへ組み立てます。親の存在や並び順は `store.js` が見ます。
 */
export function buildPage(input = {}, { now = new Date().toISOString(), id = createPageId() } = {}) {
  return {
    page_id: id,
    workspace_id: normalizeWorkspaceId(input.workspace_id),
    parent_id: normalizePageId(input.parent_id, 'parent_id'),
    title: normalizeTitle(input.title),
    content: normalizePageContent(input.content),
    position: 0,
    created_at: now,
    updated_at: now
  };
}

/**
 * `PATCH /pages/{id}` の差分を当てます。送られてこなかった欄は保存済みのままです。
 * 親と並び順は返すだけで、兄弟の並べ直しは `store.js` が行います。
 *
 * @returns {{page: object, contentChanged: boolean, titleChanged: boolean, moved: boolean, position: number|null}}
 */
export function applyPagePatch(stored, patch = {}, { now = new Date().toISOString() } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw contextApiError('更新内容はJSONオブジェクトで指定してください');
  }
  for (const key of ['page_id', 'workspace_id', 'created_at']) {
    if (patch[key] !== undefined && patch[key] !== stored[key]) {
      throw contextApiError(`${key} は更新できません`);
    }
  }
  const title = patch.title === undefined ? stored.title : normalizeTitle(patch.title);
  const content = patch.content === undefined ? stored.content : normalizePageContent(patch.content);
  const parentId = patch.parent_id === undefined ? stored.parent_id : normalizePageId(patch.parent_id, 'parent_id');
  const position = normalizePosition(patch.position);
  const contentChanged = content !== stored.content;
  const titleChanged = title !== stored.title;
  const moved = parentId !== stored.parent_id || position !== null;
  return {
    page: {
      ...stored,
      title,
      content,
      parent_id: parentId,
      // 並べ替えただけのページの更新日時は動かしません。「最近直したページ」の並びが、
      // 移動のたびに崩れるからです。
      updated_at: contentChanged || titleChanged ? now : stored.updated_at
    },
    contentChanged,
    titleChanged,
    moved,
    position
  };
}

export function buildWorkspace(input = {}, { now = new Date().toISOString() } = {}) {
  const workspaceId = input.workspace_id === undefined || input.workspace_id === null || input.workspace_id === ''
    ? createWorkspaceId()
    : normalizeWorkspaceId(input.workspace_id);
  return {
    workspace_id: workspaceId,
    name: normalizeWorkspaceName(input.name, workspaceId),
    created_at: now,
    updated_at: now
  };
}

export function applyWorkspacePatch(stored, patch = {}, { now = new Date().toISOString() } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw contextApiError('更新内容はJSONオブジェクトで指定してください');
  }
  if (patch.workspace_id !== undefined && patch.workspace_id !== stored.workspace_id) {
    throw contextApiError('workspace_id は更新できません');
  }
  return {
    ...stored,
    name: patch.name === undefined ? stored.name : normalizeWorkspaceName(patch.name, stored.workspace_id),
    updated_at: now
  };
}
