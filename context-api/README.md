# Context API

レビュアーが「次の会話でも前提にしたい」と決めた判断を預かり、意味で引けるようにするサービスです。
`review-markdown` CLI とは別に動きます。

CLI がこのサービスに求めるのは HTTP の口だけです。
索引が ChromaDB であることも、埋め込みの選び方も、CLI は知りません。
索引や埋め込みを替えても、原稿を読むためのアプリを直さずに済むように分けてあります。

## 立ち上げる

```bash
cd context-api
docker compose up -d
```

ChromaDB と一緒に立ち上がり、`http://127.0.0.1:8765` で待ち受けます。
CLI からは、この URL を設定して繋ぎます。

```bash
review-markdown config set contextEndpoint http://127.0.0.1:8765 --global
review-markdown context status
```

Docker を使わずに試すときは、索引を1ファイルに切り替えて直接起動できます。

```bash
VECTOR_DB=local npm start
```

## 設定

環境変数で決めます。`docker compose` は `.env` を読みます（`.env.example` を写してください）。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `CONTEXT_API_PORT` | `8765` | 待ち受けるポート |
| `CONTEXT_API_HOST` | `127.0.0.1` | Bind するアドレス（コンテナの中だけ `0.0.0.0`） |
| `CONTEXT_API_TOKEN` | なし | 設定すると `Authorization: Bearer <token>` を求める |
| `CONTEXT_DATA_DIR` | OS ごとのデータディレクトリ | Context の正本（`contexts.json`）の置き場所 |
| `VECTOR_DB` | `chroma` | 索引（`chroma` / `local`） |
| `CHROMA_URL` | `http://127.0.0.1:8000` | ChromaDB の URL |
| `CHROMA_COLLECTION` | `review_markdown_contexts` | コレクション名 |
| `EMBEDDING_PROVIDER` | `local` | 埋め込み（`local` / `ollama` / `openai`） |
| `EMBEDDING_MODEL` | プロバイダごと | 埋め込みのモデル名 |
| `EMBEDDING_ENDPOINT` | プロバイダごと | 埋め込みサービスの URL |
| `OPENAI_API_KEY` | なし | `EMBEDDING_PROVIDER=openai` のとき |
| `VECTOR_DB_WAIT_SECONDS` | `30` | 起動時に ChromaDB を待つ秒数 |

## 届く範囲

このサービスは認証を持ちません。個人の PC の中だけで完結する前提だからです。
素で動かすときは `127.0.0.1` にだけ Bind し、Docker で動かすときはホストへ公開するポートを
`127.0.0.1:8765:8765` と縛ります。どちらの動かし方でも、外から見える範囲は「この端末だけ」です。
ChromaDB はホストへ公開しません（繋ぐのは同じネットワークにいるこのサービスだけです）。

将来の共有に備えて、`CONTEXT_API_TOKEN` を設定したときだけ `Authorization: Bearer` を求める形に
してあります。CLI 側にも `review-markdown config set contextToken <token> --global` で同じ値を書きます。

## API

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 稼働確認。索引まで繋がることを確かめてから答えます |
| `POST` | `/contexts` | Context 作成 |
| `GET` | `/contexts` | 保存済みの一覧（訂正のための口） |
| `GET` | `/contexts/{context_id}` | 1件取得 |
| `PATCH` | `/contexts/{context_id}` | 更新（本文が変われば索引も作り直します） |
| `DELETE` | `/contexts/{context_id}` | 削除（本体と索引の両方） |
| `POST` | `/search` | Semantic Search |

```bash
curl -X POST http://127.0.0.1:8765/contexts \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"01K...","content":"このプロジェクトではOIDCを利用する","scope":"workspace","kind":"decision"}'

curl -X POST http://127.0.0.1:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"認証方式","workspace_id":"01K...","scope_path":"src/auth","include_global":true,"limit":5}'
```

エラーは3つに分けます。
`context_id` が無ければ 404、必須項目の欠落と範囲の食い違いは 400、索引や埋め込みへ繋がらないときは 503 です。
CLI は接続不能と 503 を同じ「Context API 利用不可」として扱います。

該当する Context が無いのはエラーではありません。`results: []` を返します。

## 範囲

Context は3つの範囲のどれかを持ちます。

| `scope` | `workspace_id` | `scope_path` | 効く範囲 |
| --- | --- | --- | --- |
| `workspace` | 必須 | なし | その Workspace のすべて |
| `path` | 必須 | 必須 | そのディレクトリ以下 |
| `global` | なし | なし | Workspace を問わない個人の共通知識 |

検索で `scope_path` を受け取ると、祖先ディレクトリまで自動で広げます。
`src/auth/oauth` なら `src/auth/oauth`、`src/auth`、`src`、Workspace 全体、`global` が対象です。
この展開をここで行うのは、同じ決まりを CLI とこちらの2か所に持つと、片方だけ直したときに
「保存したのに出てこない Context」ができるからです。CLI が送るのはディレクトリ1つだけです。

## Context と Vector

```
Context → Chunk → Embedding
```

Context の本文と Metadata の正本は `contexts.json` で、Vector DB へ入るのは索引だけです。
埋め込みを替えると、起動時に保存済みの Context をすべて作り直します。
違う埋め込みで作った数字同士を比べても意味が無いからです。
正本が別にあるので、作り直しで失われるものはありません。

検索結果は Chunk ではなく Context 単位で返します。
同じ Context の複数 Chunk が当たったときは、いちばん高いスコアをその Context のスコアにします。
合計にすると、長く書いた Context ほど上に来ることになり、内容ではなく分量で順位が決まります。

## 埋め込み

既定（`local`）は、このプロセスの中で計算するハッシュです。API キーもモデルのダウンロードも要りません。
語の重なりで近さを測るので、言い換えには弱く、表記ゆれには強いという性質になります。
言い換えまで拾わせたいときは `ollama` か `openai` へ切り替えてください。
`openai` を選ぶと、Context の本文がそのサービスへ渡ります。既定にしていないのはそのためです。

## テスト

```bash
npm test
```

ChromaDB は要りません。索引は1ファイルのもの（`VECTOR_DB=local` と同じ実装）で走ります。
