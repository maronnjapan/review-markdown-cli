# Context API のイメージです。2つの動かし方に使います。
#
#   docker compose up … ChromaDB は別のサービス（`docker-compose.yml` の `chroma`）です。
#                       このイメージは繋ぎに行くだけです（CHROMA_SERVER=external、既定）。
#   1つだけでデプロイ … CHROMA_SERVER=npm を付けると、npm パッケージ（`chromadb`）に同梱された
#                       ChromaDB をこのコンテナの中で立ち上げます（`src/chromaServer.js`）。
#                       イメージを1つ動かせる先なら（Fly.io、Cloud Run、Railway、VPS の Docker）、
#                       ChromaDB を別に用意せずに置けます。
#
# ── alpine ではなく slim を使う理由 ──────────────────────────
# `chromadb` が同梱する Chroma 本体は glibc 向けのネイティブバイナリで、musl（alpine）向けは
# 配られていません。alpine では `npm ci` が黙ってそれを飛ばし、CHROMA_SERVER=npm で初めて失敗します。
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
# サービス本体は依存パッケージを持ちません。ここで入るのは `chromadb`（Chroma 本体を同梱）だけです。
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
# 画面（Notion風のアプリ）。ビルドは無く、素のファイルをそのまま配ります（`src/ui.js`）。
COPY public ./public

# コンテナの中では 0.0.0.0 でListenします。コンテナの 127.0.0.1 はコンテナ自身を指すので、
# そのままだとホストから届きません。外から見える範囲は、ホストへ公開するポートのほうで
# 縛ります（`docker-compose.yml` の `127.0.0.1:8765:8765`）。
# ポートはここで決めません。既定の 8765 で待ち受け、デプロイ先が `PORT` を渡してくれば
# そちらに従います（`src/config.js`）。
ENV CONTEXT_API_HOST=0.0.0.0 \
    CONTEXT_DATA_DIR=/data

# 正本（contexts.json、pages.json）と、CHROMA_SERVER=npm のときの索引（/data/chroma）はここに置き、
# ボリュームを当てます。`node` ユーザで動かすので、先に書ける持ち主にしておきます。
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8765

USER node
CMD ["node", "./bin/context-api.js"]
