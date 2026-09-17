'use strict';
/**
 * Finder `.DS_Store` writer and reader.
 *
 * Container: a buddy-allocator file ("Bud1"). After a 4-byte file prefix all
 * offsets are relative to byte 4. A block address packs offset and size into
 * one u32: the low 5 bits are log2(size), the rest is the offset. Block 0 is
 * the allocator's own bookkeeping block (block table, a name -> block
 * directory and 32 free lists); the directory entry "DSDB" names the B-tree
 * superblock, whose nodes are 4 KiB pages of records.
 *
 * Record: u32 name length, UTF-16BE name, 4-char structure id, 4-char type,
 * payload. Records sort by lower-cased name, then structure id.
 *
 * Format knowledge comes from the MIT-licensed `ds_store` Python package by
 * Alastair Houghton and Wim Lewis' notes for Mac::Finder::DSStore (NOTICE.md).
 */

const PAGE_SIZE = 4096;
const NODE_HEADER = 8;
// A record has to leave room for two more in its page or the bulk loader
// below cannot always produce valid nodes.
const MAX_RECORD = Math.floor((PAGE_SIZE - NODE_HEADER) / 3);
// Bytes 20..35 of the header. Their meaning is unknown; these are the values
// every known writer copies.
const HEADER_UNKNOWN = Buffer.from('0000100c000000870000200b00000000', 'hex');

function utf16be(s) {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return b;
}

function fromUtf16be(buf) {
  const c = Buffer.from(buf);
  c.swap16();
  return c.toString('utf16le');
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}

// ---------------------------------------------------------------- writer

function encodeRecord(r) {
  if (r.id.length !== 4 || r.type.length !== 4) throw new Error('dsstore: id and type must be 4 characters');
  const name = utf16be(r.name);
  const head = Buffer.concat([u32(r.name.length), name, Buffer.from(r.id + r.type, 'latin1')]);
  let payload;
  switch (r.type) {
    case 'long': case 'shor': payload = u32(r.value); break;
    case 'bool': payload = Buffer.from([r.value ? 1 : 0]); break;
    case 'blob': payload = Buffer.concat([u32(r.value.length), r.value]); break;
    case 'type': payload = Buffer.from(String(r.value).padEnd(4, ' ').slice(0, 4), 'latin1'); break;
    case 'ustr': payload = Buffer.concat([u32(r.value.length), utf16be(r.value)]); break;
    case 'comp': case 'dutc': payload = Buffer.alloc(8); payload.writeBigUInt64BE(BigInt(r.value), 0); break;
    default: throw new Error('dsstore: unknown record type ' + r.type);
  }
  return Buffer.concat([head, payload]);
}

function compareRecords(a, b) {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Buddy allocator over the 2 GiB address space; the 32-byte header is the block at offset 0. */
class Buddy {
  constructor() {
    this.free = [];
    for (let w = 0; w < 32; w++) this.free.push(w >= 5 && w <= 30 ? [2 ** w] : []);
    this.blocks = []; // block number -> address
    this.end = 32;
  }
  allocate(bytes) {
    let width = 5;
    while (2 ** width < bytes) width++;
    let w = width;
    while (w < 32 && !this.free[w].length) w++;
    if (w >= 32) throw new Error('dsstore: out of space');
    const offset = this.free[w].shift();
    while (w > width) { // split, keeping the lower half
      w--;
      this.free[w].push(offset + 2 ** w);
      this.free[w].sort((a, b) => a - b);
    }
    this.blocks.push(offset | width);
    this.end = Math.max(this.end, offset + 2 ** width);
    return { number: this.blocks.length - 1, offset, size: 2 ** width };
  }
}

/** Iloc payload: icon position, then the fixed trailer Finder writes. */
function ilocValue(x, y) {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(Math.round(x) >>> 0, 0);
  b.writeUInt32BE(Math.round(y) >>> 0, 4);
  b.writeUInt32BE(0xffffffff, 8);
  b.writeUInt32BE(0xffff0000, 12);
  return b;
}

/**
 * @param {Array<{name:string,id:string,type:string,value:*}>} records
 * @returns {Buffer} the complete .DS_Store file
 */
function buildDSStore(records) {
  const sorted = [...records].sort(compareRecords);
  for (let i = 1; i < sorted.length; i++) {
    if (compareRecords(sorted[i - 1], sorted[i]) === 0) {
      throw new Error('dsstore: duplicate record ' + sorted[i].name + '/' + sorted[i].id);
    }
  }
  const encoded = sorted.map(encodeRecord);
  const total = encoded.reduce((n, r) => n + r.length, 0);
  const multiPage = NODE_HEADER + total > PAGE_SIZE;
  if (multiPage) {
    for (const r of encoded) if (r.length > MAX_RECORD) throw new Error('dsstore: record too large for a multi-page store');
  }

  // Leaves: fill greedily; the record that does not fit moves up as separator.
  const leaves = [];
  let seps = [];
  let cur = [];
  let size = NODE_HEADER;
  for (let i = 0; i < encoded.length; i++) {
    const r = encoded[i];
    if (size + r.length <= PAGE_SIZE) { cur.push(r); size += r.length; continue; }
    if (i === encoded.length - 1) { // keep the last leaf non-empty
      seps.push(cur.pop());
      leaves.push(cur);
      cur = [r];
      size = NODE_HEADER + r.length;
    } else {
      seps.push(r);
      leaves.push(cur);
      cur = [];
      size = NODE_HEADER;
    }
  }
  leaves.push(cur);

  // Block numbers: 0 = allocator info, 1 = superblock, then nodes in creation order.
  let nextBlock = 2;
  const nodes = []; // { number, bytes }
  const makeNode = (rightmost, children, recs) => {
    const parts = [u32(rightmost), u32(recs.length)];
    recs.forEach((rec, i) => { if (children) parts.push(u32(children[i])); parts.push(rec); });
    const bytes = Buffer.concat(parts);
    if (bytes.length > PAGE_SIZE) throw new Error('dsstore: node overflow');
    const number = nextBlock++;
    nodes.push({ number, bytes });
    return number;
  };

  let level = leaves.map((recs) => makeNode(0, null, recs));
  let height = 0;
  while (level.length > 1) {
    // level has n children and seps has n-1 separators; group them into parents.
    const parents = [];
    const upSeps = [];
    let group = { children: [level[0]], seps: [] };
    let used = NODE_HEADER;
    for (let i = 1; i < level.length; i++) {
      const sep = seps[i - 1];
      const need = 4 + sep.length;
      const isLastChild = i === level.length - 1;
      // Start a new parent when full - unless that would strand a lone last child.
      if (used + need > PAGE_SIZE && group.seps.length >= 2 && !isLastChild) {
        parents.push(group);
        upSeps.push(sep);
        group = { children: [level[i]], seps: [] };
        used = NODE_HEADER;
      } else if (used + need > PAGE_SIZE) {
        // Full, but splitting here is not allowed: move the previous separator up instead.
        const movedSep = group.seps.pop();
        const movedChild = group.children.pop();
        parents.push(group);
        upSeps.push(movedSep);
        group = { children: [movedChild, level[i]], seps: [sep] };
        used = NODE_HEADER + need;
      } else {
        group.children.push(level[i]);
        group.seps.push(sep);
        used += need;
      }
    }
    parents.push(group);
    level = parents.map((g) => makeNode(g.children[g.children.length - 1], g.children, g.seps));
    seps = upSeps;
    height++;
  }
  const rootNode = level[0];

  // Lay the blocks out. The info block's size depends on how many blocks exist.
  const buddy = new Buddy();
  const blockCount = 2 + nodes.length;
  const tableEntries = Math.ceil(blockCount / 256) * 256;
  const infoMax = 8 + tableEntries * 4 + 4 + (1 + 4 + 4) + 32 * 4 + 64 * 4; // generous room for the free lists
  const info = buddy.allocate(Math.max(infoMax, 2048));
  const superblock = buddy.allocate(20);
  const placed = nodes.map((n) => ({ node: n, block: buddy.allocate(PAGE_SIZE) }));

  const file = Buffer.alloc(4 + buddy.end);
  const header = Buffer.alloc(36);
  header.writeUInt32BE(1, 0);
  header.write('Bud1', 4, 'latin1');
  header.writeUInt32BE(info.offset, 8);
  header.writeUInt32BE(info.size, 12);
  header.writeUInt32BE(info.offset, 16);
  HEADER_UNKNOWN.copy(header, 20);
  header.copy(file, 0);

  const sb = Buffer.alloc(20);
  sb.writeUInt32BE(rootNode, 0);
  sb.writeUInt32BE(height, 4); // levels of internal nodes (0 = the root is a leaf)
  sb.writeUInt32BE(encoded.length, 8);
  sb.writeUInt32BE(nodes.length, 12);
  sb.writeUInt32BE(PAGE_SIZE, 16);
  sb.copy(file, 4 + superblock.offset);
  for (const p of placed) p.node.bytes.copy(file, 4 + p.block.offset);

  const infoParts = [u32(buddy.blocks.length), u32(0)];
  for (let i = 0; i < tableEntries; i++) infoParts.push(u32(i < buddy.blocks.length ? buddy.blocks[i] : 0));
  infoParts.push(u32(1), Buffer.from([4]), Buffer.from('DSDB', 'latin1'), u32(superblock.number));
  for (let w = 0; w < 32; w++) {
    infoParts.push(u32(buddy.free[w].length));
    for (const off of buddy.free[w]) infoParts.push(u32(off));
  }
  const infoBytes = Buffer.concat(infoParts);
  if (infoBytes.length > info.size) throw new Error('dsstore: allocator block overflow');
  infoBytes.copy(file, 4 + info.offset);
  return file;
}

// ---------------------------------------------------------------- reader

/** Parse a .DS_Store into { records:[{name,id,type,value}], levels, nodes, pageSize } (records in tree order). */
function parseDSStore(file) {
  if (file.length < 36 || file.readUInt32BE(0) !== 1 || file.toString('latin1', 4, 8) !== 'Bud1') {
    throw new Error('dsstore: bad header');
  }
  const infoOffset = file.readUInt32BE(8);
  const infoSize = file.readUInt32BE(12);
  if (file.readUInt32BE(16) !== infoOffset) throw new Error('dsstore: header offsets disagree');
  const info = file.subarray(4 + infoOffset, 4 + infoOffset + infoSize);
  const count = info.readUInt32BE(0);
  const addresses = [];
  for (let i = 0; i < count; i++) addresses.push(info.readUInt32BE(8 + i * 4));
  let pos = 8 + Math.ceil(count / 256) * 256 * 4;
  const directory = {};
  const dirCount = info.readUInt32BE(pos);
  pos += 4;
  for (let i = 0; i < dirCount; i++) {
    const len = info[pos];
    const name = info.toString('latin1', pos + 1, pos + 1 + len);
    directory[name] = info.readUInt32BE(pos + 1 + len);
    pos += 1 + len + 4;
  }
  const freeLists = [];
  for (let w = 0; w < 32; w++) {
    const n = info.readUInt32BE(pos);
    pos += 4;
    const list = [];
    for (let i = 0; i < n; i++) { list.push(info.readUInt32BE(pos)); pos += 4; }
    freeLists.push(list);
  }

  const block = (number) => {
    if (number >= addresses.length) throw new Error('dsstore: bad block number ' + number);
    const addr = addresses[number];
    const offset = addr & ~0x1f;
    const size = 2 ** (addr & 0x1f);
    return file.subarray(4 + offset, 4 + offset + size);
  };

  if (directory.DSDB === undefined) throw new Error('dsstore: no DSDB entry');
  const sb = block(directory.DSDB);
  const rootNode = sb.readUInt32BE(0);
  const levels = sb.readUInt32BE(4);
  const recordCount = sb.readUInt32BE(8);
  const nodeCount = sb.readUInt32BE(12);
  const pageSize = sb.readUInt32BE(16);

  const records = [];
  let visited = 0;
  function readRecord(buf, p) {
    const nameLen = buf.readUInt32BE(p);
    p += 4;
    const name = fromUtf16be(buf.subarray(p, p + nameLen * 2));
    p += nameLen * 2;
    const id = buf.toString('latin1', p, p + 4);
    const type = buf.toString('latin1', p + 4, p + 8);
    p += 8;
    let value;
    switch (type) {
      case 'long': case 'shor': value = buf.readUInt32BE(p); p += 4; break;
      case 'bool': value = buf[p] !== 0; p += 1; break;
      case 'blob': { const n = buf.readUInt32BE(p); value = Buffer.from(buf.subarray(p + 4, p + 4 + n)); p += 4 + n; break; }
      case 'type': value = buf.toString('latin1', p, p + 4); p += 4; break;
      case 'ustr': { const n = buf.readUInt32BE(p); value = fromUtf16be(buf.subarray(p + 4, p + 4 + n * 2)); p += 4 + n * 2; break; }
      case 'comp': case 'dutc': value = buf.readBigUInt64BE(p); p += 8; break;
      default: throw new Error('dsstore: unknown record type ' + JSON.stringify(type));
    }
    records.push({ name, id, type, value });
    return p;
  }
  function walk(number, depth) {
    if (depth > 32) throw new Error('dsstore: tree too deep');
    visited++;
    const buf = block(number);
    const rightmost = buf.readUInt32BE(0);
    const n = buf.readUInt32BE(4);
    let p = 8;
    for (let i = 0; i < n; i++) {
      if (rightmost) { walk(buf.readUInt32BE(p), depth + 1); p += 4; }
      p = readRecord(buf, p);
    }
    if (rightmost) walk(rightmost, depth + 1);
  }
  walk(rootNode, 0);

  return { records, levels, recordCount, nodeCount, visitedNodes: visited, pageSize, addresses, freeLists, directory };
}

module.exports = { buildDSStore, parseDSStore, ilocValue, compareRecords, PAGE_SIZE };
