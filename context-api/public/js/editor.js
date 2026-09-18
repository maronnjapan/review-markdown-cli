/**
 * ブロック単位のMarkdownエディタです。Notion風の書き心地を、素の `<textarea>` で作ります。
 *
 * ── 編集中のブロックだけを入力欄にする ──────────────────────
 * 本文は空行で区切ったブロックの並びとして持ちます（`markdown.js` の `splitBlocks`）。
 * 描いてあるブロックを押すと、その1つだけが `<textarea>` に変わり、離れると描き直します。
 * ページ全体を1つの入力欄にしないのは、長いページでも押した所だけを描き直せば済むようにするためです。
 * `contenteditable` を使わないのは、日本語入力（IME）の変換中にEnterを押したときの振る舞いを、
 * ブラウザごとに合わせ込む手間を避けるためです。`<textarea>` なら変換の確定はブラウザが面倒を見ます。
 *
 * ── キー操作 ─────────────────────────────────────
 * Enter: ブロックを分ける（箇条書きの中では次の項目、空の項目なら箇条書きを抜ける）。Shift+Enter: 改行。
 * Backspace（先頭）: 前のブロックへ繋げる。↑↓（端の行）: 前後のブロックへ移る。
 * Tab / Shift+Tab: 字下げを増やす・減らす。`/`（空のブロック）: ブロックの種類を選ぶ。
 * ⌘/Ctrl+B・I・E: 太字・斜体・コード。Esc: 編集をやめる。
 */

import { blockKind, joinBlocks, renderBlock, splitBlocks } from './markdown.js';
import { el, escapeHtml } from './util.js';

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
const FENCE = /^\s*(```|~~~)/;

const SLASH_ITEMS = [
  { id: 'text', label: 'テキスト', hint: 'ふつうの段落', icon: 'T', prefix: '', keywords: ['text', 'p'] },
  { id: 'h1', label: '見出し1', hint: '大見出し', icon: 'H1', prefix: '# ', keywords: ['h1', 'heading', '見出し'] },
  { id: 'h2', label: '見出し2', hint: '中見出し', icon: 'H2', prefix: '## ', keywords: ['h2', 'heading', '見出し'] },
  { id: 'h3', label: '見出し3', hint: '小見出し', icon: 'H3', prefix: '### ', keywords: ['h3', 'heading', '見出し'] },
  { id: 'bullet', label: '箇条書き', hint: '・で並べる', icon: '•', prefix: '- ', keywords: ['ul', 'list', 'bullet', 'かじょう'] },
  { id: 'number', label: '番号付きリスト', hint: '1. 2. 3.', icon: '1.', prefix: '1. ', keywords: ['ol', 'number', 'ばんごう'] },
  { id: 'todo', label: 'ToDo', hint: 'チェックボックス', icon: '☐', prefix: '- [ ] ', keywords: ['todo', 'task', 'check'] },
  { id: 'quote', label: '引用', hint: '引用ブロック', icon: '❝', prefix: '> ', keywords: ['quote', 'いんよう'] },
  { id: 'code', label: 'コード', hint: 'コードブロック', icon: '</>', prefix: '```\n', suffix: '\n```', keywords: ['code', 'pre'] },
  { id: 'table', label: '表', hint: '2列の表', icon: '▦', prefix: '| 列1 | 列2 |\n| --- | --- |\n| ', suffix: ' |  |', keywords: ['table', 'ひょう'] },
  { id: 'divider', label: '区切り線', hint: '横線', icon: '—', prefix: '---', keywords: ['hr', 'divider', 'line'] }
];

/**
 * @param {object} options
 * @param {HTMLElement} options.root エディタを描く要素。
 * @param {Function} [options.onChange] 本文が変わるたびに呼びます（保存は呼ぶ側が間引きます）。
 * @param {Function} [options.onExitUp] 先頭のブロックから上へ抜けるとき（題名へ移る）。
 */
export function createEditor({ root, onChange = () => {}, onExitUp = () => {} }) {
  let blocks = [''];
  let editing = -1;
  let menu = null;

  root.classList.add('editor');
  root.addEventListener('click', onRootClick);
  root.addEventListener('change', onRootChange);

  /* ---------------------------------------------------------------- *
   * 描く
   * ---------------------------------------------------------------- */

  function blockElement(index) {
    return root.children[index] || null;
  }

  function createBlockElement(block, index) {
    const element = el('div', { class: 'block', dataset: { index: String(index), kind: blockKind(block) } });
    element.innerHTML = block.trim() ? renderBlock(block) : '<p class="block-empty" data-placeholder="ここに書く。「/」でブロックの種類を選べます。"></p>';
    return element;
  }

  function renderAll() {
    root.replaceChildren(...blocks.map((block, index) => createBlockElement(block, index)));
  }

  function renumber() {
    [...root.children].forEach((child, index) => { child.dataset.index = String(index); });
  }

  function rerender(index) {
    const fresh = createBlockElement(blocks[index], index);
    blockElement(index).replaceWith(fresh);
    return fresh;
  }

  /* ---------------------------------------------------------------- *
   * 編集に入る・出る
   * ---------------------------------------------------------------- */

  function edit(index, { caret = 'end' } = {}) {
    if (index < 0 || index >= blocks.length) return;
    if (editing === index) {
      blockElement(index).querySelector('textarea')?.focus();
      return;
    }
    commit();
    editing = index;
    const element = blockElement(index);
    element.classList.add('editing');
    element.dataset.kind = blockKind(blocks[index]);
    const textarea = el('textarea', { class: 'block-input', rows: '1', spellcheck: 'true', 'aria-label': 'ブロックの本文' });
    textarea.value = blocks[index];
    element.replaceChildren(textarea);
    autosize(textarea);
    textarea.focus();
    const position = caret === 'start' ? 0 : typeof caret === 'number' ? Math.min(caret, textarea.value.length) : textarea.value.length;
    textarea.setSelectionRange(position, position);

    textarea.addEventListener('input', () => {
      blocks[index] = textarea.value;
      element.dataset.kind = blockKind(textarea.value);
      autosize(textarea);
      updateMenu(index, textarea);
      onChange();
    });
    textarea.addEventListener('keydown', (event) => onKeyDown(event, index, textarea));
    textarea.addEventListener('blur', () => {
      // 続けて別のブロックへ移るときは、移る側が先に commit を呼んでいます。
      setTimeout(() => {
        if (editing === index && document.activeElement !== textarea) commit();
      }, 0);
    });
    textarea.addEventListener('paste', () => {
      // 段落をまとめて貼ったときは、貼り終わったあとにブロックへ分けます。
      setTimeout(() => {
        if (editing === index && splitBlocks(textarea.value).length > 1) {
          commit();
        }
      }, 0);
    });
  }

  function commit() {
    if (editing < 0) return;
    const index = editing;
    editing = -1;
    closeMenu();
    const element = blockElement(index);
    const textarea = element?.querySelector('textarea');
    const value = textarea ? textarea.value : blocks[index];
    const parts = splitBlocks(value);
    if (parts.length <= 1) {
      blocks[index] = parts[0] ?? '';
      if (element) rerender(index);
    } else {
      blocks.splice(index, 1, ...parts);
      renderAll();
    }
  }

  function insertAfter(index, text, { focus = true } = {}) {
    blocks.splice(index + 1, 0, text);
    const element = createBlockElement(text, index + 1);
    const current = blockElement(index);
    if (current) current.after(element);
    else root.append(element);
    renumber();
    if (focus) edit(index + 1, { caret: 'start' });
  }

  /* ---------------------------------------------------------------- *
   * キー操作
   * ---------------------------------------------------------------- */

  function onKeyDown(event, index, textarea) {
    if (event.isComposing || event.keyCode === 229) return;
    if (menu && menuKey(event)) return;
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey) {
      if (event.key === 'b') return wrapSelection(event, textarea, index, '**');
      if (event.key === 'i') return wrapSelection(event, textarea, index, '*');
      if (event.key === 'e') return wrapSelection(event, textarea, index, '`');
      return undefined;
    }
    switch (event.key) {
      case 'Enter': {
        if (event.shiftKey || insideOpenFence(value, start)) return undefined;
        event.preventDefault();
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const line = value.slice(lineStart, start);
        const list = line.match(LIST_LINE);
        if (list) {
          const content = line.slice(list[0].length);
          if (!content.trim() && start === end) return leaveList(index, textarea, lineStart);
          textarea.setRangeText(`\n${nextMarker(list)}`, start, end, 'end');
          blocks[index] = textarea.value;
          autosize(textarea);
          onChange();
          return undefined;
        }
        return splitAt(index, textarea);
      }
      case 'Backspace': {
        if (start !== 0 || end !== 0) return undefined;
        if (index === 0) {
          if (value === '' && blocks.length > 1) {
            event.preventDefault();
            removeBlock(index);
          }
          return undefined;
        }
        event.preventDefault();
        return mergeIntoPrevious(index, value);
      }
      case 'Delete': {
        if (start !== value.length || end !== start || index >= blocks.length - 1) return undefined;
        event.preventDefault();
        const next = blocks[index + 1];
        blocks[index] = value ? `${value}${next ? `\n${next}` : ''}` : next;
        blocks.splice(index + 1, 1);
        blockElement(index + 1).remove();
        renumber();
        textarea.value = blocks[index];
        textarea.setSelectionRange(value.length, value.length);
        autosize(textarea);
        onChange();
        return undefined;
      }
      case 'ArrowUp': {
        if (value.slice(0, start).includes('\n')) return undefined;
        event.preventDefault();
        if (index === 0) onExitUp();
        else edit(index - 1, { caret: 'end' });
        return undefined;
      }
      case 'ArrowDown': {
        if (value.slice(end).includes('\n') || index >= blocks.length - 1) return undefined;
        event.preventDefault();
        edit(index + 1, { caret: 'start' });
        return undefined;
      }
      case 'Tab': {
        event.preventDefault();
        return indent(textarea, index, event.shiftKey);
      }
      case 'Escape': {
        event.preventDefault();
        commit();
        return undefined;
      }
      default:
        return undefined;
    }
  }

  function splitAt(index, textarea) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const before = value.slice(0, start).replace(/\s+$/, '');
    const after = value.slice(end).replace(/^\s+/, '');
    editing = -1;
    closeMenu();
    blocks[index] = before;
    rerender(index);
    insertAfter(index, after);
    onChange();
  }

  /** 空の項目でEnter。箇条書きを抜けて、ふつうの段落を始めます。 */
  function leaveList(index, textarea, lineStart) {
    const value = textarea.value;
    const before = value.slice(0, lineStart).replace(/\s+$/, '');
    const after = value.slice(textarea.selectionEnd).replace(/^\s+/, '');
    editing = -1;
    closeMenu();
    if (!before) {
      blocks[index] = after;
      rerender(index);
      edit(index, { caret: 'start' });
    } else {
      blocks[index] = before;
      rerender(index);
      insertAfter(index, after);
    }
    onChange();
  }

  function mergeIntoPrevious(index, value) {
    const previous = blocks[index - 1];
    const joined = value ? `${previous}${previous ? '\n' : ''}${value}` : previous;
    const caret = value ? previous.length + (previous ? 1 : 0) : previous.length;
    editing = -1;
    closeMenu();
    blocks[index - 1] = joined;
    blocks.splice(index, 1);
    blockElement(index).remove();
    renumber();
    rerender(index - 1);
    edit(index - 1, { caret });
    onChange();
  }

  function removeBlock(index) {
    editing = -1;
    closeMenu();
    blocks.splice(index, 1);
    blockElement(index).remove();
    renumber();
    edit(Math.min(index, blocks.length - 1), { caret: 'start' });
    onChange();
  }

  function indent(textarea, index, outdent) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIndex = value.indexOf('\n', end);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const segment = value.slice(lineStart, lineEnd);
    const changed = outdent ? segment.replace(/^ {1,2}/gm, '') : segment.replace(/^/gm, '  ');
    textarea.setRangeText(changed, lineStart, lineEnd, 'preserve');
    const shift = changed.length - segment.length;
    const first = Math.max(lineStart, start + Math.sign(shift) * Math.min(2, Math.abs(shift)));
    textarea.setSelectionRange(first, Math.max(first, end + shift));
    blocks[index] = textarea.value;
    autosize(textarea);
    onChange();
  }

  function wrapSelection(event, textarea, index, marker) {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const selected = value.slice(start, end);
    const wrapped = selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2
      ? selected.slice(marker.length, -marker.length)
      : `${marker}${selected}${marker}`;
    textarea.setRangeText(wrapped, start, end, 'select');
    if (!selected) textarea.setSelectionRange(start + marker.length, start + marker.length);
    blocks[index] = textarea.value;
    onChange();
  }

  /* ---------------------------------------------------------------- *
   * 「/」のメニュー
   * ---------------------------------------------------------------- */

  function updateMenu(index, textarea) {
    const value = textarea.value;
    if (value.startsWith('/') && !value.includes('\n') && value.length <= 24) openMenu(index, textarea, value.slice(1));
    else closeMenu();
  }

  function openMenu(index, textarea, filter) {
    const needle = filter.trim().toLowerCase();
    const items = SLASH_ITEMS.filter((item) => (
      !needle || item.label.includes(needle) || item.keywords.some((keyword) => keyword.startsWith(needle))
    ));
    if (items.length === 0) return closeMenu();
    if (!menu) {
      const element = el('div', { class: 'slash-menu', role: 'listbox', 'aria-label': 'ブロックの種類' });
      // メニューを押しても入力欄から焦点が外れないようにします。外れると先に commit が走り、メニューが消えます。
      element.addEventListener('mousedown', (event) => event.preventDefault());
      element.addEventListener('click', (event) => {
        const button = event.target.closest('[data-item]');
        if (button) applyMenuItem(SLASH_ITEMS.find((item) => item.id === button.dataset.item));
      });
      menu = { element, active: 0 };
    }
    menu.items = items;
    menu.index = index;
    menu.textarea = textarea;
    menu.active = Math.min(menu.active, items.length - 1);
    paintMenu();
    blockElement(index).append(menu.element);
    return undefined;
  }

  function paintMenu() {
    menu.element.innerHTML = menu.items.map((item, position) => (
      `<button type="button" role="option" data-item="${item.id}" class="${position === menu.active ? 'active' : ''}" aria-selected="${position === menu.active}">`
      + `<span class="slash-icon">${escapeHtml(item.icon)}</span>`
      + `<span class="slash-text"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.hint)}</small></span></button>`
    )).join('');
  }

  function menuKey(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      menu.active = (menu.active + delta + menu.items.length) % menu.items.length;
      paintMenu();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      applyMenuItem(menu.items[menu.active]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return true;
    }
    return false;
  }

  function applyMenuItem(item) {
    if (!menu || !item) return;
    const { index, textarea } = menu;
    closeMenu();
    textarea.value = `${item.prefix}${item.suffix || ''}`;
    const caret = item.prefix.length;
    textarea.setSelectionRange(caret, caret);
    blocks[index] = textarea.value;
    blockElement(index).dataset.kind = blockKind(textarea.value);
    autosize(textarea);
    onChange();
    if (item.id === 'divider') {
      editing = -1;
      rerender(index);
      insertAfter(index, '');
    }
  }

  function closeMenu() {
    if (!menu) return;
    menu.element.remove();
    menu = null;
  }

  /* ---------------------------------------------------------------- *
   * マウス
   * ---------------------------------------------------------------- */

  function onRootClick(event) {
    if (event.target.closest('a, input, button, .slash-menu')) return;
    const element = event.target.closest('.block');
    if (!element) {
      // ブロックの無い余白を押したら、末尾に書き始めます。
      if (editing >= 0) return;
      const last = blocks.length - 1;
      if (blocks[last].trim()) insertAfter(last, '');
      else edit(last);
      return;
    }
    const index = Number(element.dataset.index);
    if (index === editing) return;
    edit(index, { caret: caretFromClick(event, element, blocks[index]) });
  }

  /**
   * 押した位置に近い所へカーソルを置きます。描いた文字列と元のMarkdownは同じではないので、
   * 押した所までの文字の末尾の数文字を元の本文から探して、その後ろへ置きます。見つからなければ末尾です。
   */
  function caretFromClick(event, element, source) {
    try {
      const point = document.caretPositionFromPoint
        ? document.caretPositionFromPoint(event.clientX, event.clientY)
        : document.caretRangeFromPoint?.(event.clientX, event.clientY);
      const node = point?.offsetNode || point?.startContainer;
      const offset = point?.offset ?? point?.startOffset ?? 0;
      if (!node || !element.contains(node)) return 'end';
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setEnd(node, offset);
      const prefix = range.toString().replace(/\s+/g, ' ');
      const tail = prefix.slice(-12).trim();
      if (!tail) return 'start';
      const found = source.replace(/\s+/g, ' ').lastIndexOf(tail);
      if (found < 0) return 'end';
      // 空白をまとめた文字列での位置を、元の本文の位置へ戻します。
      let seen = 0;
      for (let cursor = 0; cursor < source.length; cursor += 1) {
        if (/\s/.test(source[cursor]) && cursor > 0 && /\s/.test(source[cursor - 1])) continue;
        if (seen === found + tail.length) return cursor;
        seen += 1;
      }
      return 'end';
    } catch {
      return 'end';
    }
  }

  function onRootChange(event) {
    const checkbox = event.target.closest('input.task-checkbox');
    if (!checkbox) return;
    const element = checkbox.closest('.block');
    const index = Number(element.dataset.index);
    const line = Number(checkbox.dataset.line);
    const lines = blocks[index].split('\n');
    if (!lines[line]) return;
    lines[line] = checkbox.checked ? lines[line].replace(/\[[ ]\]/, '[x]') : lines[line].replace(/\[[xX]\]/, '[ ]');
    blocks[index] = lines.join('\n');
    rerender(index);
    onChange();
  }

  /* ---------------------------------------------------------------- *
   * 口
   * ---------------------------------------------------------------- */

  return {
    setContent(text) {
      editing = -1;
      closeMenu();
      blocks = splitBlocks(text);
      if (blocks.length === 0) blocks = [''];
      renderAll();
    },
    getContent() {
      return joinBlocks(blocks);
    },
    focusFirst() {
      edit(0, { caret: 'start' });
    },
    focusLast() {
      edit(blocks.length - 1, { caret: 'end' });
    },
    commit,
    isEditing() {
      return editing >= 0;
    }
  };
}

function autosize(textarea) {
  textarea.style.height = '0px';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function insideOpenFence(value, position) {
  let open = false;
  for (const line of value.slice(0, position).split('\n')) {
    if (FENCE.test(line)) open = !open;
  }
  return open;
}

/** 次の項目の印。番号付きなら1つ進め、ToDoなら未完のチェックボックスにします。 */
function nextMarker(list) {
  const [, indent, marker, spacing, task] = list;
  const ordered = marker.match(/^(\d+)([.)])$/);
  const nextMark = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker;
  return `${indent}${nextMark}${spacing}${task ? '[ ] ' : ''}`;
}
