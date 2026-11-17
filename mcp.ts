// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp.
// Modern era (2026-07-28): server/discover, tools/list, tools/call. The legacy
// initialize handshake is answered too, so either era negotiates.

import {
  Store,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
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
        full_name: { type: 'string', description: 'The full owner/repo name.' },
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
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        state: { type: 'string', description: 'The issue state.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
  };
}

function issueJson(store: Store, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }>; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullJson(store: Store, repo: Repo, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; headRef: string; baseRef: string; headSha: string; baseSha: string; merge_commit_sha: string | null; merged_at: string | null }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: store.resolveCommitish(repo, pull.headRef) ?? pull.headSha },
    base: { ref: pull.baseRef, sha: store.resolveCommitish(repo, pull.baseRef) ?? pull.baseSha },
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
  };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [owner, repo] = args.full_name.split('/', 2);
    return { owner: owner ?? '', repo: repo ?? '' };
  }
  return {
    owner: typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN,
    repo: typeof args.repo === 'string' ? args.repo : '',
  };
}

type ToolOutcome =
  | { ok: true; data: unknown }
  | { ok: false; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, message: `Unknown tool: ${name}` };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      return { ok: false, message: `Missing required argument: ${key}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
      const repoName = String(args.name ?? '');
      const repo = store.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} already exists` };
      return { ok: true, data: repoJson(store, repo) };
    }
    case 'get_repo': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      return { ok: true, data: repoJson(store, repo) };
    }
    case 'create_issue': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const result = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in result) return { ok: false, message: result.error };
      return { ok: true, data: issueJson(store, repo, result.issue) };
    }
    case 'list_issues': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { ok: true, data: issues.map((i) => issueJson(store, repo, i)) };
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const result = store.createPull(
        repo,
        String(args.title ?? ''),
        typeof args.body === 'string' ? args.body : '',
        String(args.head ?? ''),
        String(args.base ?? ''),
      );
      if ('error' in result) return { ok: false, message: result.error };
      return { ok: true, data: pullJson(store, repo, result.pull) };
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = splitFullName(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return { ok: false, message: `Pull request #${number} not found` };
      const result = store.mergePull(repo, pull);
      if ('error' in result) return { ok: false, message: result.error };
      return { ok: true, data: { merged: true, number: pull.number, pull_number: pull.number, sha: result.sha, state: pull.state } };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

export interface McpResult {
  status: number;
  body: unknown;
}

/** Handle one POST /mcp body (already parsed as JSON, or null when unparsable). */
export function handleMcp(store: Store, body: unknown): McpResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const record = body as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params as Record<string, unknown> | undefined) ?? {};

  const errorResult = (code: number, message: string): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });
  const okResult = (result: unknown): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result },
  });

  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return okResult({
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const negotiated = offered !== null && SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
      return okResult({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list': {
      // The same constant, serialised the same way every time.
      return okResult({ tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      const outcome = callTool(store, toolName, args);
      if (!outcome.ok) {
        // Unknown tool and missing/invalid arguments are JSON-RPC errors, never 500s.
        return errorResult(-32602, outcome.message);
      }
      const text = JSON.stringify(outcome.data);
      return okResult({
        content: [{ type: 'text', text }],
        structuredContent: outcome.data,
      });
    }
    case 'ping': {
      return okResult({});
    }
    default: {
      return errorResult(-32601, `Method not found: ${method}`);
    }
  }
}
