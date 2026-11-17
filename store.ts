// store.ts — the forge's in-memory state: git objects, refs, issues, pull requests.
// Everything is deterministic: no wall clock (TRIAL_NOW), no randomness, ids from
// counters in creation order, so a replay of the same requests yields the same state.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export const TRIAL_NOW_ISO: string = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00.000Z';
export const TRIAL_NOW_EPOCH: number = Math.floor(Date.parse(TRIAL_NOW_ISO) / 1000);

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface CommitParts {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

export function buildCommit(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.authorName} <${parts.authorEmail}> ${parts.authorTime} +0000`);
  lines.push(`committer ${parts.committerName} <${parts.committerEmail}> ${parts.committerTime} +0000`);
  lines.push('');
  let message = parts.message;
  if (!message.endsWith('\n')) message += '\n';
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const header = splitAt >= 0 ? text.slice(0, splitAt) : text;
  const message = splitAt >= 0 ? text.slice(splitAt + 2) : '';
  const out: ParsedCommit = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTime: 0,
    committerName: '',
    committerEmail: '',
    committerTime: 0,
    message,
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^author (.*) <(.*)> (\d+) ([+-]\d+)$/.exec(line);
      if (m) {
        out.authorName = m[1]!;
        out.authorEmail = m[2]!;
        out.authorTime = Number(m[3]);
      }
    } else if (line.startsWith('committer ')) {
      const m = /^committer (.*) <(.*)> (\d+) ([+-]\d+)$/.exec(line);
      if (m) {
        out.committerName = m[1]!;
        out.committerEmail = m[2]!;
        out.committerTime = Number(m[3]);
      }
    }
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return Buffer.compare(Buffer.from(ka, 'utf8'), Buffer.from(kb, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const header = splitAt >= 0 ? text.slice(0, splitAt) : text;
  const message = splitAt >= 0 ? text.slice(splitAt + 2) : '';
  const out = { object: '', type: '', tag: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  labels: Map<string, Label>;
  created_at: string;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(content: string): number {
  if (content === '') return 0;
  const parts = content.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function multisetDiff(aLines: string[], bLines: string[]): number {
  // lines in a not in b (multiset difference)
  const counts = new Map<string, number>();
  for (const line of bLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let diff = 0;
  for (const line of aLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else diff += 1;
  }
  return diff;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPrId = 1;
  requestSeq = 0;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = Store.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      labels: new Map(),
      created_at: TRIAL_NOW_ISO,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // -- git objects ---------------------------------------------------------

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, a full ref, or a commit oid to a commit oid. */
  resolveCommitish(repo: Repo, value: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(value)) {
      const obj = repo.objects.get(value);
      if (obj && obj.type === 'commit') return value;
      return undefined;
    }
    const ref = value.startsWith('refs/') ? value : `refs/heads/${value}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const tag = parseTag(obj.data);
      return tag.object;
    }
    return oid;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** Nearest common ancestor of a and b (minimises dist(a)+dist(b)), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const distA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, dist] = queueA.shift()!;
      if (distA.has(oid)) continue;
      distA.set(oid, dist);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueA.push([parent, dist + 1]);
    }
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const seenB = new Set<string>();
    const queueB: Array<[string, number]> = [[b, 0]];
    while (queueB.length > 0) {
      const [oid, dist] = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const da = distA.get(oid);
      if (da !== undefined && da + dist < bestScore) {
        bestScore = da + dist;
        best = oid;
      }
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  /** All objects reachable from tips (commits + their trees + blobs). The walk does not
   * descend past commits in stopAt: a shallow client's have is a boundary, not a history. */
  reachableObjects(repo: Repo, tips: string[], stopAt: Set<string> = new Set()): Set<string> {
    const out = new Set<string>();
    const commits = new Set<string>();
    const queue: string[] = [...tips];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (commits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      commits.add(oid);
      out.add(oid);
      if (!stopAt.has(oid)) {
        for (const parent of parseCommit(obj.data).parents) queue.push(parent);
      }
    }
    const addTree = (treeOid: string): void => {
      if (out.has(treeOid)) return;
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      out.add(treeOid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') addTree(entry.oid);
        else out.add(entry.oid);
      }
    };
    for (const oid of commits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      addTree(parseCommit(obj.data).tree);
    }
    return out;
  }

  /** All commits reachable from tips (map oid -> distance from the nearest tip). */
  reachableCommits(repo: Repo, tips: string[]): Map<string, number> {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = tips.map((tip) => [tip, 0] as [string, number]);
    for (let head = 0; head < queue.length; head += 1) {
      const [oid, d] = queue[head]!;
      if (dist.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      dist.set(oid, d);
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
    }
    return dist;
  }

  /** Flat path -> {mode, oid} map of the blobs in a commit's tree. */
  treeBlobs(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== 'commit') return out;
    const rootTree = parseCommit(commitObj.data).tree;
    const walk = (treeOid: string, prefix: string): void => {
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(rootTree, '');
    return out;
  }

  /** Direct children of a tree path: for contents directory listings. */
  treeChildren(repo: Repo, commitOid: string, dirPath: string): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size?: number }> | null {
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== 'commit') return null;
    let treeOid = parseCommit(commitObj.data).tree;
    if (dirPath !== '') {
      for (const segment of dirPath.split('/')) {
        const treeObj = repo.objects.get(treeOid);
        if (!treeObj || treeObj.type !== 'tree') return null;
        const entry = parseTree(treeObj.data).find((e) => e.name === segment && e.mode === '40000');
        if (!entry) return null;
        treeOid = entry.oid;
      }
    }
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const out: Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size?: number }> = [];
    for (const entry of parseTree(treeObj.data)) {
      const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      if (entry.mode === '40000') {
        out.push({ name: entry.name, path, type: 'dir', sha: entry.oid });
      } else {
        const blob = repo.objects.get(entry.oid);
        out.push({ name: entry.name, path, type: 'file', sha: entry.oid, size: blob ? blob.data.length : 0 });
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Build (and store) nested trees from a flat path -> {mode, oid} map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Map<string, Map<string, { mode: string; oid: string }>>();
      for (const [path, value] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = subdirs.get(dir);
          if (!sub) {
            sub = new Map();
            subdirs.set(dir, sub);
          }
          sub.set(path, value);
        }
      }
      for (const [dir] of subdirs) {
        const subOid = buildLevel(prefix === '' ? dir : `${prefix}/${dir}`);
        entries.push({ mode: '40000', name: dir, oid: subOid });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return buildLevel('');
  }

  /** Create a commit on a branch from a flat file map (contents API / merge). */
  commitFiles(repo: Repo, branch: string, message: string, flat: Map<string, { mode: string; oid: string }>): { commitOid: string; treeOid: string } {
    const treeOid = this.buildTreeFromMap(repo, flat);
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const parents = parent !== undefined ? [parent] : [];
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      authorName: VIEWER_NAME,
      authorEmail: VIEWER_EMAIL,
      authorTime: TRIAL_NOW_EPOCH,
      committerName: VIEWER_NAME,
      committerEmail: VIEWER_EMAIL,
      committerTime: TRIAL_NOW_EPOCH,
      message,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, treeOid };
  }

  // -- issues / pull requests ----------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): { issue: Issue } | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `Validation Failed: label '${name}' does not exist` };
      labels.push(label);
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: this.nextIssueId,
      number,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      created_at: TRIAL_NOW_ISO,
      updated_at: TRIAL_NOW_ISO,
    };
    this.nextIssueId += 1;
    repo.issues.set(number, issue);
    return { issue };
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): { pull: PullRequest } | { error: string; status: number } {
    const headSha = this.resolveCommitish(repo, head);
    if (headSha === undefined) return { error: `Invalid head '${head}'`, status: 422 };
    const baseSha = this.resolveCommitish(repo, base);
    if (baseSha === undefined) return { error: `Invalid base '${base}'`, status: 422 };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'Validation Failed: a pull request already exists for these branches', status: 422 };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRequest = {
      id: this.nextPrId,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      created_at: TRIAL_NOW_ISO,
      updated_at: TRIAL_NOW_ISO,
    };
    this.nextPrId += 1;
    repo.pulls.set(number, pull);
    return { pull };
  }

  /** Diff between the merge-base tree and the head tree, for files/conflict checks. */
  prDiff(repo: Repo, pull: PullRequest): { files: FileDiff[]; conflict: boolean; mergeBase: string | null } {
    const headTip = this.resolveCommitish(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveCommitish(repo, pull.baseRef) ?? pull.baseSha;
    const mergeBase = this.mergeBase(repo, headTip, baseTip);
    const headBlobs = this.treeBlobs(repo, headTip);
    const baseBlobs = this.treeBlobs(repo, baseTip);
    const mbBlobs = mergeBase !== null ? this.treeBlobs(repo, mergeBase) : new Map<string, { mode: string; oid: string }>();
    const files: FileDiff[] = [];
    let conflict = false;
    const paths = new Set<string>([...mbBlobs.keys(), ...headBlobs.keys()]);
    for (const path of [...paths].sort()) {
      const mb = mbBlobs.get(path);
      const h = headBlobs.get(path);
      if (mb === undefined && h === undefined) continue;
      if (mb !== undefined && h !== undefined && mb.oid === h.oid) continue;
      if (mb === undefined && h !== undefined) {
        // added on head
        const content = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const additions = countLines(content);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
        continue;
      }
      if (mb !== undefined && h === undefined) {
        // removed on head
        const content = repo.objects.get(mb.oid)?.data.toString('utf8') ?? '';
        const deletions = countLines(content);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
        continue;
      }
      // modified
      const oldContent = repo.objects.get(mb!.oid)?.data.toString('utf8') ?? '';
      const newContent = repo.objects.get(h!.oid)?.data.toString('utf8') ?? '';
      const additions = multisetDiff(newContent.split('\n'), oldContent.split('\n'));
      const deletions = multisetDiff(oldContent.split('\n'), newContent.split('\n'));
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      // conflict rule: base-tip blob differs from merge-base, and head differs from both
      const bt = baseBlobs.get(path);
      const btOid = bt === undefined ? null : bt.oid;
      if (btOid !== mb!.oid && h!.oid !== mb!.oid && h!.oid !== btOid) conflict = true;
    }
    // Files changed only on the base side (base-tip vs merge-base) do not appear in the
    // head diff, but a file the head changed while the base also changed is caught above.
    // Also: files in base-tip but not merge-base/head are not part of the PR diff.
    return { files, conflict, mergeBase };
  }

  /** The base-tip vs head-tip file list the REST pulls/{n}/files endpoint returns. */
  prFiles(repo: Repo, pull: PullRequest): FileDiff[] {
    const headTip = this.resolveCommitish(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveCommitish(repo, pull.baseRef) ?? pull.baseSha;
    const headBlobs = this.treeBlobs(repo, headTip);
    const baseBlobs = this.treeBlobs(repo, baseTip);
    const files: FileDiff[] = [];
    const paths = new Set<string>([...baseBlobs.keys(), ...headBlobs.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseBlobs.get(path);
      const h = headBlobs.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      if (b === undefined && h !== undefined) {
        const content = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const additions = countLines(content);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const content = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const deletions = countLines(content);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined) {
        const oldContent = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newContent = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const additions = multisetDiff(newContent.split('\n'), oldContent.split('\n'));
        const deletions = multisetDiff(oldContent.split('\n'), newContent.split('\n'));
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  mergePull(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
    if (pull.merged || pull.state !== 'open') return { error: 'Pull request already merged', status: 405 };
    const { conflict } = this.prDiff(repo, pull);
    if (conflict) return { error: 'Merge conflict', status: 405 };
    const headTip = this.resolveCommitish(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveCommitish(repo, pull.baseRef) ?? pull.baseSha;
    const headCommit = repo.objects.get(headTip);
    if (!headCommit || headCommit.type !== 'commit') return { error: 'Head commit not found', status: 422 };
    const headTree = parseCommit(headCommit.data).tree;
    const commitData = buildCommit({
      tree: headTree,
      parents: [baseTip],
      authorName: VIEWER_NAME,
      authorEmail: VIEWER_EMAIL,
      authorTime: TRIAL_NOW_EPOCH,
      committerName: VIEWER_NAME,
      committerEmail: VIEWER_EMAIL,
      committerTime: TRIAL_NOW_EPOCH,
      message: pull.title,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = TRIAL_NOW_ISO;
    pull.merge_commit_sha = sha;
    pull.updated_at = TRIAL_NOW_ISO;
    return { sha };
  }

  // -- global ids (opaque, stable, decodable) -------------------------------

  globalId(type: string, key: string): string {
    return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
  }

  parseGlobalId(id: string): { type: string; key: string } | null {
    try {
      const decoded = Buffer.from(id, 'base64url').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) return null;
      return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
    } catch {
      return null;
    }
  }

  repoGlobalId(repo: Repo): string {
    return this.globalId('Repository', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return this.globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return this.globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
  }

  findByGlobalId(id: string): { repo: Repo; issue?: Issue; pull?: PullRequest } | null {
    const parsed = this.parseGlobalId(id);
    if (!parsed) return null;
    if (parsed.type === 'Repository') {
      const repo = this.repos.get(parsed.key);
      return repo ? { repo } : null;
    }
    const hashAt = parsed.key.indexOf('#');
    if (hashAt < 0) return null;
    const repo = this.repos.get(parsed.key.slice(0, hashAt));
    if (!repo) return null;
    const rest = parsed.key.slice(hashAt + 1);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(Number(rest));
      return issue ? { repo, issue } : null;
    }
    if (parsed.type === 'PullRequest') {
      const pull = repo.pulls.get(Number(rest));
      return pull ? { repo, pull } : null;
    }
    if (parsed.type === 'IssueComment') {
      const colon = rest.indexOf(':');
      if (colon < 0) return null;
      const issue = repo.issues.get(Number(rest.slice(0, colon)));
      return issue ? { repo, issue } : null;
    }
    return null;
  }
}
