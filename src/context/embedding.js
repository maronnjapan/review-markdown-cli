/**
 * ContextのChunkをベクトルへ変えます。
 *
 * ── 既定をローカル計算にした理由（仕様の【要確認8】への回答） ──────────
 * 既定は、このプロセスの中で計算するハッシュ埋め込みです。外部のAPIキーも、
 * モデルのダウンロードも要りません。個人がローカルで動かすものなので、Contextを
 * 1件保存するたびに原稿の一部が外のサービスへ出ていくのは、既定の振る舞いとしては
 * 重すぎます。精度の高い埋め込みが要るときは、起動時に `--embedding ollama` などを
 * 選べば、そちらへ切り替わります。
 *
 * ローカル計算が当てにする類似は「同じ語がどれだけ重なっているか」です。言い換え
 * （「認証方式」と「ログインのしくみ」）には弱く、表記ゆれ（「OIDC」と「Oidc」）には
 * 強い、という性質になります。判断を保存して引き直すという用途では、保存した本人が
 * 似た語で聞くことが多いので、既定としては釣り合っています。
 *
 * ── 文字N-gramで数える理由 ──────────────────────────────
 * 日本語は単語の切れ目が空白に出ません。空白で切ると「このプロジェクトではOIDCを利用する」
 * が丸ごと1語になり、何とも似なくなります。そこで文字2〜3連なりを数えます。英数字の
 * 並び（OIDC、RefreshToken）は語としても数え、`refresh_token` と `refreshToken` が
 * 同じものとして当たるようにします。
 *
 * ── 埋め込みを差し替えても壊れない形 ────────────────────────
 * 埋め込みは `id` と次元を名乗ります。保存済みのVectorには、作ったときの `id` が
 * 付きます（`store.js`）。埋め込みを変えたまま古いVectorを検索すると、意味の違う
 * 数字同士を比べることになるので、食い違いは検索前に気づけるようにしてあります。
 */

import crypto from 'node:crypto';

/** ローカル計算の次元。多いほど語がぶつからなくなり、保存するVectorも大きくなります。 */
const LOCAL_DIMENSIONS = 512;

/** 数える文字の連なり。2と3で、助詞を挟んだ言い回しと固有名詞の両方を拾います。 */
const NGRAM_SIZES = [2, 3];

/** 外部の埋め込みサービスを待つ時間。越えたら保存も検索も失敗として扱います。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * ローカル計算で「関係がある」と見なす下限です（仕様6.4の【要確認6】への回答）。
 *
 * 語の重なりで測るので、無関係な文同士はほぼ0になります。0.15は「同じ話題の語が
 * 1つは重なっている」あたりで、これを下回るものを返さないことで、関係の薄いContextが
 * 回答の前提に混ざるのを防ぎます。外部の埋め込みはスコアの出方が違い、無関係でも
 * 0.7前後を返すものがあるので、下限を持たせません（`/search` の `min_score` で指定できます）。
 */
const LOCAL_MIN_SCORE = 0.15;

/**
 * このプロセスの中だけで計算する埋め込みです。既定。
 */
export function createLocalEmbedder({ dimensions = LOCAL_DIMENSIONS } = {}) {
  return {
    id: `local-hash-${dimensions}`,
    label: 'ローカル計算（文字N-gramのハッシュ）',
    dimensions,
    minScore: LOCAL_MIN_SCORE,
    async embed(texts) {
      return texts.map((text) => hashEmbedding(text, dimensions));
    }
  };
}

/**
 * Ollama（`http://127.0.0.1:11434`）の埋め込みです。
 * ローカルで動かすものなので、原稿は端末から出ません。
 */
export function createOllamaEmbedder({ model = 'nomic-embed-text', endpoint = 'http://127.0.0.1:11434' } = {}) {
  return {
    id: `ollama-${model}`,
    label: `Ollama / ${model}`,
    dimensions: 0,
    minScore: 0,
    async embed(texts) {
      const vectors = [];
      for (const text of texts) {
        const body = await postJson(`${trimSlash(endpoint)}/api/embeddings`, { model, prompt: text });
        vectors.push(assertVector(body.embedding, 'Ollama'));
      }
      return vectors;
    }
  };
}

/**
 * OpenAI互換の埋め込みAPIです。選ぶと、Contextの本文がそのAPIへ渡ります。
 * 既定にしていないのはそのためです（このモジュール冒頭の説明）。
 */
export function createOpenAiEmbedder({
  model = 'text-embedding-3-small',
  endpoint = 'https://api.openai.com/v1',
  apiKey = process.env.OPENAI_API_KEY
} = {}) {
  return {
    id: `openai-${model}`,
    label: `OpenAI互換API / ${model}`,
    dimensions: 0,
    minScore: 0,
    async embed(texts) {
      if (!apiKey) throw new Error('OPENAI_API_KEY が設定されていません');
      const body = await postJson(`${trimSlash(endpoint)}/embeddings`, { model, input: texts }, {
        Authorization: `Bearer ${apiKey}`
      });
      const data = Array.isArray(body.data) ? body.data : [];
      if (data.length !== texts.length) throw new Error('埋め込みAPIの応答が要求した件数と合いません');
      return data.map((entry) => assertVector(entry.embedding, 'OpenAI互換API'));
    }
  };
}

const EMBEDDERS = {
  local: createLocalEmbedder,
  ollama: createOllamaEmbedder,
  openai: createOpenAiEmbedder
};

export const EMBEDDING_PROVIDERS = Object.keys(EMBEDDERS);

export function createEmbedder({ provider = 'local', ...options } = {}) {
  const create = EMBEDDERS[provider];
  if (!create) {
    throw new Error(`使えない埋め込みです: ${provider}（使えるもの: ${EMBEDDING_PROVIDERS.join(', ')}）`);
  }
  return create(options);
}

/**
 * 1つの文字列を、長さ1のベクトルにします。
 *
 * 長さを揃えるのは、コサイン類似度を内積だけで出せるようにするためです
 * （`vectorStores/local.js`）。揃えないと、長いContextほど無関係な質問にも
 * 高いスコアを返します。
 */
export function hashEmbedding(text, dimensions = LOCAL_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  for (const [token, count] of countTokens(text)) {
    const bucket = bucketOf(token, dimensions);
    // 同じバケットに違う語が入ったときに、必ず足し合わさって大きくなるのを避けます。
    // 符号をハッシュから決めておくと、無関係な語同士は打ち消し合います。
    const sign = bucket.sign;
    // 出現回数はそのままではなく対数で効かせます。同じ語を10回書いたContextが、
    // その語だけで何にでも当たるのを防ぐためです。
    vector[bucket.index] += sign * (1 + Math.log(count));
  }
  return normalize(vector);
}

/** 文字N-gramと、英数字の語を数えます。 */
function countTokens(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const counts = new Map();
  if (!normalized) return counts;

  for (const size of NGRAM_SIZES) {
    for (let index = 0; index + size <= normalized.length; index += 1) {
      const gram = normalized.slice(index, index + size);
      if (gram.trim().length < size) continue;
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
  }
  // 英数字の並びは語としても数えます。`refresh_token` と `refreshToken` を
  // 同じものにするため、区切り文字とキャメルケースの境目で割ります。
  for (const word of normalized.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    counts.set(`w:${word}`, (counts.get(`w:${word}`) || 0) + 1);
  }
  return counts;
}

function bucketOf(token, dimensions) {
  const digest = crypto.createHash('sha1').update(token).digest();
  const index = digest.readUInt32BE(0) % dimensions;
  return { index, sign: (digest[4] & 1) === 0 ? 1 : -1 };
}

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (!length) return vector;
  return vector.map((value) => value / length);
}

function assertVector(value, source) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'number')) {
    throw new Error(`${source}から埋め込みを受け取れませんでした`);
  }
  return normalize(value);
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`埋め込みの生成に失敗しました（HTTP ${response.status}）: ${url}`);
  }
  return response.json();
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}
