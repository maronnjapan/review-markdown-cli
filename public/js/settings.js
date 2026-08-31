import { escapeHtml } from './util.js';

/**
 * 設定ダイアログです。
 *
 * ここから変えられるのは2つ、翻訳機能の入り切りと、用途ごとのモデルです。どちらも
 * これまで設定ファイルとコマンドラインだけで決まっていたもので、変えるには立ち上げ
 * 直しが要りました。読んでいる途中で「この節はレビュー用の深いモデルで読み直したい」
 * と思ったときに、原稿を閉じずに変えられるようにしてあります。
 *
 * 保存はサーバーが引き受けます（`src/settings.js`）。画面がするのは、いまの値を出して、
 * 変えた値を送って、返ってきた結果を出すことだけです。断られた理由もサーバーの文面を
 * そのまま出します。使えるモデルの名前を知っているのはサーバー側だからです。
 */

/** 推論強度の「指定しない」。選んだAIの既定で走ります。 */
const DEFAULT_EFFORT_LABEL = '（既定）';

export function createSettingsController({ refs, state, api, toaster, onApplied = () => {} }) {
  let saving = false;

  bindEvents();

  async function open() {
    refs.settingsDialog.showModal();
    setStatus('');
    setError('');
    setBusy(true);
    try {
      render(await api.readSettings());
      setBusy(false);
    } catch (error) {
      // 読み込めなかったときは、保存できないままにします。いまの値が分からないまま送ると、
      // 開いた時点の空欄を、そのまま「設定しない」として書き込むことになります。
      setError(`設定を読み込めませんでした: ${error.message}`);
    }
  }

  function close() {
    refs.settingsDialog.close();
  }

  async function save(event) {
    event.preventDefault();
    if (saving || !state.settings) return;
    saving = true;
    setBusy(true);
    setError('');
    setStatus('保存中…');
    try {
      const result = await api.saveSettings(readForm());
      render(result);
      setStatus(savedMessage(result.saved));
      // 変わったことだけを短く言い、次の起動まで残るかどうかはダイアログの1行に任せます。
      toaster.success('設定を変更しました。');
      // 翻訳の入り切りは、開いている文書の見た目まで変わります。反映は画面側の持ち主に任せます。
      onApplied(result);
    } catch (error) {
      // 使えないモデルはサーバーが断ります。断られたときは画面の値も戻さず、
      // 直して出し直せるようにしておきます。
      setError(error.message);
      setStatus('');
    } finally {
      saving = false;
      setBusy(false);
    }
  }

  /** 画面の欄からいまの指定を読みます。空欄は「設定しない」として送ります。 */
  function readForm() {
    return {
      translation: refs.settingsTranslation.checked,
      aiModel: refs.settingsAiModel.value.trim(),
      aiReviewModel: refs.settingsAiReviewModel.value.trim(),
      // 出していない欄は送りません。推論強度を持たないAIで開いただけで、設定ファイルに
      // 書いてある強度が消えることのないようにです。
      ...(state.settings?.ai?.supportsEffort === false ? {} : {
        aiEffort: refs.settingsAiEffort.value,
        aiReviewEffort: refs.settingsAiReviewEffort.value
      })
    };
  }

  function render(payload) {
    state.settings = payload;
    const { settings = {}, ai = {} } = payload;
    refs.settingsTranslation.checked = settings.translation === true;
    refs.settingsAiModel.value = settings.aiModel || '';
    refs.settingsAiReviewModel.value = settings.aiReviewModel || '';
    renderProvider(ai);
    renderModelOptions(ai);
    renderEfforts(ai, settings);
    renderSaveTarget(payload.configPath);
  }

  function renderProvider(ai) {
    const label = ai.label || 'AI';
    refs.settingsProvider.textContent = ai.available
      ? `${label}で実行中`
      : ai.error || `${label}を利用できません`;
    refs.settingsProvider.dataset.state = ai.available ? 'ready' : 'error';
  }

  /**
   * 選べるモデルは候補として出すだけで、欄そのものは自由入力のままにします。
   * 一覧を持たないAI（LangChain経由）でもモデル名を書けるようにするためです。
   */
  function renderModelOptions(ai) {
    const models = ai.models || [];
    refs.settingsModelOptions.innerHTML = models
      .map((model) => `<option value="${escapeHtml(model.id)}"></option>`)
      .join('');
    refs.settingsModelHint.textContent = modelHint(ai, models);
  }

  function modelHint(ai, models) {
    const running = ai.running || {};
    const inUse = [
      profileText('翻訳・AIチャット・指摘の配置', running.assistant, ai.supportsEffort),
      profileText('AIレビューほか', running.review, ai.supportsEffort)
    ].filter(Boolean).join(' / ');
    const choices = models.length
      ? `選べるモデル: ${models.map((model) => model.id).join(', ')}`
      : 'このAIは選べるモデルの一覧を持っていないので、モデル名を書いてください。';
    return inUse ? `いま実行中 — ${inUse}。${choices}` : choices;
  }

  function profileText(label, profile, supportsEffort) {
    if (!profile?.model) return '';
    const effort = supportsEffort && profile.effort ? ` / ${profile.effort}` : '';
    return `${label}: ${profile.model}${effort}`;
  }

  /**
   * 推論強度は、そのAIが受け付けるものだけを並べます。共通の指定を持たないAIでは
   * 欄ごと隠します。選べない指定を出しておいて、保存のときに断るのは遠回りです。
   */
  function renderEfforts(ai, settings) {
    const supported = ai.supportsEffort !== false;
    refs.settingsAiEffortField.classList.toggle('hidden', !supported);
    refs.settingsAiReviewEffortField.classList.toggle('hidden', !supported);
    if (!supported) return;
    fillEffortSelect(refs.settingsAiEffort, ai.efforts || [], settings.aiEffort);
    fillEffortSelect(refs.settingsAiReviewEffort, ai.efforts || [], settings.aiReviewEffort);
  }

  /**
   * 設定済みの強度は、一覧に無くても選択肢へ足します。モデルごとに受け付ける強度が
   * 違うことがあり、落とすと、開いただけで設定が消えたように見えるからです。
   */
  function fillEffortSelect(select, efforts, current) {
    const values = [...new Set([...efforts, ...(current ? [current] : [])])];
    select.innerHTML = [
      `<option value="">${DEFAULT_EFFORT_LABEL}</option>`,
      ...values.map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effort)}</option>`)
    ].join('');
    select.value = current || '';
  }

  function renderSaveTarget(configPath) {
    refs.settingsSaveTarget.textContent = configPath
      ? `保存先: ${configPath}`
      : '設定ファイルを読まない起動（--no-config）なので、変更は今回の起動のあいだだけ効きます。';
  }

  /**
   * 保存できたことと、それが次の起動まで残るかどうか。
   * 起動のたびに戻る設定を「保存しました」とだけ言うと、直し方が分からなくなります。
   */
  function savedMessage(saved) {
    if (!saved) return '保存しました。';
    if (saved.error) return `変更は今回の起動には効いていますが、保存できませんでした: ${saved.error}`;
    if (!saved.path) return '変更は今回の起動のあいだだけ効きます。';
    const shadowed = saved.shadowed || [];
    // 保存先そのものは下の行に出ているので、ここでは繰り返しません。
    if (shadowed.length === 0) return '保存しました。';
    const overridden = shadowed.map(({ key, source }) => `${key}（${source}）`).join('、');
    return `保存しましたが、次の起動では次の設定が優先されます: ${overridden}`;
  }

  function setBusy(busy) {
    refs.settingsSave.disabled = busy;
    refs.settingsTranslation.disabled = busy;
  }

  function setStatus(text) {
    refs.settingsStatus.textContent = text;
  }

  function setError(text) {
    refs.settingsError.textContent = text;
    refs.settingsError.hidden = !text;
  }

  function bindEvents() {
    refs.settingsButton.addEventListener('click', open);
    refs.settingsForm.addEventListener('submit', save);
    refs.settingsCancel.addEventListener('click', close);
  }

  return { open, close };
}
