// git.ts — git smart HTTP (v2 + v0): pkt-lines, packfiles, advertise, fetch, receive-pack.
// Plain objects only on the wire out (no deltas); incoming packs may carry deltas.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  Store,
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type ObjType,
  type Repo,
} from './store.ts';

const AGENT = 'git-forge/1.0.0';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface PktItem {
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Parse a pkt-line stream. Throws on a malformed length prefix. */
export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const head = buf.toString('ascii', offset, offset + 4);
    if (head === '0000') {
      items.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      items.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    items.push({ kind: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const OBJ_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OBJ_CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeObjectHeader(type: ObjType, size: number): Buffer {
  const typeCode = OBJ_TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export interface PackObjectInput {
  type: ObjType;
  data: Buffer;
}

export function writePack(objects: PackObjectInput[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(encodeObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = Buffer.from(requireSha1(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

function requireSha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export interface ParsedPackObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const sourceSize = readSize();
  readSize(); // target size (checked implicitly by construction)
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta op 0 is invalid');
    }
  }
  return Buffer.concat(out);
}

/** Parse a packfile (plain, ofs-delta and ref-delta entries). Throws on corruption. */
export function parsePack(buf: Buffer): ParsedPackObject[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: ParsedPackObject[] = [];
  const byOffset = new Map<number, ParsedPackObject>();
  const byOid = new Map<string, ParsedPackObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    let byte = buf[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType;
    let data: Buffer;
    if (typeCode === 6) {
      // ofs-delta: base is the object at (entryStart - baseOffset)
      byte = buf[offset]!;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(entryStart - baseOffset);
      if (!base) throw new Error('ofs-delta base not found');
      const { data: raw, next } = inflateBounded(buf, offset);
      offset = next;
      data = applyDelta(base.data, raw);
      type = base.type;
    } else if (typeCode === 7) {
      // ref-delta
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = byOid.get(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const { data: raw, next } = inflateBounded(buf, offset);
      offset = next;
      data = applyDelta(base.data, raw);
      type = base.type;
    } else {
      type = OBJ_CODE_TYPES[typeCode] ?? (() => { throw new Error(`unknown object type ${typeCode}`); })();
      const { data: raw, next } = inflateBounded(buf, offset);
      offset = next;
      data = raw;
      if (data.length !== size) throw new Error('object size mismatch');
    }
    const oid = hashObject(type, data);
    const parsed: ParsedPackObject = { oid, type, data };
    objects.push(parsed);
    byOffset.set(entryStart, parsed);
    byOid.set(oid, parsed);
  }
  // trailer check
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const computed = requireSha1(buf.subarray(0, buf.length - 20));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  return objects;
}

/** Inflate a zlib stream starting at offset; returns the data and the offset just past it.
 * One call: inflateSync with {info:true} reports the consumed input length in
 * engine.bytesWritten (the engine stops at the stream's end). */
function inflateBounded(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

// ---------------------------------------------------------------------------
// Object collection for fetch
// ---------------------------------------------------------------------------

export interface FetchSelection {
  objects: PackObjectInput[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

export function selectFetchObjects(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowLines: string[],
  deepen: number | null,
  deepenSince: number | null,
  deepenNot: string | null,
): FetchSelection {
  // A want may name a tag object (or a tree/blob): include it directly and peel
  // tags to their commit for the history walk.
  const extraObjects = new Set<string>();
  const walkTips: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'commit') {
      walkTips.push(want);
    } else if (obj.type === 'tag') {
      extraObjects.add(want);
      const target = peelOid(repo, want);
      if (target !== null) walkTips.push(target);
    } else {
      extraObjects.add(want);
    }
  }
  // Unlimited closure of the wants, for ACKs. Skipped when there are no haves:
  // with nothing held, no ACK can exist, and the walk is pure overhead (a
  // 200-commit history on every depth-1 clone fetch).
  const acks: string[] = [];
  if (haves.length > 0) {
    const wantClosure = store.reachableCommits(repo, walkTips);
    for (const have of haves) {
      if (wantClosure.has(have)) acks.push(have);
    }
  }
  // Objects the client already holds: the full object closure of the haves, except
  // the walk stops at the request's shallow boundaries (a shallow client holds the
  // boundary commit's own objects, not its history).
  const shallowSet = new Set(shallowLines);
  const exclude = store.reachableObjects(repo, haves, shallowSet);
  if (deepenNot !== null) {
    const notOid = store.resolveCommitish(repo, deepenNot);
    if (notOid !== undefined) {
      for (const oid of store.reachableObjects(repo, [notOid]).keys()) exclude.add(oid);
    }
  }
  // Depth-limited walk from the wants.
  const included = new Map<string, number>(); // commit oid -> depth
  const queue: Array<[string, number]> = walkTips.map((w) => [w, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, depth] = queue.shift()!;
    if (included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (deepen !== null && depth >= deepen) continue;
    if (deepenSince !== null) {
      const commit = parseCommit(obj.data);
      if (commit.committerTime < deepenSince) continue;
    }
    included.set(oid, depth);
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push([parent, depth + 1]);
  }
  // Boundary commits: included commits with no included parent.
  const shallow: string[] = [];
  if (deepen !== null || deepenSince !== null || shallowLines.length > 0) {
    for (const [oid] of included) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const hasIncludedParent = parents.some((p) => included.has(p));
      if (!hasIncludedParent) shallow.push(oid);
    }
  }
  const shallowOut = new Set(shallow);
  const unshallow = shallowLines.filter((oid) => included.has(oid) && !shallowOut.has(oid));
  // Gather objects: commits + their trees/blobs, minus objects the client holds.
  const objects: PackObjectInput[] = [];
  const seen = new Set<string>();
  const addObject = (oid: string): void => {
    if (seen.has(oid) || exclude.has(oid)) return;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return;
    objects.push({ type: obj.type, data: obj.data });
  };
  const addTree = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    if (exclude.has(treeOid)) return;
    addObject(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else addObject(entry.oid);
    }
  };
  for (const oid of extraObjects) addObject(oid);
  for (const [oid] of included) {
    if (exclude.has(oid)) continue;
    addObject(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    addTree(parseCommit(obj.data).tree);
  }
  return { objects, shallow, unshallow, acks };
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(payload));
  }
  if (pack.length === 0) {
    chunks.push(pktLine(Buffer.from([1])));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Advertise
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peelOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') {
    const tag = parseTag(obj.data);
    return peelOid(repo, tag.object);
  }
  return obj.type === 'commit' ? oid : null;
}

export function advertiseV0Upload(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-upload-pack\n'));
  parts.push(pktFlush());
  const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter agent=' + AGENT;
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0 || headTip === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0symref=HEAD:refs/heads/main ${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0symref=HEAD:refs/heads/main ${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peelOid(repo, oid);
      if (peeled !== null && ref.startsWith('refs/tags/') && repo.objects.get(oid)?.type === 'tag') {
        parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function advertiseV0Receive(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-receive-pack\n'));
  parts.push(pktFlush());
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0 || headTip === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0symref=HEAD:refs/heads/main ${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0symref=HEAD:refs/heads/main ${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peelOid(repo, oid);
      if (peeled !== null && ref.startsWith('refs/tags/') && repo.objects.get(oid)?.type === 'tag') {
        parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function advertiseV2Upload(): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine(`agent=${AGENT}\n`));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow filter\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefs(repo: Repo, options: LsRefsOptions): Buffer {
  const parts: Buffer[] = [];
  const headTip = repo.refs.get('refs/heads/main');
  const matches = (ref: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((p) => ref.startsWith(p));
  if (headTip === undefined) {
    if (options.unborn && matches('HEAD')) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    if (matches('HEAD')) {
      const attrs = options.symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(pktLine(`${headTip} HEAD${attrs}\n`));
    }
    for (const [ref, oid] of sortedRefs(repo)) {
      if (!matches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (options.peel && ref.startsWith('refs/tags/') && repo.objects.get(oid)?.type === 'tag') {
        const peeled = peelOid(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Upload-pack (fetch), v2 and v0
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string | null;
  thinPack: boolean;
}

export function parseFetchRequest(items: PktItem[]): FetchRequest {
  const req: FetchRequest = {
    wants: [],
    haves: [],
    shallowLines: [],
    deepen: null,
    deepenSince: null,
    deepenNot: null,
    thinPack: false,
  };
  for (const item of items) {
    if (item.kind !== 'data') continue;
    const line = item.data.toString('utf8').trim();
    if (line === 'thin-pack') req.thinPack = true;
    else if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) req.deepen = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(13).trim());
      if (Number.isFinite(n)) req.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      req.deepenNot = line.slice(11).trim();
    }
    // thin-pack / no-progress / ofs-delta / filter / agent / command= / done: ignored
  }
  return req;
}

export function fetchResponseV2(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const selection = selectFetchObjects(store, repo, req.wants, req.haves, req.shallowLines, req.deepen, req.deepenSince, req.deepenNot);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (selection.acks.length > 0) {
    for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  const shallowRelated = req.deepen !== null || req.deepenSince !== null || req.shallowLines.length > 0;
  if (shallowRelated) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function fetchResponseV0(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const selection = selectFetchObjects(store, repo, req.wants, req.haves, req.shallowLines, req.deepen, req.deepenSince, req.deepenNot);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (selection.acks.length > 0) {
    for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  // No 'ready' line in v0, ever.
  const shallowRelated = req.deepen !== null || req.deepenSince !== null || req.shallowLines.length > 0;
  if (shallowRelated) {
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (push)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer; sideBand: boolean } {
  const commands: PushCommand[] = [];
  let sideBand = false;
  let first = true;
  let scan = 0;
  let packStart = body.length;
  while (scan + 4 <= body.length) {
    const head = body.toString('ascii', scan, scan + 4);
    if (head === '0000') {
      packStart = scan + 4;
      break;
    }
    if (head === '0001') {
      scan += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || scan + len > body.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    let line = body.toString('utf8', scan + 4, scan + len);
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.includes('side-band-64k')) sideBand = true;
        line = line.slice(0, nul);
      }
    }
    line = line.trim();
    if (line !== '') {
      const [oldOid, newOid, ref] = line.split(' ');
      if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
    }
    scan += len;
  }
  return { commands, pack: body.subarray(packStart), sideBand };
}

export function applyPush(store: Store, repo: Repo, commands: PushCommand[], objects: ParsedPackObject[]): PushReport {
  const report: PushReport = { unpackOk: true, unpackDetail: '', refs: [] };
  for (const obj of objects) {
    if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        report.refs.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        repo.refs.delete(cmd.ref);
        report.refs.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) {
        report.refs.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        report.refs.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.refs.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // update
    if (current === undefined) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (current !== cmd.oldOid) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.newOid === cmd.oldOid) {
      report.refs.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.refs.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return report;
}

export function pushResponse(report: PushReport, sideBand: boolean): Buffer {
  const lines: string[] = [];
  if (report.unpackOk) lines.push('unpack ok\n');
  else lines.push(`unpack ${report.unpackDetail}\n`);
  for (const entry of report.refs) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const parts: Buffer[] = [];
  if (sideBand) {
    for (const line of lines) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
  } else {
    for (const line of lines) parts.push(pktLine(line));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
