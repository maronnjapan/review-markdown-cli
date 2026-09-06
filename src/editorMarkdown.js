/**
 * 本文へ書き込む唯一の場所です。編集モードの保存も、AIの修正案の適用も、ここを通ります。
 *
 * 受け取るのはMarkdownだけです。以前は画面のHTMLも受けてMarkdownへ戻していましたが、
 * その戻し（turndown）は `:::message` や脚注、`$式$`、画像の `=250x` を書き換えてしまい、
 * 触っていない行にまで行末の空白を足しました。書いたものがそのまま入る道だけを残します。
 */

/**
 * 本文の一部を、送られてきた範囲ごと置き換えます。
 *
 * `before` が添えてあれば、その範囲がいまも送り手の思っている中身かを先に確かめます。
 * 画面が本文を読んでから保存するまでのあいだに別のエディタで書き換えられていると、
 * 位置だけが残って中身がずれます。確かめずに当てると、そのずれた場所を壊します。
 */
export function applyBlockEdits(markdown, edits) {
  const source = String(markdown);
  const normalizedEdits = (Array.isArray(edits) ? edits : []).map((edit, index) => {
    const start = Number(edit.start);
    const end = Number(edit.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) {
      throw Object.assign(new Error(`Invalid source range for edit ${index + 1}`), { statusCode: 400 });
    }
    if (typeof edit.markdown !== 'string') {
      throw Object.assign(new Error(`markdown is required for edit ${index + 1}`), { statusCode: 400 });
    }
    if (typeof edit.before === 'string' && source.slice(start, end) !== edit.before) {
      throw Object.assign(
        new Error('ファイルがこの編集の途中で書き換わりました。画面を開き直してください'),
        { statusCode: 409 }
      );
    }
    return {
      blockId: String(edit.blockId || `edit-${index}`),
      start,
      end,
      markdown: edit.delete === true ? '' : edit.markdown,
      ...(edit.delete === true ? { delete: true } : {})
    };
  });

  const sourceOrdered = [...normalizedEdits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sourceOrdered.length; index += 1) {
    if (sourceOrdered[index].start < sourceOrdered[index - 1].end) {
      throw Object.assign(new Error('Edited source ranges must not overlap'), { statusCode: 400 });
    }
  }

  const ascending = expandDeletionRanges(source, sourceOrdered);
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index].start < ascending[index - 1].end) {
      throw Object.assign(new Error('Expanded deletion ranges must not overlap'), { statusCode: 400 });
    }
  }

  let updated = source;
  for (const edit of [...ascending].reverse()) {
    updated = `${updated.slice(0, edit.start)}${edit.markdown}${updated.slice(edit.end)}`;
  }

  return { markdown: updated, appliedEdits: ascending };
}

function expandDeletionRanges(source, edits) {
  const expanded = [];
  for (const originalEdit of edits) {
    const edit = { ...originalEdit };
    if (!edit.delete) {
      expanded.push(edit);
      continue;
    }

    const followingSeparator = source.slice(edit.end).match(/^(?:\r\n|\n)[\t ]*(?:\r\n|\n)/);
    if (followingSeparator) {
      edit.end += followingSeparator[0].length;
      expanded.push(edit);
      continue;
    }

    const trailingWhitespace = source.slice(edit.end).match(/^(?:(?:\r\n|\n)[\t ]*)?$/);
    if (trailingWhitespace) {
      edit.end = source.length;
      const precedingSeparator = source.slice(0, edit.start).match(/(?:\r\n|\n)[\t ]*(?:\r\n|\n)$/);
      if (precedingSeparator) {
        const expandedStart = edit.start - precedingSeparator[0].length;
        const overlapsPreviousDeletion = expanded.some((previous) => (
          previous.delete && previous.end > expandedStart
        ));
        if (!overlapsPreviousDeletion) edit.start = expandedStart;
      }
    }
    expanded.push(edit);
  }
  return expanded;
}

