import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aiContextBlock, hasAiContext, normalizeAiContext, resolveAiContext } from './aiContext.js';
import {
  CONVERSATION_TITLE_CHARS,
  MAX_EDIT_INSTRUCTION_CHARS,
  MAX_EXISTING_TASKS_IN_PROMPT,
  MAX_HEADING_DEPTH,
  MAX_MESSAGE_CHARS,
  MAX_NOTES_CHARS,
  MAX_TARGET_CHARS,
  TARGET_CONTEXT_CHARS,
  TERM_MAX_CHARS,
  TERM_MAX_WORDS
} from './aiLimits.js';
import { AiStore, defaultAiDataDir, translationCacheKey } from './aiStore.js';
import { detectSourceKind, isTaskCommitted, readExtractionAnswer, readTaskResult, sliceTaskSource } from './autoTasks.js';
import {
  RECAP_SCHEMA,
  buildRecap,
  normalizeRecapRequest,
  parseCaptionEntries,
  recapPrompt,
  selectRecapWindow
} from './captionRecap.js';
import {
  DEFAULT_AI_PROVIDER,
  createAiClient,
  listProviderChoices,
  providerLabel
} from './aiProviders/index.js';
import { purposeFor } from './codexProfiles.js';
import { collectCommentContext, commentContextBlock } from './commentContext.js';
import { applyConversationEdits } from './conversationEdits.js';
import { readDirectoryContext } from './directoryContext.js';
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
import { TASK_RESULT_SCHEMA, extractTasksPrompt, performTaskPrompt, taskExtractionSchema } from './prompts/tasks.js';
import { PASSAGE_SCHEMA, TERM_SCHEMA, translationPrompt } from './prompts/translate.js';
import { listReferenceFiles, readReferenceFiles } from './referenceFiles.js';
import { deleteReviewSkill, listReviewSkills, readReviewSkill, readReviewSkills, saveReviewSkill } from './reviewSkills.js';
import { readReview } from './reviewStore.js';

/**
 * AI機能の配線です。
 *
 * どの機能も形は同じで、「材料を集める → プロンプトを組む → AIへ1ターン投げる →
 * 返ってきたJSONを整える」の4つしかしません。3番目は `askForJson` にまとめてあるので、
 * 各メソッドで読むべきなのは1・2・4だけです。
 *
 * 文面は `prompts/` に、量の上限は `aiLimits.js` に、どのAIで読ませるかは
 * `aiProviders/` にあります。ここにはどれも書きません。どのAIを選んでも、ここから
 * 見える形は同じです。
 */

/** 答えを解析できなかったときの文面。機能名だけが差し替わります。 */
const ANSWER_SUBJECTS = {
  translate: 'AIの翻訳結果',
  place: 'AIの配置結果',
  brief: '管理者が組み立てた目的・ストーリー・期待値',
  persona: 'AIが組み直した読み手ペルソナ',
  review: 'AIのレビュー結果',
  revise: 'AIの修正案',
  recap: '直近の文字起こしの要約',
  tasks: '自動タスクの抽出結果',
  taskRun: '自動タスクの実行結果'
};

export function createAiService(rootDir, options = {}) {
  const dataDir = options.aiDataDir || defaultAiDataDir();
  const store = options.aiStore || new AiStore(rootDir, { dataDir });
  const runtimeDir = path.join(dataDir, 'runtime');
  const client = options.aiClient || createAiClient({
    provider: options.aiProvider,
    modelProvider: options.aiModelProvider,
    models: options.aiModels,
    runtimeDir
  });
  return new AiService(rootDir, {
    store,
    client,
    projectContext: options.aiContext,
    managerEnabled: options.features?.manager === true
  });
}

export class AiService {
  constructor(rootDir, { store, client, projectContext = '', managerEnabled = false }) {
    this.rootDir = rootDir;
    this.store = store;
    // どのAIかは `aiProviders/` が決めます。ここから先は、相手が誰でも同じ扱いです。
    this.ai = client;
    // The reading context from the config file or --ai-context. It applies to
    // every document under the review root; each document can add its own.
    // 同じく配下すべてに効く「画面で書いたディレクトリ全体の前提」は、書き換えられる
    // たびに読み直すので、ここでは持ちません（`readingContext()`）。
    this.projectContext = normalizeAiContext(projectContext, 'aiContext');
    this.managerEnabled = managerEnabled === true;
  }

  /**
   * What the AI should assume while reading one document: the project wide
   * context, what the document is for, the one saved with that document's
   * review, the notes the reviewer left on it, the reader it is written for,
   * and the files the reviewer attached from next to the document.
   *
   * 相談もレビューも翻訳も配置も、前提はこの1本から受け取ります。
   * 「残したメモの上でレビューする」「添えた用語集の上でレビューする」が別配線ではなく
   * 既定の動きなのは、そのためです。
   *
   * 参照ファイルはここで毎回読み直します。前提として渡すのは保存したパスではなく
   * 中身なので、隣のファイルを直したら次のAI操作からその中身で読ませます。
   *
   * ディレクトリ全体の前提（`directoryContext.js`）も毎回読み直します。画面から
   * 書き換えられるものなので、起動時に読んだきりだと、書き換えても立ち上げ直すまで
   * 効きません。設定ファイルの `projectContext` が起動時のままなのとは、ここが違います。
   */
  async readingContext(documentPath) {
    const [{ aiContext, brief, contextNotes, persona, referenceFiles }, directoryContext] = await Promise.all([
      readReview(this.rootDir, documentPath),
      readDirectoryContext(this.rootDir)
    ]);
    return resolveAiContext({
      project: this.projectContext,
      directory: directoryContext,
      document: aiContext,
      brief: this.managerEnabled ? brief : null,
      notes: contextNotes,
      persona,
      files: await readReferenceFiles(this.rootDir, documentPath, referenceFiles)
    });
  }

  /**
   * その文書に添えられるファイル。同階層以下だけを返します。
   * AIは要らないので、起動前でも答えられます（レビュースキルの一覧と同じです）。
   */
  listReferenceFiles(documentPath) {
    return listReferenceFiles(this.rootDir, documentPath);
  }

  async status() {
    const provider = this.ai.provider || 'codex';
    const label = providerLabel(provider);
    try {
      await this.ai.start();
      return { available: true, provider, label, model: this.ai.model, effort: this.ai.effort };
    } catch (error) {
      return { available: false, provider, label, error: this.describeError(error) };
    }
  }

  /**
   * 画面の設定へ出す、選べるものと、いま走っているもの。
   *
   * 一覧を引けなくても投げません。設定の画面はモデルを選ぶだけの場所ではなく、翻訳機能の
   * 入り切りもここにあります。一覧が引けないだけで、その画面ごと開けなくなるのは行き過ぎです。
   *
   * 引けなかったときも、空の一覧だけを返して黙るのはやめました。選べるものが1つも無い画面は、
   * 「このAIには選択肢が無い」のか「取りに行けなかった」のかを見分けられないからです。
   * 代わりに、選べない理由（`modelsUnavailable` / `effortsUnavailable`）を一緒に返します。
   * 走らせていないAIも `providers` に残します。どれも画面では非アクティブな選択肢として並び、
   * 選べるようにするための1行（`command`）が添えられます。
   */
  async modelChoices() {
    const { models, error } = await this.listModels();
    const supportsEffort = this.ai.supportsEffort !== false;
    return {
      providers: listProviderChoices(this.ai.provider || DEFAULT_AI_PROVIDER),
      models,
      // 一覧が空でも欄は消しません。理由が読めれば、モデル名を手で書けば済むのか、
      // AIの側を直すのかを、画面を離れずに選び分けられます。
      modelsUnavailable: models.length
        ? null
        : (error || 'このAIは選べるモデルの一覧を持っていないので、モデル名を書いてください。'),
      // 推論強度の選択肢は、どのモデルにも当たるものだけを並べます。モデルによっては
      // 受け付けないものが混ざるので、選んだあと当てるときにもう一度確かめます。
      efforts: [...new Set(models.flatMap((entry) => entry.efforts || []))],
      supportsEffort,
      effortsUnavailable: supportsEffort
        ? null
        : `${providerLabel(this.ai.provider || DEFAULT_AI_PROVIDER)} は共通の推論強度を受け付けません。`,
      running: {
        assistant: { model: this.ai.model ?? null, effort: this.ai.effort ?? null },
        review: { model: this.ai.reviewModel ?? null, effort: this.ai.reviewEffort ?? null }
      }
    };
  }

  /**
   * 選べるモデルの一覧。引けなかった理由も一緒に返します。
   * 投げないのは `modelChoices` の説明のとおりですが、握り潰しもしません。
   */
  async listModels() {
    try {
      return { models: (await this.ai.listModels?.()) || [], error: null };
    } catch (error) {
      return { models: [], error: this.describeError(error) };
    }
  }

  /**
   * 使うモデルを選び直します。画面の設定から呼びます。
   *
   * 名指ししたモデルをそのAIが持っていなければ投げて、走っているモデルはそのままです。
   * 保存済みの会話はそのまま続きます。差し替わるのは次のターンから使うモデルだけです。
   */
  async applyModels(models) {
    if (typeof this.ai.setModels !== 'function') {
      throw new Error('このAIは画面からモデルを変えられません');
    }
    // 起動していないAIは、名指しされたモデルを持っているかを確かめようがありません。
    // 確かめられる状態にしてから当てます。起動できなければ、設定ファイルに書いたときと
    // 同じで、確かめるのは次に起動できたときです。
    await this.ai.start().catch(() => {});
    this.ai.setModels(models);
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

  /** どのレビュースキルを選べるか。AIは要らないので、起動前でも答えられます。 */
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

  saveReviewSkill(input) { return saveReviewSkill(this.rootDir, input); }
  deleteReviewSkill(skillId) { return deleteReviewSkill(this.rootDir, skillId); }

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
    // 参照ファイルも同じ理由で渡しません。隣に置いてある資料は「すでに書かれているもの」
    // そのもので、そこから目的を起こすのは本文から起こすのと変わりません。
    const [{ aiContext, contextNotes, persona }, directoryContext] = await Promise.all([
      readReview(this.rootDir, documentPath),
      readDirectoryContext(this.rootDir)
    ]);
    const readingContext = resolveAiContext({
      project: this.projectContext,
      directory: directoryContext,
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
    // 参照ファイルも渡しません。読み手が誰かは隣の資料ではなく、レビュアーの走り書きと
    // 決めた3点から決まるもので、添えた章を読ませても入力が重くなるだけです。
    // 読み取りコンテキストと残したメモ、そして管理者が決めた3点は渡します。
    // どんな原稿の読み手なのかが決まるからで、なかでも期待値は「読んだあと何ができれば
    // よいか」なので、読み手そのものの説明に一番近い前提です。
    const [{ aiContext, brief, contextNotes }, directoryContext] = await Promise.all([
      readReview(this.rootDir, documentPath),
      readDirectoryContext(this.rootDir)
    ]);
    const readingContext = resolveAiContext({
      project: this.projectContext,
      directory: directoryContext,
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

  /**
   * いま「直近」がどこからどこまでになるか。AIは使いません。
   *
   * 聞き直す前に画面へ出すためのものです。押してから範囲が分かるのでは、
   * 「どこまでが直近なのか」をレビュアーが確かめる手立てがありません。
   * 実際に読ませるときも同じ `selectRecapWindow` を通すので、出した範囲と
   * 読ませる範囲は必ず一致します。
   */
  async recapWindow(documentPath, input) {
    const request = normalizeRecapRequest(input);
    const entries = await this.readCaptionEntries(documentPath);
    return selectRecapWindow(entries, { ...request, mark: await this.store.getRecapMark(documentPath) });
  }

  /**
   * 直近の文字起こしから、言われたことと、それを踏まえて次にすることを出します。
   *
   * 読ませるのは切り出した窓だけです。会議が2時間続いていても、渡すのは直近の
   * ひとまとまりなので、待ち時間は会議の長さでは増えません。
   */
  async recapCaptions(documentPath, input, { onDelta, signal } = {}) {
    const request = normalizeRecapRequest(input);
    const entries = await this.readCaptionEntries(documentPath);
    if (entries.length === 0) throw new Error('この文書には文字起こしの発言が見つかりません');

    const window = selectRecapWindow(entries, { ...request, mark: await this.store.getRecapMark(documentPath) });
    if (window.entries.length === 0) {
      throw new Error(window.reason === 'no-new-entries'
        ? '前回聞いたところから、新しい発言はありません'
        : '読ませる発言がありません');
    }

    const readingContext = await this.readingContext(documentPath);
    const { answer } = await this.askForJson({
      feature: 'recap',
      prompt: recapPrompt(window, request.question, readingContext),
      outputSchema: RECAP_SCHEMA,
      onDelta,
      signal
    });

    // 「ここまで聞いた」を覚えるのは、答えを受け取ってからです。途中で失敗したぶんまで
    // 聞いたことにすると、次に「前回から」で押したときにその区間が飛びます。
    if (window.mark) await this.store.saveRecapMark(documentPath, window.mark);
    return buildRecap(answer, window, { question: request.question });
  }

  /**
   * 文字起こしや資料から「やること」を起こします。保存はしません。
   *
   * 返すのは、受け取れる形に整えた答えと、今回どこまで読んだか（`source`）です。記録へ
   * 重ねるのは `autoTasks.js` の `applyExtraction`、いつ呼ぶかを決めるのは
   * `autoTaskRunner.js` です。本文を `readDocument` に通さないのは、長さで断らないためです
   * （聞き直しと同じ理由）。渡すのは前回から増えた分か、長すぎれば末尾からだけで、
   * 切り出しは `sliceTaskSource` が決めます。
   *
   * @param {object} input
   * @param {object} input.record その文書の記録（`readTasks`）。既存タスクと前回の解析を読みます。
   * @param {string[]} input.actions 任せている自動化。整理と今すべきことを頼むかがこれで決まります。
   * @param {string} input.instructions 特にしてほしいこと。
   * @param {boolean} input.captioned この起動中に字幕が届いたファイルか。
   */
  async extractTasks(documentPath, { record, actions = [], instructions = '', captioned = false } = {}, { onDelta, signal } = {}) {
    const markdown = await fs.readFile(path.join(this.rootDir, documentPath), 'utf8');
    const source = {
      ...sliceTaskSource(markdown, record?.analysis),
      sourceKind: detectSourceKind(markdown, { captioned })
    };
    if (!source.text.trim()) throw new Error('タスクを起こせる本文がありません');

    const existing = existingTasksForPrompt(record?.tasks || []);
    const readingContext = await this.readingContext(documentPath);
    const { answer } = await this.askForJson({
      feature: 'tasks',
      prompt: extractTasksPrompt({
        sourceKind: source.sourceKind,
        appended: source.appended,
        omitted: source.omitted,
        recentText: source.recent,
        newText: source.text,
        existingTasksJson: JSON.stringify(existing),
        organize: actions.includes('organize'),
        focus: actions.includes('focus'),
        instructions,
        readingContextBlock: aiContextBlock(readingContext)
      }),
      outputSchema: taskExtractionSchema(existing.map(({ id }) => id)),
      onDelta,
      signal
    });
    return { answer: readExtractionAnswer(answer), source };
  }

  /**
   * 起こしたタスクを1つ実行します。書くのは調査メモ・コード例・回答案のいずれかで、
   * ファイルにもネットワークにも触りません。保存はしません（`autoTasks.js` の `applyTaskResult`）。
   */
  async performTask(documentPath, task, { instructions = '' } = {}, { onDelta, signal } = {}) {
    const markdown = await fs.readFile(path.join(this.rootDir, documentPath), 'utf8');
    const source = sliceTaskSource(markdown, null);
    const readingContext = await this.readingContext(documentPath);
    const { answer } = await this.askForJson({
      feature: 'taskRun',
      prompt: performTaskPrompt({
        task: { title: task.title, detail: task.detail || '', kind: task.kind, quote: task.quote || '' },
        materialText: source.text,
        omitted: source.omitted,
        instructions,
        readingContextBlock: aiContextBlock(readingContext)
      }),
      outputSchema: TASK_RESULT_SCHEMA,
      onDelta,
      signal
    });
    return readTaskResult(answer);
  }

  async listConversations(documentPath) {
    return this.store.listConversations(documentPath);
  }

  async createConversation({ documentPath, target, context, skillIds }) {
    const normalizedTarget = await this.snapshotTarget(documentPath, target);
    const now = new Date().toISOString();
    const conversation = {
      id: crypto.randomUUID(),
      documentPath,
      documentRevision: normalizedTarget.documentRevision,
      target: normalizedTarget,
      context: normalizeConversationContext(context),
      skills: skillIds?.length
        ? (await readReviewSkills(this.rootDir, skillIds)).map(({ id, name, instructions, references }) => ({ id, name, instructions, references }))
        : [],
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
      const enabled = new Set(conversation.context || DEFAULT_CONVERSATION_CONTEXT);
      const comments = enabled.has('comments')
        ? await collectCommentContext(this.rootDir, conversation.documentPath, conversation.target)
        : { entries: [], revision: '' };
      const readingContext = filterReadingContext(await this.readingContext(conversation.documentPath), enabled);
      const { text } = await this.ai.runTurn({
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
      conversation.lastError = this.describeError(error);
      await this.store.saveConversation(conversation);
      throw error;
    }
  }

  /**
   * 保存した会話を、レビュアーが直したとおりに置き換えます。
   *
   * やり取りが変わったときは、AIのスレッドを畳みます。スレッドが残っているかぎり
   * モデルは直す前の発言を覚えていて、こちらが何を書き換えても読み直さないからです。
   * 畳んでおけば、次の質問は1回目として飛び、直したあとの記録がそのまま前提になります
   * （`prompts/chat.js` の `initialChatPrompt`）。
   */
  async updateConversation(id, edits) {
    const stored = await this.store.getConversation(id);
    if (!stored) throw new Error('会話が見つかりません');
    const { conversation, transcriptChanged } = applyConversationEdits(stored, edits);
    if (transcriptChanged && conversation.codexThreadId) {
      try {
        await this.ai.deleteThread(conversation.codexThreadId);
      } catch {
        // AI側が先に失っていても、こちらの記録は直せます。開き直すのは次の質問のときです。
      }
      conversation.codexThreadId = null;
    }
    return this.store.saveConversation(conversation);
  }

  async deleteConversation(id) {
    const conversation = await this.store.getConversation(id);
    if (conversation?.codexThreadId) {
      try {
        await this.ai.deleteThread(conversation.codexThreadId);
      } catch {
        // The app transcript remains deletable even if the AI already lost its session.
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
    return this.ai.close();
  }

  /**
   * 失敗した理由を、レビュアーが次に何をすればよいか分かる日本語にします。
   * 何が起きうるかはAIごとに違うので、言い換えは選んだAI（`aiProviders/`）に任せます。
   */
  describeError(error) {
    if (error?.name === 'AbortError') return error.message;
    return this.ai.describeError?.(error) ?? String(error?.message || error);
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
    const thread = threadId || await this.ai.createThread({ ephemeral: true, purpose });
    const { text } = await this.ai.runTurn({ threadId: thread, prompt, outputSchema, onDelta, signal });
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

  /**
   * 文字起こしの発言。`readDocument` を通さないのは、長さで断らないためです。
   *
   * 2時間の会議は `MAX_TARGET_CHARS` を超えることがあります。他の機能なら「分割して
   * ください」で正しいのですが、聞き直しがモデルへ渡すのは切り出した窓だけなので、
   * 長い会議こそ使いたい場面で断るのは筋が通りません。
   */
  async readCaptionEntries(documentPath) {
    return parseCaptionEntries(await fs.readFile(path.join(this.rootDir, documentPath), 'utf8'));
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
   * 会話のスレッド。前のスレッドが残っていれば再開し、AI側で失われていれば開き直します。
   * 開き直したときは1回目として扱います。モデルは何も覚えていないからです。
   * 保存名が `codexThreadId` なのは、走らせるAIを選べるようになる前からの記録だからです。
   */
  async openConversationThread(conversation) {
    if (conversation.codexThreadId) {
      try {
        await this.ai.resumeThread(conversation.codexThreadId);
        return { threadId: conversation.codexThreadId, firstTurn: false };
      } catch {
        conversation.codexThreadId = null;
      }
    }
    conversation.codexThreadId = await this.ai.createThread({
      ephemeral: false,
      purpose: purposeFor('chat')
    });
    await this.store.saveConversation(conversation);
    return { threadId: conversation.codexThreadId, firstTurn: true };
  }
}

const DEFAULT_CONVERSATION_CONTEXT = ['comments', 'reading', 'brief', 'notes', 'persona', 'files'];

/**
 * 「もう起こしたタスク」としてモデルへ渡す形。id・題名・種類・状態・優先度だけで、
 * 詳細も引用も渡しません。見送ったものも渡します。渡さないと、見送るたびに同じタスクが
 * 次の回で起こされます。多すぎるときは新しいものから数えます。
 *
 * やると決めたタスクにだけ `commitment` を添えます。決めていないものにまで書くと、
 * 60件ぶんの「決めていない」を毎回読ませることになるので、付くのは決めたものだけです。
 * 期限もメモも渡しません。どちらもレビュアーの手元の段取りで、何を起こすかには効きません。
 */
function existingTasksForPrompt(tasks) {
  return tasks
    .slice(-MAX_EXISTING_TASKS_IN_PROMPT)
    .map((task) => ({
      id: task.id,
      title: task.title,
      kind: task.kind,
      status: task.status,
      priority: task.priority,
      ...(isTaskCommitted(task) ? { commitment: 'committed' } : {})
    }));
}

function normalizeConversationContext(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CONVERSATION_CONTEXT];
  return [...new Set(value.map(String).filter((entry) => DEFAULT_CONVERSATION_CONTEXT.includes(entry)))];
}

function filterReadingContext(context, enabled) {
  return resolveAiContext({
    project: enabled.has('reading') ? context.project : '',
    directory: enabled.has('reading') ? context.directory : '',
    document: enabled.has('reading') ? context.document : '',
    brief: enabled.has('brief') ? context.brief : null,
    notes: enabled.has('notes') ? context.notes : [],
    persona: enabled.has('persona') ? context.persona : null,
    files: enabled.has('files') ? context.files : []
  });
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
  if (!selectedText && !['document', 'none'].includes(target?.type)) throw new Error('翻訳・相談の対象がありません');
  if (selectedText.length > MAX_TARGET_CHARS) throw new Error('対象文章が長すぎます');
  return {
    type: ['text-selection', 'paragraph', 'section', 'document', 'none'].includes(target?.type)
      ? target.type
      : 'text-selection',
    ...(target?.documentType === 'pdf' ? {
      documentType: 'pdf',
      pageNumber: Number.isInteger(target.pageNumber) ? target.pageNumber : null
    } : {}),
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
  if (target.type === 'none') return '対象を指定しない会話';
  const text = target.selectedText.replace(/\s+/g, ' ').trim();
  return text.length > CONVERSATION_TITLE_CHARS ? `${text.slice(0, CONVERSATION_TITLE_CHARS)}…` : text;
}
