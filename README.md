# review-markdown

Markdownファイルをローカルブラウザで読みやすく表示し、レビューコメントの追加と本文の直接編集を行うためのCLIです。

## インストール

Node.js 20 以上が必要です。グローバルにインストールすると、どのディレクトリからでも `review-markdown` コマンドを実行できます。

```bash
# GitHub から直接インストールする
npm install -g github:maronnjapan/review-markdown-cli

# npm に公開済みのパッケージからインストールする
npm install -g review-markdown
```

インストールせずに単発で実行することもできます。

```bash
npx github:maronnjapan/review-markdown-cli .
npx review-markdown .
```

ローカルのクローンから開発版を使う場合は `npm link` でコマンドを登録します。

```bash
cd /path/to/review-markdown-cli
npm install
npm link          # review-markdown コマンドが使えるようになる
npm unlink -g review-markdown   # 解除する場合
```

## 使い方

レビューしたいディレクトリで実行します。

```bash
cd /path/to/markdown-project
review-markdown .
```

ブラウザで `http://localhost:3000` を開くと、指定ディレクトリ配下のMarkdownファイル一覧が表示されます（`--no-open` を付けない限り自動で開きます）。

除外したいディレクトリは `config` コマンドで設定ファイルに保存できます。一度設定すれば、次回以降は `review-markdown .` だけで同じ設定が適用されます。

```bash
review-markdown config add exclude 'drafts/**' node_modules
review-markdown .
```

## 主な機能

- 対象ディレクトリ配下の Markdown ファイル一覧表示（ディレクトリは既定で折りたたみ）
- `--include` / `--exclude` と設定ファイルによるレビュー対象の絞り込み（ワイルドカード対応）
- `review-markdown config` による設定ファイルの読み書き
- `zenn-markdown-html` による Zenn Markdown のHTMLレンダリング
- `zenn-content-css` による Zenn と同じ本文スタイル
- Markdown に書かれた相対パス画像（`./images/foo.png`、`../assets/foo.png`）のローカル表示
- 相対リンクによるファイル間の移動（対象ディレクトリの外はエラー表示）
- 文字列の範囲選択コメント
- 段落・見出し配下・文書全体へのコメント
- 選択範囲、段落、見出し配下、文書全体の英日翻訳
- 単語と熟語に対する複数の訳語と、文脈に合う訳語の表示
- 対象文章を引き継ぐ読み取り専用の Codex チャット
- AI 会話と文脈別の翻訳キャッシュの端末保存
- コメント対象を引用表示して確認できる追加ダイアログ
- コメントの未解決・解決済みステータス管理と状態別表示
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

## 翻訳とAIチャット

翻訳とチャットには、APIキーではなく端末の `codex` コマンドを使います。
事前に Codex CLI をインストールし、`codex login` で認証してください。

コメントモードでは、文章の範囲選択後に表示されるツールバーから「翻訳」または「AIに質問」を選べます。
段落と見出しへマウスを重ねた場合も同じ操作を選べます。
文書全体を対象にする場合は、画面上部のボタンを使います。

単語と熟語の翻訳では、複数の意味、現在の文脈に合う意味、その判断理由を表示します。
長い文章では、自然な日本語訳と必要な補足だけを表示します。
翻訳方向は英語から日本語です。

チャットを開始すると、選択した文章または文書全体のスナップショットを最初の質問へ含めます。
同じ会話では Codex のスレッドを再開し、画面を閉じた後も端末に保存した会話履歴から続けられます。
Codex が本文を変更する操作は用意していません。
Codex は読み取り専用、承認なし、ネットワーク無効で起動し、ツール実行要求もアプリ側で拒否します。

短い選択範囲は、選択直後から翻訳を先読みします。
同じ文章と文脈の翻訳は端末のキャッシュから返すため、再表示ではモデル応答を待ちません。
ただし、未キャッシュの翻訳速度は Codex のモデル応答時間に依存するため、1秒以内を保証できません。
検証環境では、短語の構造化された翻訳が揃うまで約7秒かかりました。

AI 会話と翻訳キャッシュはレビュー対象ディレクトリへ書き込みません。
既定の保存先は次のとおりです。

- Linux：`$XDG_DATA_HOME/review-markdown` または `~/.local/share/review-markdown`
- macOS：`~/Library/Application Support/review-markdown`
- Windows：`%LOCALAPPDATA%\review-markdown`

保存先を変更する場合は、`REVIEW_MARKDOWN_DATA_DIR` を指定して起動します。

```bash
REVIEW_MARKDOWN_DATA_DIR=/path/to/private-data review-markdown .
```

## ファイル一覧

ディレクトリは既定ですべて閉じた状態で表示します。大きなリポジトリでも、まずプロジェクトの構成が一覧できます。

- ディレクトリ名の右には、その配下にある Markdown ファイル数を表示します。
- 「すべて展開」「すべて閉じる」で一括操作できます。
- 開いたディレクトリはタブを閉じるまで記憶します。ファイルをレビューして一覧へ戻ると、そのファイルまでのディレクトリが開いた状態になります。
- `--include` / `--exclude` を指定している場合は、一覧のヘッダーに適用中のパターンを表示します。

## レビュー対象の絞り込み

`--include` と `--exclude` で、レビュー対象のファイルをパターンで指定できます。どちらも複数回の指定とカンマ区切りに対応します。

```bash
# drafts 配下と作業中ファイルを対象から外す
review-markdown . --exclude 'drafts/**' --exclude '**/*.wip.md'

# book ディレクトリの原稿だけをレビューする
review-markdown . --include 'book/**/*.md'

# カンマ区切りでまとめて指定する
review-markdown . --exclude 'tmp,archive,**/node_modules'
```

使えるワイルドカードは次のとおりです。部分一致はこのワイルドカードで表現します。

| 記法 | 意味 | 例 |
| --- | --- | --- |
| `*` | スラッシュ以外の0文字以上 | `docs/*.md`、`*draft*` |
| `**` | ディレクトリをまたぐ任意の階層 | `**/draft-*.md` |
| `?` | 任意の1文字 | `chapter-?.md` |
| `{a,b}` | いずれかに一致 | `{docs,notes}/**` |

- パターンは対象ディレクトリからの相対パス（`docs/guide/intro.md`）に対して照合します。
- ディレクトリに一致するパターンは、その配下すべてに一致します（`--exclude drafts` で `drafts/` 以下をすべて除外）。
- スラッシュを含まないパターンは、どの階層にも一致します（`--exclude drafts` は `book/drafts/` も除外、`--exclude '*.wip.md'` はすべての階層の `*.wip.md` を除外）。
- 先頭に `/` を付けると、対象ディレクトリ直下だけに一致します（`--exclude /drafts` は `drafts/` だけを除外し、`book/drafts/` は残します）。
- `--include` を指定した場合は、いずれかに一致するファイルだけがレビュー対象になります。
- `--exclude` は `--include` より優先されます。
- `.git`、`node_modules`、`.review` は指定に関係なく常に除外します。
- 対象外のファイルは一覧に出ないだけでなく、URLを直接開いてもエラーになります。コメントの保存もできません。

同じパターンは設定ファイルにも書けます。次の「設定ファイル」を参照してください。

## 設定ファイル

毎回オプションを打ち込まなくてよいように、`include` / `exclude` / `port` / `open` を設定ファイルに保存できます。設定は `review-markdown config` コマンドで読み書きします（エディタで直接編集しても構いません）。

```bash
# 除外パターンを追加する（複数指定・カンマ区切り可）
review-markdown config add exclude 'drafts/**' '**/*.wip.md'

# どの階層にある node_modules も除外する
review-markdown config add exclude node_modules

# 追加した設定を確認する
review-markdown config list

# 除外パターンを1つ取り消す
review-markdown config remove exclude 'drafts/**'

# ポートや自動起動の既定値を決める
review-markdown config set port 4000
review-markdown config set open false
```

設定後は、オプションなしで実行するだけで同じ絞り込みが適用されます。

```bash
review-markdown .
# Markdown Review is serving /path/to/markdown-project
#   config: /path/to/markdown-project/.review-markdown.json
#   exclude: drafts/**, **/*.wip.md
```

### 設定ファイルの場所

| 種類 | 場所 | 用途 |
| --- | --- | --- |
| プロジェクト設定 | 対象ディレクトリから親へ遡って最初に見つかる `.review-markdown.json` | そのプロジェクト固有の除外設定 |
| ユーザー全体の設定 | `~/.config/review-markdown/config.json`（Windows は `%APPDATA%\review-markdown\config.json`） | すべてのプロジェクトで常に除外したいもの |

- ユーザー全体の設定を編集するときは `--global`（`-g`）を付けます。
- 環境変数 `XDG_CONFIG_HOME` / `REVIEW_MARKDOWN_CONFIG_HOME` でユーザー全体の設定の場所を変更できます。
- `--dir <path>`（`-C`）で、設定ファイルを探すディレクトリを指定できます（既定はカレントディレクトリ）。

### 設定ファイルの書式

```json
{
  "include": [],
  "exclude": ["drafts/**", "**/*.wip.md", "node_modules"],
  "port": 4000,
  "open": true
}
```

| キー | 型 | 内容 |
| --- | --- | --- |
| `include` | 文字列の配列 | レビュー対象に含めるパスのパターン |
| `exclude` | 文字列の配列 | レビュー対象から外すパスのパターン |
| `port` | 数値 | ローカルサーバーのポート番号 |
| `open` | 真偽値 | 起動時にブラウザを開くかどうか |

### 優先順位

- `include` / `exclude` は、ユーザー全体の設定・プロジェクト設定・コマンドラインの指定をすべて合成します。
- `port` と `open` は「コマンドライン > 環境変数 `PORT` > プロジェクト設定 > ユーザー全体の設定 > 既定値」の順で決まります。
- `--config <file>` で設定ファイルを直接指定すると、そのファイルだけを読み込みます。
- `--no-config` を付けると、設定ファイルを一切読み込みません。
- 知らないキーは警告を出して無視します。JSONとして壊れている場合や値の型が違う場合は、起動せずにエラーを表示します。

### config サブコマンド

```bash
review-markdown config <command> [options]
```

| コマンド | 内容 |
| --- | --- |
| `init` | 設定ファイルを作成する |
| `path` | 読み込まれる設定ファイルのパスを表示する |
| `list` | 適用される設定内容を表示する |
| `get <key>` | 設定値を表示する |
| `set <key> <value...>` | 設定値を置き換える |
| `add <key> <value...>` | 一覧（`include` / `exclude`）に値を追加する |
| `remove <key> <value...>` | 一覧から値を削除する |
| `unset <key>` | 設定値を削除する |

オプションは `--dir <path>`（`-C`）、`--global`（`-g`）、`--json`、`--help`（`-h`）です。`--json` を付けると `list` と `get` の結果をJSONで出力します。

## 相対リンクの移動

Markdown に書かれた相対リンクは、リンク先に応じて動作が変わります。

- 対象ディレクトリ配下の Markdown ファイル（`./next.md`、`../guide/intro.md`、`/README.md`）: そのままレビュー画面で開きます。`#見出し` が付いていれば、その見出しまでスクロールします。
- 対象ディレクトリ配下のその他のファイル（`./files/spec.pdf` など）: 別タブでファイルを配信します。
- 対象ディレクトリの外を指すリンク（`../../secret/notes.md`）: 開かずにエラーを表示します。リンク自体も警告付きの表示になります。
- `--include` / `--exclude` で対象外にしたファイルへのリンク: 同じくエラーを表示します。
- `http(s)` などの外部URLとページ内アンカー（`#section`）: これまでどおりの動作です。

リンク先を開きたい場合は、そのファイルを含む親ディレクトリを対象にして CLI を起動し直してください。

なお編集モードで本文を保存しても、リンクは Markdown に書かれた元のパスのまま保存されます。

本文は元のMarkdownファイルへ自動保存されます。変更したブロックだけをMarkdownへ戻すため、編集していない箇所の空行やMarkdown記法は維持されます。保存に失敗した場合は編集内容を画面に残したままエラーと「再試行」ボタンを表示します。

コメントも同じように自動保存されます。コメントの追加・本文の書き換え・ステータス変更・削除から約800ms後に `.review/<target>.review.json` へ書き込み、コメント欄の上に「自動保存待ち…」「保存中…」「自動保存しました」「保存できませんでした」を表示します。タブを閉じる、リロードする、他のファイルへ移動するときは、自動保存を待たずにその時点の内容を送信します。「今すぐ保存」ボタンは、待ち時間なしで保存したいときに使えます。

## コメントの追加と確認

コメント追加ダイアログでは、保存前に「どこへのコメントか」を確認できます。

- コメント種別（文書全体／セクション／段落／範囲選択）をラベルで表示します。
- 対象が属する見出し階層を `設計メモ › 背景` の形式で表示します。
- 対象テキストを引用ブロックで全文表示します（長い場合はダイアログ内でスクロールします）。
- コメント本文が空の間は「追加」ボタンを押せません。
- `Ctrl / ⌘ + Enter` で追加、`Esc` で取り消しできます。

追加したコメントは「未解決」として保存されます。コメント一覧は「未解決」「解決済み」に分けて表示し、各カードの「解決済みにする」「未解決に戻す」で状態を切り替えられます。追加時は画面右下に「N件目のコメントを追加しました」と表示し、該当カードを一時的に強調します。削除は誤操作を防ぐため、「削除」を押したあとにカード内で「削除する」「やめる」を選ぶ2段階にしています。

## 画像の表示

Markdown に書かれた画像は、`http(s)` などの外部URL以外はローカルファイルとして配信します。

- Markdownファイルからの相対パス（`./images/foo.png`、`../assets/foo.png`）
- レビュー対象ディレクトリを起点とするルート相対パス（`/images/foo.png`）
- 日本語ファイル名やスペースを含むパス（`![図](<images/my pic.png>)` のようなURLエンコード済みの記述も可）
- `?v=1` や `#hash` が付いたパス

レビュー対象ディレクトリの外にある画像は配信しません（`review-markdown .` のように、画像を含む親ディレクトリを対象に指定してください）。

## 開発

```bash
npm install
npm test    # node --test（サーバー、Markdown変換、jsdomによる画面テスト）
```

## CLIオプション

```bash
review-markdown [targetDir] [--port 3000] [--include <glob>] [--exclude <glob>] [--config <file>] [--no-config] [--no-open]
review-markdown config <command> [options]
```

- `targetDir`: レビュー対象ディレクトリ。省略時はカレントディレクトリです。
- `--port`, `-p`: ローカルサーバーのポート番号です。環境変数 `PORT` でも指定できます。指定ポートが使用中の場合は、空いているポートを自動的に選択します。
- `--include`: レビュー対象に含めるパスのパターンです。複数指定・カンマ区切りに対応します。
- `--exclude`: レビュー対象から外すパスのパターンです。複数指定・カンマ区切りに対応します。
- `--config <file>`: 使用する設定ファイルを直接指定します。
- `--no-config`: 設定ファイルを読み込みません。
- `--no-open`: ブラウザの自動起動をスキップします。
- `--help`, `-h`: 使い方とワイルドカードの一覧を表示します。

`config` はサブコマンドとして扱うため、`config` という名前のディレクトリをレビューする場合は `review-markdown ./config` のように指定してください。

## ディレクトリ構成

```
bin/markdown-review.js   CLIエントリポイント（起動と終了処理）
src/cli.js               コマンドライン引数の解析
src/config.js            設定ファイルの探索・検証・オプションへの反映
src/configCommand.js     review-markdown config サブコマンド
src/pathFilter.js        --include / --exclude / 設定ファイルのグロブ照合
src/server.js            HTTPサーバーの組み立て
src/routes.js            APIエンドポイントの定義
src/markdownFiles.js     対象ディレクトリのMarkdownファイル探索
src/http.js              リクエスト／レスポンスの共通処理
src/staticFiles.js       画面ファイルの配信
src/assets.js            Markdownから参照される画像などの配信
src/links.js             Markdown内リンクの解決（アプリ内遷移／対象外の判定）
src/markdown.js          MarkdownのHTMLレンダリングとブロック分割
src/editorMarkdown.js    編集結果のHTML→Markdown変換と差分適用
src/reviewStore.js       .review 配下のレビューJSON・Markdownの読み書き
src/aiStore.js           AI会話と翻訳キャッシュの端末保存
src/aiService.js         翻訳と会話セッションの制御
src/codexAppServer.js    Codex App Serverとの読み取り専用通信
public/app.js            画面のエントリポイント
public/js/               画面のモジュール（下記）
```

`public/js/` は責務ごとに分かれています。DOMやアプリの状態はすべて `createApp()` が生成するため、モジュール側は状態を持ちません。

```
createApp.js        画面全体の配線とルーティング
state.js            画面の状態
dom.js              DOM要素の参照解決
api.js              サーバーAPIの呼び出し
ai.js               翻訳とAIチャットの表示、先読み、会話操作
fileListView.js     ファイル一覧の表示と開閉状態の記憶
fileTree.js         ファイル一覧のツリー構築
comments.js         コメント追加ダイアログとコメント一覧の描画
commentAnchors.js   コメント対象のハイライトと編集中の追従
textAnchor.js       本文からコメント対象テキストを見つける処理
editor.js           編集モードと本文の保存
markdownShortcuts.js 入力中のMarkdown記法の即時反映
autosave.js         自動保存の共通処理（デバウンスと多重実行の抑止）
links.js            相対リンクのクリック処理とアンカー移動
diagrams.js         Mermaidの遅延読み込み
toast.js            画面右下の通知
util.js             共通のユーティリティ
```

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
      "status": "open",
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
      "status": "open | resolved",
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

各コメントの `status` は対応状態を表す。`open` は未解決、`resolved` は解決済み。`status` がない古いコメントは `open` として扱う。

コメントには、必要に応じて次の位置情報が含まれる。

- `headingPath`: 対象箇所が属する見出し階層。章・節・小見出しの順に配列で入る。
- `heading`: `section` コメントの対象見出し。
- `selectedText`: コメント作成時に選択された本文。
- `targetText`: 段落や見出しなど、CLIが対象として記録したテキスト。
- `contextBefore`: `text-selection` の直前にある本文。
- `contextAfter`: `text-selection` の直後にある本文。

レビューコメントを反映するときは、次の順序で確認する。

1. `.review/**/*.review.json` を読み、`targetFile` ごとに対象原稿を開く。
2. `comments` のうち `status` が `open`（または未記載）のものを対応対象として確認する。`resolved` は原則として対応済みとして扱う。
3. `headingPath` がある場合は、まず対象原稿内の該当見出しへ移動する。
4. `text-selection` は `selectedText` だけで機械的に置換せず、`contextBefore` と `contextAfter` も見て同じ箇所か確認する。
5. `paragraph` は `targetText` または `selectedText` を段落特定の手がかりにする。
6. `section` は見出し配下全体への指摘として扱い、見出し文言だけではなく、そのセクション本文を確認する。
7. `document` は文書全体の方針・構成・表現への指摘として扱う。
8. コメント本文の依頼内容を鵜呑みにせず、仕様・既存方針・周辺文脈と照らして、反映する内容と反映しない内容を判断する。

レビューコメント対応後は、対応したコメントIDと判断を作業報告に含める。
未対応にしたコメントがある場合は、理由を明記する。
````
