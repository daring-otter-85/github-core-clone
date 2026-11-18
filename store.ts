// store.ts — the forge's state and the domain operations shared by REST, GraphQL and MCP.
// Everything is in memory: repositories (with their own git object store and refs), labels,
// issues, comments and pull requests. Issue and pull-request numbers share one per-repo counter,
// as on GitHub. API-created commits use a deterministic logical clock so a replayed trial builds
// byte-identical objects.

import {
  type ObjectStore,
  type GitObject,
  putObject,
  parseCommit,
  buildCommitData,
  flattenTree,
  buildTreeFromFlat,
  ancestorSet,
  mergeBase,
} from './git.ts';

/** The token's owner: the scenario's viewer, the one login every surface serves. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  nextCommentId: number;
  commitSeq: number;
}

export class Forge {
  repos = new Map<string, RepoRec>();
  private nextRepoDbId = 1;
  private nextIssueDbId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, input: { description?: string; isPrivate?: boolean }): RepoRec {
    const repo: RepoRec = {
      dbId: this.nextRepoDbId++,
      owner,
      name,
      isPrivate: input.isPrivate === true,
      description: input.description ?? '',
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitSeq: 0,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.dbId - b.dbId);
  }

  /** A deterministic timestamp for API-created commits: 2025-01-01 plus one minute per commit. */
  nextTimestamp(repo: RepoRec): number {
    repo.commitSeq += 1;
    return 1735689600 + repo.commitSeq * 60;
  }

  isoOf(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Create a commit in the repo with the viewer's identity and the repo's logical clock. */
  createCommit(repo: RepoRec, input: { tree: string; parents: string[]; message: string }): string {
    const ts = this.nextTimestamp(repo);
    const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    return putObject(repo.objects, 'commit', buildCommitData({ tree: input.tree, parents: input.parents, author: ident, committer: ident, message: input.message }));
  }

  /** The flat file map at a ref (branch/tag name or commit oid), or null when it does not resolve. */
  flatAt(repo: RepoRec, ref: string): Map<string, { oid: string; mode: string }> | null {
    const oid = this.resolveRef(repo, ref);
    if (oid === null) return null;
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return flattenTree(repo.objects, parseCommit(object.data).tree);
    if (object.type === 'tree') return flattenTree(repo.objects, oid);
    return null;
  }

  /** Resolve a branch name, tag name, full ref or raw oid to an object id. */
  resolveRef(repo: RepoRec, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) return oid;
    }
    return null;
  }

  /** The commit oid a branch points at, or null. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /**
   * Write one file on a branch (the contents API): creates or replaces the blob, rebuilds the
   * trees and commits on top of the branch tip. Returns the blob and commit oids, or a conflict
   * marker when the caller's `sha` does not match the current blob.
   */
  putFile(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha: string | undefined,
  ): { blobSha: string; commitSha: string; created: boolean } | { conflict: true } {
    const tip = this.branchTip(repo, branch);
    const flat = tip === null ? new Map<string, { oid: string; mode: string }>() : this.flatAt(repo, branch) ?? new Map();
    const existing = flat.get(path);
    if (existing !== undefined && expectedSha !== undefined && expectedSha !== existing.oid) return { conflict: true };
    if (existing !== undefined && expectedSha === undefined) return { conflict: true };
    const blobSha = putObject(repo.objects, 'blob', content);
    flat.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
    const tree = buildTreeFromFlat(repo.objects, flat);
    const commitSha = this.createCommit(repo, { tree, parents: tip === null ? [] : [tip], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { blobSha, commitSha, created: existing === undefined };
  }

  /** Delete one file on a branch (the contents API). */
  deleteFile(
    repo: RepoRec,
    branch: string,
    path: string,
    message: string,
    expectedSha: string | undefined,
  ): { commitSha: string } | { conflict: true } | { missing: true } {
    const tip = this.branchTip(repo, branch);
    const flat = tip === null ? null : this.flatAt(repo, branch);
    const existing = flat?.get(path);
    if (flat === null || existing === undefined) return { missing: true };
    if (expectedSha !== undefined && expectedSha !== existing.oid) return { conflict: true };
    flat.delete(path);
    const tree = buildTreeFromFlat(repo.objects, flat);
    const commitSha = this.createCommit(repo, { tree, parents: [tip!], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  addIssue(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec {
    const number = repo.nextNumber++;
    const issue: IssueRec = {
      kind: 'issue',
      number,
      dbId: this.nextIssueDbId++,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: input.labels ?? [],
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addPull(repo: RepoRec, input: { title: string; body: string; headRef: string; baseRef: string }): PullRec {
    const number = repo.nextNumber++;
    const pull: PullRec = {
      kind: 'pull',
      number,
      dbId: this.nextIssueDbId++,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      seq: number,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: repo.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }
}

// ---------------------------------------------------------------- pull request diff and merge

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(store: ObjectStore, oid: string | undefined): number {
  if (oid === undefined) return 0;
  const object = store.get(oid);
  if (object === undefined || object.type !== 'blob') return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** The changed files between two commits' trees (base -> head), with line counts. */
export function diffCommits(repo: RepoRec, baseOid: string, headOid: string): FileChange[] {
  const baseFlat = flattenTree(repo.objects, parseCommit(repo.objects.get(baseOid)!.data).tree);
  const headFlat = flattenTree(repo.objects, parseCommit(repo.objects.get(headOid)!.data).tree);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid && base.mode === head.mode) continue;
    if (base === undefined && head !== undefined) {
      const additions = lineCount(repo.objects, head.oid);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base !== undefined && head === undefined) {
      const deletions = lineCount(repo.objects, base.oid);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const additions = lineCount(repo.objects, head?.oid);
      const deletions = lineCount(repo.objects, base?.oid);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/** Three-way tree merge against the merge base. Returns the merged flat map, or null on conflict. */
export function mergeTrees(
  repo: RepoRec,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const mb = mergeBase(repo.objects, baseTip, headTip);
  const empty = new Map<string, { oid: string; mode: string }>();
  const mbFlat = mb === null ? empty : flattenTree(repo.objects, parseCommit(repo.objects.get(mb)!.data).tree);
  const baseFlat = flattenTree(repo.objects, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const headFlat = flattenTree(repo.objects, parseCommit(repo.objects.get(headTip)!.data).tree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...mbFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  const same = (a?: { oid: string; mode: string }, b?: { oid: string; mode: string }): boolean =>
    (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
  for (const path of paths) {
    const origin = mbFlat.get(path);
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (same(head, base)) {
      if (base !== undefined) merged.set(path, base);
    } else if (same(origin, base)) {
      if (head !== undefined) merged.set(path, head);
    } else if (same(origin, head)) {
      if (base !== undefined) merged.set(path, base);
    } else {
      return null;
    }
  }
  return merged;
}

/** Whether a pull request would merge cleanly right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return mergeTrees(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the three-way
 * merge and whose only parent is the base tip. Returns the merge commit oid, or 'conflict'.
 */
export function squashMerge(forge: Forge, repo: RepoRec, pull: PullRec): { sha: string } | { conflict: true } | { missing: true } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { missing: true };
  const merged = mergeTrees(repo, baseTip, headTip);
  if (merged === null) return { conflict: true };
  const tree = buildTreeFromFlat(repo.objects, merged);
  const sha = forge.createCommit(repo, { tree, parents: [baseTip], message: `${pull.title} (#${pull.number})\n` });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = forge.isoOf(1735689600 + repo.commitSeq * 60);
  return { sha };
}

/** Every ancestor commit of a tip, newest first (breadth-first over parents). */
export function commitsFrom(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const object: GitObject | undefined = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return order;
}

export { ancestorSet };
