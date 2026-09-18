import assert from 'node:assert/strict';
import test from 'node:test';
import { blockKind, joinBlocks, renderBlock, renderInline, renderMarkdown, splitBlocks } from '../public/js/markdown.js';

/**
 * 画面のMarkdownの描き手（`public/js/markdown.js`）のテストです。
 * ブラウザを持たない純粋な関数なので、サーバ側と同じ `node --test` で確かめます。
 */

test('本文は空行でブロックに分かれ、コードブロックの中の空行では分かれない', () => {
  const text = '# 題名\n\n段落1\n続き\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n- a\n- b\n';
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks, ['# 題名', '段落1\n続き', '```js\nconst a = 1;\n\nconst b = 2;\n```', '- a\n- b']);
  assert.equal(joinBlocks(blocks), text, '分けて戻せば同じ本文');
  assert.equal(joinBlocks(['', '  ', 'x']), 'x\n', '空のブロックは落ちる');
  assert.equal(joinBlocks([]), '');
  assert.deepEqual(splitBlocks('a\r\nb\r\n\r\nc'), ['a\nb', 'c'], 'CRLFも読める');
});

test('ブロックの種類は先頭の行で決まる', () => {
  assert.equal(blockKind('# 見出し'), 'h1');
  assert.equal(blockKind('### 見出し'), 'h3');
  assert.equal(blockKind('```\ncode\n```'), 'code');
  assert.equal(blockKind('> 引用'), 'quote');
  assert.equal(blockKind('- 項目'), 'list');
  assert.equal(blockKind('1. 項目'), 'list');
  assert.equal(blockKind('- [ ] todo'), 'list');
  assert.equal(blockKind('---'), 'hr');
  assert.equal(blockKind('| a | b |'), 'table');
  assert.equal(blockKind('ただの段落'), 'p');
});

test('見出し・段落・箇条書き・引用・コード・表・区切り線を描く', () => {
  assert.equal(renderBlock('## 認証'), '<h2 id="認証">認証</h2>');
  assert.equal(renderBlock('1行目\n2行目'), '<p>1行目<br>2行目</p>');
  assert.equal(renderBlock('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(renderBlock('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(
    renderBlock('- [x] done\n- [ ] todo'),
    '<ul class="task-list"><li class="task-item done"><input type="checkbox" class="task-checkbox" data-line="0" checked> done</li>'
    + '<li class="task-item"><input type="checkbox" class="task-checkbox" data-line="1"> todo</li></ul>'
  );
  assert.equal(renderBlock('> 引用\n> 2行目'), '<blockquote><p>引用<br>2行目</p></blockquote>');
  assert.equal(renderBlock('```js\nconst x = "<b>";\n```'), '<pre><code class="language-js">const x = &quot;&lt;b&gt;&quot;;</code></pre>');
  assert.equal(renderBlock('```\n未完のコード'), '<pre><code>未完のコード</code></pre>', '閉じていないコードも描ける');
  assert.equal(
    renderBlock('| a | b |\n| --- | :-: |\n| 1 | 2 |'),
    '<table><thead><tr><th>a</th><th style="text-align:center">b</th></tr></thead><tbody><tr><td>1</td><td style="text-align:center">2</td></tr></tbody></table>'
  );
  assert.equal(renderBlock('---'), '<hr>');
  assert.equal(renderBlock('# 題名\n本文'), '<h1 id="題名">題名</h1><p>本文</p>', '1つのブロックに見出しと段落が混ざってもよい');
  assert.equal(renderMarkdown('a\n\nb'), '<p>a</p><p>b</p>');
});

test('行の中の記法。コードとリンクの中は他の記法に触らない', () => {
  assert.equal(renderInline('**太字** *斜体* ~~消し~~ `co*de*`'), '<strong>太字</strong> <em>斜体</em> <s>消し</s> <code>co*de*</code>');
  assert.equal(renderInline('[link](https://x.y/a_b_c)'), '<a href="https://x.y/a_b_c" target="_blank" rel="noopener">link</a>');
  assert.equal(renderInline('[中](#top)'), '<a href="#top">中</a>', '内部のリンクは同じタブ');
  assert.equal(renderInline('see https://example.com/p_q now'), 'see <a href="https://example.com/p_q" target="_blank" rel="noopener">https://example.com/p_q</a> now');
  assert.equal(renderInline('![alt](./a.png)'), '<img src="./a.png" alt="alt" loading="lazy">');
  assert.equal(renderInline('snake_case_name と _強調_'), 'snake_case_name と <em>強調</em>', '語の途中の _ は斜体にしない');
});

test('本文の HTML はそのまま描かず、危ないURLは無効にする', () => {
  assert.equal(renderBlock('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderInline('[x](javascript:alert(1))'), '<a href="#">x</a>');
  assert.equal(renderInline('![x](javascript:alert(1))'), '<img src="#" alt="x" loading="lazy">');
  assert.equal(renderBlock('```html\n<img onerror=x>\n```'), '<pre><code class="language-html">&lt;img onerror=x&gt;</code></pre>');
});
