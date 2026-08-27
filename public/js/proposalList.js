import { commentTargetText, labelForType } from './comments.js';
import { escapeHtml } from './util.js';

/**
 * 「AIが作ったコメント候補を、レビュアーが1件ずつ採用する」一覧です。
 *
 * 指摘の配置とAIレビューは、作り方が違うだけで出てくるものは同じなので、
 * カードの描画も採用・破棄・対象表示の操作もここへまとめています。
 * 採用するまでレビューには何も保存しません。
 */

const CONFIDENCE_LABELS = {
  high: '確度 高',
  medium: '確度 中',
  low: '確度 低'
};

const SEVERITY_LABELS = {
  must: '要対応',
  should: '検討',
  idea: '提案'
};

export function createProposalList({
  container,
  state,
  toaster,
  onAddComments,
  onRevealTarget,
  emptyHtml,
  loadingHtml,
  errorPrefix,
  // 候補は state のどこに載っているか。パネルごとに置き場所が違います。
  read,
  extraHtml = () => ''
}) {
  function proposals() {
    return read(state)?.placements || [];
  }

  function add(index) {
    const proposal = proposals()[index];
    if (!proposal) return;
    read(state).placements.splice(index, 1);
    onAddComments([commentEntry(proposal)]);
    render();
  }

  function addAll() {
    const entries = proposals();
    if (entries.length === 0) return;
    read(state).placements = [];
    onAddComments(entries.map(commentEntry));
    render();
  }

  function dismiss(index) {
    if (!proposals()[index]) return;
    read(state).placements.splice(index, 1);
    render();
  }

  function reveal(index) {
    const proposal = proposals()[index];
    if (!proposal || onRevealTarget(proposal.target)) return;
    toaster.error(state.mode === 'edit'
      ? '編集モードでは対象箇所を表示できません。'
      : '本文から対象箇所を見つけられませんでした。');
  }

  /** The reviewer's edits in the card are what gets saved, not the AI's draft. */
  function edit(index, value) {
    const proposal = proposals()[index];
    if (proposal) proposal.comment = value;
  }

  function render() {
    const actions = { add, addAll, dismiss, reveal };
    container.innerHTML = resultsHtml(read(state), { emptyHtml, loadingHtml, errorPrefix, extraHtml });
    container.querySelectorAll('textarea[data-placement-index]').forEach((textarea) => {
      textarea.addEventListener('input', () => edit(Number(textarea.dataset.placementIndex), textarea.value));
    });
    container.querySelectorAll('[data-placement-action]').forEach((button) => {
      button.addEventListener('click', () => actions[button.dataset.placementAction]?.(Number(button.dataset.index)));
    });
  }

  return { render };
}

/**
 * `source` marks where the comment came from once it is saved in the review file.
 * AIレビューの候補は、どのスキルがどこを読んで書いた指摘かも一緒に残します。
 * 対象テキスト（レビューされた部分）は target が持っているので重複させません。
 */
function commentEntry(proposal) {
  return {
    target: {
      ...proposal.target,
      source: proposal.source || 'ai',
      ...(proposal.review ? { review: proposal.review } : {})
    },
    comment: proposal.comment
  };
}

function resultsHtml(result, { emptyHtml, loadingHtml, errorPrefix, extraHtml }) {
  if (!result) return emptyHtml;
  // 待たせる工程が複数あるパネルは、いまどこを読んでいるかで待ちの表示を変えます。
  if (result.status === 'loading') {
    return typeof loadingHtml === 'function' ? loadingHtml(result) : loadingHtml;
  }
  if (result.status === 'error') return `<p class="ai-error">${errorPrefix}: ${escapeHtml(result.error)}</p>`;

  const placements = result.placements || [];
  const unplaced = result.unplaced || [];
  if (placements.length === 0 && unplaced.length === 0) {
    return `${extraHtml(result)}<p class="muted">追加できる候補は残っていません。</p>`;
  }
  return [
    extraHtml(result),
    placements.length ? summaryHtml(placements.length) : '',
    ...placements.map(cardHtml),
    result.droppedPlacements > 0
      ? `<p class="placement-note">候補が多いため、${result.droppedPlacements}件は表示していません。指摘を分けて実行してください。</p>`
      : '',
    unplacedHtml(unplaced, result.unplacedTitle)
  ].join('');
}

function summaryHtml(count) {
  return `
    <div class="placement-summary">
      <span>コメント候補 ${count}件</span>
      <button type="button" data-placement-action="addAll">すべて追加</button>
    </div>`;
}

function cardHtml(proposal, index) {
  const target = proposal.target || {};
  const headingPath = (target.headingPath || []).filter(Boolean).join(' › ');
  return `
    <article class="placement-card" data-index="${index}">
      <div class="placement-card-head">
        <span class="target-badge" data-type="${escapeHtml(target.type || '')}">${escapeHtml(labelForType(target.type))}</span>
        ${severityHtml(proposal.severity)}
        <span class="placement-confidence" data-confidence="${escapeHtml(proposal.confidence || 'medium')}">${escapeHtml(CONFIDENCE_LABELS[proposal.confidence] || CONFIDENCE_LABELS.medium)}</span>
        ${skillHtml(proposal.review?.skillName)}
      </div>
      ${headingPath ? `<p class="placement-path">${escapeHtml(headingPath)}</p>` : ''}
      <blockquote class="placement-quote">${escapeHtml(commentTargetText(target))}</blockquote>
      ${proposal.reason ? `<p class="placement-reason">${escapeHtml(proposal.reason)}</p>` : ''}
      <textarea data-placement-index="${index}" rows="${commentRows(proposal.comment)}">${escapeHtml(proposal.comment || '')}</textarea>
      <div class="placement-card-actions">
        <button type="button" data-placement-action="reveal" data-index="${index}">対象を表示</button>
        <button type="button" data-placement-action="add" data-index="${index}">コメントを追加</button>
        <button type="button" data-placement-action="dismiss" data-index="${index}">破棄</button>
      </div>
    </article>`;
}

/**
 * 候補の本文がそのまま見える高さ。AIレビューの指摘は依頼・影響・直し方の3行なので、
 * 固定の高さだと、採用する前に読めるのは1行目だけになってしまいます。
 */
function commentRows(comment) {
  return Math.min(8, Math.max(3, String(comment || '').split('\n').length));
}

/** 複数のスキルで読ませたとき、どの観点から出た指摘かはここで分かります。 */
function skillHtml(skillName) {
  if (!skillName) return '';
  return `<span class="placement-skill" title="${escapeHtml(skillName)}">${escapeHtml(skillName)}</span>`;
}

/** 重みはAIレビューだけが付けます。指摘の配置の候補には出ません。 */
function severityHtml(severity) {
  if (!SEVERITY_LABELS[severity]) return '';
  return `<span class="placement-severity" data-severity="${escapeHtml(severity)}">${escapeHtml(SEVERITY_LABELS[severity])}</span>`;
}

function unplacedHtml(unplaced, title = '対象箇所を特定できなかった指摘') {
  if (unplaced.length === 0) return '';
  return `
    <section class="placement-unplaced">
      <h3>${escapeHtml(title)}</h3>
      <ul>
        ${unplaced.map((entry) => `<li><strong>${escapeHtml(entry.note)}</strong>${entry.reason ? ` — ${escapeHtml(entry.reason)}` : ''}</li>`).join('')}
      </ul>
    </section>`;
}
