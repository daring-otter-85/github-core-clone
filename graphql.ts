// graphql.ts — a small GraphQL executor for the forge's v4 surface: the fixed document shapes
// gh and github-mcp-server send (viewer, repository, issues/pulls connections, the five mutations,
// node(id:), batched operations and __type introspection), executed against the same store as REST.
// Global ids are opaque, stable base64 encodings of the object's kind and keys.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER, type RepoRec, type IssueRec, type PullRec, diffCommits, squashMerge, pullMergeable } from './store.ts';

// ---------------------------------------------------------------- ids

export function encodeId(kind: string, ...keys: (string | number)[]): string {
  return Buffer.from([kind, ...keys].join(':'), 'utf8').toString('base64');
}

export function decodeId(id: string): { kind: string; keys: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...keys] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, keys };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      if (source[j] === '.') {
        isFloat = true;
        j++;
        while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j++;
        if (source[j] === '+' || source[j] === '-') j++;
        while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      }
      if (source[i] === '-') {
        // the leading '-' was not consumed above; re-walk including it
        j = i + 1;
        while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  directives: { name: string; args: { name: string; value: ValueNode }[] }[];
  selectionSet?: SelectionNode[];
}
type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  fragments = new Map<string, SelectionNode[]>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const word = this.expectName();
      if (word === 'query' || word === 'mutation' || word === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(varName, this.parseValue());
            this.parseDirectives();
          }
        }
        this.parseDirectives();
        operations.push({
          operation: word === 'mutation' ? 'mutation' : 'query',
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (word === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName(); // type condition
        this.parseDirectives();
        this.fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition "${word}"`);
    }
    return operations;
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): { name: string; args: { name: string; value: ValueNode }[] }[] {
    const directives: { name: string; args: { name: string; value: ValueNode }[] }[] = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      const args: { name: string; value: ValueNode }[] = [];
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value token');
  }
}

// ---------------------------------------------------------------- schema tables

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url',
    'description', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'repository', 'url', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'repository', 'mergedAt', 'url', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  Edge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'REBASE', 'SQUASH'],
  FileStatus: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------- wrappers

type Wrap = { kind: string } & Record<string, unknown>;

const repoWrap = (repo: RepoRec): Wrap => ({ kind: 'Repository', repo });
const issueWrap = (repo: RepoRec, issue: IssueRec): Wrap => ({ kind: 'Issue', repo, issue });
const pullWrap = (repo: RepoRec, pull: PullRec): Wrap => ({ kind: 'PullRequest', repo, pull });
const userWrap = (login: string): Wrap => ({ kind: 'User', login });

function idOf(wrap: Wrap): string {
  switch (wrap.kind) {
    case 'Repository':
      return encodeId('Repository', (wrap.repo as RepoRec).dbId);
    case 'Issue':
      return encodeId('Issue', (wrap.repo as RepoRec).dbId, (wrap.issue as IssueRec).number);
    case 'PullRequest':
      return encodeId('PullRequest', (wrap.repo as RepoRec).dbId, (wrap.pull as PullRec).number);
    case 'IssueComment':
      return encodeId('IssueComment', (wrap.repo as RepoRec).dbId, (wrap.issue as IssueRec).number, (wrap.comment as { id: number }).id);
    case 'User':
      return encodeId('User', wrap.login === VIEWER.login ? VIEWER.id : 0);
    default:
      return encodeId(wrap.kind, 0);
  }
}

function cursorOf(key: string | number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function keyFromCursor(cursor: string): string | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    return text.startsWith('cursor:') ? text.slice('cursor:'.length) : null;
  } catch {
    return null;
  }
}

interface Connection {
  kind: string;
  nodes: Wrap[];
  pageInfo: Wrap;
  total: number;
  edges: Wrap[];
}

function makeConnection(kind: string, items: Wrap[], keyOf: (item: Wrap) => string, args: Record<string, unknown>): Connection {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const key = keyFromCursor(args.after);
    const index = key === null ? -1 : items.findIndex((item) => keyOf(item) === key);
    if (index >= 0) start = index + 1;
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  const pageInfo: Wrap = {
    kind: 'PageInfo',
    hasNextPage,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? cursorOf(keyOf(page[0]!)) : null,
    endCursor: page.length > 0 ? cursorOf(keyOf(page[page.length - 1]!)) : null,
  };
  return {
    kind,
    nodes: page,
    pageInfo,
    total: items.length,
    edges: page.map((node) => ({ kind: 'Edge', node, cursor: cursorOf(keyOf(node)) })),
  };
}

// ---------------------------------------------------------------- execution

const UNKNOWN_FIELD = Symbol('unknown-field');

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

function valueOf(ctx: Ctx, node: ValueNode): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const fallback = ctx.defaults.get(node.name);
      return fallback === undefined ? null : valueOf(ctx, fallback);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(ctx, value));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(ctx, field.value);
      return out;
    }
  }
}

function argsOf(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(ctx, arg.value);
  return out;
}

function findRepoByDbId(forge: Forge, dbId: number): RepoRec | undefined {
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return undefined;
}

function resolveNode(ctx: Ctx, id: string): Wrap | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = findRepoByDbId(ctx.forge, Number(decoded.keys[0]));
    return repo === undefined ? null : repoWrap(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = findRepoByDbId(ctx.forge, Number(decoded.keys[0]));
    if (repo === undefined) return null;
    const number = Number(decoded.keys[1]);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueWrap(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullWrap(repo, pull);
  }
  if (decoded.kind === 'User') return userWrap(VIEWER.login);
  return null;
}

function typeObject(name: string): Wrap | null {
  if (name in OBJECT_FIELDS) {
    return {
      kind: '__Type',
      name,
      typeKind: 'OBJECT',
      fieldsList: OBJECT_FIELDS[name]!.map((fieldName) => ({ kind: '__Field', name: fieldName })),
      enumValuesList: null,
    };
  }
  if (name in ENUM_VALUES) {
    return {
      kind: '__Type',
      name,
      typeKind: 'ENUM',
      fieldsList: null,
      enumValuesList: ENUM_VALUES[name]!.map((valueName) => ({ kind: '__EnumValue', name: valueName })),
    };
  }
  return null;
}

function resolveField(ctx: Ctx, typeName: string, source: unknown, fieldName: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  if (typeName === 'Query') {
    switch (fieldName) {
      case 'viewer':
        return userWrap(VIEWER.login);
      case 'user':
      case 'organization':
        return args.login === VIEWER.login || fieldName === 'user' ? userWrap(VIEWER.login) : null;
      case 'repository': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoWrap(repo);
      }
      case 'node':
        return typeof args.id === 'string' ? resolveNode(ctx, args.id) : null;
      case 'search':
        return { kind: 'SearchResultItemConnection', nodes: [], pageInfo: { kind: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, total: 0, edges: [] };
      case '__type':
        return typeof args.name === 'string' ? typeObject(args.name) : null;
      case '__schema':
        return {
          kind: '__Schema',
          queryType: typeObject('Query'),
          mutationType: typeObject('Mutation'),
          types: [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => typeObject(name)),
        };
      default:
        return UNKNOWN_FIELD;
    }
  }
  if (typeName === 'Mutation') return resolveMutation(ctx, fieldName, args);
  if (typeof source !== 'object' || source === null) return UNKNOWN_FIELD;
  const wrap = source as Wrap;

  if (typeName === 'User') {
    switch (fieldName) {
      case 'login':
        return wrap.login;
      case 'id':
        return idOf(wrap);
      case 'databaseId':
        return wrap.login === VIEWER.login ? VIEWER.id : 0;
      case 'name':
        return wrap.login === VIEWER.login ? VIEWER.name : wrap.login;
      case 'email':
        return wrap.login === VIEWER.login ? VIEWER.email : '';
      case 'url':
        return `/${String(wrap.login)}`;
      default:
        return UNKNOWN_FIELD;
    }
  }
  if (typeName === 'Repository') {
    const repo = wrap.repo as RepoRec;
    switch (fieldName) {
      case 'id':
        return idOf(wrap);
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return userWrap(repo.owner);
      case 'defaultBranchRef': {
        const branch = repo.defaultBranch;
        return forge.branchTip(repo, branch) === null ? null : { kind: 'Ref', name: branch, prefix: 'refs/heads/' };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'isPrivate':
        return repo.isPrivate;
      case 'description':
        return repo.description;
      case 'url':
        return `/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
        return forge.isoOf(1735689600 + repo.dbId * 60);
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueWrap(repo, issue);
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        if (Array.isArray(args.states)) {
          const states = args.states as string[];
          list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const direction = (args.orderBy as { direction?: string } | undefined)?.direction ?? 'DESC';
        list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        return makeConnection('IssueConnection', list.map((issue) => issueWrap(repo, issue)), (item) => String((item.issue as IssueRec).number), args);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullWrap(repo, pull);
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
        list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
        list.sort((a, b) => b.seq - a.seq);
        return makeConnection('PullRequestConnection', list.map((pull) => pullWrap(repo, pull)), (item) => String((item.pull as PullRec).number), args);
      }
      default:
        return UNKNOWN_FIELD;
    }
  }
  if (typeName === 'Issue') {
    const issue = wrap.issue as IssueRec;
    const repo = wrap.repo as RepoRec;
    switch (fieldName) {
      case 'id':
        return idOf(wrap);
      case 'databaseId':
        return issue.dbId;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'author':
        return userWrap(VIEWER.login);
      case 'repository':
        return repoWrap(repo);
      case 'url':
        return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt':
      case 'updatedAt':
        return forge.isoOf(1735689600 + issue.seq * 60);
      default:
        return UNKNOWN_FIELD;
    }
  }
  if (typeName === 'PullRequest') {
    const pull = wrap.pull as PullRec;
    const repo = wrap.repo as RepoRec;
    switch (fieldName) {
      case 'id':
        return idOf(wrap);
      case 'databaseId':
        return pull.dbId;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeable':
        return pull.state === 'open' ? pullMergeable(repo, pull) : 'UNKNOWN';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef':
        return forge.branchTip(repo, pull.headRef) === null ? null : { kind: 'Ref', name: pull.headRef, prefix: 'refs/heads/' };
      case 'baseRef':
        return forge.branchTip(repo, pull.baseRef) === null ? null : { kind: 'Ref', name: pull.baseRef, prefix: 'refs/heads/' };
      case 'author':
        return userWrap(VIEWER.login);
      case 'repository':
        return repoWrap(repo);
      case 'url':
        return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt':
      case 'updatedAt':
        return forge.isoOf(1735689600 + pull.seq * 60);
      case 'files': {
        const baseTip = forge.branchTip(repo, pull.baseRef);
        const headTip = forge.branchTip(repo, pull.headRef);
        const changes = baseTip === null || headTip === null ? [] : diffCommits(repo, baseTip, headTip);
        const items: Wrap[] = changes.map((change) => ({
          kind: 'PullRequestChangedFile',
          path: change.filename,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
        return makeConnection('PullRequestChangedFileConnection', items, (item) => String(item.path), args);
      }
      default:
        return UNKNOWN_FIELD;
    }
  }
  if (typeName === 'IssueComment') {
    const comment = wrap.comment as { id: number; body: string };
    switch (fieldName) {
      case 'id':
        return idOf(wrap);
      case 'databaseId':
        return comment.id;
      case 'body':
        return comment.body;
      case 'author':
        return userWrap(VIEWER.login);
      case 'createdAt':
        return forge.isoOf(1735689600 + comment.id * 60);
      default:
        return UNKNOWN_FIELD;
    }
  }
  // Plain property types: payloads, connections, page info, introspection objects, refs, comments.
  if (wrap.kind === '__Type') {
    if (fieldName === 'name') return wrap.name;
    if (fieldName === 'kind') return wrap.typeKind;
    if (fieldName === 'fields') return wrap.fieldsList;
    if (fieldName === 'enumValues') return wrap.enumValuesList;
    if (fieldName === 'description') return null;
    return UNKNOWN_FIELD;
  }
  if (wrap.kind === '__Field' || wrap.kind === '__EnumValue') {
    if (fieldName === 'name') return wrap.name;
    if (fieldName === 'isDeprecated') return false;
    if (fieldName === 'deprecationReason') return null;
    if (fieldName === 'description') return null;
    return UNKNOWN_FIELD;
  }
  if (wrap.kind === '__Schema') {
    if (fieldName === 'queryType' || fieldName === 'mutationType' || fieldName === 'types') return wrap[fieldName];
    return UNKNOWN_FIELD;
  }
  if (fieldName in wrap) return wrap[fieldName];
  return UNKNOWN_FIELD;
}

function resolveMutation(ctx: Ctx, fieldName: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (fieldName) {
    case 'createIssue': {
      const decoded = typeof input.repositoryId === 'string' ? decodeId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoByDbId(forge, Number(decoded.keys[0])) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return { kind: 'CreateIssuePayload', issue: null, clientMutationId };
      }
      const issue = forge.addIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { kind: 'CreateIssuePayload', issue: issueWrap(repo, issue), clientMutationId };
    }
    case 'closeIssue': {
      const node = typeof input.issueId === 'string' ? resolveNode(ctx, input.issueId) : null;
      if (node === null || node.kind !== 'Issue') {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return { kind: 'CloseIssuePayload', issue: null, clientMutationId };
      }
      const issue = node.issue as IssueRec;
      issue.state = 'closed';
      return { kind: 'CloseIssuePayload', issue: node, clientMutationId };
    }
    case 'createPullRequest': {
      const decoded = typeof input.repositoryId === 'string' ? decodeId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoByDbId(forge, Number(decoded.keys[0])) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return { kind: 'CreatePullRequestPayload', pullRequest: null, clientMutationId };
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
      if (existing !== undefined) return { kind: 'CreatePullRequestPayload', pullRequest: pullWrap(repo, existing), clientMutationId };
      const pull = forge.addPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
      });
      return { kind: 'CreatePullRequestPayload', pullRequest: pullWrap(repo, pull), clientMutationId };
    }
    case 'mergePullRequest': {
      const node = typeof input.pullRequestId === 'string' ? resolveNode(ctx, input.pullRequestId) : null;
      if (node === null || node.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return { kind: 'MergePullRequestPayload', pullRequest: null, clientMutationId };
      }
      const pull = node.pull as PullRec;
      const repo = node.repo as RepoRec;
      if (pull.state === 'open') {
        const result = squashMerge(forge, repo, pull);
        if ('conflict' in result) ctx.errors.push({ message: 'mergePullRequest: pull request is not mergeable' });
      }
      return { kind: 'MergePullRequestPayload', pullRequest: node, clientMutationId };
    }
    case 'addComment': {
      const node = typeof input.subjectId === 'string' ? resolveNode(ctx, input.subjectId) : null;
      if (node === null || node.kind !== 'Issue') {
        ctx.errors.push({ message: 'addComment: subject not found' });
        return { kind: 'AddCommentPayload', commentEdge: null, subject: null, clientMutationId };
      }
      const repo = node.repo as RepoRec;
      const issue = node.issue as IssueRec;
      const comment = forge.addComment(repo, issue, typeof input.body === 'string' ? input.body : '');
      const commentWrap: Wrap = { kind: 'IssueComment', repo, issue, comment, body: comment.body };
      return {
        kind: 'AddCommentPayload',
        commentEdge: { kind: 'IssueCommentEdge', node: commentWrap, cursor: cursorOf(comment.id) },
        subject: node,
        clientMutationId,
      };
    }
    default:
      return UNKNOWN_FIELD;
  }
}

function typeNameOf(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null && 'kind' in value) return String((value as Wrap).kind);
  return fallback;
}

function directiveSkips(ctx: Ctx, field: FieldNode): boolean {
  for (const directive of field.directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = valueOf(ctx, arg.value);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if === false) return true;
  }
  return false;
}

function executeSelections(ctx: Ctx, typeName: string, source: unknown, selections: SelectionNode[], out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        executeSelections(ctx, typeName, source, selection.selectionSet, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) executeSelections(ctx, typeName, source, fragment, out);
      continue;
    }
    if (directiveSkips(ctx, selection)) continue;
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const args = argsOf(ctx, selection);
    const raw = resolveField(ctx, typeName, source, selection.name, args);
    if (raw === UNKNOWN_FIELD) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, raw, selection);
  }
}

function completeValue(ctx: Ctx, raw: unknown, field: FieldNode): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(ctx, item, field));
  if (typeof raw === 'object') {
    if (field.selectionSet === undefined) return raw;
    const typeName = typeNameOf(raw, 'Object');
    const out: Record<string, unknown> = {};
    executeSelections(ctx, typeName, raw, field.selectionSet, out);
    return out;
  }
  return raw;
}

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): { data?: Record<string, unknown>; errors?: { message: string }[] } {
  let operations: OperationNode[];
  let fragments: Map<string, SelectionNode[]>;
  try {
    const parser = new Parser(query);
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName !== undefined ? operations.find((op) => op.name === operationName) ?? operations[0] : operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { forge, variables, defaults: operation.variableDefaults, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelections(ctx, rootType, { kind: rootType }, operation.selectionSet, data);
  const result: { data?: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------- HTTP

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 400, { errors: [{ message: 'GraphQL only accepts POST' }] });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): { data?: Record<string, unknown>; errors?: { message: string }[] } => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'invalid operation' }] };
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') return { errors: [{ message: 'query is required' }] };
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
    return executeGraphQL(forge, record.query, variables, typeof record.operationName === 'string' ? record.operationName : undefined);
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(body));
}
