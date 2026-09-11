# 依存パッケージを持たないサービスなので、`npm install` の層はありません。
# 入れるのは Node と、このディレクトリのソースだけです。
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src

# コンテナの中では 0.0.0.0 でListenします。コンテナの 127.0.0.1 はコンテナ自身を指すので、
# そのままだとホストから届きません。外から見える範囲は、ホストへ公開するポートのほうで
# 縛ります（`docker-compose.yml` の `127.0.0.1:8765:8765`）。
ENV CONTEXT_API_HOST=0.0.0.0 \
    CONTEXT_API_PORT=8765 \
    CONTEXT_DATA_DIR=/data

# Contextの正本はここに置き、ボリュームを当てます。索引（ChromaDB）とは別物です。
VOLUME ["/data"]
EXPOSE 8765

USER node
CMD ["node", "./bin/context-api.js"]
