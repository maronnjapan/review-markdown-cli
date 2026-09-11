/**
 * Contextそのものの形と、受け取った値の検証です。
 *
 * Contextは「ユーザーが再利用したいと決めた判断や知識」1件です。ローカルのファイルとは
 * 別物で、ファイルはCLIが毎回読み直せば足りるのに対し、Contextは書いた本人が消すまで
 * 残り、次の会話の前提になります。だから受け取るときだけは厳しく見ます。壊れた1件が
 * 入ると、以後の回答がその1件に引きずられ、しかもユーザーからは見えません。
 *
 * ── scope と scope_path を一緒に見る理由 ────────────────────
 * 範囲は2つの欄に分かれて入りますが、意味は1つです。`scope = path` なのに対象ディレクトリ
 * が無いContextは、どこで効くのか誰にも決められません。逆に `scope = workspace` に
 * ディレクトリが入っていると、保存した人は絞ったつもりで、検索は絞りません。どちらも
 * 保存できてしまうと、あとから「効かない前提」を探すことになるので、ここで断ります。
 *
 * ── 絶対パスを受け取らない理由 ────────────────────────────
 * `scope_path` はWorkspace Rootからの相対パスだけです。`C:\Users\xxx\project\src\auth` の
 * ような絶対パスを保存すると、別のPCで同じWorkspaceを開いたときに一致しません。
 * Workspaceをパスではなくidで持たせているのと同じ理由です（`src/workspace.js`）。
 *
 * ── kind を最初から持たせる理由 ───────────────────────────
 * 「常にTypeScriptのstrictモードで書く」という個人の作法と、「このプロジェクトはOIDCを
 * 使う」という決定は、回答での扱いが違います。前者は破っていたら直すもの、後者は
 * 前提として置くものです。MVPでは順位付けに使いませんが、欄が無いとあとから
 * 保存済みのContextを読み直して分類することになるので、最初から受け取ります。
 */

import crypto from 'node:crypto';

/** 適用範囲。`workspace`（このWorkspace全体） / `path`（特定ディレクトリ以下） / `global`（Workspaceを問わない）。 */
export const CONTEXT_SCOPES = Object.freeze(['workspace', 'path', 'global']);

/** Contextの種類。`decision`（プロジェクトの決定） / `preference`（好み・作法） / `note`（その他）。 */
export const CONTEXT_KINDS = Object.freeze(['decision', 'preference', 'note']);

/** 保存の起点。`manual`（ユーザー操作） / `comment`（コメントからの昇格） / `agent`（AIの提案の承認）。 */
export const CONTEXT_SOURCE_TYPES = Object.freeze(['manual', 'comment', 'agent']);

/** 既定の種類。分からないものは、決定でも作法でもなく知識として置きます。 */
const DEFAULT_KIND = 'note';

/** 既定の起点。APIを直に叩いた保存は、ユーザーが自分で決めたものとして扱います。 */
const DEFAULT_SOURCE_TYPE = 'manual';

/**
 * Context 1件の本文の上限です。
 *
 * 超えたぶんを切り詰めないのは、切り詰めた前提が、書いた人には全文のつもりで
 * 残り続けるからです。長いものは分けて保存してもらいます。
 */
export const MAX_CONTENT_CHARS = 8000;

/** Workspace idとパスの上限。長い値でファイル名や検索を膨らませないためだけのものです。 */
const MAX_ID_CHARS = 128;
const MAX_PATH_CHARS = 1024;

export function contextApiError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * `POST /contexts` が受け取った値をContextへ組み立てます。
 * 受け付けられない値は 400 で断ります（`server.js` がそのまま返します）。
 */
export function buildContext(input = {}, { now = new Date().toISOString(), id = createContextId() } = {}) {
  const scope = normalizeScope(input.scope);
  const createdAt = timestamp(input.created_at) || now;
  return {
    context_id: id,
    workspace_id: normalizeWorkspaceId(input.workspace_id, scope),
    content: normalizeContent(input.content),
    scope,
    scope_path: normalizeScopePath(input.scope_path, scope),
    kind: normalizeChoice(input.kind, CONTEXT_KINDS, DEFAULT_KIND, 'kind'),
    source_type: normalizeChoice(input.source_type, CONTEXT_SOURCE_TYPES, DEFAULT_SOURCE_TYPE, 'source_type'),
    source_path: normalizeOptionalPath(input.source_path, 'source_path'),
    created_at: createdAt,
    updated_at: timestamp(input.updated_at) || createdAt
  };
}

/**
 * `PATCH /contexts/{id}` の差分を当てます。送られてこなかった欄は保存済みのままです。
 *
 * 範囲だけを変えるときも、変えたあとの組み合わせで見直します。`scope` を `workspace` へ
 * 変えたのに `scope_path` が残っていると、絞ったつもりの前提が全体に効いてしまうからです。
 *
 * @returns {{context: object, contentChanged: boolean}} 本文が変わったかどうかは、
 *   呼ぶ側が再Chunking・再Embeddingの要否を決めるのに使います。
 */
export function applyContextPatch(stored, patch = {}, { now = new Date().toISOString() } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw contextApiError('更新内容はJSONオブジェクトで指定してください');
  }
  for (const key of ['context_id', 'workspace_id', 'created_at']) {
    if (patch[key] !== undefined && patch[key] !== stored[key]) {
      throw contextApiError(`${key} は更新できません`);
    }
  }
  const scope = patch.scope === undefined ? stored.scope : normalizeScope(patch.scope);
  // 範囲を変えたのにパスを送ってこない更新があるので、据え置きは変更後の範囲で見直します。
  const rawScopePath = patch.scope_path === undefined ? stored.scope_path : patch.scope_path;
  const content = patch.content === undefined ? stored.content : normalizeContent(patch.content);
  const context = {
    ...stored,
    content,
    scope,
    scope_path: normalizeScopePath(rawScopePath, scope),
    workspace_id: normalizeWorkspaceId(stored.workspace_id, scope),
    kind: patch.kind === undefined ? stored.kind : normalizeChoice(patch.kind, CONTEXT_KINDS, DEFAULT_KIND, 'kind'),
    source_type: patch.source_type === undefined
      ? stored.source_type
      : normalizeChoice(patch.source_type, CONTEXT_SOURCE_TYPES, DEFAULT_SOURCE_TYPE, 'source_type'),
    source_path: patch.source_path === undefined
      ? stored.source_path
      : normalizeOptionalPath(patch.source_path, 'source_path'),
    updated_at: now
  };
  return { context, contentChanged: content !== stored.content };
}

/** Contextのid。どのVector DBへ入れても使える形にしておきます。 */
export function createContextId() {
  return `ctx_${crypto.randomBytes(12).toString('hex')}`;
}

export function normalizeScope(value) {
  const scope = typeof value === 'string' ? value.trim() : '';
  if (!scope) throw contextApiError(`scope を指定してください（${CONTEXT_SCOPES.join(' / ')}）`);
  if (!CONTEXT_SCOPES.includes(scope)) {
    throw contextApiError(`使えない scope です: ${scope}（使えるもの: ${CONTEXT_SCOPES.join(', ')}）`);
  }
  return scope;
}

/**
 * Workspace id。`global` だけが持ちません。
 * 「どのWorkspaceでも使う知識」に特定のWorkspaceのidが付いていると、そのWorkspaceを
 * 消したときに道連れになります。
 */
export function normalizeWorkspaceId(value, scope) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (scope === 'global') {
    if (id) throw contextApiError('scope = global の Context に workspace_id は指定できません');
    return null;
  }
  if (!id) throw contextApiError(`scope = ${scope} の Context には workspace_id が必要です`);
  if (id.length > MAX_ID_CHARS) throw contextApiError('workspace_id が長すぎます');
  return id;
}

/**
 * 対象ディレクトリ。`path` のときだけ必要で、他の範囲では持てません。
 * 受け取るのはWorkspace Rootからの相対パスだけです（このモジュール冒頭の説明）。
 */
export function normalizeScopePath(value, scope) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (scope !== 'path') {
    if (raw) throw contextApiError(`scope = ${scope} の Context に scope_path は指定できません`);
    return null;
  }
  if (!raw) throw contextApiError('scope = path の Context には scope_path が必要です');
  return normalizeRelativePath(raw, 'scope_path');
}

/** 根拠になったファイル。あれば相対パスで持ちます。 */
export function normalizeOptionalPath(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw contextApiError(`${field} は文字列で指定してください`);
  const trimmed = value.trim();
  return trimmed ? normalizeRelativePath(trimmed, field) : null;
}

/**
 * Workspace Rootからの相対パスへ揃えます。区切りは `/` に統一します。
 *
 * Windowsで `src\auth` と保存したContextが、macOSで `src/auth` を開いたときに
 * 出てこない、という食い違いを起こさないためです。Context APIはWorkspaceの実ファイルを
 * 見ないので、ここで正規化しておく以外に揃える機会がありません。
 */
export function normalizeRelativePath(value, field = 'path') {
  const text = String(value).trim().replace(/\\/g, '/');
  if (text.length > MAX_PATH_CHARS) throw contextApiError(`${field} が長すぎます`);
  if (/^[a-zA-Z]:\//.test(text) || text.startsWith('/')) {
    throw contextApiError(`${field} は Workspace Root からの相対パスで指定してください: ${value}`);
  }
  const segments = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw contextApiError(`${field} に .. は使えません: ${value}`);
    segments.push(segment);
  }
  if (segments.length === 0) throw contextApiError(`${field} が空です`);
  return segments.join('/');
}

function normalizeContent(value) {
  if (typeof value !== 'string') throw contextApiError('content は文字列で指定してください');
  const content = value.trim();
  if (!content) throw contextApiError('content を指定してください');
  if (content.length > MAX_CONTENT_CHARS) {
    throw contextApiError(`content が長すぎます（${MAX_CONTENT_CHARS}文字まで）。分けて保存してください`);
  }
  return content;
}

function normalizeChoice(value, allowed, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw contextApiError(`使えない ${field} です: ${text}（使えるもの: ${allowed.join(', ')}）`);
  }
  return text;
}

function timestamp(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : '';
}
