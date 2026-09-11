import { existsSync, statSync } from 'node:fs';
import { normalizeAiContext } from './aiContext.js';
import { splitFlag, takeValue } from './argv.js';
import { CONFIG_FILE_NAME, parsePort } from './config.js';
import { normalizePatterns } from './pathFilter.js';

export const USAGE = `Usage: review-markdown [targetDir] [options]
       review-markdown config <command> [options]
       review-markdown context <command> [options]
       review-markdown extension [--path]

Options:
  -p, --port <number>   ローカルサーバーのポート番号（既定: 3000）
      --include <glob>  レビュー対象に含めるパス。複数指定・カンマ区切り可
      --exclude <glob>  レビュー対象から外すパス。複数指定・カンマ区切り可
      --ai-context <text>
                        AIがこの原稿を読むときの前提を渡す
      --enable-manager  資料の管理者を有効にする（既定: 無効）
      --enable-translation
                        翻訳機能を有効にする（既定: 無効）
      --enable-auto-tasks
                        タスクの見守り（文字起こしを読み直してタスクを起こす）を有効にする（既定: 無効）
      --no-manager      設定ファイルで有効な管理者を無効にする
      --no-translation  設定ファイルで有効な翻訳を無効にする
      --no-auto-tasks   設定ファイルで有効な見守りを無効にする
      --config <file>   使用する設定ファイルを指定する
      --no-config       設定ファイルを読み込まない
      --no-open         ブラウザの自動起動をスキップする
  -h, --help            このヘルプを表示する

Glob:
  *   スラッシュ以外の0文字以上     例: docs/*.md
  **  ディレクトリをまたぐ任意の階層 例: **/draft-*.md
  ?   任意の1文字                   例: chapter-?.md
  {}  いずれかに一致                例: {docs,notes}/**

  ディレクトリに一致するパターンは、その配下すべてに一致します（例: --exclude drafts）。
  スラッシュを含まないパターンはどの階層にも一致します（例: --exclude node_modules）。
  先頭に / を付けると対象ディレクトリ直下だけに一致します（例: --exclude /drafts）。
  --include を指定した場合は、いずれかに一致するファイルだけがレビュー対象になります。
  --exclude は --include より優先されます。

Config:
  ${CONFIG_FILE_NAME}（対象ディレクトリから親へ遡って探索）とユーザー全体の設定ファイルを
  読み込み、そこに書いた設定を既定値として使います。
  コマンドラインの指定が常に優先され、include / exclude は設定ファイルの内容と合成します。

    review-markdown config add exclude 'drafts/**'   # 設定ファイルに除外パターンを追加
    review-markdown config set aiContext '入門者向けの技術書。読者はJavaScriptの基礎を知っている。'
    review-markdown config set aiReviewModel gpt-5.6-codex   # レビューに使うモデルを固定
    review-markdown config set aiProvider claude --global    # Codex以外のAIで走らせる
    review-markdown config set autoTasks true        # タスクの見守りを次回以降も有効にする
    review-markdown config list                      # 適用中の設定を表示

  詳しくは review-markdown config --help を参照してください。

Meet Captions Memo:
  Google Meetの字幕をレビュー対象のMarkdownへ流し込むChrome拡張機能を同梱しています。
  フォルダの場所と読み込ませ方は review-markdown extension で出ます。起動すると
  「連携コード」を1行で出すので、それを拡張機能の設定へ貼れば繋がります。
  書き込めるのは文字起こし用に決めたファイルだけです（既定は meet-captions 配下と
  *.transcript.md。設定ファイルの transcriptFiles で変えられます）。原稿のパスを
  書いたまま繋いで、本文の途中に発言が挟まっていくのを防ぐためです。

AI provider:
  どのAIで走らせるかは設定ファイルの aiProvider で選びます（codex / claude / langchain、
  既定は codex）。モデルは aiModel / aiReviewModel で用途ごとに切り替えられます。
  翻訳の有効・無効と、この2つのモデル（と推論強度）は、ブラウザ右上の「設定」からも
  変えられます。変更はその場で効き、ユーザー全体の設定ファイルへ保存します。
  aiProvider と aiModelProvider は、レビュー対象のリポジトリが同梱する設定ファイルからは
  読みません。ユーザー全体の設定（--global）か --config で指定したファイルにだけ書けます。
  詳しくは review-markdown config --help を参照してください。

Tasks:
  文書ごとの「やること」は、この設定に関わらず「タスク」の画面で書けます。AIに本文から
  起こさせるのも、その画面の「AIに起こさせる」を押したときだけ走ります。
  autoTasks で有効になるのは見守りだけです。会議中の文字起こしを一定間隔で読み直し、
  増えた分からタスクを起こし、任せられるもの（調査・サンプル実装・問い合わせ対応）を
  裏で済ませておきます。見守れるのは transcriptFiles に当たるファイルだけです。
  何を任せるか・間隔・特にしてほしいこと・対象の人は、ブラウザ右上の「設定」か、
  設定ファイルの autoTasksActions / autoTasksInterval / autoTasksInstructions /
  autoTasksOwner で決めます。autoTasksOwner に名前を書くと、その人がやることだけを
  タスクに起こします。押していないのにAIへ送る唯一の道なので、既定では無効です。

Saved context:
  「保存した判断」は、次の会話でも前提にしたい決定や作法を1件ずつ残したものです。
  原稿とは別の場所（Context API）に預け、質問の内容に応じてAIが引き直します。
  引いたときは、どの判断を根拠にしたかを回答と一緒に画面へ出します。
  Context APIはこのCLIとは別のサービスです（リポジトリの context-api/。索引はChromaDB）。
  CLIがすることは、設定したURLを叩くことだけです。

    cd context-api && docker compose up -d              # 預かるサービスを立ち上げる（別サービス）
    review-markdown config set contextEndpoint http://127.0.0.1:8765 --global
    review-markdown context status                      # 繋がるかどうかを確かめる

  contextEndpoint を設定していないときは、Contextの保存と検索だけが使えません。
  ファイルの閲覧・編集・コメント・一般的なAI質問は、これまでどおり使えます。
  サービスを止めているときも同じで、AIがContextを引こうとしたときにだけ、引けなかった
  ことを画面とAIの回答へ出します。黙って一般論で答えさせないためです。

  範囲は3つです。Workspace全体、特定ディレクトリ以下（開いているファイルの位置から
  祖先へ遡って効きます）、そしてWorkspaceを問わない個人の共通知識です。
  contextEndpoint はレビュー対象のリポジトリが同梱する設定ファイルからは読みません
  （保存した判断の送り先なので、原稿を開いただけで変わってよい値ではありません）。

AI context:
  aiContext は、翻訳・AIチャット・指摘の配置で AI がこの原稿を読むときの前提です。
  対象読者、原稿の位置づけ、守りたい用語などを書くと、どの機能でも同じ前提で読ませられます。
  ここで指定するのはディレクトリ全体に効く前提で、文書ごとの前提はブラウザのAIパネルから書けます。`;

const VALUE_FLAGS = new Map([
  ['--port', 'port'],
  ['-p', 'port'],
  ['--include', 'include'],
  ['--exclude', 'exclude'],
  ['--ai-context', 'aiContext'],
  ['--config', 'configPath']
]);

/**
 * Parses argv without touching process state so it stays unit testable.
 * Throws an Error carrying a user-facing message for anything malformed.
 */
export function parseArgs(argv, env = {}) {
  const options = {
    targetDir: '.',
    port: env.PORT ? parsePort(env.PORT, 'PORT') : 3000,
    // Remembers who set the value so the config file only fills in what the
    // command line and the environment left alone.
    portSource: env.PORT ? 'env' : 'default',
    open: true,
    openSource: 'default',
    manager: false,
    managerSource: 'default',
    translation: false,
    translationSource: 'default',
    autoTasks: false,
    autoTasksSource: 'default',
    include: [],
    exclude: [],
    aiContext: undefined,
    configPath: undefined,
    useConfig: true,
    help: false
  };
  let targetDirSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = splitFlag(argv[index]);

    if (flag === '--help' || flag === '-h') {
      options.help = true;
      return options;
    }

    if (VALUE_FLAGS.has(flag)) {
      const { value, nextIndex } = takeValue(argv, index, flag, inlineValue);
      index = nextIndex;
      const key = VALUE_FLAGS.get(flag);
      if (key === 'port') {
        options.port = parsePort(value, flag);
        options.portSource = 'flag';
      } else if (key === 'configPath') {
        options.configPath = value;
      } else if (key === 'aiContext') {
        options.aiContext = normalizeAiContext(value, flag);
      } else {
        options[key].push(value);
      }
    } else if (flag === '--no-open') {
      options.open = false;
      options.openSource = 'flag';
    } else if (flag === '--enable-manager' || flag === '--no-manager') {
      options.manager = flag === '--enable-manager';
      options.managerSource = 'flag';
    } else if (flag === '--enable-translation' || flag === '--no-translation') {
      options.translation = flag === '--enable-translation';
      options.translationSource = 'flag';
    } else if (flag === '--enable-auto-tasks' || flag === '--no-auto-tasks') {
      options.autoTasks = flag === '--enable-auto-tasks';
      options.autoTasksSource = 'flag';
    } else if (flag === '--no-config') {
      options.useConfig = false;
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown option: ${flag}`);
    } else if (targetDirSeen) {
      throw new Error(`target directory is already set to "${options.targetDir}": ${flag}`);
    } else {
      options.targetDir = flag;
      targetDirSeen = true;
    }
  }

  options.include = normalizePatterns(options.include);
  options.exclude = normalizePatterns(options.exclude);
  return options;
}

export function assertTargetDirectory(targetDir) {
  if (!existsSync(targetDir)) throw new Error(`target directory not found: ${targetDir}`);
  if (!statSync(targetDir).isDirectory()) throw new Error(`target must be a directory: ${targetDir}`);
}
