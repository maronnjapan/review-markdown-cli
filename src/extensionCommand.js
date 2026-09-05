import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `review-markdown extension` です。
 *
 * Chromeの拡張機能は、フォルダを指定して読み込ませます。指定するフォルダがどこにあるかは、
 * `npm install -g` で入れた人にも `npx` で走らせた人にも分かりません。分からないままだと、
 * 連携そのものが始められないので、パスを1コマンドで出せるようにしてあります。
 *
 * `--path` を付けると、パスだけを1行で出します。`open $(review-markdown extension --path)` の
 * ように、そのまま別のコマンドへ渡せるようにするためです。
 *
 * 読み込ませたあとに人がすることはありません。連携コードは拡張機能が自分で取りに来ます
 * （`src/routes.js` の `liveCaptionsPairing`）。
 */

export const EXTENSION_USAGE = `Usage: review-markdown extension [--path]

Google Meetの字幕をこのCLIへ流し込むChrome拡張機能（Meet Captions Memo）の場所を出します。

Options:
      --path      拡張機能フォルダのパスだけを出す（他のコマンドへ渡す用）
  -h, --help      このヘルプを表示する

読み込ませ方:
  1. chrome://extensions を開き、右上の「デベロッパーモード」をオンにする
  2. 「パッケージ化されていない拡張機能を読み込む」で、上のフォルダを選ぶ
  3. review-markdown を起動する

これで繋がります。拡張機能が動いている review-markdown を自分で見つけて連携し、
Meetの会議に入ると字幕(CC)も自動でオンになります。設定を運ぶ手作業はありません。

自動で見つからないとき（既定（3000番台）と違うポートで動かしているときなど）は、
ブラウザ画面右上の「Meet連携」から連携コードをコピーし、拡張機能のアイコンを開いて
貼り付けてください。`;

/** リポジトリに同梱している拡張機能フォルダ。パッケージにも `extension/` として入ります。 */
export function extensionDir() {
  return path.resolve(fileURLToPath(import.meta.url), '..', '..', 'extension');
}

/**
 * @param {string[]} argv `extension` のあとの引数。
 * @returns {{stdout: string[], stderr: string[], exitCode: number}}
 */
export function runExtensionCommand(argv = []) {
  const directory = extensionDir();
  if (argv.includes('--help') || argv.includes('-h')) {
    return { stdout: [EXTENSION_USAGE.replace('上のフォルダ', directory)], stderr: [], exitCode: 0 };
  }
  if (argv.includes('--path')) return { stdout: [directory], stderr: [], exitCode: 0 };

  const unknown = argv.find((argument) => argument.startsWith('-'));
  if (unknown) {
    return { stdout: [], stderr: [`Error: unknown option: ${unknown}`, '', EXTENSION_USAGE], exitCode: 1 };
  }

  return {
    stdout: [
      'Meet Captions Memo（Google Meetの字幕を記録するChrome拡張機能）',
      `  フォルダ: ${directory}`,
      '',
      '読み込ませ方:',
      '  1. chrome://extensions を開き、右上の「デベロッパーモード」をオンにする',
      '  2. 「パッケージ化されていない拡張機能を読み込む」で、上のフォルダを選ぶ',
      '  3. review-markdown を起動する（拡張機能が自動で見つけて繋ぎます）',
      '',
      'Meetの会議に入ると字幕(CC)も自動でオンになります。自動で見つからないときだけ、',
      'ブラウザ画面右上の「Meet連携」から連携コードをコピーして貼り付けてください。'
    ],
    stderr: [],
    exitCode: 0
  };
}
