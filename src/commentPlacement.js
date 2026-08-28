import { load } from 'cheerio';
import { aiContextBlock } from './aiContext.js';
import {
  ANCHOR_CONTEXT_CHARS,
  MAX_PLACEMENTS,
  MAX_SEGMENTS,
  MAX_SEGMENT_PROMPT_CHARS
} from './aiLimits.js';
import { DEFAULT_CONFIDENCE, isConfidence, isSeverity } from './aiVocabulary.js';
import { renderMarkdown } from './markdown.js';
import { PLACEMENT_SCHEMA, placementPrompt as buildPlacementPrompt } from './prompts/placement.js';

/**
 * Turns a reviewer's free-form notes into review comments that point at the
 * place each note is about. The model never sees Markdown source: it picks from
 * the rendered blocks the review UI itself shows, so the text a placement
 * quotes is the text the browser can find again.
 *
 * このモジュールが持つのは本文の切り分けと、返ってきた答えの検証です。
 * モデルへ渡す文面と答えの形は `prompts/placement.js` にあります。
 */

const LEAF_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th';
const HEADING_PATTERN = /^h[1-6]$/;
/** The review UI decorates only these blocks, so only they can carry a block comment. */
const BLOCK_COMMENT_TAGS = new Set(['p', 'li', 'blockquote', 'pre']);

export { PLACEMENT_SCHEMA };

/**
 * Splits the rendered document into the blocks a comment can point at. Each
 * segment carries the text as the browser will read it, so a quote taken from
 * here is anchorable without a second guess at Markdown syntax.
 */
export async function extractDocumentSegments(markdown) {
  const $ = load(await renderMarkdown(markdown), null, false);
  const segments = [];
  const headingPath = [];

  for (const element of $(LEAF_SELECTOR).toArray()) {
    const node = $(element);
    const text = normalizeText(node.text());
    if (!text || !hasOwnText($, node)) continue;

    const tagName = String(element.tagName || '').toLowerCase();
    if (HEADING_PATTERN.test(tagName)) {
      const level = Number(tagName.slice(1));
      headingPath[level - 1] = text;
      headingPath.length = level;
    }
    segments.push({
      index: segments.length,
      tagName,
      commentType: commentTypeFor(tagName),
      text,
      headingPath: headingPath.filter(Boolean),
      contextBefore: '',
      contextAfter: ''
    });
    if (segments.length >= MAX_SEGMENTS) break;
  }

  segments.forEach((segment, index) => {
    segment.contextBefore = (segments[index - 1]?.text || '').slice(-ANCHOR_CONTEXT_CHARS);
    segment.contextAfter = (segments[index + 1]?.text || '').slice(0, ANCHOR_CONTEXT_CHARS);
  });
  return segments;
}

export function placementPrompt(segments, notes, readingContext) {
  return buildPlacementPrompt(
    JSON.stringify(promptSegments(segments)),
    notes,
    aiContextBlock(readingContext)
  );
}

/**
 * The segments as a prompt carries them: only what the model needs to choose a
 * location, so a long document still fits in one prompt. AIレビューも同じ形で渡します。
 */
export function promptSegments(segments) {
  return segments.map(promptSegment);
}

function promptSegment(segment) {
  const text = segment.text.length > MAX_SEGMENT_PROMPT_CHARS
    ? `${segment.text.slice(0, MAX_SEGMENT_PROMPT_CHARS)}…`
    : segment.text;
  return {
    i: segment.index,
    kind: segment.commentType === 'section' ? 'heading' : segment.tagName,
    headingPath: segment.headingPath,
    text
  };
}

/**
 * Validates the model's answer against the segments it was given. A quote that
 * is not in its segment falls back to the whole block rather than being dropped:
 * the location is still useful even when the model paraphrased.
 */
export function buildPlacements(segments, answer) {
  const proposed = list(answer?.placements);
  const placements = [];
  const unplaced = list(answer?.unplaced)
    .map((entry) => ({
      note: String(entry?.note || '').trim(),
      reason: String(entry?.reason || '').trim()
    }))
    .filter((entry) => entry.note);

  for (const candidate of proposed.slice(0, MAX_PLACEMENTS)) {
    const comment = String(candidate?.comment || '').trim();
    const segment = segments[candidate?.segmentIndex];
    if (!comment) continue;
    if (!segment) {
      unplaced.push({ note: comment, reason: '対象箇所を特定できませんでした' });
      continue;
    }
    const quote = matchQuote(segment.text, candidate?.quote);
    placements.push({
      comment,
      reason: String(candidate?.reason || '').trim(),
      confidence: isConfidence(candidate?.confidence) ? candidate.confidence : DEFAULT_CONFIDENCE,
      // AIレビューだけが重みと出どころのスキルを付けます。無い答えに既定値は足しません。
      ...(isSeverity(candidate?.severity) ? { severity: candidate.severity } : {}),
      ...(candidate?.skillId ? { skillId: String(candidate.skillId).trim() } : {}),
      target: quote ? selectionTarget(segment, quote) : blockTarget(segment)
    });
  }

  return { placements, unplaced, droppedPlacements: Math.max(0, proposed.length - MAX_PLACEMENTS) };
}

/** The quote as it appears in the segment, or null when the model rewrote it. */
function matchQuote(segmentText, quote) {
  const normalized = normalizeText(quote || '');
  if (!normalized || normalized === segmentText) return null;
  return segmentText.includes(normalized) ? normalized : null;
}

function selectionTarget(segment, quote) {
  const start = segment.text.indexOf(quote);
  const before = `${segment.contextBefore} ${segment.text.slice(0, start)}`;
  const after = `${segment.text.slice(start + quote.length)} ${segment.contextAfter}`;
  return {
    type: 'text-selection',
    selectedText: quote,
    contextBefore: before.trim().slice(-ANCHOR_CONTEXT_CHARS).trim(),
    contextAfter: after.trim().slice(0, ANCHOR_CONTEXT_CHARS).trim(),
    headingPath: segment.headingPath
  };
}

/** Mirrors the target the review UI builds when the reviewer comments on a block. */
function blockTarget(segment) {
  const target = {
    type: segment.commentType,
    selectedText: segment.text,
    targetText: segment.text,
    headingPath: segment.headingPath
  };
  if (segment.commentType === 'section') target.heading = segment.text;
  if (segment.commentType === 'text-selection') {
    target.contextBefore = segment.contextBefore.trim();
    target.contextAfter = segment.contextAfter.trim();
  }
  return target;
}

function commentTypeFor(tagName) {
  if (HEADING_PATTERN.test(tagName)) return 'section';
  // A table cell carries no comment affordance, so point at its text instead.
  return BLOCK_COMMENT_TAGS.has(tagName) ? 'paragraph' : 'text-selection';
}

/** False for a wrapper whose whole text belongs to the blocks nested inside it. */
function hasOwnText($, node) {
  const clone = node.clone();
  clone.find(LEAF_SELECTOR).remove();
  return normalizeText(clone.text()) !== '';
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}
