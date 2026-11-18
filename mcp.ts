// The MCP surface: POST /mcp, JSON-RPC 2.0 over Streamable HTTP. Answers the modern
// server/discover handshake, keeps a legacy initialize fallback, and exposes six tools that run
// against the same store as REST. Tool definitions are module constants so two tools/list calls
// return byte-for-byte identical arrays.

import { jsonReply, type Ctx, type Reply } from './http.ts';
import { VIEWER, forge, createIssue, createPull, pullMergeable, squashMerge, type RepoRec } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body text.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request proposing the head branch into the base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body text.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function resultReply(id: JsonRpcId, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, result });
}

function errorMessageReply(id: JsonRpcId, code: number, message: string): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Resolve the addressed repository: owner defaults to the viewer; repo may be "owner/name". */
function resolveRepo(args: Record<string, unknown>): RepoRec | undefined {
  let owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (name.includes('/')) {
    const parts = name.split('/');
    owner = parts[0] as string;
    name = parts.slice(1).join('/');
  }
  if (name === '') return undefined;
  return forge.getRepo(owner, name);
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      const existing = forge.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return toolResult(repoJson(existing));
      const repo = forge.createRepo({
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(args);
      if (repo === undefined) return toolError('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(args);
      if (repo === undefined) return toolError('Repository not found');
      const issue = createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(args);
      if (repo === undefined) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(args);
      if (repo === undefined) return toolError('Repository not found');
      const pull = createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: String(args.head ?? ''),
        baseRef: String(args.base ?? ''),
      });
      if (pull === null) return toolError('Head or base branch does not exist');
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(args);
      if (repo === undefined) return toolError('Repository not found');
      const number = Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError('Pull request not found');
      if (!pullMergeable(repo, pull)) return toolError('Pull request is not mergeable');
      squashMerge(repo, pull);
      return toolResult(pullJson(repo, pull));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function handleMessage(message: JsonRpcMessage): Reply | null {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return resultReply(id, {
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
        instructions: 'A GitHub-compatible forge. Create repositories, issues and pull requests with the tools.',
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return resultReply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return resultReply(id, {});
    case 'tools/list':
      return resultReply(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return errorMessageReply(id, -32602, `Unknown tool: ${toolName}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null) {
          return resultReply(id, toolError(`Missing required argument: ${required}`));
        }
      }
      return resultReply(id, callTool(toolName, args));
    }
    case 'resources/list':
      return resultReply(id, { resources: [] });
    case 'prompts/list':
      return resultReply(id, { prompts: [] });
    default:
      if (isNotification) return null;
      return errorMessageReply(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp request (a single message, or a batch array). */
export function handleMcp(ctx: Ctx): Reply {
  if (ctx.jsonError) {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(ctx.json)) {
    const replies: unknown[] = [];
    for (const entry of ctx.json) {
      if (typeof entry !== 'object' || entry === null) continue;
      const reply = handleMessage(entry as JsonRpcMessage);
      if (reply !== null && reply.body !== undefined) replies.push(reply.body);
    }
    if (replies.length === 0) return { status: 202 };
    return jsonReply(200, replies);
  }
  if (typeof ctx.json !== 'object' || ctx.json === null) {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const reply = handleMessage(ctx.json as JsonRpcMessage);
  if (reply === null) return { status: 202 };
  return reply;
}
