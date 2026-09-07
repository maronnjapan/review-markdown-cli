import crypto from 'node:crypto';

/**
 * メモは、本文のその場所に残した「自分のための覚え書き」です。
 *
 * コメントとの違いは、宛先です。コメントは書き手やAIエージェントへの依頼で、だから
 * 未解決・解決済みという状態を持ち、レビューMarkdownへ書き出され、本文の修正では
 * 直す理由として読まれます。メモは自分宛てなので、そのどれにも入りません。
 * 読んでいて浮かんだこと（あとで確かめる、この語は前の章と揃っていない気がする）を
 * その場に置いておくためのもので、置いた瞬間に誰かの仕事になってしまわない、という
 * ことがこの機能の全部です。
 *
 * ── AIへ渡さないことは、実装ではなく約束です ──────────────
 * メモを渡さないのは「まだ配線していない」からではありません。渡すと、自分だけの
 * つぶやきのつもりで書いたものが、次のレビューや修正案の根拠になります。前提として
 * 読ませたいことは、コンテキストメモ（`contextNotes.js`）に種類を付けて残す道が
 * すでにあります。2つが同じ名前で紛らわしいのは確かですが、分かれているのは
 * 「AIに読ませるために書く」か「自分のために書く」かという、書くときの構えの違いです。
 *
 * ── コンテキストメモと違って、件数と長さの上限がありません ────
 * コンテキストメモの上限（`aiLimits.js`）は、プロンプトへ載る量の上限です。メモは
 * プロンプトへ載らないので、そこから来る上限がありません。隣に並ぶコメントにも
 * 上限が無いので、揃えてあります。
 *
 * ── 読むときは通し、書くときだけ断る ──────────────────────
 * `readMemos` は保存済みの値を読むためのもので、何が入っていても投げません。
 * ここで投げると、レビューファイルを手で直した1文字で、その文書が画面から開けなく
 * なります（`readReview` は本文の表示にも通る道です）。断るのは、レビュアーが
 * 送ってきた値を受け取る `normalizeMemos` だけです。
 */

/** メモを残せる先。コメントと同じ4種類です。同じ対象の作り方を画面で使い回すためです。 */
const MEMO_TYPES = Object.freeze(['document', 'section', 'paragraph', 'text-selection']);

/** idの長さ。こちらが振るidは30文字ほどで、手で書かれた長いidを切るためだけの上限です。 */
const ID_CHARS = 80;

/** ISO 8601 の日時が収まる長さ。長い文字列を書かれても切り詰めるためだけの上限です。 */
const TIMESTAMP_CHARS = 40;

/**
 * 保存済みのメモを読みます。何が入っていても投げません。
 *
 * 本文の無いメモは落とします。残す意味が無いうえに、画面では空のカードになるからです。
 */
export function readMemos(value) {
  if (!Array.isArray(value)) return [];
  return value.map(readMemo).filter(Boolean);
}

/**
 * レビュアーが送ってきたメモを受け取ります。配列でなければ断ります。
 *
 * 件数と長さを見ないのは、上で書いたとおり見る理由が無いからです。ここが断るのは
 * 「メモの一覧ではないもの」を一覧として保存しようとしたときだけで、それは画面の
 * 不具合か、APIを直接叩いた間違いのどちらかです。
 */
export function normalizeMemos(value, source = 'メモ') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${source} は配列で指定してください`);
  return readMemos(value);
}

export function createMemoId() {
  return `memo-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function readMemo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = text(value.body);
  if (!body) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, ID_CHARS) : createMemoId(),
    type: memoType(value),
    body,
    ...anchorOf(value),
    // 日時は補いません。無いものを読むたびに「今」で埋めると、開き直すだけで
    // 残した日が今日へ動きます。新しいメモへ付けるのは、コメントやコンテキストメモと
    // 同じく `reviewStore.js` の保存時です。
    ...(timestamp(value.createdAt) ? { createdAt: timestamp(value.createdAt) } : {}),
    ...(timestamp(value.updatedAt) ? { updatedAt: timestamp(value.updatedAt) } : {})
  };
}

/**
 * 種類の分からないメモの読み方。対象の文字があれば範囲選択、無ければ文書全体とします。
 * 手で書き足したメモ（`{ "body": "あとで確かめる" }`）を捨てずに、指す先の無いメモとして
 * 読ませるためです。文書全体のメモは対象を探さないので、外れた印も付きません。
 */
function memoType(value) {
  if (MEMO_TYPES.includes(value.type)) return value.type;
  return text(value.selectedText) || text(value.targetText) || text(value.heading)
    ? 'text-selection'
    : 'document';
}

/**
 * どこに残したか。コメントと同じ形で持ちます。画面が本文から同じ場所を探し直すのに
 * 使うものが同じなので、探し方（`public/js/commentAnchors.js`）も1つで済みます。
 *
 * 拾う項目を並べて書いているのは、手で書き足された知らない項目を、そのまま保存し直して
 * 増やさないためです。PDFの座標（`pdfAnchor`）だけは中身を見ずに通します。形を決めて
 * いるのは画面側（`public/js/pdf/anchors.js`）で、ここで測り直しても二重になるからです。
 */
function anchorOf(value) {
  const heading = text(value.heading);
  const headingPath = Array.isArray(value.headingPath)
    ? value.headingPath.map(text).filter(Boolean)
    : [];
  const pageNumber = Number.isFinite(value.pageNumber) ? value.pageNumber : 0;
  return {
    ...(text(value.selectedText) ? { selectedText: text(value.selectedText) } : {}),
    ...(text(value.targetText) ? { targetText: text(value.targetText) } : {}),
    ...(heading ? { heading } : {}),
    ...(headingPath.length ? { headingPath } : {}),
    ...(text(value.contextBefore) ? { contextBefore: text(value.contextBefore) } : {}),
    ...(text(value.contextAfter) ? { contextAfter: text(value.contextAfter) } : {}),
    ...(value.documentType === 'pdf' ? { documentType: 'pdf' } : {}),
    ...(pageNumber ? { pageNumber } : {}),
    ...(value.pdfAnchor && typeof value.pdfAnchor === 'object' ? { pdfAnchor: value.pdfAnchor } : {})
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function timestamp(value) {
  return typeof value === 'string' ? value.trim().slice(0, TIMESTAMP_CHARS) : '';
}
