# review-markdown

Markdownファイルをローカルブラウザで読みやすく表示し、レビューコメントの追加と本文の直接編集を行うためのCLIです。

## 使い方

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開くと、指定ディレクトリ配下のMarkdownファイル一覧が表示されます。

別ディレクトリ配下の Markdown をこのローカル開発版でレビューする場合は、対象ディレクトリでこのパッケージのパスを指定して実行します。

```bash
cd /path/to/markdown-project
npx /path/to/review-markdown-cli .
```

どこからでも `review-markdown .` と実行したい場合は、開発中のパッケージをリンクします。

```bash
cd /path/to/review-markdown-cli
npm link
cd /path/to/markdown-project
review-markdown .
```

npm に `review-markdown` として公開した後は、任意のディレクトリで次の形式でも実行できます。

```bash
npx review-markdown .
```

## 主な機能

- 対象ディレクトリ配下の Markdown ファイル一覧表示
- `zenn-markdown-html` による Zenn Markdown のHTMLレンダリング
- `zenn-content-css` による Zenn と同じ本文スタイル
- Markdown に書かれた相対パス画像（`./images/foo.png`、`../assets/foo.png`）のローカル表示
- 文字列の範囲選択コメント
- 段落・見出し配下・文書全体へのコメント
- レンダリングされた本文を直接変更できる編集モード
- `Ctrl/⌘+Shift+E` によるコメント・編集モードの切り替え
- 見出し・太字・斜体・リンク・リスト・引用・コードなどの書式ツールバー
- 編集中に入力した見出し、リスト、引用、太字、斜体、リンクなどのMarkdown記法を即時反映
- 文字をすべて消した段落の自動削除
- 変更したMarkdownブロックの自動保存（入力停止から約800ms後）
- 追加・編集・削除したコメントの自動保存（入力停止から約800ms後）
- 本文編集に合わせたコメント対象テキスト・文脈の追従
- `.review/<target>.review.json` へのレビューJSON保存
- `.review/<target>.review.md` への生成AI向けレビューMarkdown出力

レビュー画面上部の「コメント」「編集」、または `Ctrl/⌘+Shift+E` で操作モードを切り替えます。コメントモードでは従来どおり対象を選んでコメントを追加でき、編集モードでは表示中の見出し、段落、リスト、表、コードなどを直接変更できます。編集モードでは、行頭の `# `、`- `、`> ` などと、`**太字**`、`*斜体*`、`[リンク](https://example.com)` などの記法が入力時に反映されます。段落を空にすると、その段落は次の自動保存時に本文から削除されます。

本文は元のMarkdownファイルへ自動保存されます。変更したブロックだけをMarkdownへ戻すため、編集していない箇所の空行やMarkdown記法は維持されます。保存に失敗した場合は編集内容を画面に残したままエラーと「再試行」ボタンを表示します。

コメントも同じように自動保存されます。コメントの追加・本文の書き換え・削除から約800ms後に `.review/<target>.review.json` へ書き込み、コメント欄の上に「自動保存待ち…」「保存中…」「自動保存しました」「保存できませんでした」を表示します。タブを閉じる、リロードする、他のファイルへ移動するときは、自動保存を待たずにその時点の内容を送信します。「今すぐ保存」ボタンは、待ち時間なしで保存したいときに使えます。

## 画像の表示

Markdown に書かれた画像は、`http(s)` などの外部URL以外はローカルファイルとして配信します。

- Markdownファイルからの相対パス（`./images/foo.png`、`../assets/foo.png`）
- レビュー対象ディレクトリを起点とするルート相対パス（`/images/foo.png`）
- 日本語ファイル名やスペースを含むパス（`![図](<images/my pic.png>)` のようなURLエンコード済みの記述も可）
- `?v=1` や `#hash` が付いたパス

レビュー対象ディレクトリの外にある画像は配信しません（`review-markdown .` のように、画像を含む親ディレクトリを対象に指定してください）。

## CLIオプション

```bash
review-markdown [targetDir] [--port 3000] [--no-open]
```

- `targetDir`: レビュー対象ディレクトリ。省略時はカレントディレクトリです。
- `--port`, `-p`: ローカルサーバーのポート番号です。
- `--no-open`: ブラウザの自動起動をスキップします。

## 保存形式

コメントだけを追加した場合、元のMarkdownファイルは変更せず、レビュー情報を `.review` ディレクトリに保存します。編集モードで本文を変更した場合は、元のMarkdownファイルを直接更新します。

```json
{
  "targetFile": "example.md",
  "updatedAt": "2026-06-11T00:00:00.000Z",
  "comments": [
    {
      "id": "comment-001",
      "type": "text-selection",
      "selectedText": "対象として選択された文章",
      "comment": "具体例を追加してほしい",
      "contextBefore": "前の文脈",
      "contextAfter": "後ろの文脈",
      "headingPath": ["大見出し", "小見出し"],
      "createdAt": "2026-06-11T00:00:00.000Z"
    }
  ]
}
```


## CLIレビューコメントをAIエージェントに理解させるための追記テンプレート

このリポジトリでは、レビュー用CLIで書いたコメントが `.review/` 配下にJSONとして保存されることがあります。CLIを実行しているリポジトリ側の `AGENTS.md` や `CLAUDE.md` に以下の文章を貼り付けると、AIエージェントがレビューコメントの構造と読み方を理解しやすくなります。

````markdown
## CLIレビューコメントの読み方

このリポジトリでは、レビュー用CLIで付けたコメントが `.review/` ディレクトリに保存される。
レビューコメントは、対象ファイルと同じ相対パスを `.review/` 配下に再現し、末尾に `.review.json` を付けたファイルとして保存される。

例:
- 対象原稿: `book-draft/02_drafts/draft_005.md`
- レビューコメント: `.review/book-draft/02_drafts/draft_005.md.review.json`

レビューJSONのトップレベル構造は次のとおり。

```json
{
  "targetFile": "レビュー対象ファイルのリポジトリ相対パス",
  "updatedAt": "レビューJSONの最終更新日時（ISO 8601）",
  "comments": [
    {
      "id": "コメントID",
      "type": "document | section | paragraph | text-selection",
      "comment": "レビューコメント本文",
      "createdAt": "コメント作成日時（ISO 8601）"
    }
  ]
}
```

各コメントの `type` は、コメントがどの粒度に紐づくかを表す。

- `document`: 文書全体へのコメント。特定の見出しや本文位置に限定しない。
- `section`: 見出し単位へのコメント。`headingPath` と `heading` を使って対象セクションを特定する。
- `paragraph`: 段落単位へのコメント。`targetText` または `selectedText` を対象段落の手がかりにする。
- `text-selection`: 選択範囲へのコメント。`selectedText`、`contextBefore`、`contextAfter` を使って対象箇所を特定する。

コメントには、必要に応じて次の位置情報が含まれる。

- `headingPath`: 対象箇所が属する見出し階層。章・節・小見出しの順に配列で入る。
- `heading`: `section` コメントの対象見出し。
- `selectedText`: コメント作成時に選択された本文。
- `targetText`: 段落や見出しなど、CLIが対象として記録したテキスト。
- `contextBefore`: `text-selection` の直前にある本文。
- `contextAfter`: `text-selection` の直後にある本文。

レビューコメントを反映するときは、次の順序で確認する。

1. `.review/**/*.review.json` を読み、`targetFile` ごとに対象原稿を開く。
2. `comments` を上から順に確認する。
3. `headingPath` がある場合は、まず対象原稿内の該当見出しへ移動する。
4. `text-selection` は `selectedText` だけで機械的に置換せず、`contextBefore` と `contextAfter` も見て同じ箇所か確認する。
5. `paragraph` は `targetText` または `selectedText` を段落特定の手がかりにする。ただし末尾の「段落にコメント」など、CLI表示由来の補助文言は本文そのものではない場合がある。
6. `section` は見出し配下全体への指摘として扱い、見出し文言だけではなく、そのセクション本文を確認する。
7. `document` は文書全体の方針・構成・表現への指摘として扱う。
8. コメント本文の依頼内容を鵜呑みにせず、仕様・既存方針・周辺文脈と照らして、反映する内容と反映しない内容を判断する。

レビューコメント対応後は、対応したコメントIDと判断を作業報告に含める。
未対応にしたコメントがある場合は、理由を明記する。
````
