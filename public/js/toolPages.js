/**
 * 本文の隣に置かなくてよいものを、それぞれの画面へ出すための表です。
 *
 * サイドパネルは本文の隣に置くもので、幅も高さも本文に譲ります。そこへ10枚のタブを
 * 並べていたころは、AIレビューの読み手やスキル、自動タスクの一覧のような「腰を据えて
 * 読み書きするもの」まで、細長い欄の中で上下に流して見るしかありませんでした。
 *
 * そこで、本文の位置に紐づくもの（目次・コメント・メモ・その場の相談）だけをタブに残し、
 * 残りはこの表に載せて1画面ずつ開くようにしています。行き先はアドレス（`#/placement/...`）
 * なので、導線は素の `<a>` で書けます。Ctrl/⌘クリックや中クリックで別タブへ開けるのは、
 * ボタンで画面を差し替えていたころには無かった、この作りのそのままの利点です。
 */

/** レビュー本文（`#/review/<path>`）。ツール画面から戻る先です。 */
export const BODY_LINK = 'body';

export const TOOL_PAGES = [
  {
    key: 'context',
    route: 'context',
    label: 'コンテキスト',
    title: 'コンテキスト',
    lead: 'AIがこの文書を読むときの前提と、交わした相談の記録です。'
  },
  {
    key: 'manager',
    route: 'manager',
    label: '管理者',
    title: '資料の管理者',
    panel: 'managerPanel',
    lead: '資料を作り始める前に決める、目的・ストーリー・期待値の3点です。'
  },
  {
    key: 'placement',
    route: 'placement',
    label: '指摘の配置',
    title: '指摘の配置',
    panel: 'placementPanel',
    lead: '手元の指摘を貼り付けると、AIが本文のどこを指しているかを探します。'
  },
  {
    key: 'review',
    route: 'ai-review',
    label: 'AIレビュー',
    title: 'AIレビュー',
    panel: 'reviewPanel',
    lead: 'レビューの観点と読み手を決めて、AIに読ませます。'
  },
  {
    key: 'revise',
    route: 'revise',
    label: '本文の修正',
    title: '本文の修正',
    panel: 'revisePanel',
    lead: '未解決のコメントと指示から、AIが本文の修正案を作ります。'
  },
  {
    key: 'recap',
    route: 'recap',
    label: '文字起こし',
    title: '文字起こしの聞き直し',
    panel: 'recapPanel',
    lead: '会議で直近に言われたことを要約し、次にすることを出します。'
  },
  {
    key: 'tasks',
    route: 'tasks',
    label: 'タスク',
    title: '自動タスク',
    panel: 'tasksPanel',
    lead: '文字起こしや書きかけの資料から、AIが起こした「やること」です。'
  }
];

const BY_KEY = new Map(TOOL_PAGES.map((page) => [page.key, page]));
const BY_ROUTE = new Map(TOOL_PAGES.map((page) => [page.route, page]));

/** アドレスに書ける行き先すべて（`#/<route>/<path>`）。ルーティングの正規表現に使います。 */
export const TOOL_ROUTES = TOOL_PAGES.map((page) => page.route);

export function toolPageByRoute(route) {
  return BY_ROUTE.get(route) || null;
}

export function toolPageByKey(key) {
  return BY_KEY.get(key) || null;
}

/**
 * 画面の中の `<a data-tool-link>` を、いま開いている文書へ向け直します。
 *
 * 行き先を書き換えるだけで、押したときの処理はブラウザに任せます。こうしておくと
 * 「別タブで開く」がアプリ側の実装なしに効きます。文書を閉じているあいだはファイル
 * 一覧へ向けて、押しても行き場のないリンクにしません。
 */
export function updateToolLinks(root, { path, visible }) {
  for (const anchor of root.querySelectorAll('[data-tool-link]')) {
    const key = anchor.dataset.toolLink;
    const page = BY_KEY.get(key);
    anchor.href = !path
      ? '#/'
      : key === BODY_LINK
        ? `#/review/${encodeURIComponent(path)}`
        : `#/${page.route}/${encodeURIComponent(path)}`;
    anchor.classList.toggle('hidden', !path || (key !== BODY_LINK && !visible(key)));
  }
}

/** いま開いている画面のリンクへ印を付けます。押しても同じ場所なので、現在地の表示です。 */
export function markCurrentToolLink(root, key) {
  for (const anchor of root.querySelectorAll('[data-tool-link]')) {
    const current = anchor.dataset.toolLink === (key || BODY_LINK);
    anchor.classList.toggle('current', current);
    if (current) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
}
