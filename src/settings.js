/**
 * 画面から変えられる設定です。
 *
 * 設定ファイルに書けるキーのうち、レビューの最中に変えたくなるのはこの5つだけです。
 * 翻訳機能を使うかどうかと、どのモデルでどれくらい考えさせるか。ほかのキー
 * （対象の絞り込み、ポート、どのAIで走らせるか）は起動のしかたそのものを決めるので、
 * 起動し直す前提の設定ファイルとコマンドラインに置いたままにしています。
 *
 * 変えた値は2か所へ届きます。走っているサーバー（`createSettings` が持つ値）と、
 * 次の起動のための設定ファイル（`createSettingsFile`）です。前者だけだと立ち上げ直す
 * たびに元へ戻り、後者だけだと変えたのに画面が変わりません。
 *
 * 書き込む先は `config set --global` と同じユーザー全体の設定ファイル（`--config` で
 * 名指ししたときはそのファイル）で、レビュー対象のディレクトリへは書きません。
 * 画面を開けるのは端末の持ち主だけですが、書いた先が対象のリポジトリだと、
 * レビューし終えた原稿と一緒に、その人の設定が混ざって出ていきます。
 */

import path from 'node:path';
import {
  aiModelsFromConfig,
  globalConfigPath,
  loadConfig,
  normalizeConfigValue,
  readConfigFile,
  writeConfigFile
} from './config.js';

/** 画面から変えられる設定キー。ここに無いキーは、画面からは読むことも書くこともしません。 */
export const UI_SETTING_KEYS = ['translation', 'aiModel', 'aiEffort', 'aiReviewModel', 'aiReviewEffort'];

/**
 * 空にすると「設定しない」に戻るキー。モデルと推論強度は、外すと選んだAIの既定へ戻ります。
 * `translation` はここにありません。false は「無効にした」という指定そのものだからです。
 */
const CLEARABLE_KEYS = ['aiModel', 'aiEffort', 'aiReviewModel', 'aiReviewEffort'];

/**
 * 走っているサーバーが見ている設定です。
 *
 * @param {object} [options]
 * @param {object} [options.values] 起動時に決まった値（コマンドラインと設定ファイルの合成）。
 * @param {boolean} [options.manager] 資料の管理者。画面からは変えられないので、そのまま持ちます。
 * @param {object} [options.file] 保存先（`createSettingsFile`）。無ければ今回の起動限りです。
 */
export function createSettings({ values = {}, manager = false, file = null } = {}) {
  let current = pickSettings(values);

  return {
    /** 保存先のパス。保存しない起動（`--no-config`）では null です。 */
    get configPath() {
      return file?.path ?? null;
    },

    get values() {
      return { ...current };
    },

    /** 有効になっている機能。ルートは要求のたびにこれを読むので、変えた直後から効きます。 */
    get features() {
      return Object.freeze({ manager, translation: current.translation === true });
    },

    /** 用途ごとのモデル指定。`aiProviders/` が受け取る形です。 */
    get aiModels() {
      return aiModelsFromConfig(current);
    },

    /**
     * 画面から届いた変更を当てます。
     *
     * モデルの指定は、確定する前に `apply` へ渡して確かめます。そのAIが持っていない
     * モデルなら `apply` が投げるので、設定は変わらず、走っているモデルもそのままです。
     * 半端に切り替わった状態でレビューを頼ませないためです。
     *
     * 保存に失敗しても、当てた設定は戻しません。画面ではもう変わっているので、
     * 戻すと「効いているのに保存できていない」ではなく「何が起きたのか分からない」に
     * なります。保存できなかったことは、返り値の `error` で画面へ伝えます。
     */
    async update(patch, { apply = () => {} } = {}) {
      const next = normalizeSettings(patch, current);
      if (!sameModels(next, current)) await apply(aiModelsFromConfig(next));
      current = next;
      if (!file) return { path: null, shadowed: [], error: null };
      try {
        return { ...await file.save(current), error: null };
      } catch (error) {
        return { path: file.path, shadowed: [], error: error.message };
      }
    }
  };
}

/**
 * 設定ファイルへの保存です。
 *
 * 保存しても、次の起動で効かないことがあります。コマンドラインの指定と、対象ディレクトリの
 * `.review-markdown.json` は、ユーザー全体の設定より強いからです（READMEの「優先順位」）。
 * 黙って上書きされると、設定したのに変わらない理由が画面からは分かりません。そこで保存の
 * たびに読み直して、いま書いた値が次の起動まで残らないキーを `shadowed` として返します。
 *
 * @param {object} [options]
 * @param {string} [options.configPath] `--config` で名指しされたファイル。無ければユーザー全体の設定。
 * @param {string} [options.targetDir] レビュー対象のディレクトリ。プロジェクト設定の探索に使います。
 * @param {string[]} [options.fixedByCommandLine] 今回の起動でコマンドラインが決めたキー。
 */
export function createSettingsFile({
  configPath,
  targetDir = '.',
  fixedByCommandLine = [],
  env = process.env,
  platform = process.platform
} = {}) {
  const filePath = configPath ? path.resolve(configPath) : globalConfigPath(env, platform);

  return {
    path: filePath,
    async save(values) {
      const existing = await readConfigFile(filePath);
      const config = { ...existing.config };
      for (const key of UI_SETTING_KEYS) {
        if (values[key] === undefined) delete config[key];
        else config[key] = values[key];
      }
      await writeConfigFile(filePath, config);
      return { path: filePath, shadowed: await shadowedKeys(values) };
    }
  };

  /** 書いたのに次の起動では効かないキーと、代わりに効くもの。 */
  async function shadowedKeys(values) {
    const shadowed = fixedByCommandLine
      .filter((key) => UI_SETTING_KEYS.includes(key))
      .map((key) => ({ key, source: '今回の起動のコマンドライン指定' }));
    // `--config` で名指しした起動は、そのファイルしか読みません。上書きするものがありません。
    if (configPath) return shadowed;

    const { config, sources } = await loadConfig({ targetDir, env, platform });
    const projectSource = sources.find((source) => path.resolve(source) !== filePath);
    for (const key of UI_SETTING_KEYS) {
      if (shadowed.some((entry) => entry.key === key)) continue;
      if (config[key] === values[key]) continue;
      shadowed.push({ key, source: projectSource || 'プロジェクト設定' });
    }
    return shadowed;
  }
}

/**
 * 画面から届いた値を、設定ファイルに書くのと同じ形へ整えます。
 * 送られてこなかったキーはそのままです。1つだけ変える要求と、まとめて変える要求を
 * 同じ扱いにできます。
 */
export function normalizeSettings(patch, current = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('設定はJSONオブジェクトで送ってください');
  }
  const next = { ...current };
  for (const key of UI_SETTING_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (CLEARABLE_KEYS.includes(key) && (value === null || String(value).trim() === '')) {
      delete next[key];
      continue;
    }
    next[key] = normalizeConfigValue(key, value, `設定: ${key}`);
  }
  return next;
}

/**
 * 起動時に決まった値を、設定ファイルに書くのと同じ形へ戻します。
 *
 * `applyConfigToOptions` は用途ごとにまとめた `aiModels` を渡してくるので、画面が扱う
 * 1キー1値の形へほどきます。名指ししなかった用途はキーごと落とし、「未設定（選んだAIの
 * 既定で走る）」と「既定と同じ名前を書いた」を画面でも取り違えないようにします。
 */
export function settingsFromOptions({ translation, aiModels = {} } = {}) {
  const { assistant = {}, review = {} } = aiModels;
  return {
    translation: translation === true,
    ...(assistant.model ? { aiModel: assistant.model } : {}),
    ...(assistant.effort ? { aiEffort: assistant.effort } : {}),
    ...(review.model ? { aiReviewModel: review.model } : {}),
    ...(review.effort ? { aiReviewEffort: review.effort } : {})
  };
}

/** 起動時に決まった値のうち、画面が扱うぶんだけを取り出します。 */
function pickSettings(values) {
  const settings = {};
  for (const key of UI_SETTING_KEYS) {
    if (values[key] !== undefined) settings[key] = values[key];
  }
  return settings;
}

function sameModels(next, current) {
  return CLEARABLE_KEYS.every((key) => next[key] === current[key]);
}
