// graphql.ts — a small GraphQL parser + executor for the v4 surface the suite uses:
// viewer, repository (+issues/pullRequests connections, __type introspection),
// node(id:), and the five mutations. No dependencies, deterministic.

import {
  Store,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  TRIAL_NOW_ISO,
  type Repo,
  type Issue,
  type PullRequest,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && j + 5 < input.length) {
            value += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  opType: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, ValueNode | null>;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const tok = this.tokens[this.pos]!;
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
  }

  private skipPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        doc.operations.push({ opType: 'query', name: null, variables: new Map(), selection: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        doc.operations.push(this.parseOperation());
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const nameTok = this.next();
        const onTok = this.next();
        if (onTok.value !== 'on') throw new Error('expected on in fragment');
        const typeTok = this.next();
        const selection = this.parseSelectionSet();
        doc.fragments.set(nameTok.value, { typeCondition: typeTok.value, selection });
      } else {
        throw new Error(`unexpected token ${tok.value} in document`);
      }
    }
    return doc;
  }

  private parseOperation(): OperationNode {
    const opTok = this.next();
    const opType = opTok.value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = new Map<string, ValueNode | null>();
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        this.expectPunct('$');
        const varName = this.next().value;
        this.expectPunct(':');
        this.skipType();
        let defaultValue: ValueNode | null = null;
        if (this.skipPunct('=')) defaultValue = this.parseValue();
        variables.set(varName, defaultValue);
      }
    }
    const selection = this.parseSelectionSet();
    return { opType, name, variables, selection };
  }

  private skipType(): void {
    // Type: Name | '[' Type ']' | Type '!'
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'name') this.next();
      else if (tok.kind === 'punct' && (tok.value === '[' || tok.value === ']' || tok.value === '!')) this.next();
      else break;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const tok = this.peek();
      if (tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeTok = this.next();
        return { kind: 'inline', typeCondition: typeTok.value, selection: this.parseSelectionSet() };
      }
      if (tok.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const nameTok = this.next();
    let alias: string | null = null;
    let name = nameTok.value;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives: skip @name(args)
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.next();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.value) };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.value}`);
  }
}

// ---------------------------------------------------------------------------
// Values and object wrappers
// ---------------------------------------------------------------------------

type PlainValue = string | number | boolean | null | PlainValue[] | { [key: string]: PlainValue };

interface Wrapped {
  __typename: string;
  [key: string]: unknown;
}

function wrap(typename: string, fields: Record<string, unknown>): Wrapped {
  return { __typename: typename, ...fields };
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'databaseId', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'prefix', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

class Executor {
  private store: Store;
  private variables: Record<string, unknown>;
  private doc: DocumentNode;
  private errors: Array<{ message: string }> = [];

  constructor(store: Store, doc: DocumentNode, variables: Record<string, unknown>) {
    this.store = store;
    this.doc = doc;
    this.variables = variables;
  }

  run(operationName: string | null): GraphQLResult {
    const op = operationName !== null
      ? this.doc.operations.find((o) => o.name === operationName) ?? this.doc.operations[0]
      : this.doc.operations[0];
    if (!op) return { data: null, errors: [{ message: 'No operation provided' }] };
    const rootType = op.opType === 'mutation' ? 'Mutation' : 'Query';
    const root: Wrapped = wrap(rootType, {});
    const data = this.executeSelection(root, op.selection);
    const result: GraphQLResult = { data: data as Record<string, unknown> };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private executeSelection(obj: Wrapped, selections: SelectionNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition !== null && selection.typeCondition !== obj.__typename) continue;
        Object.assign(out, this.executeSelection(obj, selection.selection));
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = this.doc.fragments.get(selection.name);
        if (!fragment) continue;
        if (fragment.typeCondition !== obj.__typename) continue;
        Object.assign(out, this.executeSelection(obj, fragment.selection));
        continue;
      }
      const responseKey = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[responseKey] = obj.__typename;
        continue;
      }
      const allowed = SCHEMA_FIELDS[obj.__typename];
      if (allowed !== undefined && !allowed.includes(selection.name)) {
        this.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj.__typename}".` });
        out[responseKey] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of selection.args) args[arg.name] = evalValue(arg.value, this.variables);
      let value: unknown;
      try {
        value = this.resolveField(obj, selection.name, args);
      } catch (e) {
        this.errors.push({ message: e instanceof Error ? e.message : String(e) });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = this.completeValue(value, selection.selection);
    }
    return out;
  }

  private completeValue(value: unknown, selection: SelectionNode[] | null): unknown {
    if (value === null || value === undefined) return null;
    if (selection === null) {
      if (typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>)) {
        return null;
      }
      return value as PlainValue;
    }
    if (Array.isArray(value)) return value.map((item) => this.completeValue(item, selection));
    if (typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>)) {
      return this.executeSelection(value as Wrapped, selection);
    }
    return value as PlainValue;
  }

  private viewerUser(): Wrapped {
    return wrap('User', {
      login: VIEWER_LOGIN,
      id: this.store.globalId('User', VIEWER_LOGIN),
      databaseId: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
    });
  }

  private repoWrap(repo: Repo): Wrapped {
    return wrap('Repository', { repo });
  }

  private issueWrap(repo: Repo, issue: Issue): Wrapped {
    return wrap('Issue', { repo, issue });
  }

  private pullWrap(repo: Repo, pull: PullRequest): Wrapped {
    return wrap('PullRequest', { repo, pull });
  }

  private cursorFor(kind: string, number: number): string {
    return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64url');
  }

  private cursorNumber(cursor: unknown): number | null {
    if (typeof cursor !== 'string' || cursor === '') return null;
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const n = Number(decoded.split(':')[1]);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? undefined;
    const direction = orderBy !== undefined && orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
    let issues = [...repo.issues.values()];
    if (states !== null) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      issues = issues.filter((i) => wanted.has(i.state));
    }
    issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    const after = this.cursorNumber(args.after);
    if (after !== null) {
      issues = issues.filter((i) => (direction === 'ASC' ? i.number > after : i.number < after));
    }
    const total = issues.length;
    const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
    const nodes = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = nodes.length > 0 ? this.cursorFor('issue', nodes[nodes.length - 1]!.number) : null;
    const startCursor = nodes.length > 0 ? this.cursorFor('issue', nodes[0]!.number) : null;
    return wrap('IssueConnection', {
      nodes: nodes.map((i) => this.issueWrap(repo, i)),
      edges: nodes.map((i) => wrap('IssueEdge', { node: this.issueWrap(repo, i), cursor: this.cursorFor('issue', i.number) })),
      pageInfo: wrap('PageInfo', { hasNextPage, hasPreviousPage: after !== null, startCursor, endCursor }),
      totalCount: total,
    });
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    let pulls = [...repo.pulls.values()];
    if (states !== null) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      pulls = pulls.filter((p) => wanted.has(p.state));
    } else {
      pulls = pulls.filter((p) => p.state === 'open');
    }
    pulls.sort((a, b) => b.number - a.number);
    const after = this.cursorNumber(args.after);
    if (after !== null) pulls = pulls.filter((p) => p.number < after);
    const total = pulls.length;
    const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
    const nodes = pulls.slice(0, first);
    const hasNextPage = pulls.length > first;
    const endCursor = nodes.length > 0 ? this.cursorFor('pr', nodes[nodes.length - 1]!.number) : null;
    const startCursor = nodes.length > 0 ? this.cursorFor('pr', nodes[0]!.number) : null;
    return wrap('PullRequestConnection', {
      nodes: nodes.map((p) => this.pullWrap(repo, p)),
      edges: nodes.map((p) => wrap('PullRequestEdge', { node: this.pullWrap(repo, p), cursor: this.cursorFor('pr', p.number) })),
      pageInfo: wrap('PageInfo', { hasNextPage, hasPreviousPage: after !== null, startCursor, endCursor }),
      totalCount: total,
    });
  }

  private resolveField(obj: Wrapped, field: string, args: Record<string, unknown>): unknown {
    const store = this.store;
    switch (obj.__typename) {
      case 'Query': {
        if (field === 'viewer') return this.viewerUser();
        if (field === 'repository') {
          const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          if (!repo || repo.owner !== VIEWER_LOGIN) return null;
          return this.repoWrap(repo);
        }
        if (field === 'node') {
          const found = store.findByGlobalId(String(args.id ?? ''));
          if (!found) return null;
          if (found.issue) return this.issueWrap(found.repo, found.issue);
          if (found.pull) return this.pullWrap(found.repo, found.pull);
          return this.repoWrap(found.repo);
        }
        if (field === '__type') {
          const name = String(args.name ?? '');
          if (INTROSPECTION_FIELDS[name] !== undefined) {
            return wrap('__Type', {
              name,
              kind: 'OBJECT',
              fields: INTROSPECTION_FIELDS[name]!.map((n) => wrap('__Field', { name: n })),
              enumValues: null,
            });
          }
          if (INTROSPECTION_ENUMS[name] !== undefined) {
            return wrap('__Type', {
              name,
              kind: 'ENUM',
              fields: null,
              enumValues: INTROSPECTION_ENUMS[name]!.map((n) => wrap('__EnumValue', { name: n })),
            });
          }
          return null;
        }
        if (field === '__schema') {
          return wrap('__Schema', { types: [], queryType: null, mutationType: null });
        }
        return null;
      }
      case 'Mutation': {
        if (field === 'createIssue') {
          const input = (args.input as Record<string, unknown>) ?? {};
          const found = store.findByGlobalId(String(input.repositoryId ?? ''));
          if (!found) throw new Error('Repository not found');
          const result = store.createIssue(found.repo, String(input.title ?? ''), String(input.body ?? ''), []);
          if ('error' in result) throw new Error(result.error);
          return wrap('CreateIssuePayload', { issue: this.issueWrap(found.repo, result.issue) });
        }
        if (field === 'closeIssue') {
          const input = (args.input as Record<string, unknown>) ?? {};
          const found = store.findByGlobalId(String(input.issueId ?? ''));
          if (!found || !found.issue) throw new Error('Issue not found');
          found.issue.state = 'closed';
          found.issue.updated_at = TRIAL_NOW_ISO;
          return wrap('CloseIssuePayload', { issue: this.issueWrap(found.repo, found.issue) });
        }
        if (field === 'createPullRequest') {
          const input = (args.input as Record<string, unknown>) ?? {};
          const found = store.findByGlobalId(String(input.repositoryId ?? ''));
          if (!found) throw new Error('Repository not found');
          const result = store.createPull(
            found.repo,
            String(input.title ?? ''),
            String(input.body ?? ''),
            String(input.headRefName ?? ''),
            String(input.baseRefName ?? ''),
          );
          if ('error' in result) throw new Error(result.error);
          return wrap('CreatePullRequestPayload', { pullRequest: this.pullWrap(found.repo, result.pull) });
        }
        if (field === 'mergePullRequest') {
          const input = (args.input as Record<string, unknown>) ?? {};
          const found = store.findByGlobalId(String(input.pullRequestId ?? ''));
          if (!found || !found.pull) throw new Error('Pull request not found');
          const result = store.mergePull(found.repo, found.pull);
          if ('error' in result) throw new Error(result.error);
          return wrap('MergePullRequestPayload', { pullRequest: this.pullWrap(found.repo, found.pull) });
        }
        if (field === 'addComment') {
          const input = (args.input as Record<string, unknown>) ?? {};
          const found = store.findByGlobalId(String(input.subjectId ?? ''));
          if (!found || !found.issue) throw new Error('Subject not found');
          const comment = {
            id: store.nextCommentId,
            body: String(input.body ?? ''),
            created_at: TRIAL_NOW_ISO,
            updated_at: TRIAL_NOW_ISO,
          };
          store.nextCommentId += 1;
          found.issue.comments.push(comment);
          found.issue.updated_at = TRIAL_NOW_ISO;
          const node = wrap('IssueComment', { repo: found.repo, issue: found.issue, comment });
          return wrap('AddCommentPayload', {
            commentEdge: wrap('CommentEdge', { node, cursor: this.cursorFor('comment', comment.id) }),
            comment: node,
          });
        }
        return null;
      }
      case 'User': {
        if (field === 'login') return obj.login as string;
        if (field === 'id') return obj.id as string;
        if (field === 'databaseId') return obj.databaseId as number;
        if (field === 'name') return obj.name as string;
        if (field === 'email') return obj.email as string;
        return null;
      }
      case 'Repository': {
        const repo = obj.repo as Repo;
        if (field === 'id') return store.repoGlobalId(repo);
        if (field === 'databaseId') return repo.id;
        if (field === 'name') return repo.name;
        if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
        if (field === 'owner') return this.viewerUser();
        if (field === 'defaultBranchRef') {
          return repo.refs.has('refs/heads/main') ? wrap('Ref', { name: 'main' }) : null;
        }
        if (field === 'viewerPermission') return 'ADMIN';
        if (field === 'hasIssuesEnabled') return true;
        if (field === 'description') return repo.description;
        if (field === 'private') return repo.private;
        if (field === 'createdAt') return repo.created_at;
        if (field === 'updatedAt') return TRIAL_NOW_ISO;
        if (field === 'issue') {
          const issue = repo.issues.get(Number(args.number));
          return issue ? this.issueWrap(repo, issue) : null;
        }
        if (field === 'issues') return this.issueConnection(repo, args);
        if (field === 'pullRequest') {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? this.pullWrap(repo, pull) : null;
        }
        if (field === 'pullRequests') return this.pullConnection(repo, args);
        return null;
      }
      case 'Ref': {
        if (field === 'name') return obj.name as string;
        return null;
      }
      case 'Issue': {
        const repo = obj.repo as Repo;
        const issue = obj.issue as Issue;
        if (field === 'id') return store.issueGlobalId(repo, issue);
        if (field === 'number') return issue.number;
        if (field === 'title') return issue.title;
        if (field === 'body') return issue.body;
        if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        if (field === 'createdAt') return issue.created_at;
        if (field === 'updatedAt') return issue.updated_at;
        if (field === 'author') return this.viewerUser();
        if (field === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        if (field === 'labels') {
          return wrap('LabelConnection', {
            nodes: issue.labels.map((l) => wrap('Label', { name: l.name, color: l.color })),
            edges: [],
            pageInfo: wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
            totalCount: issue.labels.length,
          });
        }
        if (field === 'comments') {
          return wrap('IssueConnection', {
            nodes: issue.comments.map((c) => wrap('IssueComment', { repo, issue, comment: c })),
            edges: [],
            pageInfo: wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
            totalCount: issue.comments.length,
          });
        }
        if (field === 'repository') return this.repoWrap(repo);
        return null;
      }
      case 'PullRequest': {
        const repo = obj.repo as Repo;
        const pull = obj.pull as PullRequest;
        if (field === 'id') return store.pullGlobalId(repo, pull);
        if (field === 'number') return pull.number;
        if (field === 'title') return pull.title;
        if (field === 'body') return pull.body;
        if (field === 'state') return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        if (field === 'merged') return pull.merged;
        if (field === 'mergeable') {
          if (pull.state !== 'open') return 'UNKNOWN';
          const { conflict, mergeBase } = store.prDiff(repo, pull);
          if (mergeBase === null) return 'UNKNOWN';
          return conflict ? 'CONFLICTING' : 'MERGEABLE';
        }
        if (field === 'headRefName') return pull.headRef;
        if (field === 'baseRefName') return pull.baseRef;
        if (field === 'headRefOid') return store.resolveCommitish(repo, pull.headRef) ?? pull.headSha;
        if (field === 'baseRefOid') return store.resolveCommitish(repo, pull.baseRef) ?? pull.baseSha;
        if (field === 'createdAt') return pull.created_at;
        if (field === 'updatedAt') return pull.updated_at;
        if (field === 'mergedAt') return pull.merged_at;
        if (field === 'author') return this.viewerUser();
        if (field === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        if (field === 'files') {
          const files = store.prFiles(repo, pull);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
          const nodes = files.slice(0, first);
          return wrap('PullRequestFileConnection', {
            nodes: nodes.map((f) => wrap('PullRequestFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status })),
            edges: nodes.map((f) => wrap('PullRequestFileEdge', { node: wrap('PullRequestFile', { path: f.filename }), cursor: this.cursorFor('file', 0) })),
            pageInfo: wrap('PageInfo', { hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }),
            totalCount: files.length,
          });
        }
        return null;
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestFileConnection':
      case 'LabelConnection': {
        if (field === 'nodes') return obj.nodes as unknown[];
        if (field === 'edges') return obj.edges as unknown[];
        if (field === 'pageInfo') return obj.pageInfo as Wrapped;
        if (field === 'totalCount') return obj.totalCount as number;
        return null;
      }
      case 'IssueEdge':
      case 'PullRequestEdge':
      case 'PullRequestFileEdge':
      case 'CommentEdge': {
        if (field === 'node') return obj.node as Wrapped;
        if (field === 'cursor') return obj.cursor as string;
        return null;
      }
      case 'PageInfo': {
        if (field === 'hasNextPage') return obj.hasNextPage as boolean;
        if (field === 'hasPreviousPage') return obj.hasPreviousPage as boolean;
        if (field === 'startCursor') return obj.startCursor as string | null;
        if (field === 'endCursor') return obj.endCursor as string | null;
        return null;
      }
      case 'IssueComment': {
        const comment = obj.comment as { id: number; body: string; created_at: string; updated_at: string };
        if (field === 'id') {
          const repo = obj.repo as Repo;
          const issue = obj.issue as Issue;
          return store.commentGlobalId(repo, issue, comment);
        }
        if (field === 'body') return comment.body;
        if (field === 'author') return this.viewerUser();
        if (field === 'createdAt') return comment.created_at;
        if (field === 'updated_at' || field === 'updatedAt') return comment.updated_at;
        return null;
      }
      case 'Label': {
        if (field === 'name') return obj.name as string;
        if (field === 'color') return obj.color as string;
        if (field === 'id') return store.globalId('Label', String(obj.name ?? ''));
        return null;
      }
      case 'PullRequestFile': {
        if (field === 'path') return obj.path as string;
        if (field === 'additions') return obj.additions as number;
        if (field === 'deletions') return obj.deletions as number;
        if (field === 'changeType') return obj.changeType as string;
        return null;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field === 'issue') return obj.issue as Wrapped;
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field === 'pullRequest') return obj.pullRequest as Wrapped;
        return null;
      }
      case 'AddCommentPayload': {
        if (field === 'commentEdge') return obj.commentEdge as Wrapped;
        if (field === 'comment') return obj.comment as Wrapped;
        return null;
      }
      case '__Type': {
        if (field === 'name') return obj.name as string;
        if (field === 'kind') return obj.kind as string;
        if (field === 'fields') return obj.fields as Wrapped[] | null;
        if (field === 'enumValues') return obj.enumValues as Wrapped[] | null;
        return null;
      }
      case '__Field': {
        if (field === 'name') return obj.name as string;
        return null;
      }
      case '__EnumValue': {
        if (field === 'name') return obj.name as string;
        return null;
      }
      case '__Schema': {
        if (field === 'types') return [];
        if (field === 'queryType') return null;
        if (field === 'mutationType') return null;
        return null;
      }
      default:
        return null;
    }
  }
}

/** Execute one GraphQL request body (object or batch array). */
export function executeGraphQL(store: Store, body: unknown): Record<string, unknown> | Array<Record<string, unknown>> {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    const variables = (record.variables as Record<string, unknown> | undefined) ?? {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let doc: DocumentNode;
    try {
      doc = new Parser(query).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax Error' }] };
    }
    return new Executor(store, doc, variables).run(operationName);
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}
