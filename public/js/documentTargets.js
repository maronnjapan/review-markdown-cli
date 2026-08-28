import { collectHeadingPath, targetTextOf } from './textAnchor.js';

/**
 * 本文のどこを指しているかを表す「対象」を組み立てます。
 *
 * 対象はコメント・翻訳・AIチャットの3つが共通で使い、必ず次を持ちます。
 * 選んだ文字そのもの、その前後の文脈、見出し階層。前後の文脈と見出し階層は、
 * あとで本文から同じ場所を探し直すためのものです。同じ語が何度も出てくる文書で、
 * 選んだ文字だけでは1か所に定まらないからです。
 *
 * 作り方は3通りあります。
 *   - コメント用のブロック : 見出しやその段落の文字だけ。コメントを付ける先を指します。
 *   - 読ませる用のブロック : 見出しなら配下ごと。翻訳やAIに読ませるのは節のまとまりです。
 *   - 選択範囲             : レビュアーがドラッグで選んだ文字。
 */

/** 前後の文脈として持ち回る文字数。サーバー側の `ANCHOR_CONTEXT_CHARS` と同じ値です。 */
const SELECTION_CONTEXT_LENGTH = 120;

export function createDocumentTargets(document, content) {
  /** コメントを付ける先。見出し配下ではなく、その見出し自身の文字を指します。 */
  function forComment(element, type) {
    const text = targetTextOf(element).trim();
    return {
      type,
      selectedText: text,
      targetText: text,
      heading: type === 'section' ? text : undefined,
      headingPath: collectHeadingPath(content, element)
    };
  }

  /**
   * 読ませる先。見出しを選んだときは、その配下の本文までを1つの対象にします。
   * 見出しの文字だけを訳しても、AIに聞いても、読み手には何も返らないからです。
   */
  function forReading(element, type) {
    const nodes = type === 'section' ? sectionNodes(element) : [element];
    const selectedText = nodes.map((node) => targetTextOf(node).trim()).filter(Boolean).join('\n\n');
    const context = contextAroundNodes(nodes);
    return {
      type,
      selectedText,
      targetText: selectedText,
      heading: type === 'section' ? targetTextOf(element).trim() : undefined,
      headingPath: collectHeadingPath(content, element),
      contextBefore: context.before,
      contextAfter: context.after
    };
  }

  /** レビュアーがドラッグで選んだ文字。何も選んでいなければ null。 */
  function forSelection(range, selectedText) {
    if (!selectedText) return null;
    const containerNode = range.commonAncestorContainer;
    const containerElement = containerNode.nodeType === 3 ? containerNode.parentElement : containerNode;
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(content);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(content);
    afterRange.setStart(range.endContainer, range.endOffset);
    return {
      type: 'text-selection',
      selectedText,
      contextBefore: cleanRangeText(beforeRange).slice(-SELECTION_CONTEXT_LENGTH).trim(),
      contextAfter: cleanRangeText(afterRange).slice(0, SELECTION_CONTEXT_LENGTH).trim(),
      headingPath: collectHeadingPath(content, containerElement)
    };
  }

  /** 見出しと、次の同じ深さ以上の見出しが来るまでの兄弟すべて。 */
  function sectionNodes(heading) {
    const nodes = [heading];
    const level = Number(heading.tagName.slice(1));
    let next = heading.nextElementSibling;
    while (next) {
      if (/^H[1-6]$/.test(next.tagName) && Number(next.tagName.slice(1)) <= level) break;
      nodes.push(next);
      next = next.nextElementSibling;
    }
    return nodes;
  }

  function contextAroundNodes(nodes) {
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(content);
    beforeRange.setEndBefore(nodes[0]);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(content);
    afterRange.setStartAfter(nodes.at(-1));
    return {
      before: cleanRangeText(beforeRange).slice(-SELECTION_CONTEXT_LENGTH).trim(),
      after: cleanRangeText(afterRange).slice(0, SELECTION_CONTEXT_LENGTH).trim()
    };
  }

  /**
   * 範囲の文字。こちらが本文へ差し込んだボタンは外します。
   * 「翻訳」「AIに質問」といったボタンの文字が、対象の一部として保存されてしまうからです。
   */
  function cleanRangeText(range) {
    const fragment = range.cloneContents();
    fragment.querySelectorAll?.('.inline-target-action').forEach((button) => button.remove());
    const wrapper = document.createElement('div');
    wrapper.append(fragment);
    return wrapper.innerText || wrapper.textContent || '';
  }

  return { forComment, forReading, forSelection };
}
