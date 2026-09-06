import assert from 'node:assert/strict';
import test from 'node:test';
import { changedRange } from '../public/js/editor.js';
import {
  blockFormatAt,
  continueBlockOnEnter,
  insertLink,
  linkifyPaste,
  setHeadingLevel,
  shiftListIndent,
  toggleCodeFence,
  toggleInlineMarker,
  toggleLinePrefix
} from '../public/js/markdownEditing.js';

/** 書き換えを当てたあとの本文と選択範囲。画面がやっていることと同じです。 */
function apply(text, edit) {
  if (!edit) return { text, selection: null };
  return {
    text: `${text.slice(0, edit.start)}${edit.insert}${text.slice(edit.end)}`,
    selection: [edit.selectionStart, edit.selectionEnd]
  };
}

test('太字は選んだところを囲み、もう一度押すと外れる', () => {
  const text = 'これは大事な話です。';
  const wrapped = apply(text, toggleInlineMarker(text, 3, 6, '**'));
  assert.equal(wrapped.text, 'これは**大事な**話です。');
  assert.deepEqual(wrapped.selection, [5, 8]);

  // 印の内側を選び直した状態から、もう一度押した場合。
  const unwrapped = apply(wrapped.text, toggleInlineMarker(wrapped.text, 5, 8, '**'));
  assert.equal(unwrapped.text, text);
});

test('選んだ範囲そのものが印つきでも外せる', () => {
  const text = 'これは**大事な**話です。';
  assert.equal(apply(text, toggleInlineMarker(text, 3, 10, '**')).text, 'これは大事な話です。');
});

test('太字の中を斜体にしても、太字の印を1つだけ削らない', () => {
  const text = 'これは**大事な**話です。';
  // 以前の実装は隣の `*` を自分の印と見なして `*大事な*` に減らしていました。
  assert.equal(apply(text, toggleInlineMarker(text, 5, 8, '*')).text, 'これは***大事な***話です。');
});

test('端の空白は印の外に置く', () => {
  const text = 'a word b';
  assert.equal(apply(text, toggleInlineMarker(text, 1, 7, '**')).text, 'a **word** b');
});

test('何も選ばずに押すと、印だけ置いて間にカーソルが入る', () => {
  const placed = apply('ここ', toggleInlineMarker('ここ', 2, 2, '**'));
  assert.equal(placed.text, 'ここ****');
  assert.deepEqual(placed.selection, [4, 4]);
});

test('箇条書きは選んだ行すべてに付き、番号付きへ変えても印は重ならない', () => {
  const text = '一つ目\n二つ目\n三つ目';
  const bulleted = apply(text, toggleLinePrefix(text, 0, text.length, '- '));
  assert.equal(bulleted.text, '- 一つ目\n- 二つ目\n- 三つ目');

  const numbered = apply(bulleted.text, toggleLinePrefix(bulleted.text, 0, bulleted.text.length, '1. '));
  assert.equal(numbered.text, '1. 一つ目\n2. 二つ目\n3. 三つ目');

  const plain = apply(numbered.text, toggleLinePrefix(numbered.text, 0, numbered.text.length, '1. '));
  assert.equal(plain.text, text);
});

test('引用は箇条書きの外側に重なる', () => {
  const text = '- 一つ目\n- 二つ目';
  assert.equal(apply(text, toggleLinePrefix(text, 0, text.length, '> ')).text, '> - 一つ目\n> - 二つ目');
});

test('段落スタイルは付け外しではなく指定で、見出しの深さを入れ替える', () => {
  const text = '### 見出し';
  assert.equal(apply(text, setHeadingLevel(text, 0, 0, 2)).text, '## 見出し');
  assert.equal(apply(text, setHeadingLevel(text, 0, 0, 0)).text, '見出し');
  assert.equal(blockFormatAt(text, 2), 'h3');
  assert.equal(blockFormatAt('ただの段落', 2), 'p');
});

test('リンクは選んだ文字を見出しにして、URLを選んだ状態で置く', () => {
  const text = '詳しくは公式サイトを見てください。';
  const linked = apply(text, insertLink(text, 4, 9, 'https://example.com'));
  assert.equal(linked.text, '詳しくは[公式サイト](https://example.com)を見てください。');
  assert.equal(linked.text.slice(...linked.selection), 'https://example.com');
});

test('URLを選択に貼るとリンクになり、ただの文字列の貼り付けには手を出さない', () => {
  const text = '公式サイトを見てください。';
  assert.equal(
    apply(text, linkifyPaste(text, 0, 5, 'https://example.com')).text,
    '[公式サイト](https://example.com)を見てください。'
  );
  assert.equal(linkifyPaste(text, 0, 5, 'ただの文字列'), null);
  assert.equal(linkifyPaste(text, 3, 3, 'https://example.com'), null, '選んでいなければ普通に貼る');
});

test('コードブロックは柵で囲み、中のバッククォートより長い柵を選ぶ', () => {
  const text = 'const a = 1;';
  const fenced = apply(text, toggleCodeFence(text, 0, text.length));
  assert.equal(fenced.text, '```\nconst a = 1;\n```');
  assert.deepEqual(fenced.selection, [3, 3], '言語を書くところにカーソルが入る');
  assert.equal(apply(fenced.text, toggleCodeFence(fenced.text, 0, fenced.text.length)).text, text);

  const withFence = 'これは ``` です';
  assert.equal(
    apply(withFence, toggleCodeFence(withFence, 0, withFence.length)).text,
    '````\nこれは ``` です\n````'
  );
});

test('Enterは箇条書き・番号付き・引用を続け、中身が無ければ1段浅くしてから抜ける', () => {
  const bullet = '- 一つ目';
  assert.equal(apply(bullet, continueBlockOnEnter(bullet, 5, 5)).text, '- 一つ目\n- ');

  const ordered = '3. 三つ目';
  assert.equal(apply(ordered, continueBlockOnEnter(ordered, 6, 6)).text, '3. 三つ目\n4. ');

  const task = '- [x] 済んだこと';
  assert.equal(apply(task, continueBlockOnEnter(task, 11, 11)).text, '- [x] 済んだこと\n- [ ] ');

  const quote = '> 引用';
  assert.equal(apply(quote, continueBlockOnEnter(quote, 4, 4)).text, '> 引用\n> ');

  const nested = '- 一つ目\n  - ';
  assert.equal(apply(nested, continueBlockOnEnter(nested, nested.length, nested.length)).text, '- 一つ目\n- ');

  const empty = '- 一つ目\n- ';
  assert.equal(apply(empty, continueBlockOnEnter(empty, empty.length, empty.length)).text, '- 一つ目\n');

  assert.equal(continueBlockOnEnter('ただの段落', 5, 5), null, 'ふつうの行はブラウザに任せる');
});

test('Tabはリストの行だけを動かし、それ以外では譲る', () => {
  const list = '- 一つ目\n- 二つ目';
  const indented = apply(list, shiftListIndent(list, 6, 6, {}));
  assert.equal(indented.text, '- 一つ目\n  - 二つ目');
  assert.deepEqual(indented.selection, [8, 8], 'カーソルは同じ文字の前に残る');

  assert.equal(
    apply(indented.text, shiftListIndent(indented.text, 8, 8, { outdent: true })).text,
    list
  );
  assert.equal(shiftListIndent('ただの段落', 2, 2, {}), null, 'リストでなければTabは編集欄を出るために残す');
  assert.equal(shiftListIndent(list, 6, 6, { outdent: true }), null, '浅くできなければ何もしない');

  // 複数行を選んでいるときは、リストでなくてもまとめて下げます。
  const paragraphs = '一行目\n二行目';
  assert.equal(apply(paragraphs, shiftListIndent(paragraphs, 0, paragraphs.length, {})).text, '  一行目\n  二行目');
});

test('保存に送るのは、前後の一致を除いた1か所だけ', () => {
  assert.equal(changedRange('同じ本文', '同じ本文'), null);

  const before = '# 見出し\n\n本文です。\n\n:::message\n囲み\n:::\n';
  const after = '# 見出し\n\n書き換えました。\n\n:::message\n囲み\n:::\n';
  const change = changedRange(before, after);
  assert.equal(before.slice(change.start, change.end), '本文です');
  assert.equal(change.insert, '書き換えました');
  assert.equal(`${before.slice(0, change.start)}${change.insert}${before.slice(change.end)}`, after);
});

test('絵文字の途中では切らない', () => {
  const before = 'ここに🙂を置く';
  const after = 'ここに🙃を置く';
  const change = changedRange(before, after);

  assert.equal(before.slice(change.start, change.end), '🙂');
  assert.equal(change.insert, '🙃');
  assert.equal(`${before.slice(0, change.start)}${change.insert}${before.slice(change.end)}`, after);
});
