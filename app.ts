// app.ts — the forge's HTTP surface: git smart HTTP (protocol v2 upload-pack, v0 receive-pack),
// the REST v3 resources, GraphQL v4 and the MCP endpoint, all over one in-memory store.
// main.ts owns the lifecycle; this file is the server the suite scores.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  parsePktLines,
  sidebandWrap,
  parsePack,
  writePack,
  putObject,
  parseCommit,
  parseTree,
  peelToCommit,
  isAncestor,
  ancestorSet,
  type GitObject,
} from './git.ts';
import { Forge, VIEWER, type RepoRec, type IssueRec, type PullRec, diffCommits, squashMerge, pullMergeable, commitsFrom } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const forge = new Forge();
let requestCounter = 0;

// ---------------------------------------------------------------- plumbing

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token gate: the suite's token when the env names one, any bearer otherwise. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return match[1] === expected;
  return match[1]!.length > 0;
}

type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false };

function parseJsonBody(raw: Buffer): JsonBody {
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pagination(url: URL): { page: number; perPage: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

/** Slice a list for one page and build GitHub's Link header for the relations that exist. */
function paginate<T>(req: IncomingMessage, url: URL, items: T[]): { pageItems: T[]; link?: string } {
  const { page, perPage } = pagination(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const pageItems = items.slice((page - 1) * perPage, page * perPage);
  if (items.length <= perPage && page === 1) return { pageItems };
  const host = req.headers.host ?? 'entry';
  const make = (target: number): string => {
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) if (key !== 'page') next.searchParams.set(key, value);
    next.searchParams.set('page', String(target));
    return next.toString();
  };
  const parts: string[] = [];
  if (page < totalPages) {
    parts.push(`<${make(page + 1)}>; rel="next"`);
    parts.push(`<${make(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    parts.push(`<${make(page - 1)}>; rel="prev"`);
    parts.push(`<${make(1)}>; rel="first"`);
  }
  return { pageItems, link: parts.length > 0 ? parts.join(', ') : undefined };
}

// ---------------------------------------------------------------- JSON shapes

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.isoOf(1735689600 + repo.dbId * 60),
    updated_at: forge.isoOf(1735689600 + repo.dbId * 60),
  };
}

export function issueJson(issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: forge.isoOf(1735689600 + issue.seq * 60),
    updated_at: forge.isoOf(1735689600 + issue.seq * 60),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) === 'MERGEABLE' : null,
    head: {
      ref: pull.headRef,
      sha: forge.branchTip(repo, pull.headRef),
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: forge.branchTip(repo, pull.baseRef),
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: forge.isoOf(1735689600 + pull.seq * 60),
    updated_at: forge.isoOf(1735689600 + pull.seq * 60),
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } };
}

// ---------------------------------------------------------------- REST v3

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** Resolve a repo for a REST route; answers 404 (and returns null) when it is not the viewer's. */
function restRepo(res: ServerResponse, owner: string, name: string): RepoRec | null {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) {
    notFound(res);
    return null;
  }
  return repo;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, rest: string[], url: URL, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';

  // API root and meta.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues?q={query}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    else notFound(res);
    return;
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false });
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const body = parseJsonBody(raw);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const name = str(body.value.name);
      if (name === undefined || name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        sendJson(res, 422, { message: 'name already exists on this account' });
        return;
      }
      const repo = forge.createRepo(VIEWER.login, name, {
        description: str(body.value.description) ?? '',
        isPrivate: body.value.private === true,
      });
      if (body.value.auto_init === true) {
        const tree = putObject(repo.objects, 'tree', Buffer.alloc(0));
        const commit = forge.createCommit(repo, { tree, parents: [], message: 'Initial commit\n' });
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const { pageItems, link } = paginate(req, url, forge.reposOf(VIEWER.login).map(repoJson));
      sendJson(res, 200, pageItems, link !== undefined ? { link } : {});
      return;
    }
    notFound(res);
    return;
  }

  if (rest[0] !== 'repos' || rest.length < 3) {
    notFound(res);
    return;
  }
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const tail = rest.slice(3);

  if (tail.length === 0) {
    const repo = restRepo(res, owner, repoName);
    if (repo === null) return;
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(raw);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      sendJson(res, 204, null);
      return;
    }
    notFound(res);
    return;
  }

  const repo = restRepo(res, owner, repoName);
  if (repo === null) return;

  // ---- contents API (backed by real git trees)
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
      const commitOid = forge.resolveRef(repo, ref);
      if (commitOid === null) return notFound(res);
      const commitObj = repo.objects.get(commitOid);
      if (commitObj === undefined || commitObj.type !== 'commit') return notFound(res);
      let treeOid = parseCommit(commitObj.data).tree;
      if (path !== '') {
        const segments = path.split('/');
        for (let i = 0; i < segments.length; i++) {
          const tree = repo.objects.get(treeOid);
          if (tree === undefined || tree.type !== 'tree') return notFound(res);
          const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
          if (entry === undefined) return notFound(res);
          if (i === segments.length - 1) {
            if (entry.mode === '40000') {
              treeOid = entry.oid;
              break;
            }
            const blob = repo.objects.get(entry.oid);
            if (blob === undefined) return notFound(res);
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              name: entry.name,
              path,
              sha: entry.oid,
              size: blob.data.length,
              content: blob.data.toString('base64'),
            });
            return;
          }
          if (entry.mode !== '40000') return notFound(res);
          treeOid = entry.oid;
        }
      }
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return notFound(res);
      const listing = parseTree(tree.data).map((entry) => ({
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        type: entry.mode === '40000' ? 'dir' : 'file',
      }));
      sendJson(res, 200, listing);
      return;
    }
    if (method === 'PUT') {
      const body = parseJsonBody(raw);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const content = str(body.value.content);
      if (content === undefined) {
        sendJson(res, 422, { message: 'Validation Failed: content is required' });
        return;
      }
      const branch = str(body.value.branch) ?? repo.defaultBranch;
      const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
      const result = forge.putFile(repo, branch, path, bytes, str(body.value.message) ?? `Update ${path}`, str(body.value.sha));
      if ('conflict' in result) {
        sendJson(res, 409, { message: `${path} does not match the sha given` });
        return;
      }
      sendJson(res, result.created ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: result.blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = parseJsonBody(raw);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const branch = str(body.value.branch) ?? repo.defaultBranch;
      const result = forge.deleteFile(repo, branch, path, str(body.value.message) ?? `Delete ${path}`, str(body.value.sha));
      if ('missing' in result) return notFound(res);
      if ('conflict' in result) {
        sendJson(res, 409, { message: `${path} does not match the sha given` });
        return;
      }
      sendJson(res, 200, { content: null, commit: { sha: result.commitSha } });
      return;
    }
    notFound(res);
    return;
  }

  // ---- git refs and branches
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = parseJsonBody(raw);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const ref = str(body.value.ref);
      const sha = str(body.value.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
        sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      const target = repo.objects.get(sha);
      if (target === undefined || target.type !== 'commit') {
        sendJson(res, 422, { message: 'Validation Failed: sha is not a commit in this repository' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound(res);
      sendJson(res, 200, { ref, object: { sha: oid, type: 'commit' } });
      return;
    }
    notFound(res);
    return;
  }
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
    return;
  }
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveRef(repo, ref);
    if (tip === null) return notFound(res);
    const items = commitsFrom(repo, tip).map((oid) => {
      const info = parseCommit(repo.objects.get(oid)!.data);
      const person = (line: string): Record<string, unknown> => {
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
        return match !== null
          ? { name: match[1], email: match[2], date: forge.isoOf(Number(match[3])) }
          : { name: line, email: '', date: forge.isoOf(0) };
      };
      return {
        sha: oid,
        commit: { message: info.message, author: person(info.authorLine), committer: person(info.committerLine), tree: { sha: info.tree } },
        parents: info.parents.map((parent) => ({ sha: parent })),
      };
    });
    const { pageItems, link } = paginate(req, url, items);
    sendJson(res, 200, pageItems, link !== undefined ? { link } : {});
    return;
  }

  // ---- labels
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'POST') {
      const body = parseJsonBody(raw);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const name = str(body.value.name);
      if (name === undefined || name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Validation Failed: label already exists' });
        return;
      }
      const color = str(body.value.color) ?? 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { id: repo.labels.size, name, color, default: false, description: null });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label, index) => ({ id: index + 1, name: label.name, color: label.color, default: false, description: null })));
      return;
    }
    notFound(res);
    return;
  }

  // ---- issues and comments
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = parseJsonBody(raw);
        if (!body.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const title = str(body.value.title);
        if (title === undefined || title === '') {
          sendJson(res, 422, { message: 'Validation Failed: title is required' });
          return;
        }
        const labels = Array.isArray(body.value.labels) ? body.value.labels.filter((x): x is string => typeof x === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist` });
            return;
          }
        }
        const issue = forge.addIssue(repo, { title, body: str(body.value.body) ?? '', labels });
        sendJson(res, 201, issueJson(issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { pageItems, link } = paginate(req, url, issues.map(issueJson));
        sendJson(res, 200, pageItems, link !== undefined ? { link } : {});
        return;
      }
      notFound(res);
      return;
    }
    const number = Number(tail[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (issue === undefined) return notFound(res);
      if (method === 'GET') {
        sendJson(res, 200, issueJson(issue));
        return;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(raw);
        if (!body.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (str(body.value.state) === 'closed' || str(body.value.state) === 'open') issue.state = str(body.value.state) as 'open' | 'closed';
        if (typeof body.value.title === 'string') issue.title = body.value.title;
        if (typeof body.value.body === 'string') issue.body = body.value.body;
        if (Array.isArray(body.value.labels)) {
          issue.labels = body.value.labels.filter((x): x is string => typeof x === 'string');
        }
        sendJson(res, 200, issueJson(issue));
        return;
      }
      notFound(res);
      return;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) return notFound(res);
      if (method === 'POST') {
        const body = parseJsonBody(raw);
        if (!body.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const text = str(body.value.body);
        if (text === undefined) {
          sendJson(res, 422, { message: 'Validation Failed: body is required' });
          return;
        }
        const comment = forge.addComment(repo, issue, text);
        sendJson(res, 201, commentJson(comment));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(commentJson));
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  // ---- pull requests
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = parseJsonBody(raw);
        if (!body.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const title = str(body.value.title);
        const head = (str(body.value.head) ?? '').replace(/^refs\/heads\//, '').split(':').pop()!;
        const base = (str(body.value.base) ?? '').replace(/^refs\/heads\//, '').split(':').pop()!;
        if (title === undefined || title === '' || head === '' || base === '') {
          sendJson(res, 422, { message: 'Validation Failed: title, head and base are required' });
          return;
        }
        if (forge.branchTip(repo, head) === null) {
          sendJson(res, 422, { message: `Validation Failed: head branch "${head}" does not exist` });
          return;
        }
        if (forge.branchTip(repo, base) === null) {
          sendJson(res, 422, { message: `Validation Failed: base branch "${base}" does not exist` });
          return;
        }
        const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (duplicate !== undefined) {
          sendJson(res, 422, { message: `A pull request already exists for ${head} into ${base}` });
          return;
        }
        const pull = forge.addPull(repo, { title, body: str(body.value.body) ?? '', headRef: head, baseRef: base });
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { pageItems, link } = paginate(req, url, pulls.map((pull) => pullJson(repo, pull)));
        sendJson(res, 200, pageItems, link !== undefined ? { link } : {});
        return;
      }
      notFound(res);
      return;
    }
    const number = Number(tail[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2 && method === 'GET') {
      if (pull === undefined) return notFound(res);
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound(res);
      const baseTip = forge.branchTip(repo, pull.baseRef);
      const headTip = forge.branchTip(repo, pull.headRef);
      if (baseTip === null || headTip === null) {
        sendJson(res, 200, []);
        return;
      }
      sendJson(
        res,
        200,
        diffCommits(repo, baseTip, headTip).map((change) => ({
          filename: change.filename,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
        })),
      );
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound(res);
      const body = parseJsonBody(raw);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (pull.state !== 'open') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const result = squashMerge(forge, repo, pull);
      if ('conflict' in result || 'missing' in result) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta allow-tip-sha1-in-want allow-reachable-sha1-in-want';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function handleAdvertise(req: IncomingMessage, res: ServerResponse, repo: RepoRec, service: string): void {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    const lines = ['version 2\n', 'agent=forge/1.0.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
    sendBytes(res, 200, Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:${headRef} agent=forge/1.0.0` : `${RECEIVE_CAPS} agent=forge/1.0.0`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headRef) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null && peeled !== oid) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(res: ServerResponse, repo: RepoRec, args: LsRefsArgs): void {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  if (matches('HEAD')) {
    const headOid = repo.refs.get(headRef);
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (args.unborn) {
      lines.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
}

/** Every object id in a tree's closure (the tree itself, subtrees and blobs). */
function treeClosure(store: Map<string, GitObject>, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') treeClosure(store, entry.oid, into);
    else into.add(entry.oid);
  }
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenSince?: number;
  done: boolean;
}

interface FetchOutcome {
  pack: Buffer;
  shallowOut: string[];
  unshallowOut: string[];
}

/**
 * Recent fetch outcomes per repository. A fetch's pack and shallow boundary are a pure function
 * of the object store plus the request arguments, and objects are only ever added to a store —
 * never removed or mutated — so the store's size versions it exactly: same size and same
 * arguments, same outcome. Concurrent identical clones (the common case: many readers fetching
 * the same tip at the same depth) then share one traversal and one pack build instead of
 * repeating both per request. A handful of entries per repo is plenty; older ones fall out FIFO.
 */
const fetchOutcomes = new WeakMap<RepoRec, Map<string, FetchOutcome>>();

function fetchOutcomeKey(repo: RepoRec, args: FetchArgs): string {
  return [
    repo.objects.size,
    [...args.wants].sort().join(' '),
    [...args.haves].sort().join(' '),
    [...args.shallow].sort().join(' '),
    args.deepen ?? '',
    args.deepenSince ?? '',
  ].join('|');
}

function handleFetch(res: ServerResponse, repo: RepoRec, args: FetchArgs): void {
  const store = repo.objects;
  const outcomeKey = fetchOutcomeKey(repo, args);
  let outcomes = fetchOutcomes.get(repo);
  const cached = outcomes?.get(outcomeKey);
  if (cached !== undefined) {
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    const recognized = args.haves.filter((have) => store.has(have));
    if (recognized.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of new Set(recognized)) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
    if (cached.shallowOut.length > 0 || cached.unshallowOut.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of cached.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of cached.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    if (args.done) {
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandWrap(cached.pack, 1));
      parts.push(PKT_FLUSH);
    }
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  // Distances (in commit generations) from the wants, following parents.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(store, want);
    if (commit !== null && !dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const d = dist.get(oid)!;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    if (args.deepenSince !== undefined && info.time < args.deepenSince) continue;
    for (const parent of info.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const shallowClient = new Set(args.shallow);
  const haveCommits = new Set<string>();
  for (const have of args.haves) {
    const commit = peelToCommit(store, have);
    if (commit === null) continue;
    if (shallowClient.has(commit) || shallowClient.has(have)) haveCommits.add(commit);
    else for (const ancestor of ancestorSet(store, commit)) haveCommits.add(ancestor);
  }
  // What the client already holds, object by object.
  const had = new Set<string>();
  for (const have of args.haves) {
    const object = store.get(have);
    if (object !== undefined) had.add(have);
    const commit = peelToCommit(store, have);
    if (commit === null) continue;
    const commits = shallowClient.has(commit) || shallowClient.has(have) ? [commit] : [...ancestorSet(store, commit)];
    for (const c of commits) {
      had.add(c);
      const cObj = store.get(c);
      if (cObj !== undefined) treeClosure(store, parseCommit(cObj.data).tree, had);
    }
  }
  const limit = args.deepen; // undefined: no depth limit
  const sendCommits = new Set<string>();
  for (const [commit, d] of dist) {
    if (limit !== undefined && d >= limit) continue;
    if (args.deepenSince !== undefined) {
      const object = store.get(commit);
      if (object !== undefined && object.type === 'commit' && parseCommit(object.data).time < args.deepenSince) continue;
    }
    if (haveCommits.has(commit)) continue;
    sendCommits.add(commit);
  }
  // The client's commit set after this fetch, for boundary computation.
  const after = new Set<string>([...haveCommits, ...shallowClient, ...sendCommits]);
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  for (const commit of sendCommits) {
    const object = store.get(commit);
    if (object === undefined) continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !after.has(parent))) shallowOut.push(commit);
  }
  for (const commit of shallowClient) {
    if (!after.has(commit) || shallowOut.includes(commit)) continue;
    const object = store.get(commit);
    if (object === undefined) continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => after.has(parent))) unshallowOut.push(commit);
  }
  // Assemble the object list: tag objects for wanted tags, the commits, their tree closures.
  const send = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (send.has(oid) || had.has(oid)) return;
    const object = store.get(oid);
    if (object !== undefined) send.set(oid, object);
  };
  for (const want of args.wants) {
    let current = want;
    for (let depth = 0; depth < 16; depth++) {
      const object = store.get(current);
      if (object === undefined || object.type !== 'tag') break;
      addObject(current);
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) break;
      current = match[1]!;
    }
  }
  for (const commit of sendCommits) {
    addObject(commit);
    const object = store.get(commit);
    if (object === undefined) continue;
    const closure = new Set<string>();
    treeClosure(store, parseCommit(object.data).tree, closure);
    for (const oid of closure) addObject(oid);
  }
  const pack = writePack([...send.values()]);
  if (outcomes === undefined) {
    outcomes = new Map();
    fetchOutcomes.set(repo, outcomes);
  }
  if (outcomes.size >= 16) outcomes.delete(outcomes.keys().next().value!);
  outcomes.set(outcomeKey, { pack, shallowOut, unshallowOut });

  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const recognized = args.haves.filter((have) => store.has(have));
  if (recognized.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of new Set(recognized)) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (args.done) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(pack, 1));
    parts.push(PKT_FLUSH);
  }
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleUploadPack(res: ServerResponse, repo: RepoRec, raw: Buffer): Promise<void> {
  let items;
  try {
    items = parsePktLines(raw, 0).items;
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line request' });
    return;
  }
  const commandLine = items.find((item) => item.kind === 'data')?.data.toString('utf8') ?? '';
  const command = /^command=([a-z-]+)/.exec(commandLine)?.[1];
  // Arguments follow the first delim packet.
  const delimIndex = items.findIndex((item) => item.kind === 'delim');
  const argItems = delimIndex === -1 ? [] : items.slice(delimIndex + 1).filter((item) => item.kind === 'data');
  const argLines = argItems.map((item) => (item as { data: Buffer }).data.toString('utf8').replace(/\n$/, ''));
  if (command === 'ls-refs') {
    handleLsRefs(res, repo, {
      peel: argLines.includes('peel'),
      symrefs: argLines.includes('symrefs'),
      unborn: argLines.includes('unborn'),
      prefixes: argLines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length)),
    });
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let deepen: number | undefined;
    let deepenSince: number | undefined;
    for (const line of argLines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13).trim());
    }
    handleFetch(res, repo, { wants, haves, shallow, deepen, deepenSince, done: argLines.includes('done') });
    return;
  }
  sendJson(res, 400, { message: 'unsupported upload-pack command' });
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  let parsed;
  try {
    parsed = parsePktLines(raw, 0);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line request' });
    return;
  }
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const item of parsed.items) {
    if (item.kind !== 'data') break;
    let line = item.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length === 3) commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }
  const packBytes = raw.subarray(parsed.next);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const pack = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of pack.objects) putObject(repo.objects, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID && command.oldOid === ZERO_OID) results.push({ ref: command.ref, ok: true });
      else if (current !== command.oldOid) results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'unknown object' });
      continue;
    }
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: current === ZERO_OID ? 'reference already exists' : 'stale info' });
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const newCommit = peelToCommit(repo.objects, command.newOid);
      const oldCommit = peelToCommit(repo.objects, command.oldOid);
      if (newCommit === null || oldCommit === null || !isAncestor(repo.objects, oldCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  const inner: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack error: ${unpackError}\n`)];
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  const framed = capabilities.includes('side-band-64k')
    ? Buffer.concat([sidebandWrap(innerBytes, 1), PKT_FLUSH])
    : innerBytes;
  sendBytes(res, 200, framed, 'application/x-git-receive-pack-result');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[], url: URL, raw: Buffer): Promise<void> {
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -'.git'.length);
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const method = req.method ?? 'GET';
  const action = segments.slice(2).join('/');
  if (method === 'GET' && action === 'info/refs') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'unknown service' });
      return;
    }
    handleAdvertise(req, res, repo, service);
    return;
  }
  if (method === 'POST' && action === 'git-upload-pack') {
    await handleUploadPack(res, repo, raw);
    return;
  }
  if (method === 'POST' && action === 'git-receive-pack') {
    handleReceivePack(res, repo, raw);
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `forge-${requestCounter}`);
    void (async () => {
      try {
        const raw = await readBody(req);
        const parsedUrl = new URL(req.url ?? '/', 'http://entry');
        const segments = parsedUrl.pathname
          .split('/')
          .filter((segment) => segment !== '')
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
        const method = req.method ?? 'GET';

        if (method === 'GET' && parsedUrl.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isApi = segments[0] === 'api' && segments[1] === 'v3';
        const isGraphql = segments[0] === 'api' && segments[1] === 'graphql';
        const isMcp = segments[0] === 'mcp';
        const isGit = segments.length >= 2 && segments[1]!.endsWith('.git');
        if (!isApi && !isGraphql && !isMcp && !isGit) {
          notFound(res);
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        if (isApi) {
          await handleRest(req, res, segments.slice(2), parsedUrl, raw);
          return;
        }
        if (isGraphql) {
          await handleGraphQL(forge, req, res, raw);
          return;
        }
        if (isMcp) {
          await handleMcp(forge, req, res, raw);
          return;
        }
        await handleGit(req, res, segments, parsedUrl, raw);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

export { forge };
