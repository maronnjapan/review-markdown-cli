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
 */

export const EXTENSION_USAGE = `Usage: review-markdown extension [--path]

Google Meetの字幕をこのCLIへ流し込むChrome拡張機能（Meet Captions Memo）の場所を出します。

Options:
      --path      拡張機能フォルダのパスだけを出す（他のコマンドへ渡す用）
  -h, --help      このヘルプを表示する

読み込ませ方:
  1. chrome://extensions を開き、右上の「デベロッパーモード」をオンにする
  2. 「パッケージ化されていない拡張機能を読み込む」で、上のフォルダを選ぶ
  3. review-markdown を起動し、ブラウザ画面右上の「Meet連携」から連携コードをコピーする
  4. 拡張機能のアイコンを開き、連携コードを貼って保存する`;

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
      '  3. review-markdown を起動し、ブラウザ画面右上の「Meet連携」から連携コードをコピーする',
      '  4. 拡張機能のアイコンを開き、連携コードを貼って保存する'
    ],
    stderr: [],
    exitCode: 0
  };
}
