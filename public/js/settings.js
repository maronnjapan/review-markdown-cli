import { AUTO_TASK_ACTIONS } from './autoTasks.js';
import { escapeHtml } from './util.js';

/**
 * 設定ダイアログです。
 *
 * ここから変えられるのは3つ、翻訳機能の入り切り、自動タスク（入り切り・間隔・任せること・
 * 特にしてほしいこと）、用途ごとのモデルです。どれもこれまで設定ファイルとコマンドライン
 * だけで決まっていたもので、変えるには立ち上げ直しが要りました。読んでいる途中で「この節は
 * レビュー用の深いモデルで読み直したい」「裏の見守りを止めたい」と思ったときに、原稿を閉じずに
 * 変えられるようにしてあります。
 *
 * 保存はサーバーが引き受けます（`src/settings.js`）。画面がするのは、いまの値を出して、
 * 変えた値を送って、返ってきた結果を出すことだけです。断られた理由もサーバーの文面を
 * そのまま出します。使えるモデルの名前を知っているのはサーバー側だからです。
 *
 * ── 選べないものを消さない ────────────────────────────────
 * 使えない選択肢は、一覧から落とさずに非アクティブで並べます。走らせていないAI、
 * 一覧を引けなかったときのモデル欄、そのモデルが受け付けない推論強度。どれも消すと、
 * 画面には「そういう選択肢は無い」と映ります。無いのではなく、まだ設定していないだけ
 * なので、選べない理由と、選べるようにする方法を選択肢そのものに書いて残します。
 *
 * ── 「既定」と書かない ────────────────────────────────────
 * 名指ししていない用途も、実際には決まったモデルで走っています。欄を「（既定）」と
 * だけ書くと、何で走っているのかが画面のどこにも出ません。名指ししていないことは
 * 「自動で選ぶ」と書き、そのとき選ばれているモデル名を必ず添えます。
 */

/** 一覧に無いモデル名を手で書くための、選択肢としての印。設定値にはなりません。 */
const CUSTOM_MODEL_VALUE = '__custom__';

/** 選べない理由をその場に残しておくための、選べない選択肢の印。設定値にはなりません。 */
const UNAVAILABLE_VALUE = '__unavailable__';

/** 用途ごとの欄。1つの用途はモデル・手入力・実行中表示・推論強度の4つでできています。 */
const MODEL_FIELDS = [
  {
    purpose: 'assistant',
    settingKey: 'aiModel',
    effortKey: 'aiEffort',
    select: 'settingsAiModel',
    custom: 'settingsAiModelCustom',
    running: 'settingsAiModelRunning',
    effort: 'settingsAiEffort'
  },
  {
    purpose: 'review',
    settingKey: 'aiReviewModel',
    effortKey: 'aiReviewEffort',
    select: 'settingsAiReviewModel',
    custom: 'settingsAiReviewModelCustom',
    running: 'settingsAiReviewModelRunning',
    effort: 'settingsAiReviewEffort'
  }
];

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

  /** 画面の欄からいまの指定を読みます。「自動で選ぶ」は「設定しない」として送ります。 */
  function readForm() {
    const supportsEffort = state.settings?.ai?.supportsEffort !== false;
    const patch = {
      translation: refs.settingsTranslation.checked,
      autoTasks: refs.settingsAutoTasks.checked,
      // 空は「自動で選ぶ」で、サーバー側では「設定しない」に戻ります。
      autoTasksInterval: refs.settingsAutoTasksInterval.value,
      autoTasksActions: [...refs.settingsAutoTasksActions.querySelectorAll('input:checked')].map((input) => input.value),
      autoTasksInstructions: refs.settingsAutoTasksInstructions.value.trim(),
      aiEmptyTarget: refs.settingsAiEmptyTarget.value
    };
    for (const field of MODEL_FIELDS) {
      patch[field.settingKey] = readModelField(field);
      // 出していない欄は送りません。推論強度を持たないAIで開いただけで、設定ファイルに
      // 書いてある強度が消えることのないようにです。
      if (supportsEffort) patch[field.effortKey] = refs[field.effort].value;
    }
    return patch;
  }

  /** 1つの用途のモデル指定。手入力を選んでいるときだけ、書いた名前を読みます。 */
  function readModelField(field) {
    const chosen = refs[field.select].value;
    return chosen === CUSTOM_MODEL_VALUE ? refs[field.custom].value.trim() : chosen;
  }

  function render(payload) {
    state.settings = payload;
    const { settings = {}, ai = {} } = payload;
    refs.settingsTranslation.checked = settings.translation === true;
    renderAutoTasks(settings);
    refs.settingsAiEmptyTarget.value = settings.aiEmptyTarget === 'none' ? 'none' : 'document';
    renderProvider(ai);
    renderProviderChoices(ai);
    for (const field of MODEL_FIELDS) renderModelField(field, ai, settings);
    refs.settingsModelHint.textContent = modelHint(ai);
    renderSaveTarget(payload.configPath);
  }

  /**
   * 自動タスク。任せることは、一覧から落とさずにチェックで出します。外したものは
   * 走らないだけで、無いわけではないからです。何も設定していなければ全部に印が付きます。
   */
  function renderAutoTasks(settings) {
    refs.settingsAutoTasks.checked = settings.autoTasks === true;
    const interval = settings.autoTasksInterval ? String(settings.autoTasksInterval) : '';
    // 設定ファイルに一覧に無い秒数が書いてあっても、開いただけで消えないように選択肢へ足します。
    if (interval && ![...refs.settingsAutoTasksInterval.options].some((option) => option.value === interval)) {
      const option = refs.settingsAutoTasksInterval.ownerDocument.createElement('option');
      option.value = interval;
      option.textContent = `${interval}秒`;
      refs.settingsAutoTasksInterval.append(option);
    }
    refs.settingsAutoTasksInterval.value = interval;
    const chosen = Array.isArray(settings.autoTasksActions)
      ? settings.autoTasksActions
      : AUTO_TASK_ACTIONS.map(({ id }) => id);
    refs.settingsAutoTasksActions.innerHTML = [
      '<legend class="settings-field-label">任せること</legend>',
      ...AUTO_TASK_ACTIONS.map(({ id, label, hint }) => `
        <label class="settings-check settings-action" title="${escapeHtml(hint)}">
          <input type="checkbox" value="${escapeHtml(id)}"${chosen.includes(id) ? ' checked' : ''}>
          <span>${escapeHtml(label)}<small>${escapeHtml(hint)}</small></span>
        </label>`)
    ].join('');
    refs.settingsAutoTasksInstructions.value = settings.autoTasksInstructions || '';
  }

  function renderProvider(ai) {
    const label = ai.label || 'AI';
    refs.settingsProvider.textContent = ai.available
      ? `${label}で実行中`
      : ai.error || `${label}を利用できません`;
    refs.settingsProvider.dataset.state = ai.available ? 'ready' : 'error';
  }

  /**
   * 走らせるAIの一覧です。欄そのものは操作できません。AIの組み立ては起動の1回きりで、
   * 画面から差し替えると、開いている会話が記録の無い相手へ続きを聞くことになるからです。
   * それでも一覧は出します。ほかにどんなAIで走らせられるのかと、走らせるのに何が要るかは、
   * 切り替えられないことと同じくらい知りたいことだからです。
   */
  function renderProviderChoices(ai) {
    const providers = ai.providers || [];
    if (providers.length === 0) {
      refs.settingsAiProvider.innerHTML = `<option>${escapeHtml(ai.label || 'AI')}</option>`;
      refs.settingsProviderHint.textContent = '';
      return;
    }
    refs.settingsAiProvider.innerHTML = providers.map((provider) => {
      const suffix = provider.active ? '（実行中）' : `（いまは選べません: ${provider.requires}）`;
      return `<option value="${escapeHtml(provider.id)}"${provider.active ? ' selected' : ' disabled'}`
        + ` title="${escapeHtml(provider.summary)}">${escapeHtml(provider.label)}${escapeHtml(suffix)}</option>`;
    }).join('');
    const others = providers.filter((provider) => !provider.active);
    refs.settingsProviderHint.textContent = others.length === 0
      ? ''
      : `切り替えるには、設定ファイルへ書いて立ち上げ直してください: ${
        others.map((provider) => provider.command).join(' / ')}`;
  }

  /**
   * 1つの用途の欄です。モデルの一覧、手で書く欄、いま走っているモデル、推論強度の4つを
   * 同じ材料から出します。
   */
  function renderModelField(field, ai, settings) {
    const configured = settings[field.settingKey] || '';
    renderModelOptions(field, ai, configured);
    renderRunning(field, ai);
    renderEffort(field, ai, settings, selectedModelId(field, ai, configured));
  }

  /**
   * 選べるモデル。名指ししていない用途は「自動で選ぶ」を選んだ状態にし、そこにいま
   * 選ばれているモデル名を書きます。一覧を引けなかったAIでも欄は残し、引けなかった理由を
   * 非アクティブな選択肢として出したうえで、手で書く欄へ切り替えます。
   */
  function renderModelOptions(field, ai, configured) {
    const models = ai.models || [];
    const known = models.map((model) => model.id);
    const custom = Boolean(configured) && !known.includes(configured);
    const options = [
      `<option value="">${escapeHtml(autoModelLabel(ai, field.purpose))}</option>`,
      // 「自動で選ぶ」と同じ空の値にはしません。同じにすると、指定なしを選び直したときに
      // どちらが選ばれるかがブラウザ任せになります。
      ...(models.length
        ? []
        : [`<option value="${UNAVAILABLE_VALUE}" disabled>${escapeHtml(unavailableReason(ai))}</option>`]),
      ...models.map((model) => (
        `<option value="${escapeHtml(model.id)}">${escapeHtml(model.id)}`
        + `${model.isDefault ? '（このAIの既定）' : ''}</option>`
      )),
      `<option value="${CUSTOM_MODEL_VALUE}">一覧にないモデル名を書く…</option>`
    ];
    refs[field.select].innerHTML = options.join('');
    refs[field.select].value = custom ? CUSTOM_MODEL_VALUE : configured;
    refs[field.custom].value = custom ? configured : '';
    showCustomInput(field, custom);
  }

  /** 名指ししていないときの選択肢。何で走るかを括弧の中に必ず書きます。 */
  function autoModelLabel(ai, purpose) {
    const running = ai.running?.[purpose]?.model;
    return running ? `自動で選ぶ（いまは ${running}）` : '自動で選ぶ';
  }

  /** いま実際に走っているモデルと推論強度。名指しの有無にかかわらず、必ず出します。 */
  function renderRunning(field, ai) {
    const running = ai.running?.[field.purpose] || {};
    if (!running.model) {
      refs[field.running].textContent = ai.available === false
        ? '実行中のモデルは、AIを利用できるようになってから分かります'
        : '';
      return;
    }
    const effort = ai.supportsEffort !== false && running.effort ? ` / ${running.effort}` : '';
    refs[field.running].textContent = `実行中: ${running.model}${effort}`;
  }

  /** 手入力の欄は、選んだときだけ出します。出しっぱなしだと、どちらが効くのか読めません。 */
  function showCustomInput(field, show) {
    refs[field.custom].hidden = !show;
  }

  /** いま欄が指しているモデル。推論強度の選択肢は、このモデルが受け付けるかで決まります。 */
  function selectedModelId(field, ai, configured) {
    const chosen = refs[field.select]?.value;
    if (chosen === CUSTOM_MODEL_VALUE) return refs[field.custom].value.trim() || configured;
    return chosen || ai.running?.[field.purpose]?.model || '';
  }

  /**
   * 推論強度です。共通の指定を持たないAIでも欄は残し、受け付けないことを非アクティブな
   * 選択肢として書きます。受け付けるAIでは、いま選んでいるモデルが持たない強度も残し、
   * そのモデルでは選べないことを添えます。選べない理由を保存のときまで伏せません。
   */
  function renderEffort(field, ai, settings, modelId) {
    const select = refs[field.effort];
    const current = settings[field.effortKey] || '';
    if (ai.supportsEffort === false) {
      select.innerHTML = `<option value="">${escapeHtml(
        ai.effortsUnavailable || 'このAIは推論強度を受け付けません'
      )}</option>`;
      select.value = '';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    const accepted = effortsOfModel(ai, modelId);
    const values = [...new Set([...(ai.efforts || []), ...(current ? [current] : [])])];
    select.innerHTML = [
      `<option value="">${escapeHtml(autoEffortLabel(ai, field.purpose))}</option>`,
      ...values.map((effort) => {
        // 設定済みの強度は、そのモデルが受け付けなくても選べるままにします。外すと、
        // 開いただけで設定が消えたように見えるからです。
        const usable = !accepted || accepted.includes(effort) || effort === current;
        const suffix = usable ? '' : `（${modelId} は受け付けません）`;
        return `<option value="${escapeHtml(effort)}"${usable ? '' : ' disabled'}>`
          + `${escapeHtml(effort)}${escapeHtml(suffix)}</option>`;
      })
    ].join('');
    select.value = current;
  }

  /** そのモデルが受け付ける強度。申告していないモデルでは null（確かめようがない）です。 */
  function effortsOfModel(ai, modelId) {
    const model = (ai.models || []).find((entry) => entry.id === modelId);
    return model?.efforts?.length ? model.efforts : null;
  }

  function autoEffortLabel(ai, purpose) {
    const running = ai.running?.[purpose]?.effort;
    return running ? `自動で選ぶ（いまは ${running}）` : '自動で選ぶ';
  }

  /** モデル欄の下の1行。選べるモデルが何かを、一覧を開かなくても読めるようにします。 */
  function modelHint(ai) {
    const models = ai.models || [];
    if (models.length) return `選べるモデル: ${models.map((model) => model.id).join(', ')}`;
    return unavailableReason(ai);
  }

  /**
   * 一覧が空のときに書く理由。サーバーが理由を添えてこなかったときも、空欄のままには
   * しません。選択肢が無いことと、一覧を持たないAIであることは、別のことだからです。
   */
  function unavailableReason(ai) {
    return ai.modelsUnavailable
      || 'このAIは選べるモデルの一覧を持っていないので、モデル名を書いてください。';
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
    refs.settingsAutoTasks.disabled = busy;
    refs.settingsAutoTasksInterval.disabled = busy;
    refs.settingsAutoTasksInstructions.disabled = busy;
    for (const input of refs.settingsAutoTasksActions.querySelectorAll('input')) input.disabled = busy;
    refs.settingsAiEmptyTarget.disabled = busy;
  }

  function setStatus(text) {
    refs.settingsStatus.textContent = text;
  }

  function setError(text) {
    refs.settingsError.textContent = text;
    refs.settingsError.hidden = !text;
  }

  /**
   * モデルを選び直したら、その用途の推論強度を並べ直します。モデルによって受け付ける
   * 強度が違うので、選んだあとも古いモデルの並びのままだと、選べないものが選べる顔で
   * 残ります。
   */
  function refreshEffort(field) {
    if (!state.settings) return;
    const { ai = {}, settings = {} } = state.settings;
    showCustomInput(field, refs[field.select].value === CUSTOM_MODEL_VALUE);
    renderEffort(field, ai, settings, selectedModelId(field, ai, settings[field.settingKey] || ''));
  }

  function bindEvents() {
    refs.settingsButton.addEventListener('click', open);
    refs.settingsForm.addEventListener('submit', save);
    refs.settingsCancel.addEventListener('click', close);
    for (const field of MODEL_FIELDS) {
      refs[field.select].addEventListener('change', () => refreshEffort(field));
      refs[field.custom].addEventListener('change', () => refreshEffort(field));
    }
  }

  return { open, close };
}
