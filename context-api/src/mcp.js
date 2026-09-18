/**
 * MCP（Model Context Protocol）の口です。Claude CodeやCodexのようなAIエージェントから、
 * このサービスをツールとして使えるようにします。
 *
 * ── HTTPの口とは別に持つ理由 ───────────────────────────
 * `/search` や `/pages` は、review-markdown CLIのように自分でHTTPを叩く相手のための口です。
 * AIエージェントは、ツールの一覧と呼び方をMCPの形で受け取ります。同じ機能を2つの形で
 * 出すことになりますが、ここが持つのは形の変換だけで、中身は `search.js`、`store.js`、
 * `pages/store.js` をそのまま呼びます。
 *
 * ── Streamable HTTPの、いちばん薄い形 ────────────────────
 * 1回のPOSTに1つのJSON-RPCで答えます。サーバから先に話しかけること（SSEの流れ）はしないので、
 * GETは405です。セッションも持ちません。個人がローカルで使う相手なので、
 * 「いまの要求に答える」以上のことは要りません。
 *
 * ── 依存パッケージを持たない ───────────────────────────
 * 使うメソッドは `initialize`、`tools/list`、`tools/call`、`ping` の4つだけなので、
 * SDKを入れるより、JSON-RPCを直に読み書きしたほうが小さく済みます（`embedding.js` と同じ理由）。
 */

import { CONTEXT_KINDS, CONTEXT_SCOPES } from './model.js';
import { KNOWLEDGE_SOURCES, normalizeKnowledgeRequest } from './search.js';

/** 新しい順。クライアントが求めた版を知っていればそれを、知らなければいちばん新しい版を返します。 */
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
};

const INSTRUCTIONS = [
  'This server is the user\'s personal knowledge base: saved decisions ("contexts") and written pages.',
  'Call search_knowledge before answering questions about what the user decided, prefers, or wrote down.',
  'Cite the ids of the results you rely on. If nothing matches, say so instead of guessing.',
  'Save a decision with save_context only after the user confirmed it. Write longer notes as pages.'
].join(' ');

/**
 * @param {object} options
 * @param {object} options.search `search.js` が作ったもの。
 * @param {object} options.contexts `store.js` が作ったもの。
 * @param {object} options.pages `pages/store.js` が作ったもの。
 * @param {string} [options.serverName]
 * @param {string} [options.serverVersion]
 */
export function createMcpHandler({ search, contexts, pages, serverName = 'review-markdown-context-api', serverVersion = '0.2.0' }) {
  const tools = [
    {
      name: 'search_knowledge',
      title: 'Search the knowledge base',
      description: 'Semantic search over the user\'s saved decisions (contexts) and pages. Returns the best matching items with a snippet, a score and ids. Use it before answering questions about what the user decided, prefers, or wrote down.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to search with. Include the words the user would have written when saving, not only the ones in the question.' },
          workspace_id: { type: 'string', description: 'Workspace to search (the id in .review/workspace.json of a repository, or one from list_workspaces). Omit to search only global contexts, or set all_workspaces.' },
          scope_path: { type: 'string', description: 'Directory the question is about, relative to the workspace root (for example "src/auth"). Ancestor directories are included automatically.' },
          sources: { type: 'array', items: { type: 'string', enum: [...KNOWLEDGE_SOURCES] }, description: 'Which kinds to search. Default: both contexts and pages.' },
          all_workspaces: { type: 'boolean', description: 'Search every workspace and global contexts.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of results (default 5).' }
        },
        required: ['query'],
        additionalProperties: false
      },
      run: async (args) => {
        const request = normalizeKnowledgeRequest({ ...args, sources: args.sources }, { defaultSources: [...KNOWLEDGE_SOURCES] });
        const results = await search.search(request);
        return {
          text: results.length ? results.map(formatResult).join('\n\n') : 'No saved decision or page matched this query.',
          structured: { results }
        };
      }
    },
    {
      name: 'read_page',
      title: 'Read a page',
      description: 'Returns the full Markdown of one page, with its title and location in the page tree.',
      inputSchema: {
        type: 'object',
        properties: { page_id: { type: 'string', description: 'The page id (pg_...) from search_knowledge or list_pages.' } },
        required: ['page_id'],
        additionalProperties: false
      },
      run: async (args) => {
        const page = await pages.get(String(args.page_id || ''));
        if (!page) throw toolError(`Page not found: ${args.page_id}`);
        const trail = page.breadcrumb.map((entry) => entry.title || '(untitled)').join(' › ');
        return {
          text: [`# ${page.title || '(untitled)'}`, `location: ${trail}`, `page_id: ${page.page_id}`, `workspace_id: ${page.workspace_id}`, `updated_at: ${page.updated_at}`, '', page.content].join('\n'),
          structured: { page: withoutIndex(page) }
        };
      }
    },
    {
      name: 'list_pages',
      title: 'List the pages of a workspace',
      description: 'Lists the page tree of a workspace (titles and ids, indented by depth). Contents are not included; use read_page.',
      inputSchema: {
        type: 'object',
        properties: { workspace_id: { type: 'string', description: 'Workspace id from list_workspaces.' } },
        required: ['workspace_id'],
        additionalProperties: false
      },
      run: async (args) => {
        const tree = await pages.tree(String(args.workspace_id || ''));
        return {
          text: tree.length
            ? tree.map((page) => `${'  '.repeat(page.depth)}- ${page.title || '(untitled)'} (${page.page_id})`).join('\n')
            : 'This workspace has no pages yet.',
          structured: { pages: tree }
        };
      }
    },
    {
      name: 'list_workspaces',
      title: 'List workspaces',
      description: 'Lists the workspaces (projects) that hold pages or saved decisions, with their ids.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const workspaces = await pages.listWorkspaces({ extraIds: await contexts.workspaceIds() });
        return {
          text: workspaces.length
            ? workspaces.map((workspace) => `- ${workspace.name} (${workspace.workspace_id}) pages: ${workspace.page_count}`).join('\n')
            : 'There are no workspaces yet.',
          structured: { workspaces }
        };
      }
    },
    {
      name: 'create_page',
      title: 'Create a page',
      description: 'Creates a Markdown page in a workspace, optionally under a parent page. Use it for notes longer than one decision.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string', description: 'Markdown body.' },
          parent_id: { type: 'string', description: 'Parent page id to nest under.' }
        },
        required: ['workspace_id', 'title'],
        additionalProperties: false
      },
      run: async (args) => {
        const page = await pages.create(args);
        return { text: `Created page ${page.page_id} (${page.title || '(untitled)'}).`, structured: { page: withoutIndex(page) } };
      }
    },
    {
      name: 'update_page',
      title: 'Update a page',
      description: 'Changes the title or content of a page, or appends Markdown to the end of it.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string', description: 'Replaces the whole Markdown body.' },
          append: { type: 'string', description: 'Markdown appended after the current body (separated by a blank line).' }
        },
        required: ['page_id'],
        additionalProperties: false
      },
      run: async (args) => {
        const pageId = String(args.page_id || '');
        const changes = {};
        if (args.title !== undefined) changes.title = args.title;
        if (args.content !== undefined) changes.content = args.content;
        if (typeof args.append === 'string' && args.append.trim()) {
          const current = await pages.get(pageId);
          if (!current) throw toolError(`Page not found: ${pageId}`);
          const base = args.content !== undefined ? String(args.content) : current.content;
          changes.content = base.trim() ? `${base.replace(/\s+$/, '')}\n\n${args.append.trim()}\n` : `${args.append.trim()}\n`;
        }
        const { page } = await pages.patch(pageId, changes);
        return { text: `Updated page ${page.page_id} (${page.title || '(untitled)'}).`, structured: { page: withoutIndex(page) } };
      }
    },
    {
      name: 'save_context',
      title: 'Save a decision',
      description: 'Saves a decision, preference or note the user confirmed, so it is found by later searches. Scope "workspace" needs workspace_id, "path" also needs scope_path, "global" applies everywhere.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'One decision or note, in the user\'s words (max 8000 characters).' },
          scope: { type: 'string', enum: [...CONTEXT_SCOPES], description: 'Default: "workspace" when workspace_id is given, otherwise "global".' },
          workspace_id: { type: 'string' },
          scope_path: { type: 'string', description: 'Directory the decision applies to (scope "path"), relative to the workspace root.' },
          kind: { type: 'string', enum: [...CONTEXT_KINDS], description: 'decision (the project decided this), preference (how the user always works), note (other knowledge).' }
        },
        required: ['content'],
        additionalProperties: false
      },
      run: async (args) => {
        const scope = args.scope || (args.workspace_id ? 'workspace' : 'global');
        const context = await contexts.create({
          content: args.content,
          scope,
          ...(scope === 'global' ? {} : { workspace_id: args.workspace_id }),
          ...(args.scope_path ? { scope_path: args.scope_path } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          source_type: 'agent'
        });
        return { text: `Saved context ${context.context_id} (scope: ${context.scope}).`, structured: { context } };
      }
    },
    {
      name: 'list_contexts',
      title: 'List saved decisions',
      description: 'Lists the saved decisions of a workspace (newest first) together with the global ones.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          include_global: { type: 'boolean', description: 'Default true.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 }
        },
        additionalProperties: false
      },
      run: async (args) => {
        const listed = await contexts.list({
          workspaceId: args.workspace_id ? String(args.workspace_id) : null,
          includeGlobal: args.include_global !== false,
          limit: Number(args.limit) || undefined
        });
        return {
          text: listed.length ? listed.map(formatResult).join('\n\n') : 'No saved decisions.',
          structured: { results: listed }
        };
      }
    }
  ];

  async function callTool(params = {}) {
    const tool = tools.find((candidate) => candidate.name === params.name);
    if (!tool) throw rpcError(JSON_RPC.INVALID_PARAMS, `Unknown tool: ${params.name}`);
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      const { text, structured } = await tool.run(args);
      return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), isError: false };
    } catch (error) {
      // 使い方の誤りや預け先の不調は、ツールの結果として返します。JSON-RPCのエラーにすると、
      // モデルは何が悪かったのかを読めず、言い直しもできません。
      if (error.rpcCode) throw error;
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }

  async function dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      throw rpcError(JSON_RPC.INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    const { method, params = {} } = message;
    if (typeof method !== 'string') throw rpcError(JSON_RPC.INVALID_REQUEST, 'Invalid JSON-RPC request');
    // 通知（`notifications/initialized` など）は受け取るだけです。答える相手がいません。
    if (method.startsWith('notifications/')) return null;
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: serverVersion },
          instructions: INSTRUCTIONS
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: tools.map(({ run, ...definition }) => definition) };
      case 'tools/call':
        return callTool(params);
      default:
        throw rpcError(JSON_RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return {
    tools: tools.map(({ run, ...definition }) => definition),

    /**
     * 1回のPOSTを処理します。
     *
     * @param {object} params
     * @param {string} params.method HTTPのメソッド。
     * @param {*} params.body 読み終えたJSON。配列も受け付けます。
     * @returns {Promise<{status: number, payload: *}>} `payload` が null なら本文なし（202）。
     */
    async handle({ method, body }) {
      if (method !== 'POST') {
        return { status: 405, headers: { Allow: 'POST' }, payload: { error: 'Method not allowed. This MCP endpoint answers POST only.' } };
      }
      const messages = Array.isArray(body) ? body : [body];
      const responses = [];
      for (const message of messages) {
        const id = message && typeof message === 'object' ? message.id : undefined;
        // idの無いものは通知です。答えを返す相手がいないので、処理だけして応答しません。
        const isNotification = id === undefined || id === null;
        try {
          const result = await dispatch(message);
          if (!isNotification) responses.push({ jsonrpc: '2.0', id, result });
        } catch (error) {
          if (isNotification) continue;
          responses.push({
            jsonrpc: '2.0',
            id,
            error: { code: error.rpcCode || JSON_RPC.INTERNAL_ERROR, message: error.message }
          });
        }
      }
      if (responses.length === 0) return { status: 202, payload: null };
      return { status: 200, payload: Array.isArray(body) ? responses : responses[0] };
    }
  };
}

function formatResult(result) {
  const updated = String(result.updated_at || '').slice(0, 10);
  if (result.type === 'page') {
    const trail = (result.breadcrumb || []).map((entry) => entry.title || '(untitled)').join(' › ') || result.title || '(untitled)';
    const heading = result.heading ? ` › ${result.heading}` : '';
    return [
      `[page] ${trail}${heading} (page_id: ${result.page_id}, workspace: ${result.workspace_id}, score: ${result.score}, updated: ${updated})`,
      result.snippet || '(no excerpt)'
    ].join('\n');
  }
  const scope = result.scope === 'path' ? `path ${result.scope_path}` : result.scope || 'workspace';
  const score = typeof result.score === 'number' ? `, score: ${result.score}` : '';
  return [
    `[${result.kind || 'note'}] (context_id: ${result.context_id}, scope: ${scope}${score}, updated: ${updated})`,
    result.content
  ].join('\n');
}

function withoutIndex(page) {
  const { index, ...rest } = page;
  return rest;
}

function toolError(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}
