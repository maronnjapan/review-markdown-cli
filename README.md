# review-markdown-cli

Markdownファイルをローカルブラウザで読みやすく表示し、範囲選択・段落・見出し・文書全体にレビューコメントを残すためのMVP CLIです。

## 使い方

```bash
npm install
npx markdown-review .
```

ブラウザで `http://localhost:3000` を開くと、指定ディレクトリ配下のMarkdownファイル一覧が表示されます。

## 主な機能

- 対象ディレクトリ配下の Markdown ファイル一覧表示
- GitHub Flavored Markdown のHTMLレンダリング
- 文字列の範囲選択コメント
- 段落・見出し配下・文書全体へのコメント
- `.review/<target>.review.json` へのレビューJSON保存
- `.review/<target>.review.md` への生成AI向けレビューMarkdown出力

## CLIオプション

```bash
markdown-review [targetDir] [--port 3000] [--no-open]
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
