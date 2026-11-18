// mcp.ts — the forge's Model Context Protocol endpoint (the agent-native surface).
// JSON-RPC 2.0 over POST /mcp, Streamable-HTTP style with plain JSON answers: the modern
// `server/discover` negotiation (2026-07-28) plus the legacy initialize handshake, and six
// tools that act on the same store as REST — create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER, type RepoRec, squashMerge } from './store.ts';
import { repoJson, issueJson, pullJson } from './app.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

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
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The branch to merge from.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return { error: { code: -32602, message: `missing required argument: ${required}` } };
    }
  }
  const repoOf = (): RepoRec | undefined => forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = forge.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return { result: toolResult(repoJson(existing)) };
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === undefined) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === undefined) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const issue = forge.addIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { result: toolResult(issueJson(issue)) };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === undefined) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.seq - a.seq);
      return { result: toolResult(issues.map(issueJson)) };
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === undefined) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const head = String(args.head).replace(/^refs\/heads\//, '').split(':').pop()!;
      const base = String(args.base).replace(/^refs\/heads\//, '').split(':').pop()!;
      if (forge.branchTip(repo, head) === null) return { result: toolError(`head branch "${head}" does not exist`) };
      if (forge.branchTip(repo, base) === null) return { result: toolError(`base branch "${base}" does not exist`) };
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing !== undefined) return { result: toolResult(pullJson(repo, existing)) };
      const pull = forge.addPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
      });
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === undefined) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { result: toolError(`pull request #${String(args.pull_number)} not found`) };
      if (pull.state !== 'open') return { result: toolError(`pull request #${pull.number} is not open`) };
      const merged = squashMerge(forge, repo, pull);
      if ('conflict' in merged || 'missing' in merged) return { result: toolError(`pull request #${pull.number} is not mergeable`) };
      return { result: toolResult(pullJson(repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

function handleRequest(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};
  if (id === undefined) return null; // a notification: no answer
  switch (method) {
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const outcome = callTool(forge, toolName, args);
      if (outcome.error !== undefined) return rpcError(id, outcome.error.code, outcome.error.message);
      return { jsonrpc: '2.0', id, result: outcome.result };
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, rpcError(null, -32601, 'the MCP endpoint only accepts POST'));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: the body is not JSON'));
    return;
  }
  if (Array.isArray(body)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of body) {
      if (typeof entry !== 'object' || entry === null) continue;
      const answer = handleRequest(forge, entry as Record<string, unknown>);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const request = body as Record<string, unknown>;
  if (request.id === undefined) {
    // A notification (e.g. notifications/initialized): accepted, no body.
    res.writeHead(202);
    res.end();
    return;
  }
  const answer = handleRequest(forge, request);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
