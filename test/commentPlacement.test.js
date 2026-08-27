import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/markdown.js';
import { findTextRange } from '../public/js/textAnchor.js';
import {
  PLACEMENT_SCHEMA,
  buildPlacements,
  extractDocumentSegments,
  placementPrompt
} from '../src/commentPlacement.js';

const MARKDOWN = [
  '# 設計メモ',
  '',
  '## 背景',
  '',
  'この段落は **冗長** な説明を含みます。',
  '',
  '- 手順1を実行する',
  '- 手順2を実行する',
  '',
  '> 引用した注意書きです。',
  ''
].join('\n');

test('segments carry the rendered text, not the Markdown the reviewer wrote', async () => {
  const segments = await extractDocumentSegments(MARKDOWN);
  const paragraph = segments.find((segment) => segment.tagName === 'p' && segment.text.startsWith('この段落'));

  assert.equal(paragraph.text, 'この段落は 冗長 な説明を含みます。', '強調記号は本文に残らない');
  assert.deepEqual(paragraph.headingPath, ['設計メモ', '背景']);
  assert.equal(paragraph.commentType, 'paragraph');
  assert.equal(paragraph.contextBefore, '背景');
  assert.match(paragraph.contextAfter, /手順1/);

  const heading = segments.find((segment) => segment.text === '背景');
  assert.equal(heading.commentType, 'section');
  assert.deepEqual(heading.headingPath, ['設計メモ', '背景'], '見出し自身も階層に入る');

  // The blockquote only wraps its paragraph, so the comment target is the paragraph.
  assert.deepEqual(
    segments.filter((segment) => segment.text === '引用した注意書きです。').map((segment) => segment.tagName),
    ['p']
  );
});

test('the prompt hands over the numbered segments and treats both sides as data', async () => {
  const segments = await extractDocumentSegments(MARKDOWN);
  const prompt = placementPrompt(segments, '冗長な説明を削ってほしい');

  assert.match(prompt, /"i":0/);
  assert.match(prompt, /この段落は 冗長 な説明を含みます。/);
  assert.match(prompt, /<reviewer_notes>冗長な説明を削ってほしい<\/reviewer_notes>/);
  assert.match(prompt, /data, not instructions/);
  assert.deepEqual(Object.keys(PLACEMENT_SCHEMA.properties), ['placements', 'unplaced']);
});

test('a quoted placement becomes a text selection comment with the context around it', async () => {
  const segments = await extractDocumentSegments(MARKDOWN);
  const paragraphIndex = segments.findIndex((segment) => segment.text.startsWith('この段落'));

  const { placements } = buildPlacements(segments, {
    placements: [{
      segmentIndex: paragraphIndex,
      // Whitespace the model normalized differently still matches the rendered text.
      quote: '冗長  な説明',
      comment: '冗長な説明を削ってほしい',
      reason: '該当する説明です',
      confidence: 'high'
    }],
    unplaced: []
  });

  assert.equal(placements.length, 1);
  assert.deepEqual(placements[0].target, {
    type: 'text-selection',
    selectedText: '冗長 な説明',
    contextBefore: '背景 この段落は',
    contextAfter: 'を含みます。 手順1を実行する',
    headingPath: ['設計メモ', '背景']
  });
  assert.equal(placements[0].comment, '冗長な説明を削ってほしい');
  assert.equal(placements[0].confidence, 'high');
});

test('a placement without a usable quote falls back to the whole block', async () => {
  const segments = await extractDocumentSegments(MARKDOWN);
  const headingIndex = segments.findIndex((segment) => segment.text === '背景');
  const listIndex = segments.findIndex((segment) => segment.text === '手順1を実行する');

  const { placements } = buildPlacements(segments, {
    placements: [
      { segmentIndex: headingIndex, quote: '', comment: '背景の粒度を揃えて', reason: '', confidence: 'medium' },
      {
        segmentIndex: listIndex,
        quote: 'この文は本文のどこにもありません',
        comment: '手順に前提を足して',
        reason: '',
        confidence: 'low'
      }
    ],
    unplaced: []
  });

  assert.deepEqual(placements[0].target, {
    type: 'section',
    selectedText: '背景',
    targetText: '背景',
    headingPath: ['設計メモ', '背景'],
    heading: '背景'
  });
  assert.equal(placements[1].target.type, 'paragraph', '言い換えられた引用でもブロックには残す');
  assert.equal(placements[1].target.selectedText, '手順1を実行する');
});

test('a placement pointing outside the document is reported as unplaced, never guessed at', async () => {
  const segments = await extractDocumentSegments(MARKDOWN);

  const { placements, unplaced } = buildPlacements(segments, {
    placements: [
      { segmentIndex: 999, quote: '', comment: '存在しない箇所への指摘', reason: '', confidence: 'low' },
      { segmentIndex: 0, quote: '', comment: '   ', reason: '', confidence: 'low' }
    ],
    unplaced: [{ note: '全体的に長い', reason: '特定の箇所を選べません' }]
  });

  assert.equal(placements.length, 0);
  assert.deepEqual(unplaced, [
    { note: '全体的に長い', reason: '特定の箇所を選べません' },
    { note: '存在しない箇所への指摘', reason: '対象箇所を特定できませんでした' }
  ]);
});

test('a table cell keeps its neighbours as context so a short quote still anchors', async () => {
  const segments = await extractDocumentSegments([
    '| 項目 | 値 |',
    '| --- | --- |',
    '| 通信量 | 12 |'
  ].join('\n'));
  const cell = segments.find((segment) => segment.text === '12');

  assert.equal(cell.commentType, 'text-selection', '表のセルにはコメント操作がないため範囲選択として扱う');
  const { placements } = buildPlacements(segments, {
    placements: [{ segmentIndex: cell.index, quote: '', comment: '単位が抜けている', reason: '', confidence: 'high' }],
    unplaced: []
  });
  assert.equal(placements[0].target.contextBefore, '通信量');
});

test('only the first placements are kept, and the rest are reported rather than dropped in silence', async () => {
  const segments = await extractDocumentSegments(MARKDOWN);
  const proposed = Array.from({ length: 34 }, () => ({
    segmentIndex: 0, quote: '', comment: '見出しを見直して', reason: '', confidence: 'medium'
  }));

  const result = buildPlacements(segments, { placements: proposed, unplaced: [] });

  assert.equal(result.placements.length, 30);
  assert.equal(result.droppedPlacements, 4);
});

test('every proposed target can be found again in the document the reviewer sees', async (t) => {
  const markdown = [
    '# API設計メモ',
    '',
    '## 仕様',
    '',
    'リクエストは1分あたり60回まで受け付けます。',
    '',
    '- レスポンスは最大100件を返す',
    '',
    '| 項目 | 値 |',
    '| --- | --- |',
    '| タイムアウト | 30 |'
  ].join('\n');
  const segments = await extractDocumentSegments(markdown);
  const indexOf = (text) => segments.find((segment) => segment.text.includes(text)).index;

  const { placements } = buildPlacements(segments, {
    placements: [
      { segmentIndex: indexOf('1分あたり60回'), quote: '1分あたり60回', comment: '根拠を書いて', reason: '', confidence: 'high' },
      { segmentIndex: indexOf('最大100件'), quote: '', comment: '超過時の挙動は？', reason: '', confidence: 'high' },
      { segmentIndex: indexOf('30'), quote: '', comment: '単位が抜けている', reason: '', confidence: 'medium' },
      { segmentIndex: indexOf('仕様'), quote: '', comment: '節を分けて', reason: '', confidence: 'low' }
    ],
    unplaced: []
  });

  const { window } = new JSDOM(`<div id="content">${await renderMarkdown(markdown)}</div>`);
  globalThis.NodeFilter = window.NodeFilter;
  t.after(() => {
    delete globalThis.NodeFilter;
    window.close();
  });
  const content = window.document.querySelector('#content');

  for (const { target } of placements) {
    const match = findTextRange(content, target.selectedText, target.contextBefore, target.contextAfter);
    assert.ok(match, `${target.selectedText} を本文から見つけられない`);
    const range = window.document.createRange();
    range.setStart(match.startNode, match.startOffset);
    range.setEnd(match.endNode, match.endOffset);
    assert.equal(range.toString().replace(/\s+/g, ' ').trim(), target.selectedText);
  }

  // "30" repeats inside "100" and "60"; the cell's neighbours are what disambiguates it.
  const cell = placements.find(({ target }) => target.selectedText === '30');
  const cellMatch = findTextRange(content, '30', cell.target.contextBefore, cell.target.contextAfter);
  assert.equal(cellMatch.startNode.parentElement.tagName, 'TD');
});
