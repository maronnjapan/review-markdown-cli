import { CONVERSATION_TITLE_CHARS, MAX_MESSAGE_CHARS } from './aiLimits.js';

/**
 * 保存したAIチャットを、レビュアーが後から直すための検証です。
 *
 * 相談の記録は、読み返すためだけのものではありません。Codexのスレッドが切れていれば、
 * 次に同じ会話を続けるときの1回目のプロンプトへ、ここに残っている発言がそのまま
 * 入ります（`prompts/chat.js` の `initialChatPrompt`）。つまり残った記録は前提の一部です。
 * 言い間違えた質問や、間違ったまま残っている回答を直せないと、その会話を続けるかぎり
 * 間違いを読ませ続けることになります。
 *
 * ここが持つのは検証と差し替えだけです。スレッドを開き直すかどうかは `aiService.js` が
 * 決めます。書き換えたことをモデルへどう伝えるかは、そちらの都合だからです。
 *
 * ── 消し方を「省く」にした理由 ────────────────────────────
 * 消したい発言は、送ってくる一覧から省いてもらいます。「消す」を別に用意すると、
 * 画面が持っている一覧と保存されている一覧のどちらが正なのかが場面ごとに変わります。
 * 送られた一覧をそのまま残りの全部として扱えば、そのずれが起きません。
 */

/**
 * 保存済みの会話へ、レビュアーの書き換えを当てます。
 *
 * @param {object} conversation 保存されている会話。
 * @param {object} edits `title`（題名）と `messages`（残す発言）。どちらも省けます。
 * @param {Array<{id: string, content: string}>} [edits.messages]
 *   残す発言を、残す順に。ここに無い発言は消えます。
 * @returns {{conversation: object, transcriptChanged: boolean}}
 *   `transcriptChanged` は、モデルが読む文面が変わったかどうかです。題名だけの変更では立ちません。
 */
export function applyConversationEdits(conversation, edits = {}, now = new Date()) {
  const { title, messages } = edits || {};
  if (title === undefined && messages === undefined) {
    throw new Error('会話の題名か、残すやり取りを指定してください');
  }

  const next = { ...conversation };
  if (title !== undefined) next.title = readTitle(title);

  let transcriptChanged = false;
  if (messages !== undefined) {
    const kept = readMessages(conversation.messages || [], messages, now);
    transcriptChanged = kept.changed;
    next.messages = kept.messages;
  }

  // 題名だけを直したときも日時は進めます。一覧は新しい順に並ぶので、
  // 直したものが動かないと、直したこと自体が画面から分かりません。
  next.updatedAt = now.toISOString();
  return { conversation: next, transcriptChanged };
}

function readTitle(value) {
  if (typeof value !== 'string') throw new Error('会話の題名は文字列で指定してください');
  const text = value.trim();
  if (!text) throw new Error('会話の題名は空にできません');
  if (text.length > CONVERSATION_TITLE_CHARS) {
    throw new Error(`会話の題名は${CONVERSATION_TITLE_CHARS}文字までです`);
  }
  return text;
}

/**
 * 残す発言を、保存されている並びのまま組み直します。
 *
 * 並べ替えは受け取りません。送られた順ではなく保存されている順を使うのは、質問と回答の
 * 前後が入れ替わった記録をモデルへ読ませないためです。画面にも並べ替えは出しません。
 */
function readMessages(stored, requested, now) {
  if (!Array.isArray(requested)) throw new Error('残すやり取りは配列で指定してください');
  const edits = new Map();
  for (const entry of requested) {
    if (!entry || typeof entry !== 'object') throw new Error('やり取りの指定が壊れています');
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id || !stored.some((message) => message.id === id)) {
      // 画面が持っている記録が古いということなので、当てずに断ります。当ててしまうと、
      // もう消えている発言を残すつもりの操作が、別の発言を消す操作になります。
      throw new Error('この会話に無いやり取りが含まれています。画面を開き直してください');
    }
    edits.set(id, readContent(entry.content));
  }

  const messages = [];
  let changed = false;
  for (const message of stored) {
    if (!edits.has(message.id)) {
      changed = true;
      continue;
    }
    const content = edits.get(message.id);
    if (content === message.content) {
      messages.push(message);
      continue;
    }
    changed = true;
    // 直したことは記録に残します。読み返したときに、そのときの発言そのままなのか
    // 後から直したものなのかが分からないと、記録として当てになりません。
    messages.push({ ...message, content, editedAt: now.toISOString() });
  }
  return { messages, changed };
}

function readContent(value) {
  if (typeof value !== 'string') throw new Error('やり取りの本文は文字列で指定してください');
  const content = value.trim();
  // 空にすることは、消すこととは違う操作です。空の発言を残すと、モデルは
  // 「何も言わなかった順番」を読むことになるので、消すほうを選んでもらいます。
  if (!content) throw new Error('やり取りの本文は空にできません。消すときは削除してください');
  if (content.length > MAX_MESSAGE_CHARS) throw new Error('やり取りの本文が長すぎます');
  return content;
}
