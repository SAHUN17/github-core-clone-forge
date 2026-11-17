// Git's on-the-wire and on-disk object model: hashing, trees, commits, the packfile reader (with
// OFS_DELTA and REF_DELTA resolution, as a pushing client may send) and the packfile writer (plain
// objects, which every client accepts).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { store, type GitObject } from './store.ts';

export function sha1Hex(data: Buffer | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** `<type> <size>\0<content>`: the bytes git hashes to name an object. */
export function objectBytes(type: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'utf8'), data]);
}

export function hashObject(type: string, data: Buffer): string {
  return sha1Hex(objectBytes(type, data));
}

/** Store an object and return its id; the id is the same whether or not it was already held. */
export function putObject(type: string, data: Buffer): string {
  const id = hashObject(type, data);
  if (!store.objects.has(id)) store.objects.set(id, { type, data });
  return id;
}

export function getObject(id: string): GitObject | undefined {
  return store.objects.get(id);
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree's raw bytes into its entries, in the order git stores them. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree ordering: byte order of the name, a directory compared as if it ended in '/'. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function writeTree(entries: TreeEntry[]): string {
  return putObject('tree', buildTree(entries));
}

export interface CommitFields {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function writeCommit(fields: CommitFields): string {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  lines.push('');
  lines.push(fields.message);
  return putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** Every entry of a tree, flattened to `path -> {sha, mode}`. */
export function flattenTree(treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = getObject(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build the tree chain for a flat `path -> {sha, mode}` map, returning the root tree id. */
export function writeFlatTree(files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, value);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, sha: value.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
    return writeTree(entries);
  };
  return emit(root);
}

/** Read a path's blob out of a commit's tree, or undefined when the path is not a file there. */
export function readPath(commitSha: string, path: string): { sha: string; mode: string; data: Buffer } | undefined {
  const commit = getObject(commitSha);
  if (commit === undefined || commit.type !== 'commit') return undefined;
  const parsed = parseCommit(commit.data);
  const files = flattenTree(parsed.tree);
  const entry = files.get(path);
  if (entry === undefined) return undefined;
  const blob = getObject(entry.sha);
  if (blob === undefined) return undefined;
  return { sha: entry.sha, mode: entry.mode, data: blob.data };
}

// ---------------------------------------------------------------- packfile writing

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** A pack holding exactly `ids`, as plain (undeltified) objects, with git's trailing sha1. */
export function writePack(ids: string[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from('PACK', 'ascii'));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(ids.length, 4);
  parts.push(header);
  for (const id of ids) {
    const obj = store.objects.get(id);
    if (obj === undefined) continue;
    const code = TYPE_CODES[obj.type];
    if (code === undefined) continue;
    parts.push(packObjectHeader(code, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ---------------------------------------------------------------- packfile reading

function readObjectHeader(data: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  let byte = data[offset];
  let typeCode = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = data[pos];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    pos += 1;
  }
  return { typeCode, size, next: pos };
}

function readOffsetDeltaBase(data: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = data[offset];
  let value = byte & 0x7f;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = data[pos];
    value = (value + 1) * 128 + (byte & 0x7f);
    pos += 1;
  }
  return { baseOffset: offset - value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset += delta[offset] * 2 ** (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize += delta[offset] * 2 ** (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/** Inflate one zlib stream out of `raw`, reporting how many input bytes it occupied. */
function inflateOne(raw: Buffer): { data: Buffer; consumed: number } {
  const result = inflateSync(raw, { info: true, finishFlush: 2 });
  const consumed = (result as unknown as { engine: { bytesWritten: number } }).engine.bytesWritten;
  return { data: result.buffer as Buffer, consumed };
}

export interface PackReadResult {
  shas: string[];
  count: number;
}

/** Read a packfile the client sent, storing every object it holds; returns the ids in pack order. */
export function readPackIntoStore(pack: Buffer): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const shas: string[] = [];
  interface Entry {
    offset: number;
    typeCode: number;
    type: string;
    data: Buffer | null;
    deltaOfs: number | null;
    deltaRef: string | null;
    sha: string | null;
  }
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readObjectHeader(pack, offset);
    offset = header.next;
    if (header.typeCode === 6) {
      const base = readOffsetDeltaBase(pack, offset);
      offset = base.next;
      const inflated = inflateOne(pack.subarray(offset, pack.length - 20));
      offset += inflated.consumed;
      const entry: Entry = { offset: entryOffset, typeCode: 6, type: '', data: inflated.data, deltaOfs: base.baseOffset, deltaRef: null, sha: null };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else if (header.typeCode === 7) {
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const delta = inflateOne(pack.subarray(offset, pack.length - 20));
      offset += delta.consumed;
      const entry: Entry = { offset: entryOffset, typeCode: 7, type: '', data: delta.data, deltaOfs: null, deltaRef: baseSha, sha: null };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else {
      const type = TYPE_NAMES[header.typeCode];
      if (type === undefined) throw new Error(`pack object type ${header.typeCode}`);
      const inflated = inflateOne(pack.subarray(offset, pack.length - 20));
      offset += inflated.consumed;
      const data = inflated.data;
      const entry: Entry = { offset: entryOffset, typeCode: header.typeCode, type, data, deltaOfs: null, deltaRef: null, sha: null };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  const resolving = new Set<number>();
  const resolve = (entry: Entry): { type: string; data: Buffer } => {
    if (entry.type !== '' && entry.data !== null && entry.typeCode !== 6 && entry.typeCode !== 7) {
      return { type: entry.type, data: entry.data };
    }
    if (entry.sha !== null) {
      const stored = store.objects.get(entry.sha);
      if (stored !== undefined) return stored;
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let base: { type: string; data: Buffer } | undefined;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.deltaOfs as number);
      if (baseEntry === undefined) throw new Error('offset delta base missing');
      base = resolve(baseEntry);
    } else if (entry.typeCode === 7) {
      const ref = entry.deltaRef as string;
      const stored = store.objects.get(ref);
      if (stored !== undefined) base = stored;
      else {
        for (const candidate of entries) {
          if (candidate.sha === ref) {
            base = resolve(candidate);
            break;
          }
        }
      }
      if (base === undefined) throw new Error('ref delta base missing');
    }
    if (base === undefined) throw new Error('delta without a base');
    resolving.delete(entry.offset);
    const data = applyDelta(base.data, entry.data as Buffer);
    return { type: base.type, data };
  };
  for (const entry of entries) {
    const resolved = resolve(entry);
    const sha = hashObject(resolved.type, resolved.data);
    entry.sha = sha;
    if (!store.objects.has(sha)) store.objects.set(sha, { type: resolved.type, data: resolved.data });
    shas.push(sha);
  }
  return { shas, count };
}

/** Every object reachable from `tips`, stopping at anything reachable from `stop`. */
export function collectReachable(tips: string[], stop: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [...tips];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === '' || seen.has(id) || stop.has(id)) continue;
    seen.add(id);
    const obj = store.objects.get(id);
    if (obj === undefined) continue;
    out.push(id);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return out;
}