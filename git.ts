// git.ts — the git object model, pack reader/writer and pkt-line framing for the forge.
// Pure Node stdlib (node:crypto for SHA-1, node:zlib for pack compression). Objects live in a
// per-repository Map keyed by their SHA-1; everything the wire carries round-trips byte-exactly
// because objects are stored as their raw (headerless) payloads and re-hashed on demand.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}
export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODES: Record<string, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The oid of an object: SHA-1 of "<type> <byte length>\0" followed by the raw payload. */
export function hashObject(type: ObjType, data: Buffer): string {
  // Two updates, not a concat: hashing runs once per stored object, and the concat used to copy
  // every payload (a full extra pass over large blobs) just to hash it.
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object and return its oid (idempotent: the same bytes give the same oid). */
export function putObject(store: ObjectStore, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // as written in the tree: "100644", "100755", "120000", "40000" for a directory
  name: string;
  oid: string;
}

const treeCache = new WeakMap<Buffer, TreeEntry[]>();

export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeCache.get(data);
  if (cached !== undefined) return cached;
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  treeCache.set(data, entries);
  return entries;
}

/** Git's tree order: by name bytes, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> { oid, mode } for files (blobs) only. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> blob map; returns the root tree oid. */
export function buildTreeFromFlat(store: ObjectStore, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      let next = node.dirs.get(segments[i]!);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segments[i]!, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1]!, value);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return putObject(store, 'tree', buildTreeData(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  /** Committer timestamp (seconds), 0 when unparseable. */
  time: number;
  message: string;
}

const commitCache = new WeakMap<Buffer, CommitInfo>();

export function parseCommit(data: Buffer): CommitInfo {
  const cached = commitCache.get(data);
  if (cached !== undefined) return cached;
  const info = parseCommitRaw(data);
  commitCache.set(data, info);
  return info;
}

function parseCommitRaw(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  let time = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) {
      committerLine = line.slice(10);
      const match = / (\d+) [+-]\d{4}$/.exec(committerLine);
      if (match !== null) time = Number(match[1]);
    }
  }
  return { tree, parents, authorLine, committerLine, time, message };
}

export function buildCommitData(input: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  let head = `tree ${input.tree}\n`;
  for (const parent of input.parents) head += `parent ${parent}\n`;
  head += `author ${input.author}\ncommitter ${input.committer}\n`;
  return Buffer.from(`${head}\n${input.message}`, 'utf8');
}

/** The commit a tag points at (following nested tags), or null when it does not resolve to a commit. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth++) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

/** Every commit reachable from `tip` (inclusive), following parents. */
export function ancestorSet(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  // Depth-first from the descendant, exiting the moment the ancestor turns up. The old shape
  // built the descendant's entire ancestor set first, so a fast-forward push — where the
  // ancestor is the new tip's parent — paid a full-history walk on every receive-pack; now it
  // pays one step. A push that is not a fast-forward still walks everything, exactly as before.
  if (ancestor === descendant) {
    const self = store.get(descendant);
    return self !== undefined && self.type === 'commit';
  }
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** A merge base of two commits: the first commit on a BFS from `b` that is an ancestor of `a`. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestors = ancestorSet(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------- pack files

/** Apply a git binary delta to its base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size (trusted, not re-checked)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) offset = delta[pos++]!;
      if ((op & 0x02) !== 0) offset |= delta[pos++]! << 8;
      if ((op & 0x04) !== 0) offset |= delta[pos++]! << 16;
      if ((op & 0x08) !== 0) offset |= delta[pos++]! << 24;
      if ((op & 0x10) !== 0) size = delta[pos++]!;
      if ((op & 0x20) !== 0) size |= delta[pos++]! << 8;
      if ((op & 0x40) !== 0) size |= delta[pos++]! << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  if (produced !== targetSize) throw new Error('delta produced mismatch');
  return result;
}

/**
 * Inflate one zlib stream starting at `offset`, returning the payload and the offset just past the
 * stream. zlib's inflateSync tolerates trailing bytes but does not report how many it consumed, so
 * the stream end is found by binary search: the shortest prefix that still inflates is the stream.
 */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; next: number } {
  let lo = 1;
  let hi = buf.length - offset;
  let best: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = inflateSync(buf.subarray(offset, offset + mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === null) throw new Error('corrupt zlib stream in pack');
  // `best` inflated from prefix length lo (== hi + 1): recompute the exact consumed length.
  return { data: best, next: offset + lo };
}

export interface ParsedPack {
  objects: GitObject[];
  count: number;
}

/** Parse a whole pack (header, objects with OFS/REF deltas resolved, SHA-1 trailer ignored). */
export function parsePack(buf: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): ParsedPack {
  if (buf.length < 12 || buf.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = buf.readUInt32BE(8);
  let pos = 12;
  interface RawEntry {
    type: ObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    start: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const start = pos;
    let byte = buf[pos++]!;
    const typeCode = (byte >> 4) & 0x07;
    // size is informational here (the inflated length is authoritative); still walk the varint.
    while ((byte & 0x80) !== 0) byte = buf[pos++]!;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let b = buf[pos++]!;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[pos++]!;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeCode === 7) {
      baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateOne(buf, pos);
    pos = inflated.next;
    const type: RawEntry['type'] = typeCode === 6 ? 'ofs-delta' : typeCode === 7 ? 'ref-delta' : TYPE_CODES[typeCode]!;
    raw.push({ type, data: inflated.data, baseOffset, baseOid, start });
    byOffset.set(start, i);
  }
  const resolved: (GitObject | null)[] = raw.map(() => null);
  // oid -> raw index over the pack's plain (non-delta) entries, each hashed once on first use.
  // The ref-delta base hunt used to re-hash every plain entry for every delta in the pack —
  // quadratic on the delta-heavy packs real git clients send. The map makes a base lookup O(1).
  let plainIndex: Map<string, number> | null = null;
  const plainIndexByOid = (): Map<string, number> => {
    if (plainIndex !== null) return plainIndex;
    plainIndex = new Map();
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i]!;
      if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
        plainIndex.set(hashObject(entry.type, entry.data), i);
      }
    }
    return plainIndex;
  };
  // The oid of each resolved entry, memoized: the delta-base fallback scan below hashes any
  // given entry at most once per pack instead of once per delta that goes looking.
  const resolvedOid: (string | null)[] = raw.map(() => null);
  const resolve = (index: number): GitObject => {
    const done = resolved[index];
    if (done !== null) return done;
    const entry = raw[index]!;
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset!);
      if (baseIndex === undefined) throw new Error('ofs-delta base outside pack');
      const base = resolve(baseIndex);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      const localIndex = plainIndexByOid().get(entry.baseOid!);
      if (localIndex !== undefined) base = resolve(localIndex);
      if (base === undefined) {
        // Maybe the base is another delta entry whose resolution yields the oid.
        for (let candidateIndex = 0; candidateIndex < raw.length; candidateIndex++) {
          if (candidateIndex === index) continue;
          const candidate = resolve(candidateIndex);
          let candidateOid = resolvedOid[candidateIndex];
          if (candidateOid === null) {
            candidateOid = hashObject(candidate.type, candidate.data);
            resolvedOid[candidateIndex] = candidateOid;
          }
          if (candidateOid === entry.baseOid) {
            base = candidate;
            break;
          }
        }
      }
      if (base === undefined && resolveExternal !== undefined) base = resolveExternal(entry.baseOid!);
      if (base === undefined) throw new Error('ref-delta base not found');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved[index] = object;
    return object;
  };
  const objects = raw.map((_, index) => resolve(index));
  return { objects, count };
}

/** Write a pack holding the given objects as full (non-delta) entries, pack version 2. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const bytes: number[] = [];
    let first = (CODE_BY_TYPE[object.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    while (rest > 0) {
      bytes.push(first | 0x80);
      first = rest & 0x7f;
      rest >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

/** Frame one pkt-line ("<4 hex length><payload>"); payloads are capped at 65516 bytes by callers. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Parse pkt-lines from `buf` starting at `offset`; returns the items and the offset just past the last one. */
export function parsePktLines(buf: Buffer, offset = 0): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const hex = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length "${hex}"`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
      break;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'response-end' });
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > buf.length) throw new Error('pkt-line overruns the body');
    items.push({ kind: 'data', data: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { items, next: pos };
}

/** Wrap a payload in side-band-64k framing: band-1 pkt-lines of at most 32 KiB of payload each. */
export function sidebandWrap(payload: Buffer, band = 1): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < payload.length; pos += CHUNK) {
    const slice = payload.subarray(pos, Math.min(payload.length, pos + CHUNK));
    chunks.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (payload.length === 0) chunks.push(pktLine(Buffer.from([band])));
  return Buffer.concat(chunks);
}
