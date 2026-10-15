# Context API

レビュアーが残した判断（Context）と、書いたページを預かり、意味で引けるようにするサービスです。
`review-markdown` CLI とは別に動きます。

役は2つあります。

| 役 | 中身 | 使う相手 |
| --- | --- | --- |
| 知識の核 | 判断とページの正本、索引（Vector DB）、意味での検索、資料を根拠にした回答 | review-markdown CLI、MCP で繋いだ AI エージェント、HTTP を叩く任意のツール |
| 画面 | Notion 風のページのエディタ、検索、保存した判断の一覧、資料に聞く | ブラウザを開く人 |

画面は核の「一利用者」です。
画面が使うのは外部のツールに開いている HTTP の口だけで、画面のためだけの近道はありません。
核を別に配ることになっても、画面を別の場所へ移すことになっても、片方を直さずに済ませるための分け方です。
同じプロセスから配っているのは、使い始めるのに `docker compose up` の1回で済ませるためで、`CONTEXT_API_UI=off` にすれば API だけになります。

## 立ち上げる

索引（ChromaDB）の用意の仕方は2つあります。どちらも `http://127.0.0.1:8765` で待ち受け、CLI からの繋ぎ方は同じです。

### Docker で

```bash
cd context-api
docker compose up -d
```

ChromaDB と一緒に立ち上がります。

### npm で（Docker なし）

`chromadb` の npm パッケージは、Chroma 本体（Rust 製のサーバ）を同梱しています。
`npm install` で揃い、`CHROMA_SERVER=npm` を付けると、このサービスが起動時に ChromaDB を立ち上げ、終了時に止めます。

```bash
cd context-api
npm install
CHROMA_SERVER=npm npm start
```

索引のデータは `CONTEXT_DATA_DIR` の下の `chroma/` に残ります（`CHROMA_PATH` で変えられます）。
ChromaDB だけを別に動かしておきたいときは `npm run chroma` です。
`CHROMA_URL` のポート（既定 8000）で待ち受けるので、`npm start` は既定のままそこへ繋がります。
止めるのは Ctrl-C です（`npm run` 越しに `kill` を送ると npm だけが終わり、ChromaDB が残ります。`kill` するなら `node` のプロセスへ送ってください）。

`chromadb` パッケージは Chroma 本体を含むので 50MB ほどあります。
索引を ChromaDB にせず1ファイルで済ませるなら `VECTOR_DB=local npm start` で、`npm install` も要りません。

### 繋ぐ

ブラウザで開くと画面が出ます。CLI からは、この URL を設定して繋ぎます。

```bash
review-markdown config set contextEndpoint http://127.0.0.1:8765 --global
review-markdown context status
```

## 画面

`http://127.0.0.1:8765/` を開きます。ビルドはなく、`public/` の素の HTML と JavaScript です。

- **ページ**。Workspace ごとに階層を持ちます。ブロック単位の Markdown エディタで、書いたそばから保存され、少し遅れて索引が作られます。Enter で次のブロック、空のブロックで `/` を打つと見出し・箇条書き・ToDo・コードなどを選べます。サイドバーの木はドラッグで並べ替えと入れ子ができます。
- **検索（⌘K / Ctrl+K）**。ページと保存した判断を意味で引きます。言い換えでも引けます。
- **保存した判断**。CLI が「保存した判断」として引くものと同じ物を、ここでも残せて、直せて、消せます。
- **資料に聞く**。見つかった資料だけを根拠に答えます（`POST /ask`）。回答を作るには `CHAT_PROVIDER` の設定が要り、無ければ資料の一覧だけが出ます。
- **設定**。サーバの状態、Workspace の名前と id、Markdown の取り込みと書き出し、外部のツールから繋ぐ手順。
- **索引**。ChromaDB（または1ファイルの索引）に入っている Chunk を、入れた形のまま並べます。本文、範囲や出どころの Metadata、埋め込みのベクトルを1件ずつ見られます。「保存したのに引けない」ときに、何が埋め込まれているかを確かめるところです。ChromaDB は外へ公開していないので、ローカルでもデプロイ先でもこの画面（と `GET /index/chunks`）から覗きます。

Workspace の id は、CLI が `.review/workspace.json` に振るものと同じ形（ULID）です。
画面で作った Workspace の id をそのファイルに書けば、そのリポジトリを開いた CLI の AI が、ここに書いたページも引きます。

## 外部のツールから使う

### review-markdown CLI

`contextEndpoint` を設定すると、CLI の AI は質問に応じて `POST /search` を呼び、判断とページの抜粋を前提として読みます（`sources: ["context", "page"]`）。

### AI エージェント（MCP）

`POST /mcp` が MCP（Streamable HTTP）の口です。Claude Code なら1行で繋がります。

```bash
claude mcp add --transport http knowledge http://127.0.0.1:8765/mcp
```

| ツール | 用途 |
| --- | --- |
| `search_knowledge` | 判断とページを意味で引く |
| `read_page` / `list_pages` / `list_workspaces` | ページを読む、木を見る、Workspace を見る |
| `create_page` / `update_page` | ページを書く、追記する |
| `save_context` / `list_contexts` | 確認の取れた判断を残す、一覧を見る |

`CONTEXT_API_TOKEN` を設定しているときは、`--header "Authorization: Bearer <token>"` を付けます。
サーバから先に話しかける流れ（SSE）は持たないので、`GET /mcp` は 405 です。

### HTTP

```bash
curl -X POST http://127.0.0.1:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"認証方式","workspace_id":"01K...","sources":["context","page"],"limit":5}'
```

## 設定

環境変数で決めます。`docker compose` も `npm start`（`npm run chroma` も）も、`context-api/.env` を読みます（`.env.example` を写してください）。
シェルで付けた値が `.env` より優先されるので、`CHROMA_SERVER=npm EMBEDDING_PROVIDER=ollama npm start` のように1回だけ変えることもできます。
`npm start` で `.env` を読むには Node.js 20.12 以上が要ります。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `CONTEXT_API_PORT` | `8765` | 待ち受けるポート。無ければ `PORT`（デプロイ先が渡すもの）、それも無ければ 8765 |
| `CONTEXT_API_HOST` | `127.0.0.1` | Bind するアドレス（コンテナの中だけ `0.0.0.0`） |
| `CONTEXT_API_TOKEN` | なし | 設定すると `Authorization: Bearer <token>` を求める |
| `CONTEXT_API_UI` | `on` | 画面を配るかどうか。`off` で API だけ |
| `CONTEXT_DATA_DIR` | OS ごとのデータディレクトリ | 正本（`contexts.json`、`pages.json`）の置き場所 |
| `VECTOR_DB` | `chroma` | 索引（`chroma` / `local`） |
| `CHROMA_URL` | `http://127.0.0.1:8000` | ChromaDB の URL |
| `CHROMA_COLLECTION` | `review_markdown_contexts` | コレクション名 |
| `CHROMA_SERVER` | `external` | ChromaDB を誰が動かすか。`external` は `CHROMA_URL` の先に立っているもの（`docker compose`、`npm run chroma`）、`npm` はこのプロセスが npm パッケージ（`chromadb`）から立ち上げて終了時に止める |
| `CHROMA_PATH` | `CONTEXT_DATA_DIR` の下の `chroma/` | `CHROMA_SERVER=npm` と `npm run chroma` のときの、ChromaDB の索引の置き場所 |
| `RUST_LOG` | `warn` | npm パッケージの ChromaDB のログの量。`info` にすると要求ごとに出ます |
| `EMBEDDING_PROVIDER` | `local` | 埋め込み（`local` / `ollama` / `openai`） |
| `EMBEDDING_MODEL` | プロバイダごと | 埋め込みのモデル名 |
| `EMBEDDING_ENDPOINT` | プロバイダごと | 埋め込みサービスの URL |
| `OPENAI_API_KEY` | なし | `EMBEDDING_PROVIDER=openai` のとき |
| `CHAT_PROVIDER` | `none` | 回答の生成（`none` / `ollama` / `openai`） |
| `CHAT_MODEL` | プロバイダごと | 回答を作るモデル名（Ollama は `llama3.2`、OpenAI 互換は `gpt-4o-mini`） |
| `CHAT_ENDPOINT` | プロバイダごと | 回答を作るサービスの URL |
| `CHAT_API_KEY` | `OPENAI_API_KEY` | `CHAT_PROVIDER=openai` のとき |
| `VECTOR_DB_WAIT_SECONDS` | `30` | 起動時に ChromaDB を待つ秒数（`CHROMA_SERVER=npm` では、立ち上げた ChromaDB が心拍を返すまでの上限） |

## デプロイする

1つの端末の外に置きたいとき（別の端末からも引く、チームで同じ判断を共有する）は、このサービスを1つのイメージ、
または1つの Node のプロセスとしてデプロイします。
`CHROMA_SERVER=npm` にすると ChromaDB も同じコンテナの中で動くので、ChromaDB を別に用意する必要はありません。

```bash
cd context-api
docker build -t context-api .
docker run -d --name context-api \
  -p 8765:8765 \
  -v context-data:/data \
  -e CHROMA_SERVER=npm \
  -e CONTEXT_API_TOKEN=<token> \
  context-api
```

イメージを1つ動かせる先（Fly.io、Cloud Run、Railway、VPS の Docker）なら、どこでもこの形です。
Node が動くホスティング（Render、Railway の Nixpacks など）に置くなら、ビルドは `npm ci`、起動は `CHROMA_SERVER=npm npm start` です。

置くときに決めることは5つです。

- **トークン**。`CONTEXT_API_TOKEN` を必ず設定します。このサービスは他に認証を持たず、保存した判断とページがそのまま読めます。CLI には `review-markdown config set contextToken <token> --global`、MCP には `--header "Authorization: Bearer <token>"`、画面は設定の画面で入れます。トークン無しで外から届く設定になっていると、起動ログに注意を出します。
- **TLS**。トークンは平文で流れるので、HTTPS で受けてください（PaaS の前段か、リバースプロキシ）。このサービス自身は TLS を持ちません。
- **ポート**。既定は 8765 です。デプロイ先が `PORT` を渡してくれば、そちらで待ち受けます（`CONTEXT_API_PORT` があればそれが優先）。
- **データ**。正本（`contexts.json`、`pages.json`）と索引（`chroma/`）は `CONTEXT_DATA_DIR`（コンテナでは `/data`）にまとまっています。ここに永続ボリュームを当てます。当てないと、再デプロイで消えます。コンテナは `node` ユーザで動くので、ボリュームはそのユーザが書ける持ち主にします。
- **インスタンスは1つ**。索引は ChromaDB の1プロセスが持ち、同じデータを複数のプロセスで開けません。横に増やさず、1つで動かします。

既定の埋め込み（`local`）は外へ出ません。`openai` や `ollama` にするときは、デプロイ先からそのサービスへ届く必要があります。

## 届く範囲

このサービスは認証を持ちません。個人の PC の中だけで完結する前提だからです。
素で動かすときは `127.0.0.1` にだけ Bind し、Docker で動かすときはホストへ公開するポートを
`127.0.0.1:8765:8765` と縛ります。どちらの動かし方でも、外から見える範囲は「この端末だけ」です。
ChromaDB はホストへ公開しません（繋ぐのは同じネットワークにいるこのサービスだけです）。
npm パッケージから立ち上げるときも、ChromaDB が待ち受けるのはこの端末（`127.0.0.1`）だけです。

画面を持つので、ブラウザから来る要求の `Origin` も見ます。
`Origin` が、このサービス自身か、この端末（localhost）でなければ 403 です。
同じ端末で開いた他のサイトが、この端末の中のサービスへ書き込みに来るのを防ぐためです。

将来の共有に備えて、`CONTEXT_API_TOKEN` を設定したときだけ `Authorization: Bearer` を求める形に
してあります。CLI 側にも `review-markdown config set contextToken <token> --global` で同じ値を書きます。
画面は設定の画面でトークンを入れると、そのブラウザにだけ保存します。

## API

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 稼働確認。索引まで繋がることを確かめてから答えます。件数と索引の状態も返します |
| `POST` | `/contexts` | Context 作成 |
| `GET` | `/contexts` | 保存済みの一覧（訂正のための口） |
| `GET` | `/contexts/{context_id}` | 1件取得 |
| `PATCH` | `/contexts/{context_id}` | 更新（本文が変われば索引も作り直します） |
| `DELETE` | `/contexts/{context_id}` | 削除（本体と索引の両方） |
| `POST` | `/search` | Semantic Search。`sources` を省くと Context だけ、`["context","page"]` でページも |
| `POST` | `/ask` | 資料を根拠にした回答。`stream: true` で SSE |
| `GET` / `POST` | `/workspaces` | Workspace の一覧と作成 |
| `GET` / `PATCH` / `DELETE` | `/workspaces/{id}` | Workspace の取得、名前の変更、削除（中のページごと） |
| `GET` | `/workspaces/{id}/pages` | ページの木（本文なし） |
| `GET` | `/workspaces/{id}/export` | ページを木の順に本文ごと |
| `POST` | `/workspaces/{id}/import` | Markdown の束をパスの階層どおりに取り込む |
| `POST` | `/pages` | ページ作成 |
| `GET` | `/pages/{page_id}` | 1件取得。`?format=markdown` で本文だけを `text/markdown` で |
| `PATCH` | `/pages/{page_id}` | 題名・本文・親・並び順の更新 |
| `DELETE` | `/pages/{page_id}` | 削除（下のページごと） |
| `POST` | `/index/retry` | 失敗した索引を作り直す |
| `GET` | `/index/chunks` | 索引に入っている Chunk の一覧（本文と Metadata）。`source`（`context` / `page`）、`id`（判断かページの id）、`limit` / `offset` で絞り、`vectors=on` でベクトルも付けます |
| `GET` | `/index/chunks/{chunk_id}` | Chunk 1件。ベクトルごと返します |
| `POST` | `/mcp` | MCP（Streamable HTTP） |

```bash
curl -X POST http://127.0.0.1:8765/contexts \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"01K...","content":"このプロジェクトではOIDCを利用する","scope":"workspace","kind":"decision"}'

curl -X POST http://127.0.0.1:8765/pages \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"01K...","title":"認証の設計","content":"# トークン\n\n有効期限は15分にする。"}'

curl -X POST http://127.0.0.1:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"認証方式","workspace_id":"01K...","scope_path":"src/auth","include_global":true,"limit":5}'
```

エラーは3つに分けます。
id が無ければ 404、必須項目の欠落と範囲の食い違いは 400、索引や埋め込みへ繋がらないときは 503 です。
CLI は接続不能と 503 を同じ「Context API 利用不可」として扱います。

該当する Context もページも無いのはエラーではありません。`results: []` を返します。

### 検索の結果

`/search` は、Context とページを同じ並びで返します。`type` で見分けます。

```json
{
  "results": [
    { "type": "context", "context_id": "ctx_…", "content": "このプロジェクトではOIDCを利用する", "score": 0.61, "scope": "workspace", "kind": "decision", "updated_at": "…" },
    { "type": "page", "page_id": "pg_…", "title": "認証の設計", "breadcrumb": [{ "page_id": "pg_…", "title": "認証の設計" }], "heading": "トークン", "snippet": "有効期限は15分にする。", "content": "有効期限は15分にする。", "score": 0.43, "updated_at": "…" }
  ]
}
```

ページはページ丸ごとではなく、当たった箇所の抜粋（`snippet`）を返します。
200,000 文字のページが1件当たっただけで、AI に渡す前提がページ丸ごとになるのを避けるためです。
本文が要るときは `GET /pages/{page_id}` で引けます。
`all_workspaces: true` を付けると、Workspace を問わず引きます。

### 資料を根拠にした回答

`POST /ask` は `question` を意味で引き、当たった資料を `[1]` `[2]` と番号を付けてモデルへ渡し、
番号を根拠として書かせた回答を返します。`CHAT_PROVIDER` が無ければ `answer: null` で資料だけを返します。

```bash
curl -X POST http://127.0.0.1:8765/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"トークンの有効期限はどう決めた？","workspace_id":"01K..."}'
```

`stream: true` を付けると Server-Sent Events で、`sources`（資料）、`delta`（本文の断片）、`done` の順に流れます。

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

ページは Workspace 全体の範囲を持ちます。CLI がその Workspace の判断を引く絞り込みで、ページも一緒に引けます。

## 正本と索引

```
Context ─┐
         ├→ Chunk → Embedding → Vector DB
Page    ─┘
```

Context の正本は `contexts.json`、ページの正本は `pages.json` で、Vector DB へ入るのは索引だけです。
Chunk には出どころ（`source`）を付け、検索のときにどちらかだけを引けるようにしています。
埋め込みや索引の形を替えると、起動時に保存済みのものをすべて作り直します。
違う埋め込みで作った数字同士を比べても意味が無いからです。
正本が別にあるので、作り直しで失われるものはありません。

索引に何が入っているか（Chunk の本文、Metadata、ベクトル）は、画面の「索引」か `GET /index/chunks` で見られます。
1ファイルの索引も本文を一緒に持つので、ChromaDB と同じ見え方です。

```bash
curl 'http://127.0.0.1:8765/index/chunks?source=context&limit=5'
curl 'http://127.0.0.1:8765/index/chunks/ctx_%E2%80%A6%230'   # 1件はベクトルごと（# は %23 と書きます）
```

ページは見出しごとの節に分けてから長さで切り、題名と見出しの経路を頭に付けて埋め込みます。
「有効期限は15分」という節の本文だけでは何の有効期限か分からず、
「トークンの有効期限は？」という質問に当たらないからです。画面に出す抜粋には付けません。

ページの索引は保存のあとで非同期に作ります。
外部の埋め込みサービスを使っているときに、1文字ごとの保存が秒単位で待たされないためです。
同じページの編集が続いたら最後の1回だけを索引にし、検索の前には列が空になるのを待つので、
「保存したのに出てこない」ことはありません。索引に失敗したページは `/health` に数が出て、`POST /index/retry` で作り直せます。

検索結果は Chunk ではなく Context かページ単位で返します。
同じものの複数 Chunk が当たったときは、いちばん高いスコアをそのスコアにします。
合計にすると、長く書いたものほど上に来ることになり、内容ではなく分量で順位が決まります。

## 埋め込みと回答の生成

既定（`local`）は、このプロセスの中で計算するハッシュです。API キーもモデルのダウンロードも要りません。
語の重なりで近さを測るので、言い換えには弱く、表記ゆれには強いという性質になります。
言い換えまで拾わせたいときは `ollama` か `openai` へ切り替えてください。
`openai` を選ぶと、本文がそのサービスへ渡ります。既定にしていないのはそのためです。

回答の生成も同じ考え方で、既定は何も呼びません。
`CHAT_PROVIDER=ollama` なら端末の中で、`openai` なら OpenAI 互換の API（外へ出ます）で回答を作ります。
`CHAT_ENDPOINT` を向ければ、vLLM や LM Studio など OpenAI 互換の口を持つものもそのまま使えます。

## テスト

```bash
npm test
```

ChromaDB は要りません。索引は1ファイルのもの（`VECTOR_DB=local` と同じ実装）で走ります。
`npm install` 済みで `chromadb` パッケージがあるときだけ、npm パッケージの ChromaDB を実際に立ち上げて索引の読み書きを通すテストも走ります（無ければ飛ばします）。
画面の Markdown の描き手も、ブラウザを持たない純粋な関数なので同じテストで確かめます。
