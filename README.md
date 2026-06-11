# review-markdown

Markdownファイルをローカルブラウザで読みやすく表示し、範囲選択・段落・見出し・文書全体にレビューコメントを残すためのMVP CLIです。

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
- GitHub Flavored Markdown のHTMLレンダリング
- 文字列の範囲選択コメント
- 段落・見出し配下・文書全体へのコメント
- `.review/<target>.review.json` へのレビューJSON保存
- `.review/<target>.review.md` への生成AI向けレビューMarkdown出力

## CLIオプション

```bash
review-markdown [targetDir] [--port 3000] [--no-open]
```

- `targetDir`: レビュー対象ディレクトリ。省略時はカレントディレクトリです。
- `--port`, `-p`: ローカルサーバーのポート番号です。
- `--no-open`: ブラウザの自動起動をスキップします。

## 保存形式

元のMarkdownファイルは変更せず、レビュー情報は `.review` ディレクトリに保存します。

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
