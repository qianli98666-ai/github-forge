// rest.ts — GitHub REST v3 surface: repositories, branches, commits, contents,
// issues, comments, labels, pull requests, merges, plus the API root and meta.

import {
  Store,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  TRIAL_NOW_ISO,
  parseCommit,
  type Repo,
  type Issue,
  type PullRequest,
} from './store.ts';

export interface RestCtx {
  store: Store;
  method: string;
  pathname: string;
  query: URLSearchParams;
  host: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => json(status, { message });

function isoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function userView(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

function repoView(store: Store, repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: TRIAL_NOW_ISO,
    pushed_at: TRIAL_NOW_ISO,
    html_url: `http://${host}/${repo.owner}/${repo.name}`,
    clone_url: `http://${host}/${repo.owner}/${repo.name}.git`,
    git_url: `http://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
  };
}

function issueView(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userView(),
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.resolveCommitish(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.resolveCommitish(repo, pull.baseRef) ?? pull.baseSha;
  const { conflict } = store.prDiff(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userView(),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !conflict : null,
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  let page = Number(query.get('page') ?? '1');
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.trunc(page);
  let perPage = Number(query.get('per_page') ?? '30');
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  perPage = Math.min(100, Math.trunc(perPage));
  return { page, perPage };
}

function paginate<T>(items: T[], ctx: RestCtx): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (totalPages > 1) {
    const base = `http://${ctx.host}${ctx.pathname}`;
    const links: string[] = [];
    const withPage = (p: number): string => {
      const q = new URLSearchParams(ctx.query);
      q.set('page', String(p));
      q.set('per_page', String(perPage));
      return `${base}?${q.toString()}`;
    };
    if (page < totalPages) {
      links.push(`<${withPage(page + 1)}>; rel="next"`);
      links.push(`<${withPage(totalPages)}>; rel="last"`);
    }
    if (page > 1) {
      links.push(`<${withPage(1)}>; rel="first"`);
      links.push(`<${withPage(page - 1)}>; rel="prev"`);
    }
    headers.Link = links.join(', ');
  }
  return { page: pageItems, headers };
}

function getRepoOr404(ctx: RestCtx, owner: string, name: string): Repo | RestResult {
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Handle a /api/v3 request. Returns null when the path is not a REST route. */
export function handleRest(ctx: RestCtx, body: unknown): RestResult | null {
  const { method, pathname } = ctx;
  const store = ctx.store;

  // API root
  if ((pathname === '/api/v3' || pathname === '/api/v3/') && method === 'GET') {
    return json(200, {
      current_user_url: `http://${ctx.host}/api/v3/user`,
      repository_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `http://${ctx.host}/api/v3/user/repos`,
    }, { 'X-Oauth-Scopes': 'repo, read:org' });
  }
  if (pathname === '/api/v3/meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true, hooks: [], git: [], pages: [] });
  }
  if (pathname === '/api/v3/user' && method === 'GET') {
    return json(200, userView());
  }

  // POST /user/repos, GET /user/repos
  if (pathname === '/api/v3/user/repos') {
    if (method === 'POST') {
      const b = bodyRecord(body);
      const name = str(b.name);
      if (name === '') return err(422, 'Validation Failed: name is required');
      const repo = store.createRepo(VIEWER_LOGIN, name, str(b.description), b.private === true);
      if (!repo) return err(422, 'Validation Failed: name already exists on this account');
      return json(201, repoView(store, repo, ctx.host));
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { page, headers } = paginate(repos, ctx);
      return json(200, page.map((r) => repoView(store, r, ctx.host)), headers);
    }
    return err(404, 'Not Found');
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!repoMatch) return null;
  const owner = decodeURIComponent(repoMatch[1]!);
  const repoName = decodeURIComponent(repoMatch[2]!);
  const rest = repoMatch[3] ?? '';

  // /repos/{owner}/{repo}
  if (rest === '') {
    if (method === 'GET') {
      const repo = getRepoOr404(ctx, owner, repoName);
      if ('status' in repo) return repo;
      return json(200, repoView(store, repo, ctx.host));
    }
    if (method === 'PATCH') {
      const repo = getRepoOr404(ctx, owner, repoName);
      if ('status' in repo) return repo;
      const b = bodyRecord(body);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.private = b.private;
      return json(200, repoView(store, repo, ctx.host));
    }
    if (method === 'DELETE') {
      const repo = getRepoOr404(ctx, owner, repoName);
      if ('status' in repo) return repo;
      store.deleteRepo(owner, repoName);
      return { status: 204, body: '' };
    }
    return err(404, 'Not Found');
  }

  const repo = getRepoOr404(ctx, owner, repoName);
  if ('status' in repo) return repo;

  // branches
  if (rest === 'branches' && method === 'GET') {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    const { page, headers } = paginate(branches, ctx);
    return json(200, page, headers);
  }
  const branchMatch = /^branches\/(.+)$/.exec(rest);
  if (branchMatch && method === 'GET') {
    const branch = decodeURIComponent(branchMatch[1]!);
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return err(404, 'Not Found');
    return json(200, { name: branch, commit: { sha: oid } });
  }

  // git refs
  if (rest === 'git/refs' && method === 'POST') {
    const b = bodyRecord(body);
    const ref = str(b.ref);
    const sha = str(b.sha);
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Validation Failed: invalid ref or sha');
    if (repo.refs.has(ref)) return err(422, 'Validation Failed: Reference already exists');
    const obj = repo.objects.get(sha);
    if (!obj) return err(422, 'Validation Failed: Invalid commit sha');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha, type: obj.type } });
  }
  const refMatch = /^git\/refs\/heads\/(.+)$/.exec(rest);
  if (refMatch && method === 'GET') {
    const branch = decodeURIComponent(refMatch[1]!);
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return err(404, 'Not Found');
    return json(200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: 'commit' } });
  }

  // commits
  if (rest === 'commits' && method === 'GET') {
    const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveCommitish(repo, shaParam);
    if (tip === undefined) return err(404, 'Not Found');
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      out.push({
        sha: oid,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: { name: commit.authorName, email: commit.authorEmail, date: isoDate(commit.authorTime) },
          committer: { name: commit.committerName, email: commit.committerEmail, date: isoDate(commit.committerTime) },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
        parents: commit.parents.map((p) => ({ sha: p })),
      });
      for (const parent of commit.parents) queue.push(parent);
    }
    const { page, headers } = paginate(out, ctx);
    return json(200, page, headers);
  }

  // contents
  const contentsMatch = /^contents\/(.+)$/.exec(rest);
  if (contentsMatch) {
    const filePath = decodeURIComponent(contentsMatch[1]!);
    if (method === 'GET') {
      const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = store.resolveCommitish(repo, refParam);
      if (tip === undefined) return err(404, 'Not Found');
      const blobs = store.treeBlobs(repo, tip);
      const entry = blobs.get(filePath);
      if (entry) {
        const blob = repo.objects.get(entry.oid);
        const content = blob ? blob.data.toString('base64') : '';
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: blob ? blob.data.length : 0,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content,
          sha: entry.oid,
        });
      }
      const children = store.treeChildren(repo, tip, filePath);
      if (children === null) return err(404, 'Not Found');
      return json(200, children.map((c) => ({
        type: c.type,
        name: c.name,
        path: c.path,
        sha: c.sha,
        ...(c.type === 'file' ? { size: c.size ?? 0 } : {}),
      })));
    }
    if (method === 'PUT') {
      const b = bodyRecord(body);
      const message = str(b.message, 'Update');
      const contentB64 = str(b.content);
      if (contentB64 === '') return err(422, 'Validation Failed: content is required');
      const data = Buffer.from(contentB64, 'base64');
      const branch = str(b.branch, repo.defaultBranch);
      let tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        // New branch: start from the default branch.
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      const flat = tip !== undefined ? store.treeBlobs(repo, tip) : new Map<string, { mode: string; oid: string }>();
      const existing = flat.get(filePath);
      const shaParam = str(b.sha);
      if (existing && shaParam === '') return err(409, 'Validation Failed: sha was not supplied');
      if (existing && shaParam !== '' && shaParam !== existing.oid) {
        return err(409, 'Validation Failed: sha does not match the current blob');
      }
      if (!existing && shaParam !== '') return err(422, 'Validation Failed: sha was supplied for a new file');
      const isUpdate = existing !== undefined;
      const blobOid = store.putObject(repo, 'blob', data);
      flat.set(filePath, { mode: '100644', oid: blobOid });
      const { commitOid } = store.commitFiles(repo, branch, message, flat);
      return json(isUpdate ? 200 : 201, {
        content: {
          type: 'file',
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: blobOid,
          size: data.length,
          encoding: 'base64',
          content: contentB64,
        },
        commit: {
          sha: commitOid,
          message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO },
        },
      });
    }
    if (method === 'DELETE') {
      const b = bodyRecord(body);
      const branch = str(b.branch, repo.defaultBranch);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      const flat = store.treeBlobs(repo, tip);
      const existing = flat.get(filePath);
      if (!existing) return err(404, 'Not Found');
      const shaParam = str(b.sha);
      if (shaParam !== '' && shaParam !== existing.oid) {
        return err(409, 'Validation Failed: sha does not match the current blob');
      }
      flat.delete(filePath);
      const { commitOid } = store.commitFiles(repo, branch, str(b.message, 'Delete'), flat);
      return json(200, {
        commit: {
          sha: commitOid,
          message: str(b.message, 'Delete'),
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO },
        },
      });
    }
    return err(404, 'Not Found');
  }

  // labels
  if (rest === 'labels') {
    if (method === 'GET') {
      return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    }
    if (method === 'POST') {
      const b = bodyRecord(body);
      const name = str(b.name);
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return err(422, 'Validation Failed: label already exists');
      const label = { name, color: str(b.color, 'ededed') };
      repo.labels.set(name, label);
      return json(201, { name: label.name, color: label.color });
    }
    return err(404, 'Not Found');
  }

  // issues
  if (rest === 'issues') {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, headers } = paginate(issues, ctx);
      return json(200, page.map((i) => issueView(store, repo, i)), headers);
    }
    if (method === 'POST') {
      const b = bodyRecord(body);
      const title = str(b.title);
      if (title === '') return err(422, 'Validation Failed: title is required');
      const labelNames = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
      const result = store.createIssue(repo, title, str(b.body), labelNames);
      if ('error' in result) return err(422, result.error);
      return json(201, issueView(store, repo, result.issue));
    }
    return err(404, 'Not Found');
  }

  const issueMatch = /^issues\/(\d+)(?:\/(.*))?$/.exec(rest);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    const sub = issueMatch[2] ?? '';
    const issue = repo.issues.get(number);
    if (sub === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') {
        const { page, headers } = paginate(issue.comments, ctx);
        return json(200, page.map((c) => ({
          id: c.id,
          body: c.body,
          user: userView(),
          created_at: c.created_at,
          updated_at: c.updated_at,
        })), headers);
      }
      if (method === 'POST') {
        const b = bodyRecord(body);
        const commentBody = str(b.body);
        if (commentBody === '') return err(422, 'Validation Failed: body is required');
        const comment = {
          id: store.nextCommentId,
          body: commentBody,
          created_at: TRIAL_NOW_ISO,
          updated_at: TRIAL_NOW_ISO,
        };
        store.nextCommentId += 1;
        issue.comments.push(comment);
        issue.updated_at = TRIAL_NOW_ISO;
        return json(201, { id: comment.id, body: comment.body, user: userView(), created_at: comment.created_at, updated_at: comment.updated_at });
      }
      return err(404, 'Not Found');
    }
    if (sub === '') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return json(200, issueView(store, repo, issue));
      if (method === 'PATCH') {
        const b = bodyRecord(body);
        if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        issue.updated_at = TRIAL_NOW_ISO;
        return json(200, issueView(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // pull requests
  if (rest === 'pulls') {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(pulls, ctx);
      return json(200, page.map((p) => pullView(store, repo, p)), headers);
    }
    if (method === 'POST') {
      const b = bodyRecord(body);
      const title = str(b.title);
      const head = str(b.head);
      const base = str(b.base, repo.defaultBranch);
      if (title === '' || head === '') return err(422, 'Validation Failed: title and head are required');
      const result = store.createPull(repo, title, str(b.body), head, base);
      if ('error' in result) return err(result.status ?? 422, result.error);
      return json(201, pullView(store, repo, result.pull));
    }
    return err(404, 'Not Found');
  }

  const pullMatch = /^pulls\/(\d+)(?:\/(.*))?$/.exec(rest);
  if (pullMatch) {
    const number = Number(pullMatch[1]);
    const sub = pullMatch[2] ?? '';
    const pull = repo.pulls.get(number);
    if (sub === 'files' && method === 'GET') {
      if (!pull) return err(404, 'Not Found');
      const files = store.prFiles(repo, pull);
      const { page, headers } = paginate(files, ctx);
      return json(200, page.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })), headers);
    }
    if (sub === 'merge' && method === 'PUT') {
      if (!pull) return err(404, 'Not Found');
      const result = store.mergePull(repo, pull);
      if ('error' in result) return err(result.status, result.error);
      return json(200, {
        merged: true,
        sha: result.sha,
        message: 'Pull request successfully merged',
      });
    }
    if (sub === '') {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') return json(200, pullView(store, repo, pull));
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return null;
}
