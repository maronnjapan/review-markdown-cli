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
    create: ({ runtimeDir, models }) => new CodexAppServer({ runtimeDir, models })
  },
  claude: {
    label: 'Claude',
    summary: 'Anthropic Messages API（`npm install @anthropic-ai/sdk` が要ります）',
    create: ({ models }) => new ClaudeClient({ models })
  },
  langchain: {
    label: 'LangChain',
    summary: 'LangChain経由で任意のモデル（`npm install langchain` と各プロバイダのパッケージが要ります）',
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

/** 画面と起動ログに出す名前。設定に書く名前（小文字）とは別です。 */
export function providerLabel(provider) {
  return PROVIDERS[provider]?.label || provider;
}

export function unknownProviderMessage(provider) {
  return `使えないaiProviderです: ${provider}（使えるもの: ${AI_PROVIDERS.join(', ')}）`;
}
