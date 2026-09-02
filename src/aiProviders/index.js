import { CodexAppServer } from '../codexAppServer.js';
import { ClaudeClient } from './claude.js';
import { LangChainClient } from './langchain.js';

/**
 * どのAIでレビューを走らせるかを1か所にまとめた表です。
 *
 * `AiService` はここが返したものだけを相手にします。相手に求めるのは6つで、
 * 起動・スレッドを開く・再開する・1ターン投げる・スレッドを畳む・閉じる、だけです
 * （`aiProviders/turnClient.js` の説明）。この形さえ満たしていれば、中で何をしていても
 * 構いません。Codexは外部プロセスと話し、claudeはAPIを叩き、langchainは他所へ委ねます。
 *
 * 増やすときは、この表へ1行足します。設定ファイルの `aiProvider` に書ける名前も、
 * `config --help` に出る一覧も、ここから作ります。
 */

export const DEFAULT_AI_PROVIDER = 'codex';

const PROVIDERS = {
  codex: {
    label: 'Codex',
    summary: 'Codex CLI（既定。`codex` へログインしていれば追加のインストールは要りません）',
    /** 選ぶ前に済ませておくこと。画面はこれを、選べない理由としてそのまま出します。 */
    requires: '`codex` コマンドが入っていて、ログインが済んでいること',
    create: ({ runtimeDir, models }) => new CodexAppServer({ runtimeDir, models })
  },
  claude: {
    label: 'Claude',
    summary: 'Anthropic Messages API（`npm install @anthropic-ai/sdk` が要ります）',
    requires: '`npm install @anthropic-ai/sdk` と、ANTHROPIC_API_KEY などの資格情報',
    create: ({ models }) => new ClaudeClient({ models })
  },
  langchain: {
    label: 'LangChain',
    summary: 'LangChain経由で任意のモデル（`npm install langchain` と各プロバイダのパッケージが要ります）',
    requires: '`npm install langchain` と各プロバイダのパッケージ、設定ファイルの aiModelProvider / aiModel / aiReviewModel',
    create: ({ models, modelProvider }) => new LangChainClient({ models, modelProvider })
  }
};

export const AI_PROVIDERS = Object.keys(PROVIDERS);

/** `config --help` などに出す一覧。表から作るので、増やしても書き忘れません。 */
export const AI_PROVIDER_HELP = AI_PROVIDERS
  .map((provider) => `    ${provider.padEnd(10)}${PROVIDERS[provider].summary}`)
  .join('\n');

/**
 * 設定に書かれたAIを組み立てます。
 *
 * @param {object} [options]
 * @param {string} [options.provider] `aiProvider`。省略すると Codex です。
 * @param {string} [options.runtimeDir] Codexの作業ディレクトリ。
 * @param {object} [options.models] 用途ごとのモデル指定（`config.js` の `aiModelsFromConfig`）。
 * @param {string} [options.modelProvider] `aiModelProvider`。LangChainのときだけ使います。
 */
export function createAiClient({ provider = DEFAULT_AI_PROVIDER, ...options } = {}) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(unknownProviderMessage(provider));
  return entry.create(options);
}

/**
 * 画面の設定へ並べる、AIの選択肢です。
 *
 * いま走っていないAIも落とさずに返します。画面はそれを選べない形（非アクティブ）で
 * 出し、選べない理由と、選べるようにするための1行を一緒に見せます。一覧から消すと、
 * このアプリが他のAIでも走ることも、走らせるのに何が要るかも、画面からは分かりません。
 *
 * 走っているAIを画面から差し替えないのは、AIの組み立てが起動時の1回きりだからです
 * （`createAiClient` を呼ぶのは `createAiService` だけ）。途中で差し替えると、
 * 開いている会話が、記録の残っていない相手へ続きを聞くことになります。
 *
 * @param {string} [current] いま走っているAI（`aiProvider`）。
 * @returns {Array<{id: string, label: string, summary: string, requires: string,
 *   active: boolean, command: string}>}
 */
export function listProviderChoices(current = DEFAULT_AI_PROVIDER) {
  return AI_PROVIDERS.map((provider) => ({
    id: provider,
    label: PROVIDERS[provider].label,
    summary: PROVIDERS[provider].summary,
    requires: PROVIDERS[provider].requires,
    active: provider === current,
    // 切り替えは設定ファイルへ書いて立ち上げ直す道しかないので、その1行をそのまま渡します。
    command: `review-markdown config set aiProvider ${provider} --global`
  }));
}

/** 画面と起動ログに出す名前。設定に書く名前（小文字）とは別です。 */
export function providerLabel(provider) {
  return PROVIDERS[provider]?.label || provider;
}

export function unknownProviderMessage(provider) {
  return `使えないaiProviderです: ${provider}（使えるもの: ${AI_PROVIDERS.join(', ')}）`;
}
