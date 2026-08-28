import { aiContextBlock } from './aiContext.js';
import { MAX_VERIFIED_SEGMENT_CHARS, MAX_OUTLINE_HEADINGS } from './aiLimits.js';
import { CONFIDENCE_ORDER, SEVERITY_ORDER, isConfidence, isSeverity } from './aiVocabulary.js';
import { buildPlacements, promptSegments } from './commentPlacement.js';
import { hasPersonaContent } from './persona.js';
import {
  firstPassPrompt,
  reviewSchema as buildReviewSchema,
  verificationPrompt as buildVerificationPrompt,
  verificationSchema
} from './prompts/review.js';

/**
 * AIレビューは「どの観点で読むか（レビュースキル）」と「誰として読むか（読み手
 * ペルソナ）」を決めてから本文を読ませ、指摘を箇所ごとのコメント候補にして返します。
 *
 * レビュースキルは複数選べます。観点ごとに読み直すのではなく、選んだ観点をすべて
 * 持った1人として1回で読ませ、指摘それぞれにどの観点から出たかを言わせます。
 * 同じ箇所が別々の観点から挙がったとき、それが同じ指摘かどうかを判断できるのは
 * 全部を並べて読んでいるモデルの側だけだからです。
 *
 * 読みは2周します。1周目で指摘を出させ、2周目で同じモデルにその指摘を反証させます。
 * 2周目が失敗しても1周目の指摘は返します。
 *
 * 出力は「指摘の配置」と同じ形です。モデルが選ぶのはレンダリング後のブロックなので、
 * 候補の対象は手動で付けたコメントと同じように本文へ結び付きます。
 * 採用するまでレビューファイルへは何も書きません。
 *
 * ── このモジュールが持っているもの ──────────────────────────
 * プロンプトへ渡す材料の組み立て（見取り図・スキルの枠・反証へ添える本文）と、
 * 返ってきた答えの検証・重ね合わせ・並べ替えです。文面と答えの形そのものは
 * `prompts/review.js` にあります。厳しさや取り下げ条件を変えたいときはそちらです。
 */

export { verificationSchema };

/** 指摘がどのスキルの観点から出たかを言わせるので、スキルのidで形が変わります。 */
export function reviewSchema(skills) {
  return buildReviewSchema(skills.map((skill) => skill.id));
}

export function reviewPrompt(segments, skills, readingContext) {
  return firstPassPrompt({
    multiple: skills.length > 1,
    reader: hasPersonaContent(readingContext?.persona),
    readingContextBlock: aiContextBlock(readingContext),
    skillsBlock: skillsBlock(skills),
    outlineBlock: outlineBlock(segments),
    segmentsJson: JSON.stringify(promptSegments(segments))
  });
}

export function verificationPrompt(answer, segments, skills, readingContext) {
  const unplaced = list(answer?.unplaced);
  return buildVerificationPrompt({
    findingsJson: JSON.stringify(verifiableFindings(list(answer?.placements), segments)),
    unplacedJson: unplaced.length
      ? JSON.stringify(unplaced.map((entry, index) => ({ index, note: entry?.note || '' })))
      : '',
    readingContextBlock: aiContextBlock(readingContext),
    skillsBlock: skillReferenceBlock(skills)
  });
}

/**
 * 反証の結果を1周目の答えへ重ねます。判定の返らなかった指摘は残します。
 * 反証は指摘を削るための工程で、答えそのものではないからです。
 */
export function applyVerification(answer, verification) {
  const proposed = list(answer?.placements);
  const proposedUnplaced = list(answer?.unplaced);
  const verdicts = byIndex(verification?.verdicts);
  const unplacedVerdicts = byIndex(verification?.unplacedVerdicts);

  const placements = [];
  for (const [index, placement] of proposed.entries()) {
    const verdict = verdicts.get(index);
    if (verdict?.keep === false) continue;
    placements.push(verdict ? revised(placement, verdict) : placement);
  }
  const unplaced = [];
  for (const [index, entry] of proposedUnplaced.entries()) {
    const verdict = unplacedVerdicts.get(index);
    if (verdict?.keep === false) continue;
    unplaced.push(verdict ? { ...entry, note: text(verdict.note) || entry.note } : entry);
  }

  const summary = String(verification?.summary || '').trim() || answer?.summary;
  return {
    answer: { ...answer, summary, placements, unplaced },
    refuted: (proposed.length - placements.length) + (proposedUnplaced.length - unplaced.length)
  };
}

/**
 * Reuses the placement validation, so a review finding anchors like any comment.
 * 指摘には出どころのスキルを添えます。答えたidが選んだスキルに無ければ、
 * 1つだけ選んでいるときに限りそのスキルの指摘として扱います。
 */
export function buildReviewFindings(segments, answer, skills = []) {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const ordered = { ...answer, placements: sortFindings(answer?.placements).map(commentedFinding) };
  const { placements, unplaced, droppedPlacements } = buildPlacements(segments, ordered);
  return {
    summary: String(answer?.summary || '').trim(),
    placements: placements.map((placement) => {
      const skill = byId.get(placement.skillId) || (skills.length === 1 ? skills[0] : null);
      const { skillId, ...rest } = placement;
      return skill ? { ...rest, skill: { id: skill.id, name: skill.name } } : rest;
    }),
    unplaced,
    droppedPlacements
  };
}

/**
 * 重い指摘から並べます。プロンプトでも重要な順に出すよう頼んでいますが、
 * レビュアーが上から読んで手を止められるかは並び順だけで決まるので、こちらで揃えます。
 */
function sortFindings(placements) {
  return list(placements)
    .map((placement, index) => ({ placement, index }))
    .sort((a, b) => (
      rank(SEVERITY_ORDER, a.placement?.severity) - rank(SEVERITY_ORDER, b.placement?.severity)
      || rank(CONFIDENCE_ORDER, a.placement?.confidence) - rank(CONFIDENCE_ORDER, b.placement?.confidence)
      || a.index - b.index
    ))
    .map((entry) => entry.placement);
}

function rank(order, value) {
  return order[value] ?? Object.keys(order).length;
}

/** 判定を index で引けるようにします。index の無い判定は、どの指摘のものか決められません。 */
function byIndex(verdicts) {
  return new Map(
    list(verdicts)
      .filter((verdict) => Number.isInteger(verdict?.index))
      .map((verdict) => [verdict.index, verdict])
  );
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 指摘の本文。依頼・影響・直し方をこの順で1つのコメントにします。
 *
 * 3つを別々に見せても、採用するとき保存されるのはコメント本文だけなので、
 * 直し方が候補のうちに消えてしまうからです。この文面はモデルへは渡らず、
 * レビューファイルへ書かれるものなので、`prompts/` ではなくここにあります。
 */
function commentedFinding(placement) {
  const impact = text(placement?.impact);
  const suggestion = text(placement?.suggestion);
  const comment = [
    text(placement?.comment),
    impact ? `影響: ${impact}` : '',
    suggestion ? `直し方: ${suggestion}` : ''
  ].filter(Boolean).join('\n');
  return { ...placement, comment };
}

/** 反証が直した文面を取り込みます。空で返ってきた項目は、1周目のまま残します。 */
function revised(placement, verdict) {
  return {
    ...placement,
    comment: text(verdict.comment) || placement.comment,
    impact: text(verdict.impact) || placement.impact,
    suggestion: text(verdict.suggestion) || placement.suggestion,
    severity: isSeverity(verdict.severity) ? verdict.severity : placement.severity,
    confidence: isConfidence(verdict.confidence) ? verdict.confidence : placement.confidence
  };
}

/** 反証へ渡す1周目の指摘。根拠を確かめるのに要るものだけを添えます。 */
function verifiableFindings(findings, segments) {
  return findings.map((finding, index) => ({
    index,
    skillId: finding?.skillId || '',
    quote: finding?.quote || '',
    segmentText: segmentText(segments, finding?.segmentIndex),
    comment: finding?.comment || '',
    impact: finding?.impact || '',
    suggestion: finding?.suggestion || '',
    severity: finding?.severity || '',
    confidence: finding?.confidence || ''
  }));
}

function segmentText(segments, segmentIndex) {
  const segment = segments?.[segmentIndex];
  if (!segment) return '';
  return segment.text.length > MAX_VERIFIED_SEGMENT_CHARS
    ? `${segment.text.slice(0, MAX_VERIFIED_SEGMENT_CHARS)}…`
    : segment.text;
}

/**
 * 見出しだけを並べた見取り図。段落は順に読めば分かりますが、「この節がここにある」は
 * 全体を一度に見ないと分からず、並び順の指摘はそこからしか出てきません。
 */
function outlineBlock(segments) {
  const headings = segments
    .filter((segment) => segment.commentType === 'section')
    .slice(0, MAX_OUTLINE_HEADINGS)
    .map((segment) => ({ i: segment.index, level: Number(segment.tagName.slice(1)) || 1, text: segment.text }));
  if (headings.length === 0) return '';
  return `<document_outline>${JSON.stringify(headings)}</document_outline>`;
}

function skillsBlock(skills) {
  return [
    '<review_skills>',
    ...skills.map(skillBlock),
    '</review_skills>'
  ].join('\n');
}

function skillBlock(skill) {
  return [
    `<review_skill id="${escapeAttribute(skill.id)}" name="${escapeAttribute(skill.name)}">`,
    skill.description ? `<description>${skill.description}</description>` : '',
    skill.instructions,
    // スキルの手順が名指しした判断材料。渡さなければ、その手順は実行できません。
    ...list(skill.references).map((reference) => [
      `<reference name="${escapeAttribute(reference.name)}">`,
      reference.text,
      '</reference>'
    ].join('\n')),
    '</review_skill>'
  ].filter(Boolean).join('\n');
}

/** 反証では、どのスキルから出た指摘かが分かれば足ります。本文は同じスレッドが既に読んでいます。 */
function skillReferenceBlock(skills) {
  return [
    '<review_skills>',
    ...skills.map((skill) => (
      `<review_skill id="${escapeAttribute(skill.id)}" name="${escapeAttribute(skill.name)}">${skill.description || ''}</review_skill>`
    )),
    '</review_skills>'
  ].join('\n');
}

function escapeAttribute(value) {
  return String(value).replace(/["<>&]/g, '');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
