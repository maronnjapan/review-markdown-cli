/**
 * 連携先「Automation App」（agent-xaa-platform）へ、決めたタスクをToDoとして登録する口です。
 *
 * 向こうの `/external/todos` は、Human IdPが発行したこのアプリ宛のAccess Token
 * （`aud=automation-app`、scopeに `agent:operate`）を `Authorization: Bearer` で受け取り、
 * 下書き（`DRAFT`）のToDoを1件作ります。確定・承認・Agentの作成は向こうの画面で人が押す
 * 操作なので（RULE-08）、ここから先には進めません。このCLIが渡すのは種だけです。
 *
 * トークンの取り方はHuman IdPの `automation-app` クライアントで認可コードフローを行い、
 * `agent:operate` スコープを要求するというもので、このCLIは発行も更新もしません
 * （`aiProviders/claude.js` と同じく、資格情報は受け取ったものをそのまま使うだけです）。
 * 期限が切れたら、取り直して設定し直してください。
 */

const TODOS_PATH = '/external/todos';

/** レビューMarkdown側の優先度を、Automation App側の3段階へ合わせます。 */
const PRIORITY_TO_AUTOMATION_APP = { now: 'high', next: 'normal', later: 'low' };

/** Automation Appが返す `error` コードを、次に何をすればよいか分かる日本語にします。 */
const ERROR_HINTS = {
  invalid_token: 'アクセストークンが無効です。automationAppToken（または環境変数 AUTOMATION_APP_ACCESS_TOKEN）を取得し直してください',
  insufficient_scope: 'アクセストークンに agent:operate スコープがありません。取得し直してください',
  invalid_request: 'リクエストの形式が正しくありません',
  title_required: 'タスクの題名が空です',
  text_too_long: 'タスクの内容が長すぎます',
  too_many_items: '項目が多すぎます',
  invalid_priority: '優先度が正しくありません',
  invalid_due_on: '期限の形式が正しくありません',
  lifetime_out_of_range: '実行時間の指定が範囲外です'
};

export class AutomationAppError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'AutomationAppError';
    this.status = status;
  }
}

/**
 * 設定から、この連携が使える状態かを読みます。
 *
 * URLが無ければ連携していないので `null` です。トークンは環境変数が設定を上書きします。
 * 発行されたトークンは期限が短く、使うたびに設定ファイルを書き直すよりも、その場だけ
 * 環境変数で渡したいことがあるからです（CIやワンショットの実行など）。
 */
export function resolveAutomationAppTarget({ automationAppUrl, automationAppToken } = {}, env = process.env) {
  const baseUrl = typeof automationAppUrl === 'string' ? automationAppUrl.trim().replace(/\/+$/, '') : '';
  if (!baseUrl) return null;
  const token = String(env.AUTOMATION_APP_ACCESS_TOKEN || automationAppToken || '').trim();
  return { baseUrl, token };
}

/**
 * タスク1件を、Automation Appの `POST /external/todos` が読める形へ整えます。
 *
 * 必須なのは題名だけです（向こうの `readTodoInput` と同じ）。「やること」を持たない項目
 * （達成条件・手順・してはいけないこと）は、このCLIが持っていない情報を作らず、空のまま
 * 渡します。実行時間の指定も渡しません。渡さなければ、向こうが自分の既定を当てます。
 */
export function buildAutomationAppTodoInput(task, { documentPath = '' } = {}) {
  const title = typeof task?.title === 'string' ? task.title.trim() : '';
  if (!title) throw new AutomationAppError('題名の無いタスクはAutomation Appへ登録できません', { status: 400 });
  const input = {
    title,
    description: typeof task.detail === 'string' ? task.detail : '',
    context: buildContext(task, documentPath),
    done_criteria: [],
    steps: [],
    notes: [],
    priority: PRIORITY_TO_AUTOMATION_APP[task.priority] || 'normal'
  };
  if (task.plan?.due) input.due_on = task.plan.due;
  return input;
}

/** 実行の前提として渡す文脈。書かれているものだけをつなぎ、無いものは作りません。 */
function buildContext(task, documentPath) {
  const parts = [];
  if (documentPath) parts.push(`元の文書: ${documentPath}`);
  if (task.owner) parts.push(`担当: ${task.owner}`);
  if (task.quote) parts.push(`引用:\n${task.quote}`);
  if (task.reference?.knowledge) parts.push(`参考知識:\n${task.reference.knowledge}`);
  return parts.join('\n\n');
}

/**
 * ToDoを1件、下書きとして登録します。返り値は向こうが作ったWork Definitionそのものです。
 *
 * @param {{baseUrl: string, token: string}} target `resolveAutomationAppTarget` の返り値。
 * @param {object} todoInput `buildAutomationAppTodoInput` の返り値。
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] テストの差し替え口。既定はグローバルの `fetch`。
 */
export async function createAutomationAppTodo(target, todoInput, { fetchImpl = fetch } = {}) {
  if (!target?.baseUrl) {
    throw new AutomationAppError('連携先のAutomation AppのURL（automationAppUrl）が設定されていません', { status: 400 });
  }
  if (!target.token) {
    throw new AutomationAppError(
      'Automation Appへ渡すアクセストークンが設定されていません（automationAppToken か環境変数 AUTOMATION_APP_ACCESS_TOKEN）',
      { status: 400 }
    );
  }

  let response;
  try {
    response = await fetchImpl(`${target.baseUrl}${TODOS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
      body: JSON.stringify(todoInput)
    });
  } catch (error) {
    throw new AutomationAppError(`Automation Appへ接続できませんでした: ${error.message}`);
  }

  const body = await readJsonBody(response);
  if (!response.ok) {
    const code = body?.error;
    const hint = code && ERROR_HINTS[code];
    throw new AutomationAppError(
      hint || `Automation Appが要求を断りました（${response.status}${code ? `: ${code}` : ''}）`,
      { status: response.status }
    );
  }
  return body;
}

async function readJsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
