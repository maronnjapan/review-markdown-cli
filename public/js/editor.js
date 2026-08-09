import { createAutosave } from './autosave.js';
import { prepareEditorCommentAnchors, syncCommentsFromEditor } from './commentAnchors.js';
import { applyMarkdownShortcuts } from './markdownShortcuts.js';
import { escapeHtml } from './util.js';

const TEXT_NODE = 3;

/**
 * Edit mode. The document is rendered as a list of `.markdown-block` elements,
 * each remembering the source range it came from, so a save only rewrites the
 * blocks that actually changed and leaves the rest of the file byte for byte.
 */
export function createEditor({ refs, state, api, onCommentsChanged, onDocumentUpdated }) {
  const root = refs.markdownContent;
  const autosave = createAutosave({
    save: saveDirtyBlocks,
    hasPendingWork: () => state.dirtyBlocks.size > 0
  });

  refs.retrySaveButton.addEventListener('click', () => autosave.run());
  refs.blockFormat.addEventListener('change', () => applyBlockFormat(refs.blockFormat.value));
  refs.editorToolbar.addEventListener('mousedown', (event) => {
    // Keep the caret where it is while a toolbar button takes the click.
    if (event.target.closest('button')) event.preventDefault();
  });
  refs.editorToolbar.addEventListener('click', handleToolbarClick);

  function render() {
    root.innerHTML = state.editableHtml;
    root.classList.add('editing');
    restoreFencedBlockSource();
    state.editorCommentBlocks = prepareEditorCommentAnchors(root, state.comments);
    root.querySelectorAll('.markdown-block').forEach(bindBlock);
    ensurePlaceholderBlock();
  }

  function bindBlock(block) {
    block.contentEditable = 'true';
    block.spellcheck = true;
    block.addEventListener('input', handleInput);
    block.addEventListener('paste', handlePaste);
    block.addEventListener('dblclick', handleMediaEdit);
  }

  /** An empty document still needs one place to start typing. */
  function ensurePlaceholderBlock() {
    if (root.querySelector('.markdown-block')) return;
    const block = root.ownerDocument.createElement('div');
    block.className = 'markdown-block new-block';
    block.dataset.blockId = `block-new-${Date.now()}`;
    block.dataset.blockKind = 'paragraph';
    block.dataset.sourceStart = String(state.markdown.length);
    block.dataset.sourceEnd = String(state.markdown.length);
    block.innerHTML = '<p><br></p>';
    root.append(block);
    bindBlock(block);
  }

  /**
   * The renderer turns fenced blocks into highlighted markup that would not
   * survive a round trip, so show the original source for code and Mermaid.
   */
  function restoreFencedBlockSource() {
    const selector = '.markdown-block[data-block-kind="code"], .markdown-block[data-block-kind="mermaid"]';
    root.querySelectorAll(selector).forEach((block) => {
      const source = state.markdown.slice(Number(block.dataset.sourceStart), Number(block.dataset.sourceEnd));
      const fence = source.match(/^(`{3,}|~{3,})\s*([^\r\n]*)\r?\n/);
      if (!fence) return;
      const closingFence = new RegExp(`\\r?\\n${fence[1][0]}{${fence[1].length},}\\s*$`);
      const document = root.ownerDocument;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const info = fence[2].trim();
      if (info) code.className = `language-${info}`;
      code.textContent = source.slice(fence[0].length).replace(closingFence, '');
      pre.append(code);
      block.replaceChildren(pre);
    });
  }

  function handleInput(event) {
    const block = event.currentTarget.closest('.markdown-block');
    if (!block) return;
    if (!event.isComposing) applyMarkdownShortcuts(block, { resolveImageSource });

    const pendingDeletion = isEmptyParagraph(block);
    block.dataset.pendingDeletion = String(pendingDeletion);
    block.classList.toggle('pending-deletion', pendingDeletion);

    const blockId = block.dataset.blockId;
    state.dirtyBlocks.add(blockId);
    state.blockVersions.set(blockId, (state.blockVersions.get(blockId) || 0) + 1);
    block.classList.add('dirty');

    syncCommentsFromEditor(root, block, state.comments, state.editorCommentBlocks);
    onCommentsChanged();
    setStatus('dirty', '未保存の変更があります');
    autosave.schedule();
  }

  function handlePaste(event) {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    root.ownerDocument.execCommand('insertText', false, text);
  }

  function handleMediaEdit(event) {
    const image = event.target.closest('img');
    const link = event.target.closest('a');
    if (!image && !link) return;
    event.preventDefault();
    const promptFor = root.ownerDocument.defaultView.prompt;

    if (link) {
      const current = link.dataset.markdownHref || link.getAttribute('href') || '';
      const href = promptFor('リンク先URL', current);
      if (href === null) return;
      link.dataset.markdownHref = href.trim();
      link.setAttribute('href', href.trim());
      markDirty(link);
      return;
    }

    const currentSource = image.dataset.markdownSrc || image.getAttribute('src') || '';
    const source = promptFor('画像のパスまたはURL', currentSource);
    if (source === null) return;
    const alt = promptFor('画像の代替テキスト', image.getAttribute('alt') || '');
    if (alt === null) return;
    image.dataset.markdownSrc = source.trim();
    image.setAttribute('src', resolveImageSource(source.trim()));
    image.setAttribute('alt', alt);
    markDirty(image);
  }

  function isEmptyParagraph(block) {
    if (block.dataset.blockKind !== 'paragraph') return false;
    if (block.querySelector('img, table, hr, video, audio, iframe')) return false;
    return block.textContent.replaceAll('\u00a0', ' ').trim() === '';
  }

  function resolveImageSource(source) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source)) return source;
    return `/api/asset?from=${encodeURIComponent(state.currentPath)}&src=${encodeURIComponent(source)}`;
  }

  function handleToolbarClick(event) {
    const button = event.target.closest('button');
    if (!button || state.mode !== 'edit') return;
    const document = root.ownerDocument;

    const command = button.dataset.editorCommand;
    if (command) {
      document.execCommand(command, false);
      markSelectionDirty();
      return;
    }

    const action = button.dataset.editorAction;
    if (action === 'link') {
      const selection = document.defaultView.getSelection();
      if (!selection || selection.isCollapsed) return;
      const href = document.defaultView.prompt('リンク先URL', 'https://');
      if (href) document.execCommand('createLink', false, href);
    } else if (action === 'inline-code') {
      wrapSelection('code');
    } else if (action === 'blockquote') {
      document.execCommand('formatBlock', false, 'blockquote');
    } else if (action === 'code-block') {
      document.execCommand('formatBlock', false, 'pre');
    }
    markSelectionDirty();
  }

  function applyBlockFormat(tagName) {
    if (state.mode !== 'edit') return;
    root.ownerDocument.execCommand('formatBlock', false, tagName);
    markSelectionDirty();
  }

  function wrapSelection(tagName) {
    const document = root.ownerDocument;
    const selection = document.defaultView.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const element = document.createElement(tagName);
    try {
      range.surroundContents(element);
      selection.removeAllRanges();
      const nextRange = document.createRange();
      nextRange.selectNodeContents(element);
      selection.addRange(nextRange);
    } catch {
      // The selection crosses element boundaries; fall back to raw insertion.
      document.execCommand('insertHTML', false, `<${tagName}>${escapeHtml(selection.toString())}</${tagName}>`);
    }
  }

  function markSelectionDirty() {
    const selection = root.ownerDocument.defaultView.getSelection();
    const node = selection?.anchorNode;
    markDirty(node?.nodeType === TEXT_NODE ? node.parentElement : node);
  }

  function markDirty(element) {
    const block = element?.closest?.('.markdown-block');
    if (!block) return;
    const InputEventClass = root.ownerDocument.defaultView.InputEvent;
    block.dispatchEvent(new InputEventClass('input', { bubbles: true, inputType: 'insertText' }));
  }

  /* ---------------------------------------------------------------- *
   * Saving
   * ---------------------------------------------------------------- */

  function snapshotDirtyBlocks() {
    const blocks = new Map(
      [...root.querySelectorAll('.markdown-block')].map((block) => [block.dataset.blockId, block])
    );
    return [...state.dirtyBlocks].map((blockId) => {
      const block = blocks.get(blockId);
      if (!block) return null;
      return {
        block,
        blockId,
        start: Number(block.dataset.sourceStart),
        end: Number(block.dataset.sourceEnd),
        html: cleanBlockHtml(block),
        delete: block.dataset.pendingDeletion === 'true',
        version: state.blockVersions.get(blockId) || 0
      };
    }).filter(Boolean);
  }

  async function saveDirtyBlocks() {
    const snapshots = snapshotDirtyBlocks();
    if (snapshots.length === 0) {
      state.dirtyBlocks.clear();
      state.saveFailed = false;
      setStatus('saved', '保存済み');
      return true;
    }

    snapshots.filter((snapshot) => snapshot.delete).forEach(({ block }) => {
      block.contentEditable = 'false';
      block.setAttribute('aria-busy', 'true');
    });
    setStatus('saving', '保存中…');

    try {
      const result = await api.saveFile({
        path: state.currentPath,
        edits: snapshots.map(({ blockId, start, end, html, delete: remove }) => ({
          blockId, start, end, html, delete: remove
        })),
        comments: state.comments
      });

      shiftSourceRanges(result.appliedEdits || []);
      onDocumentUpdated(result);
      snapshots.forEach(({ block, blockId, version, delete: remove }) => {
        // A newer keystroke landed while saving: keep the block dirty for the next round.
        if ((state.blockVersions.get(blockId) || 0) !== version) return;
        state.dirtyBlocks.delete(blockId);
        if (remove) {
          block.remove();
          return;
        }
        block.classList.remove('dirty', 'pending-deletion');
        delete block.dataset.pendingDeletion;
      });

      if (state.mode === 'edit') ensurePlaceholderBlock();
      state.saveFailed = false;
      onCommentsChanged();
      if (state.dirtyBlocks.size > 0) autosave.schedule();
      else setStatus('saved', '保存済み');
      return true;
    } catch (error) {
      snapshots.filter((snapshot) => snapshot.delete).forEach(({ block }) => {
        if (!block.isConnected) return;
        block.contentEditable = 'true';
        block.removeAttribute('aria-busy');
      });
      state.saveFailed = true;
      setStatus('error', `保存できませんでした: ${error.message}`);
      return false;
    }
  }

  /** Strips the review affordances so only the author's own markup is saved. */
  function cleanBlockHtml(block) {
    if (block.dataset.pendingDeletion === 'true') return '';
    const clone = block.cloneNode(true);
    clone.querySelectorAll('.editor-comment-anchor, .comment-highlight-text').forEach((anchor) => {
      anchor.replaceWith(...anchor.childNodes);
    });
    clone.querySelectorAll('.inline-comment-button').forEach((button) => button.remove());
    clone.querySelectorAll('[data-block-comment-ids]').forEach((element) => {
      element.removeAttribute('data-block-comment-ids');
    });
    clone.querySelectorAll('.comment-highlight-target').forEach((element) => {
      element.classList.remove('comment-highlight-target');
    });
    clone.querySelectorAll('[contenteditable]').forEach((element) => element.removeAttribute('contenteditable'));
    return clone.innerHTML;
  }

  /**
   * Saving rewrites part of the file, which moves every later block. Shift the
   * remembered ranges by the size change so the next save still targets the
   * right bytes without re-rendering the whole document.
   */
  function shiftSourceRanges(appliedEdits) {
    const edits = [...appliedEdits].sort((a, b) => a.start - b.start);
    root.querySelectorAll('.markdown-block').forEach((block) => {
      const oldStart = Number(block.dataset.sourceStart);
      const oldEnd = Number(block.dataset.sourceEnd);
      const ownEdit = edits.find((edit) => edit.blockId === block.dataset.blockId);
      const shift = edits
        .filter((edit) => edit.blockId !== block.dataset.blockId && edit.end <= oldStart)
        .reduce((total, edit) => total + edit.markdown.length - (edit.end - edit.start), 0);
      const nextStart = oldStart + shift;
      block.dataset.sourceStart = String(nextStart);
      block.dataset.sourceEnd = String(ownEdit ? nextStart + ownEdit.markdown.length : oldEnd + shift);
    });
  }

  function setStatus(status, message) {
    refs.editorSaveRow.dataset.state = status;
    refs.editorSaveStatus.textContent = message;
    refs.retrySaveButton.classList.toggle('hidden', status !== 'error');
  }

  return {
    render,
    setStatus,
    flush: autosave.flush,
    cancel: autosave.cancel,
    hasUnsavedChanges: () => state.dirtyBlocks.size > 0 || state.saveFailed || autosave.isBusy()
  };
}
