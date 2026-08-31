import { TurnClient, loadOptional } from './turnClient.js';

/**
 * LangChain経由でAIを走らせるための口です。
 *
 * ここはモデルを1つも知りません。`aiModel` に書かれた名前を LangChain の
 * `initChatModel` へ渡すだけで、その先がOpenAIでもAnthropicでもOllamaでも、
 * LangChainが対応していれば同じように動きます。逃げ道として置いてある口なので、
 * 「このアプリが対応していないAIを使いたい」ときはここを選びます。
 *
 * 代わりに、決め打ちできないものが3つあります。
 *   - プロバイダ名。`aiModelProvider` の指定が要ります。省略するとLangChainがモデル名から
 *     推測しますが、そうすると `aiModel` を書き換えるだけで送り先が変わります。モデル名は
 *     プロジェクト設定にも書けるので、推測に任せると、レビュー対象のリポジトリが送り先を
 *     決められることになります（`config.js` の `CONFIG_KEY_SPECS`）。
 *   - モデル名。既定を持てないので、`aiModel` / `aiReviewModel` の指定が要ります。
 *   - 推論強度。共通の指定が無いので、`aiEffort` は使いません（Codexとclaudeでは効きます）。
 *
 * 答えの形も、モデルへ言葉で頼みます。CodexとclaudeはJSONスキーマで縛れますが、
 * LangChainの先にいるモデルがそれを持っているとは限らないためです。
 */

/** JSONで答えさせるための頼み。スキーマをそのまま見せて、それ以外を書かせません。 */
function jsonInstruction(schema) {
  return [
    '',
    '',
    'Reply with JSON only. No prose, no explanation, no Markdown code fence.',
    'The JSON must validate against this schema:',
    JSON.stringify(schema)
  ].join('\n');
}

export class LangChainClient extends TurnClient {
  /**
   * @param {object} [options]
   * @param {object} [options.models] 設定ファイル由来の用途ごとのモデル指定。
   * @param {string} [options.modelProvider] `aiModelProvider`。LangChainのプロバイダ名。
   *   省略するとモデル名から推測させます。
   * @param {Function} [options.initChatModel] LangChainの差し替え口。テスト以外では使いません。
   */
  constructor({ models, modelProvider, initChatModel } = {}) {
    super({ provider: 'langchain', defaults: {}, models });
    if (!modelProvider) {
      throw new Error(
        'langchain で使うプロバイダが決まっていません。設定ファイルの aiModelProvider に '
        + 'anthropic / openai / ollama などを書いてください'
      );
    }
    this.modelProvider = modelProvider;
    this.initChatModel = initChatModel || null;
    /** 用途ごとに1つずつ作って使い回します。モデルの組み立てはターンごとには要りません。 */
    this.models = new Map();
  }

  /** 推論強度はLangChain共通の指定が無いので、画面へも出しません。 */
  get supportsEffort() {
    return false;
  }

  get effort() {
    return null;
  }

  get reviewEffort() {
    return null;
  }

  /**
   * 使うモデルをここで組み立てます。プロバイダのパッケージが入っていないことも、
   * プロバイダ名が違うことも、ここで分かります。最初のレビューまで持ち越しません。
   */
  async connect() {
    if (!this.initChatModel) {
      const { initChatModel } = await loadOptional('langchain/chat_models/universal', 'langchain');
      this.initChatModel = initChatModel;
    }
    for (const profile of Object.values(this.profiles)) await this.modelFor(profile);
  }

  /** 用途に対応するモデル。1度組み立てたら使い回します。 */
  async modelFor(profile) {
    const cached = this.models.get(profile.model);
    if (cached) return cached;
    const model = await this.initChatModel(profile.model, { modelProvider: this.modelProvider });
    this.models.set(profile.model, model);
    return model;
  }

  async complete({ system, messages, profile, outputSchema, onDelta, signal }) {
    const model = await this.modelFor(profile);
    const stream = await model.stream(
      [{ role: 'system', content: system }, ...withSchemaRequest(messages, outputSchema)],
      { signal }
    );

    let text = '';
    for await (const chunk of stream) {
      // 新しいLangChainは本文を `text` で渡します。古いものは `content` に文字列で入るので、
      // どちらでも同じように読めるようにしておきます。
      const delta = chunk?.text || (typeof chunk?.content === 'string' ? chunk.content : '');
      if (!delta) continue;
      text += delta;
      onDelta(delta);
    }
    return outputSchema ? stripJsonFence(text) : text;
  }

  async close() {
    this.models.clear();
    await super.close();
  }
}

/** 答えの形を、最後の質問の後ろへ添えます。会話の記録そのものは汚しません。 */
function withSchemaRequest(messages, outputSchema) {
  if (!outputSchema) return messages;
  const last = messages[messages.length - 1];
  return [
    ...messages.slice(0, -1),
    { ...last, content: `${last.content}${jsonInstruction(outputSchema)}` }
  ];
}

/**
 * ```json … ``` で包んで返すモデルがあるので、包みだけ外します。
 * 中身は触りません。JSONとして読めるかどうかは、受け取った側が確かめます。
 */
export function stripJsonFence(text) {
  const fenced = String(text).trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : String(text).trim();
}
