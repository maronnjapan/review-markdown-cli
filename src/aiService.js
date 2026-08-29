import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aiContextBlock, hasAiContext, normalizeAiContext, resolveAiContext } from './aiContext.js';
import {
  CONVERSATION_TITLE_CHARS,
  MAX_EDIT_INSTRUCTION_CHARS,
  MAX_HEADING_DEPTH,
  MAX_MESSAGE_CHARS,
  MAX_NOTES_CHARS,
  MAX_TARGET_CHARS,
  TARGET_CONTEXT_CHARS,
  TERM_MAX_CHARS,
  TERM_MAX_WORDS
} from './aiLimits.js';
import { AiStore, defaultAiDataDir, translationCacheKey } from './aiStore.js';
import { CodexAppServer } from './codexAppServer.js';
import { purposeFor } from './codexProfiles.js';
import { collectCommentContext, commentContextBlock } from './commentContext.js';
import { buildBriefDraft, normalizeBriefInput } from './documentBrief.js';
import {
  REVISE_SCHEMA,
  buildEditProposals,
  documentRevision,
  extractEditableBlocks,
  revisePrompt
} from './documentEdits.js';
import {
  applyVerification,
  buildReviewFindings,
  reviewPrompt,
  reviewSchema,
  verificationPrompt,
  verificationSchema
} from './documentReview.js';
import { PERSONA_SCHEMA, buildPersona, normalizePersonaInput, personaPrompt } from './persona.js';
import {
  PLACEMENT_SCHEMA,
  buildPlacements,
  extractDocumentSegments,
  placementPrompt
} from './commentPlacement.js';
import { followUpChatPrompt, initialChatPrompt } from './prompts/chat.js';
import { BRIEF_SCHEMA, briefPrompt } from './prompts/manager.js';
import { PASSAGE_SCHEMA, TERM_SCHEMA, translationPrompt } from './prompts/translate.js';
import { listReviewSkills, readReviewSkill, readReviewSkills } from './reviewSkills.js';
import { readReview } from './reviewStore.js';

/**
 * AI機能の配線です。
 *
 * どの機能も形は同じで、「材料を集める → プロンプトを組む → Codexへ1ターン投げる →
 * 返ってきたJSONを整える」の4つしかしません。3番目は `askForJson` にまとめてあるので、
 * 各メソッドで読むべきなのは1・2・4だけです。
 *
 * 文面は `prompts/` に、量の上限は `aiLimits.js` に、どのモデルで読ませるかは
 * `codexProfiles.js` にあります。ここにはどれも書きません。
 */

/** 答えを解析できなかったときの文面。機能名だけが差し替わります。 */
const ANSWER_SUBJECTS = {
  translate: 'Codexの翻訳結果',
  place: 'Codexの配置結果',
  brief: '管理者が組み立てた目的・ストーリー・期待値',
  persona: 'Codexが組み直した読み手ペルソナ',
  review: 'Codexのレビュー結果',
  revise: 'Codexの修正案'
};

/**
 * Codexが返した失敗を、レビュアーが次に何をすればよいか分かる日本語にします。
 * 上から順に当てて、最初に一致したものを使います。
 */
const CODEX_ERROR_HINTS = [
  [/not found|ENOENT/i, 'Codexコマンドが見つかりません'],
  [/unauthorized|login|authentication/i, 'Codexへログインしてください'],
  [/usageLimit|usage limit/i, 'Codexの利用上限に達しました']
];

export function createAiService(rootDir, options = {}) {
  const dataDir = options.aiDataDir || defaultAiDataDir();
  const store = options.aiStore || new AiStore(rootDir, { dataDir });
  const runtimeDir = path.join(dataDir, 'runtime');
  const codex = options.codexClient || new CodexAppServer({ runtimeDir, models: options.aiModels });
  return new AiService(rootDir, {
    store,
    codex,
    projectContext: options.aiContext,
    managerEnabled: options.features?.manager === true
  });
}

export class AiService {
  constructor(rootDir, { store, codex, projectContext = '', managerEnabled = false }) {
    this.rootDir = rootDir;
    this.store = store;
    this.codex = codex;
    // The reading context from the config file or --ai-context. It applies to
    // every document under the review root; each document can add its own.
    this.projectContext = normalizeAiContext(projectContext, 'aiContext');
    this.managerEnabled = managerEnabled === true;
  }

  /**
   * What the AI should assume while reading one document: the project wide
   * context, what the document is for, the one saved with that document's
   * review, the notes the reviewer left on it, and the reader it is written for.
   *
   * 相談もレビューも翻訳も配置も、前提はこの1本から受け取ります。
   * 「残したメモの上でレビューする」が別配線ではなく既定の動きなのは、そのためです。
   */
  async readingContext(documentPath) {
    const { aiContext, brief, contextNotes, persona } = await readReview(this.rootDir, documentPath);
    return resolveAiContext({
      project: this.projectContext,
      document: aiContext,
      brief: this.managerEnabled ? brief : null,
      notes: contextNotes,
      persona
    });
  }

  async status() {
    try {
      await this.codex.start();
      return { available: true, provider: 'codex', model: this.codex.model, effort: this.codex.effort };
    } catch (error) {
      return { available: false, provider: 'codex', error: friendlyCodexError(error) };
    }
  }

  async translate(documentPath, target, { onDelta, signal } = {}) {
    const normalizedTarget = await this.snapshotTarget(documentPath, target);
    const readingContext = await this.readingContext(documentPath);
    // The context changes what a word should become, so it belongs in the key.
    const cacheKey = translationCacheKey(normalizedTarget, readingContext.revision);
    const cached = await this.store.getTranslation(cacheKey);
    if (cached) return { ...cached, cached: true };

    const term = isTerm(normalizedTarget.selectedText);
    const { answer } = await this.askForJson({
      feature: 'translate',
      prompt: translationPrompt(normalizedTarget, term, aiContextBlock(readingContext)),
      outputSchema: term ? TERM_SCHEMA : PASSAGE_SCHEMA,
      onDelta,
      signal
    });

    const value = { kind: term ? 'term' : 'passage', result: answer, cached: false };
    await this.store.saveTranslation(cacheKey, value);
    return value;
  }

  /**
   * Finds where the reviewer's notes belong. Nothing is saved here: the answer
   * is a set of proposals the reviewer accepts one by one in the UI.
   */
  async placeComments(documentPath, notes, { onDelta, signal } = {}) {
    const reviewerNotes = String(notes || '').trim();
    if (!reviewerNotes) throw new Error('指摘コメントを入力してください');
    if (reviewerNotes.length > MAX_NOTES_CHARS) throw new Error('指摘コメントが長すぎます');

    const segments = await this.readSegments(documentPath, 'コメントを付けられる本文が見つかりません');
    const readingContext = await this.readingContext(documentPath);
    const { answer } = await this.askForJson({
      feature: 'place',
      prompt: placementPrompt(segments, reviewerNotes, readingContext),
      outputSchema: PLACEMENT_SCHEMA,
      onDelta,
      signal
    });
    return buildPlacements(segments, answer);
  }

  /** どのレビュースキルを選べるか。Codexは要らないので、起動前でも答えられます。 */
  listReviewSkills() {
    return listReviewSkills(this.rootDir);
  }

  /**
   * 1つのスキルの中身。選ぶ前に「このスキルは何を見るのか」を画面で読めるように、
   * プロンプトへ載せるのと同じ本文をそのまま返します。
   */
  readReviewSkill(skillId) {
    return readReviewSkill(this.rootDir, skillId);
  }

  /**
   * レビュアーの走り書きから、資料の管理者に目的・ストーリー・期待値を組み立てさせます。
   * 保存はしません。組み立てた結果と、埋まらなかった項目への問いを返します。
   */
  async composeDocumentBrief(documentPath, input, { onDelta, signal } = {}) {
    const notes = normalizeBriefInput(input);
    if (!notes) throw new Error('決まっていることを入力してください');

    // 本文は渡しません。すでに書かれているものから目的を起こすと、書いてあることが
    // そのまま目的になります。それは「作る前に目的を決める」の逆で、手段が目的に
    // 化けた状態を追認するだけです。保存済みのブリーフも混ぜません。組み直しの材料は
    // 走り書きだけ、というのは読み手ペルソナと同じです。
    const { aiContext, contextNotes, persona } = await readReview(this.rootDir, documentPath);
    const readingContext = resolveAiContext({
      project: this.projectContext,
      document: aiContext,
      notes: contextNotes,
      persona
    });
    const { answer } = await this.askForJson({
      feature: 'brief',
      prompt: briefPrompt(notes, aiContextBlock(readingContext)),
      outputSchema: BRIEF_SCHEMA,
      onDelta,
      signal
    });
    return buildBriefDraft(answer);
  }

  /**
   * レビュアーの走り書きを、読み手ペルソナへ組み直します。
   * 保存はしません。組み直した結果を確認したレビュアーが保存します。
   */
  async composePersona(documentPath, input, { onDelta, signal } = {}) {
    const notes = normalizePersonaInput(input);
    if (!notes) throw new Error('読み手ペルソナの説明を入力してください');

    // 組み直しの材料は走り書きだけです。保存済みのペルソナは前提に混ぜません。
    // 読み取りコンテキストと残したメモ、そして管理者が決めた3点は渡します。
    // どんな原稿の読み手なのかが決まるからで、なかでも期待値は「読んだあと何ができれば
    // よいか」なので、読み手そのものの説明に一番近い前提です。
    const { aiContext, brief, contextNotes } = await readReview(this.rootDir, documentPath);
    const readingContext = resolveAiContext({
      project: this.projectContext,
      document: aiContext,
      brief: this.managerEnabled ? brief : null,
      notes: contextNotes
    });
    const { answer } = await this.askForJson({
      feature: 'persona',
      prompt: personaPrompt(notes, aiContextBlock(readingContext)),
      outputSchema: PERSONA_SCHEMA,
      onDelta,
      signal
    });
    return buildPersona(answer, notes);
  }

  /**
   * 選んだレビュースキル（複数可）と、保存済みの読み手ペルソナで文書をレビューします。
   * 返すのはコメント候補で、レビューファイルへは何も書きません。
   *
   * 読みは2周します。1周目で指摘を出させ、2周目で同じスレッドにその指摘を反証させます。
   * `onPhase` はいまどちらを読んでいるかで、待っている画面へ出すためのものです。
   */
  async reviewDocument(documentPath, { skillIds, skillId } = {}, { onDelta, onPhase = () => {}, signal } = {}) {
    const skills = await readReviewSkills(this.rootDir, skillIds ?? skillId);
    const segments = await this.readSegments(documentPath, 'レビューできる本文が見つかりません');
    const readingContext = await this.readingContext(documentPath);

    onPhase('reading');
    const { answer, threadId } = await this.askForJson({
      feature: 'review',
      prompt: reviewPrompt(segments, skills, readingContext),
      outputSchema: reviewSchema(skills),
      onDelta,
      signal
    });

    const { verdicts, verified } = await this.refuteFindings({
      threadId, answer, segments, skills, readingContext, onDelta, onPhase, signal
    });
    const { answer: checked, refuted } = applyVerification(answer, verdicts);
    return {
      skills: skills.map(({ id, name, source }) => ({ id, name, source })),
      persona: readingContext.persona,
      // 反証まで通ったかどうかは、指摘をどれだけ信じてよいかの目安になるので画面へ出します。
      verified,
      refuted,
      ...buildReviewFindings(segments, checked, skills)
    };
  }

  /**
   * 2周目。1周目の指摘を、同じスレッドに反証させます。
   *
   * 失敗しても投げません。反証は指摘の精度を上げる工程であって、レビューそのものでは
   * ないので、ここで止めるとレビュアーは1周目の指摘まで受け取れなくなります。
   * `verified` は「反証まで通ったか」で、指摘が0件だったレビューも通ったものとして扱います。
   * 確かめる対象が無かっただけで、失敗ではないからです。
   */
  async refuteFindings({ threadId, answer, segments, skills, readingContext, onDelta, onPhase, signal }) {
    const findings = (answer?.placements?.length || 0) + (answer?.unplaced?.length || 0);
    if (findings === 0) return { verdicts: { verdicts: [], unplacedVerdicts: [] }, verified: true };

    onPhase('verifying');
    try {
      const { answer: verdicts } = await this.askForJson({
        feature: 'review',
        threadId,
        prompt: verificationPrompt(answer, segments, skills, readingContext),
        outputSchema: verificationSchema(),
        onDelta,
        signal
      });
      return { verdicts, verified: true };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return { verdicts: null, verified: false };
    }
  }

  /**
   * 本文の修正案を作ります。書き込みはしません。返すのは候補で、レビュアーが承認した
   * ぶんだけが `/api/file` を通ってファイルへ入ります。
   *
   * 材料は2つです。レビュアーがその場で書いた指示と、その文書に残っている未解決の
   * レビューコメント。どちらも無いときは頼みません。何を直すかが決まっていない状態で
   * 走らせると、頼んでいない書き換えが並ぶだけだからです。
   *
   * 一緒に返す `documentRevision` は、候補を作ったときの本文のハッシュです。
   * 適用のとき、そこから本文が変わっていないことを確かめるのに使います。
   */
  async proposeEdits(documentPath, instruction, { onDelta, signal } = {}) {
    const request = String(instruction || '').trim();
    if (request.length > MAX_EDIT_INSTRUCTION_CHARS) {
      throw new Error(`修正の指示が長すぎます（${MAX_EDIT_INSTRUCTION_CHARS}文字まで）`);
    }

    const markdown = await this.readDocument(documentPath);
    const { blocks, dropped } = extractEditableBlocks(markdown);
    if (blocks.length === 0) throw new Error('修正できる本文が見つかりません');

    // 依頼として渡すのは未解決のコメントだけです。解決済みは手当て済みだからです。
    const comments = await collectCommentContext(this.rootDir, documentPath, { type: 'document' }, { openOnly: true });
    if (!request && comments.entries.length === 0) {
      throw new Error('修正の指示を書くか、未解決のレビューコメントを残してから実行してください');
    }

    const readingContext = await this.readingContext(documentPath);
    const { answer } = await this.askForJson({
      feature: 'revise',
      prompt: revisePrompt(blocks, { instruction: request, comments, readingContext }),
      outputSchema: REVISE_SCHEMA,
      onDelta,
      signal
    });

    return {
      documentRevision: documentRevision(markdown),
      // 何を材料に作った候補かは、画面に出します。コメントを直すつもりで走らせて
      // 1件も渡っていなかった、が黙って起きないようにするためです。
      requestedComments: comments.entries.length,
      droppedComments: comments.dropped,
      droppedBlocks: dropped,
      ...await buildEditProposals(blocks, answer)
    };
  }

  async listConversations(documentPath) {
    return this.store.listConversations(documentPath);
  }

  async createConversation({ documentPath, target }) {
    const normalizedTarget = await this.snapshotTarget(documentPath, target);
    const now = new Date().toISOString();
    const conversation = {
      id: crypto.randomUUID(),
      documentPath,
      documentRevision: normalizedTarget.documentRevision,
      target: normalizedTarget,
      codexThreadId: null,
      title: conversationTitle(normalizedTarget),
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    return this.store.saveConversation(conversation);
  }

  async sendMessage(conversationId, message, { onDelta, signal } = {}) {
    const content = String(message || '').trim();
    if (!content) throw new Error('メッセージを入力してください');
    if (content.length > MAX_MESSAGE_CHARS) throw new Error('メッセージが長すぎます');

    const conversation = await this.store.getConversation(conversationId);
    if (!conversation) throw new Error('会話が見つかりません');
    // 質問はCodexへ投げる前に保存します。途中で失敗しても、何を聞いたかは残ります。
    await this.appendMessage(conversation, 'user', content);

    try {
      const { threadId, firstTurn } = await this.openConversationThread(conversation);
      const comments = await collectCommentContext(this.rootDir, conversation.documentPath, conversation.target);
      const readingContext = await this.readingContext(conversation.documentPath);
      const { text } = await this.codex.runTurn({
        threadId,
        prompt: chatPrompt(conversation, content, comments, readingContext, firstTurn),
        onDelta,
        signal
      });
      conversation.commentsRevision = comments.revision;
      conversation.contextRevision = readingContext.revision;
      const assistantMessage = await this.appendMessage(conversation, 'assistant', text);
      return { conversation, message: assistantMessage };
    } catch (error) {
      conversation.updatedAt = new Date().toISOString();
      conversation.lastError = friendlyCodexError(error);
      await this.store.saveConversation(conversation);
      throw error;
    }
  }

  async deleteConversation(id) {
    const conversation = await this.store.getConversation(id);
    if (conversation?.codexThreadId) {
      try {
        await this.codex.deleteThread(conversation.codexThreadId);
      } catch {
        // The app transcript remains deletable even if Codex already lost its session.
      }
    }
    await this.store.deleteConversation(id);
  }

  async snapshotTarget(documentPath, target) {
    const normalized = normalizeTarget(target);
    if (normalized.type !== 'document') return normalized;
    const markdown = await this.readDocument(documentPath, '文書全体が長すぎます。セクションを選択してください');
    return {
      ...normalized,
      selectedText: markdown,
      documentRevision: crypto.createHash('sha256').update(markdown).digest('hex')
    };
  }

  close() {
    return this.codex.close();
  }

  /* ---------------------------------------------------------------- *
   * 共通の手順
   * ---------------------------------------------------------------- */

  /**
   * Codexへ1ターン投げて、JSONの答えを受け取ります。どの機能もここを通ります。
   *
   * `threadId` を渡すとそのスレッドで続けます。渡さなければ新しく開きます。
   * どのモデルで読ませるかは機能名から決まるので（`codexProfiles.js`）、
   * 呼ぶ側がモデルを気にすることはありません。
   *
   * @returns {Promise<{answer: object, threadId: string}>}
   *   `threadId` を返すのは、AIレビューが2周目を同じスレッドで続けるためです。
   */
  async askForJson({ feature, threadId, prompt, outputSchema, onDelta, signal }) {
    const purpose = purposeFor(feature);
    const thread = threadId || await this.codex.createThread({ ephemeral: true, purpose });
    const { text } = await this.codex.runTurn({ threadId: thread, prompt, outputSchema, onDelta, signal });
    try {
      return { answer: JSON.parse(text), threadId: thread };
    } catch {
      throw new Error(`${ANSWER_SUBJECTS[feature]}を解析できませんでした`);
    }
  }

  /** 対象の文書。長すぎるものは、この先どの機能でも扱えないのでここで断ります。 */
  async readDocument(documentPath, tooLongMessage = '文書全体が長すぎます。ファイルを分割してください') {
    const markdown = await fs.readFile(path.join(this.rootDir, documentPath), 'utf8');
    if (markdown.length > MAX_TARGET_CHARS) throw new Error(tooLongMessage);
    return markdown;
  }

  /** モデルへ渡す本文ブロック。1つも取れない文書は、指す場所が無いので断ります。 */
  async readSegments(documentPath, emptyMessage) {
    const segments = await extractDocumentSegments(await this.readDocument(documentPath));
    if (segments.length === 0) throw new Error(emptyMessage);
    return segments;
  }

  /** 会話へ1件足して保存します。保存まで済ませるので、呼んだ時点で記録は残ります。 */
  async appendMessage(conversation, role, content) {
    const message = { id: crypto.randomUUID(), role, content, createdAt: new Date().toISOString() };
    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;
    await this.store.saveConversation(conversation);
    return message;
  }

  /**
   * 会話のCodexスレッド。前のスレッドが残っていれば再開し、Codex側で失われていれば
   * 開き直します。開き直したときは1回目として扱います。モデルは何も覚えていないからです。
   */
  async openConversationThread(conversation) {
    if (conversation.codexThreadId) {
      try {
        await this.codex.resumeThread(conversation.codexThreadId);
        return { threadId: conversation.codexThreadId, firstTurn: false };
      } catch {
        conversation.codexThreadId = null;
      }
    }
    conversation.codexThreadId = await this.codex.createThread({
      ephemeral: false,
      purpose: purposeFor('chat')
    });
    await this.store.saveConversation(conversation);
    return { threadId: conversation.codexThreadId, firstTurn: true };
  }
}

/**
 * 1回目は読ませたいものを全部並べ、2回目以降はスレッドに任せます。
 * ただしコメントと前提だけは、会話中に書き換わっていれば添え直します。
 */
function chatPrompt(conversation, userMessage, comments, readingContext, firstTurn) {
  if (firstTurn) {
    return initialChatPrompt(
      conversation,
      userMessage,
      comments.entries.length ? commentContextBlock(comments) : '',
      aiContextBlock(readingContext)
    );
  }
  return followUpChatPrompt(userMessage, {
    commentsBlock: commentsChanged(conversation, comments) ? commentContextBlock(comments) : null,
    readingContextBlock: contextChanged(conversation, readingContext) ? aiContextBlock(readingContext) : null
  });
}

function commentsChanged(conversation, comments) {
  // A conversation started before comments travelled with a chat, on a document
  // without any, has nothing to catch up on either.
  if (!conversation.commentsRevision && comments.entries.length === 0) return false;
  return comments.revision !== conversation.commentsRevision;
}

function contextChanged(conversation, readingContext) {
  // Same for a conversation from before reading contexts existed: with none set
  // now, there is nothing the model has yet to read.
  if (!conversation.contextRevision && !hasAiContext(readingContext)) return false;
  return readingContext.revision !== conversation.contextRevision;
}

function normalizeTarget(target) {
  const selectedText = String(target?.selectedText || target?.targetText || '').trim();
  if (!selectedText && target?.type !== 'document') throw new Error('翻訳・相談の対象がありません');
  if (selectedText.length > MAX_TARGET_CHARS) throw new Error('対象文章が長すぎます');
  return {
    type: ['text-selection', 'paragraph', 'section', 'document'].includes(target?.type)
      ? target.type
      : 'text-selection',
    selectedText,
    contextBefore: String(target?.contextBefore || '').slice(-TARGET_CONTEXT_CHARS),
    contextAfter: String(target?.contextAfter || '').slice(0, TARGET_CONTEXT_CHARS),
    headingPath: Array.isArray(target?.headingPath)
      ? target.headingPath.map(String).filter(Boolean).slice(0, MAX_HEADING_DEPTH)
      : [],
    sourceStart: Number.isInteger(target?.sourceStart) ? target.sourceStart : null,
    sourceEnd: Number.isInteger(target?.sourceEnd) ? target.sourceEnd : null,
    documentRevision: target?.documentRevision || null
  };
}

/** 短い語なら意味を引き、それ以外は文章として訳します。境目は `aiLimits.js`。 */
function isTerm(text) {
  return text.length <= TERM_MAX_CHARS
    && text.split(/\s+/).filter(Boolean).length <= TERM_MAX_WORDS
    && !/[.!?]\s*$/.test(text);
}

function conversationTitle(target) {
  if (target.type === 'document') return '文書全体についての会話';
  const text = target.selectedText.replace(/\s+/g, ' ').trim();
  return text.length > CONVERSATION_TITLE_CHARS ? `${text.slice(0, CONVERSATION_TITLE_CHARS)}…` : text;
}

function friendlyCodexError(error) {
  if (error?.name === 'AbortError') return error.message;
  const message = String(error?.message || error);
  return CODEX_ERROR_HINTS.find(([pattern]) => pattern.test(message))?.[1] || message;
}
