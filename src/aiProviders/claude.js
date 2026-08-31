import { TurnClient, loadOptional } from './turnClient.js';

/**
 * Claude（Anthropic Messages API）でレビューを走らせるための口です。
 *
 * Codexと違い、こちらはAPIを1回叩くだけで、向こうに会話は残りません。やり取りの記録は
 * `TurnClient` が持っていて、毎ターンまとめて渡し直します。ここが引き受けるのは
 * 「1回分の問い合わせをして、本文を返す」ところだけです。
 *
 * SDKは選んだときだけ読み込みます（`aiProvider` が `claude` のとき）。鍵は SDK が
 * 環境から拾うので、このアプリは鍵を受け取りも保存もしません。
 */

/** 用途ごとの既定。モデルは揃え、読み方の深さは推論強度で分けます。 */
export const CLAUDE_DEFAULTS = {
  assistant: { model: 'claude-opus-5', effort: 'low' },
  review: { model: 'claude-opus-5', effort: 'high' }
};

/**
 * 受け付ける推論強度。Codexの `none` はここにありません。設定を引き継いだまま
 * `aiProvider` を変えたときに、レビューを頼んだ時点で初めて断られることのないよう、
 * 起動の前に見ます。
 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 1回の答えの上限。
 *
 * 一番長い答えはAIレビューのJSONで、指摘の件数は `aiLimits.js` の `MAX_FINDINGS` で
 * 抑えてあります。それでも足りずに途中で切れると、JSONとして読めない答えが返るので、
 * 実際に要る量よりかなり広く取ってあります。
 */
const MAX_OUTPUT_TOKENS = 32_000;

/** 画面の設定へ並べるモデルの件数。選ぶための一覧なので、全件は要りません。 */
const MODEL_LIST_LIMIT = 100;

/** 答えが返らなかった理由を、レビュアーが次に何をすればよいか分かる日本語にします。 */
const ERROR_HINTS = [
  [/api[_ ]?key|authentication|401|credential/i, 'Claudeの資格情報を設定してください（ANTHROPIC_API_KEY など）'],
  [/404|not_found/i, '設定したモデルがClaudeにありません'],
  [/rate[_ ]?limit|429/i, 'Claudeの利用上限に達しました'],
  [/credit|billing|402/i, 'Claudeの残高または請求設定を確認してください']
];

export class ClaudeClient extends TurnClient {
  /**
   * @param {object} [options]
   * @param {object} [options.models] 設定ファイル由来の用途ごとのモデル指定。
   * @param {Function} [options.createClient] SDKの差し替え口。テスト以外では使いません。
   */
  constructor({ models, createClient } = {}) {
    super({ provider: 'claude', defaults: CLAUDE_DEFAULTS, models });
    this.assertProfiles(this.profiles);
    this.createClient = createClient || defaultClient;
    this.client = null;
  }

  /** 名指しした推論強度。Claudeが受け付けないものは、選び直しのときも同じ理由で断ります。 */
  assertProfiles(profiles) {
    for (const [purpose, profile] of Object.entries(profiles)) assertEffort(purpose, profile.effort);
  }

  /**
   * 資格情報と、名指ししたモデルをここで確かめます。SDKは鍵が無くても組み立てられるので、
   * 確かめずに済ませると「使える」と画面へ出したあと、レビューを頼んだ時点で断られます。
   * モデルを1つ引くだけの問い合わせで、原稿は送らず、生成もさせません。
   */
  async connect() {
    this.client = await this.createClient();
    for (const model of new Set(Object.values(this.profiles).map((profile) => profile.model))) {
      await this.client.models.retrieve(model);
    }
  }

  /**
   * 画面の設定へ出す選択肢。Claudeのモデルは推論強度の受け付け方が揃っているので、
   * どのモデルにも同じ強度を並べます。鍵が無ければ一覧も引けないので、空で返します。
   */
  async listModels() {
    if (!this.client) return [];
    const page = await this.client.models.list({ limit: MODEL_LIST_LIMIT });
    return (page?.data || [])
      .map((entry) => ({ id: entry?.id, efforts: CLAUDE_EFFORTS }))
      .filter((entry) => entry.id);
  }

  async complete({ system, messages, profile, outputSchema, onDelta, signal }) {
    const stream = this.client.messages.stream({
      model: profile.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages,
      // 深く読ませるかどうかは推論強度で決めます。思考そのものは出させません。
      thinking: { type: 'adaptive' },
      output_config: {
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(outputSchema ? { format: { type: 'json_schema', schema: outputSchema } } : {})
      }
    }, { signal });

    stream.on('text', (delta) => onDelta(delta));
    const message = await stream.finalMessage();
    return textOf(message);
  }

  async close() {
    this.client = null;
    await super.close();
  }

  describeError(error) {
    const message = String(error?.message || error);
    return ERROR_HINTS.find(([pattern]) => pattern.test(message))?.[1] || message;
  }
}

/** 名指しした推論強度。Claudeが受け付けないものは、使えるものを並べて断ります。 */
function assertEffort(purpose, effort) {
  if (!effort || CLAUDE_EFFORTS.includes(effort)) return;
  throw new Error(
    `設定した${purpose === 'review' ? 'aiReviewEffort' : 'aiEffort'} をClaudeは受け付けません: `
    + `${effort}（使える強度: ${CLAUDE_EFFORTS.join(', ')}）`
  );
}

/** 答えの本文。考えた跡や道具の呼び出しは混ぜず、文章のブロックだけをつなぎます。 */
function textOf(message) {
  return (message?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function defaultClient() {
  const { default: Anthropic } = await loadOptional('@anthropic-ai/sdk', '@anthropic-ai/sdk');
  return new Anthropic();
}
