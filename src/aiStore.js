import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_RECAP_MARKS, MAX_TRANSLATIONS } from './aiLimits.js';
import { readRecapMark } from './captionRecap.js';
import { TRANSLATION_PROMPT_VERSION } from './prompts/translate.js';

const STORE_VERSION = 1;

export function defaultAiDataDir(env = process.env, platform = process.platform) {
  if (env.REVIEW_MARKDOWN_DATA_DIR) return path.resolve(env.REVIEW_MARKDOWN_DATA_DIR);
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'review-markdown');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'review-markdown');
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'review-markdown');
}

export function projectStorageKey(rootDir) {
  return crypto.createHash('sha256').update(path.resolve(rootDir)).digest('hex').slice(0, 24);
}

/**
 * @param {object} target the snapshotted translation target.
 * @param {string} [readingContext] revision of the reading context the prompt carries.
 *   A different context can call for a different word, so it keys the cache too;
 *   documents without one keep the keys they already had.
 */
export function translationCacheKey(target, readingContext = '') {
  const relevant = {
    text: String(target?.selectedText || target?.targetText || ''),
    contextBefore: String(target?.contextBefore || ''),
    contextAfter: String(target?.contextAfter || ''),
    headingPath: Array.isArray(target?.headingPath) ? target.headingPath : [],
    // 文面を書き換えたのに版が据え置きだと、古い文面で作った訳を返し続けます。
    // 版はプロンプトの隣に置いてあるので、書き換えた側で上げてください。
    promptVersion: TRANSLATION_PROMPT_VERSION,
    ...(readingContext ? { readingContext } : {})
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

export class AiStore {
  constructor(rootDir, { dataDir = defaultAiDataDir() } = {}) {
    this.projectDir = path.join(dataDir, 'projects', projectStorageKey(rootDir));
    this.conversationsDir = path.join(this.projectDir, 'conversations');
    this.translationFile = path.join(this.projectDir, 'translation-cache.json');
    // 文字起こしをどこまで聞いたか。文書と一緒に配らないのは、これがレビューの成果物
    // ではなく、この端末のこの人がどこまで追いついたかという記録だからです。
    this.recapMarkFile = path.join(this.projectDir, 'caption-marks.json');
    this.writeQueue = Promise.resolve();
    this.translationCache = null;
    this.recapMarks = null;
  }

  async listConversations(documentPath) {
    await fs.mkdir(this.conversationsDir, { recursive: true, mode: 0o700 });
    const names = await fs.readdir(this.conversationsDir);
    const conversations = await Promise.all(names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          return JSON.parse(await fs.readFile(path.join(this.conversationsDir, name), 'utf8'));
        } catch {
          return null;
        }
      }));
    return conversations
      .filter((conversation) => conversation && (!documentPath || conversation.documentPath === documentPath))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async getConversation(id) {
    const filePath = this.conversationPath(id);
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveConversation(conversation) {
    const payload = { version: STORE_VERSION, ...conversation };
    await this.enqueueWrite(() => writeJsonAtomic(this.conversationPath(conversation.id), payload));
    return payload;
  }

  async deleteConversation(id) {
    const filePath = this.conversationPath(id);
    await this.enqueueWrite(async () => {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    });
  }

  async getTranslation(key) {
    const cache = await this.readTranslationCache();
    return cache.entries[key]?.value || null;
  }

  async saveTranslation(key, value) {
    await this.enqueueWrite(async () => {
      const cache = await this.readTranslationCache();
      cache.entries[key] = { value, updatedAt: new Date().toISOString() };
      const entries = Object.entries(cache.entries)
        .sort(([, a], [, b]) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, MAX_TRANSLATIONS);
      cache.entries = Object.fromEntries(entries);
      await writeJsonAtomic(this.translationFile, cache);
    });
  }

  /**
   * その文書を前回どこまで聞いたか。一度も聞いていなければ null です。
   * 壊れていても投げません（`readRecapMark` が読めない値を null にします）。
   */
  async getRecapMark(documentPath) {
    const marks = await this.readRecapMarks();
    return readRecapMark(marks.entries[documentPath]?.mark);
  }

  async saveRecapMark(documentPath, mark) {
    await this.enqueueWrite(async () => {
      const marks = await this.readRecapMarks();
      marks.entries[documentPath] = { mark, updatedAt: new Date().toISOString() };
      const entries = Object.entries(marks.entries)
        .sort(([, a], [, b]) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, MAX_RECAP_MARKS);
      marks.entries = Object.fromEntries(entries);
      await writeJsonAtomic(this.recapMarkFile, marks);
    });
  }

  conversationPath(id) {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(String(id))) throw new Error('Invalid conversation id');
    return path.join(this.conversationsDir, `${id}.json`);
  }

  async readTranslationCache() {
    if (this.translationCache) return this.translationCache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.translationFile, 'utf8'));
      this.translationCache = {
        version: STORE_VERSION,
        entries: parsed && typeof parsed.entries === 'object' ? parsed.entries : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      this.translationCache = { version: STORE_VERSION, entries: {} };
    }
    return this.translationCache;
  }

  async readRecapMarks() {
    if (this.recapMarks) return this.recapMarks;
    try {
      const parsed = JSON.parse(await fs.readFile(this.recapMarkFile, 'utf8'));
      this.recapMarks = {
        version: STORE_VERSION,
        entries: parsed && typeof parsed.entries === 'object' ? parsed.entries : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      this.recapMarks = { version: STORE_VERSION, entries: {} };
    }
    return this.recapMarks;
  }

  enqueueWrite(write) {
    const queued = this.writeQueue.then(write, write);
    this.writeQueue = queued.catch(() => {});
    return queued;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}
