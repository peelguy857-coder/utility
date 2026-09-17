'use strict';
/**
 * DMG reader: parses a UDIF image and the HFS+/HFSX volume inside it, and
 * re-derives everything the writer computed so the two can be compared.
 *
 * It is deliberately independent of the writer modules (it shares only the
 * CRC, plist and .DS_Store parsers) so a mistake in the writer cannot hide
 * behind the same mistake in the reader.
 *
 * Handles zlib / raw / zero-fill / ignore chunks, images with or without a
 * partition map, files with up to 8 extents plus the extents-overflow tree.
 * Not handled: bzip2/lzfse/lzma chunks, encrypted or segmented images,
 * HFS+ compression (decmpfs) and hard links (reported as plain files).
 */
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { crc32 } = require('./crc32.cjs');
const { parsePlist } = require('./plist.cjs');
const { parseDSStore } = require('./dsstore.cjs');

const SECTOR = 512;
const CHUNK_ZERO = 0x00000000;
const CHUNK_RAW = 0x00000001;
const CHUNK_IGNORE = 0x00000002;
const CHUNK_COMMENT = 0x7ffffffe;
const CHUNK_ZLIB = 0x80000005;
const CHUNK_TERMINATOR = 0xffffffff;
const CHUNK_NAMES = { 0x80000004: 'ADC', 0x80000006: 'bzip2', 0x80000007: 'LZFSE', 0x80000008: 'LZMA' };

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const HFS_EPOCH_OFFSET = 2082844800;

function inflate(buf) {
  return new Promise((resolve, reject) => zlib.inflate(buf, (err, out) => (err ? reject(err) : resolve(out))));
}

// ------------------------------------------------------------------ UDIF

class DmgImage {
  static async open(dmgPath) {
    const img = new DmgImage();
    img.handle = await fs.promises.open(dmgPath, 'r');
    try {
      await img._parse();
    } catch (err) {
      await img.close();
      throw err;
    }
    return img;
  }

  async close() {
    if (this.handle) await this.handle.close().catch(() => {});
    this.handle = null;
  }

  async _readFile(position, length) {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buf, done, length - done, position + done);
      if (!bytesRead) throw new Error('dmg: unexpected end of file');
      done += bytesRead;
    }
    return buf;
  }

  async _parse() {
    const { size } = await this.handle.stat();
    if (size < 512) throw new Error('Not a disk image (too small)');
    this.fileSize = size;
    const k = await this._readFile(size - 512, 512);
    if (k.toString('latin1', 0, 4) !== 'koly') throw new Error('Not a UDIF disk image (no koly trailer)');
    this.koly = {
      version: k.readUInt32BE(4), headerSize: k.readUInt32BE(8), flags: k.readUInt32BE(12),
      runningDataForkOffset: Number(k.readBigUInt64BE(16)), dataForkOffset: Number(k.readBigUInt64BE(24)),
      dataForkLength: Number(k.readBigUInt64BE(32)), rsrcForkOffset: Number(k.readBigUInt64BE(40)),
      rsrcForkLength: Number(k.readBigUInt64BE(48)), segmentNumber: k.readUInt32BE(56), segmentCount: k.readUInt32BE(60),
      segmentId: k.toString('hex', 64, 80), dataChecksumType: k.readUInt32BE(80), dataChecksumBits: k.readUInt32BE(84),
      dataChecksum: k.readUInt32BE(88), xmlOffset: Number(k.readBigUInt64BE(216)), xmlLength: Number(k.readBigUInt64BE(224)),
      checksumType: k.readUInt32BE(352), checksumBits: k.readUInt32BE(356), checksum: k.readUInt32BE(360),
      imageVariant: k.readUInt32BE(488), sectorCount: Number(k.readBigUInt64BE(492)),
    };
    if (!this.koly.xmlLength) throw new Error('dmg: image has no XML property list');
    this.plist = parsePlist(await this._readFile(this.koly.xmlOffset, this.koly.xmlLength));
    const fork = this.plist['resource-fork'] || {};
    this.resourceKeys = Object.keys(fork);
    this.blocks = [];
    this.chunks = [];
    for (const item of fork.blkx || []) {
      const d = item.Data;
      if (!Buffer.isBuffer(d) || d.length < 204 || d.toString('latin1', 0, 4) !== 'mish') throw new Error('dmg: damaged blkx entry');
      const block = {
        name: item.Name || item.CFName || '', id: item.ID, attributes: item.Attributes,
        version: d.readUInt32BE(4), firstSector: Number(d.readBigUInt64BE(8)), sectorCount: Number(d.readBigUInt64BE(16)),
        dataOffset: Number(d.readBigUInt64BE(24)), buffersNeeded: d.readUInt32BE(32), descriptor: d.readUInt32BE(36),
        checksumType: d.readUInt32BE(64), checksumBits: d.readUInt32BE(68), checksum: d.readUInt32BE(72),
        chunkCount: d.readUInt32BE(200), chunks: [],
      };
      if (d.length < 204 + 40 * block.chunkCount) throw new Error('dmg: truncated chunk table');
      for (let i = 0; i < block.chunkCount; i++) {
        const p = 204 + 40 * i;
        const c = {
          type: d.readUInt32BE(p), comment: d.readUInt32BE(p + 4), sector: Number(d.readBigUInt64BE(p + 8)),
          sectors: Number(d.readBigUInt64BE(p + 16)), offset: Number(d.readBigUInt64BE(p + 24)), length: Number(d.readBigUInt64BE(p + 32)),
        };
        block.chunks.push(c);
        if (c.type === CHUNK_TERMINATOR || c.type === CHUNK_COMMENT || !c.sectors) continue;
        this.chunks.push({
          type: c.type, diskStart: (block.firstSector + c.sector) * SECTOR, diskLength: c.sectors * SECTOR,
          fileOffset: this.koly.dataForkOffset + block.dataOffset + c.offset, fileLength: c.length,
        });
      }
      this.blocks.push(block);
    }
    this.chunks.sort((a, b) => a.diskStart - b.diskStart);
    this.cache = new Map(); // chunk -> inflated Buffer, small LRU
  }

  async _chunkData(c) {
    if (this.cache.has(c)) {
      const hit = this.cache.get(c);
      this.cache.delete(c);
      this.cache.set(c, hit);
      return hit;
    }
    let data;
    if (c.type === CHUNK_RAW) {
      data = await this._readFile(c.fileOffset, c.fileLength);
    } else if (c.type === CHUNK_ZLIB) {
      data = await inflate(await this._readFile(c.fileOffset, c.fileLength));
    } else {
      throw new Error('dmg: unsupported chunk type 0x' + c.type.toString(16) + (CHUNK_NAMES[c.type] ? ' (' + CHUNK_NAMES[c.type] + ')' : ''));
    }
    if (data.length !== c.diskLength) throw new Error('dmg: chunk at sector ' + c.diskStart / SECTOR + ' has the wrong length');
    this.cache.set(c, data);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return data;
  }

  /** Read `length` bytes of the virtual disk at byte `offset`. */
  async read(offset, length) {
    const out = Buffer.alloc(length); // gaps and zero-fill chunks read as zeros
    let lo = 0;
    let hi = this.chunks.length - 1;
    let first = this.chunks.length;
    while (lo <= hi) { // first chunk that ends after `offset`
      const mid = (lo + hi) >> 1;
      if (this.chunks[mid].diskStart + this.chunks[mid].diskLength > offset) { first = mid; hi = mid - 1; } else lo = mid + 1;
    }
    for (let i = first; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c.diskStart >= offset + length) break;
      if (c.type === CHUNK_ZERO || c.type === CHUNK_IGNORE) continue;
      const data = await this._chunkData(c);
      const from = Math.max(offset, c.diskStart);
      const to = Math.min(offset + length, c.diskStart + c.diskLength);
      data.copy(out, from - offset, from - c.diskStart, to - c.diskStart);
    }
    return out;
  }

  /** Recompute all three checksums from the file. */
  async verifyChecksums() {
    const checks = [];
    const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');

    let crc = 0;
    const step = 4 << 20;
    for (let pos = 0; pos < this.koly.dataForkLength; pos += step) {
      crc = crc32(await this._readFile(this.koly.dataForkOffset + pos, Math.min(step, this.koly.dataForkLength - pos)), crc);
    }
    checks.push({ name: 'koly data-fork CRC32', ok: crc === this.koly.dataChecksum, detail: 'stored ' + hex(this.koly.dataChecksum) + ', computed ' + hex(crc) });

    const zeros = Buffer.alloc(1 << 20);
    const master = Buffer.alloc(4 * this.blocks.length);
    for (let b = 0; b < this.blocks.length; b++) {
      const block = this.blocks[b];
      let c32 = 0;
      let sector = 0;
      let ordered = true;
      for (const c of block.chunks) {
        if (c.type === CHUNK_COMMENT) continue;
        if (c.sector !== sector) ordered = false;
        if (c.type === CHUNK_TERMINATOR) break;
        if (c.type === CHUNK_ZERO || c.type === CHUNK_IGNORE) {
          for (let left = c.sectors * SECTOR; left > 0; left -= zeros.length) c32 = crc32(zeros.subarray(0, Math.min(left, zeros.length)), c32);
        } else {
          c32 = crc32(await this._chunkData({
            type: c.type, diskStart: (block.firstSector + c.sector) * SECTOR, diskLength: c.sectors * SECTOR,
            fileOffset: this.koly.dataForkOffset + block.dataOffset + c.offset, fileLength: c.length,
          }), c32);
          this.cache.clear();
        }
        sector += c.sectors;
      }
      master.writeUInt32BE(block.checksum, b * 4);
      const label = 'blkx[' + b + '] "' + block.name + '"';
      checks.push({ name: label + ' CRC32 of uncompressed data', ok: c32 === block.checksum, detail: 'stored ' + hex(block.checksum) + ', computed ' + hex(c32) });
      checks.push({ name: label + ' chunk table is contiguous', ok: ordered && sector === block.sectorCount, detail: sector + ' of ' + block.sectorCount + ' sectors covered' });
      const term = block.chunks[block.chunks.length - 1];
      checks.push({ name: label + ' ends with a terminator', ok: !!term && term.type === CHUNK_TERMINATOR && term.sector === block.sectorCount, detail: term ? 'type 0x' + term.type.toString(16) : 'no chunks' });
    }
    const m = crc32(master);
    checks.push({ name: 'koly master CRC32', ok: m === this.koly.checksum, detail: 'stored ' + hex(this.koly.checksum) + ', computed ' + hex(m) });
    return checks;
  }

  /** Structural consistency of trailer, plist and block tables. */
  containerChecks() {
    const k = this.koly;
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail) });
    add('koly version/size', k.version === 4 && k.headerSize === 512, 'version ' + k.version + ', header ' + k.headerSize);
    add('koly segment 1 of 1', k.segmentNumber === 1 && k.segmentCount === 1, k.segmentNumber + '/' + k.segmentCount);
    add('koly checksum types are CRC32', k.dataChecksumType === 2 && k.dataChecksumBits === 32 && k.checksumType === 2 && k.checksumBits === 32, 'types ' + k.dataChecksumType + '/' + k.checksumType);
    add('plist follows the data fork', k.xmlOffset === k.dataForkOffset + k.dataForkLength, 'xml at ' + k.xmlOffset + ', data fork ends at ' + (k.dataForkOffset + k.dataForkLength));
    add('koly follows the plist', k.xmlOffset + k.xmlLength === this.fileSize - 512, 'xml ends at ' + (k.xmlOffset + k.xmlLength) + ', koly at ' + (this.fileSize - 512));
    const sectors = this.blocks.reduce((max, b) => Math.max(max, b.firstSector + b.sectorCount), 0);
    add('koly sector count matches the blkx tables', sectors === k.sectorCount, 'koly ' + k.sectorCount + ', blkx ' + sectors);
    let inside = true;
    for (const c of this.chunks) if (c.fileLength && c.fileOffset + c.fileLength > k.dataForkOffset + k.dataForkLength) inside = false;
    add('every chunk lies inside the data fork', inside, this.chunks.length + ' data chunks');
    return checks;
  }
}

// ------------------------------------------------------------------ HFS+

function parseFork(buf, offset) {
  const fork = { logicalSize: Number(buf.readBigUInt64BE(offset)), clumpSize: buf.readUInt32BE(offset + 8), totalBlocks: buf.readUInt32BE(offset + 12), extents: [] };
  for (let i = 0; i < 8; i++) {
    const start = buf.readUInt32BE(offset + 16 + i * 8);
    const count = buf.readUInt32BE(offset + 20 + i * 8);
    if (count) fork.extents.push({ start, count });
  }
  return fork;
}

function parseVolumeHeader(b) {
  return {
    signature: b.toString('latin1', 0, 2), version: b.readUInt16BE(2), attributes: b.readUInt32BE(4),
    lastMountedVersion: b.toString('latin1', 8, 12), journalInfoBlock: b.readUInt32BE(12),
    createDate: b.readUInt32BE(16), modifyDate: b.readUInt32BE(20), backupDate: b.readUInt32BE(24), checkedDate: b.readUInt32BE(28),
    fileCount: b.readUInt32BE(32), folderCount: b.readUInt32BE(36), blockSize: b.readUInt32BE(40), totalBlocks: b.readUInt32BE(44),
    freeBlocks: b.readUInt32BE(48), nextAllocation: b.readUInt32BE(52), rsrcClumpSize: b.readUInt32BE(56), dataClumpSize: b.readUInt32BE(60),
    nextCatalogID: b.readUInt32BE(64), writeCount: b.readUInt32BE(68), encodingsBitmap: b.readBigUInt64BE(72),
    finderInfo: Array.from({ length: 8 }, (_, i) => b.readUInt32BE(80 + i * 4)),
    allocationFile: parseFork(b, 112), extentsFile: parseFork(b, 192), catalogFile: parseFork(b, 272),
    attributesFile: parseFork(b, 352), startupFile: parseFork(b, 432),
  };
}

function utf16beToString(buf) {
  const c = Buffer.from(buf);
  c.swap16();
  return c.toString('utf16le');
}

class HfsReader {
  constructor(image, partitionOffset) {
    this.image = image;
    this.base = partitionOffset;
    this.checks = [];
  }

  _check(name, ok, detail) { this.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); }

  async init() {
    const raw = await this.image.read(this.base + 1024, 512);
    this.header = parseVolumeHeader(raw);
    this.rawHeader = raw;
    const h = this.header;
    if (h.signature !== 'H+' && h.signature !== 'HX') throw new Error('No HFS+ volume header found');
    if (!h.blockSize || h.blockSize & (h.blockSize - 1)) throw new Error('hfs: bad allocation block size');
    this.blockSize = h.blockSize;
    this.volumeBytes = h.totalBlocks * h.blockSize;
  }

  /** Read a byte range of a fork given its extent list. */
  async readExtents(extents, offset, length) {
    const parts = [];
    let skip = offset;
    let left = length;
    for (const ext of extents) {
      const bytes = ext.count * this.blockSize;
      if (skip >= bytes) { skip -= bytes; continue; }
      const n = Math.min(left, bytes - skip);
      parts.push(await this.image.read(this.base + ext.start * this.blockSize + skip, n));
      left -= n;
      skip = 0;
      if (!left) break;
    }
    if (left) throw new Error('hfs: fork is shorter than its logical size');
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** All extents of a fork, consulting the overflow tree when the first 8 do not cover it. */
  forkExtents(fork, cnid, forkType) {
    let have = fork.extents.reduce((n, e) => n + e.count, 0);
    if (have >= fork.totalBlocks || !this.overflow) return fork.extents;
    const all = [...fork.extents];
    for (;;) {
      const more = this.overflow.get(forkType + ':' + cnid + ':' + have);
      if (!more) break;
      for (const e of more) { all.push(e); have += e.count; }
      if (have >= fork.totalBlocks) break;
    }
    return all;
  }

  /**
   * Load a B-tree completely and verify its structure.
   * Returns { header, leafRecords:[{key,data,node}], usedNodes:Set }.
   */
  async loadBTree(label, fork, compareKeys) {
    const out = { header: null, leafRecords: [], ok: true };
    if (!fork.totalBlocks) return out;
    const extents = fork.extents;
    const head = await this.readExtents(extents, 0, 512);
    const nodeSize = head.readUInt16BE(14 + 18);
    const treeBytes = fork.logicalSize;
    const hdr = {
      treeDepth: head.readUInt16BE(14), rootNode: head.readUInt32BE(16), leafRecords: head.readUInt32BE(20),
      firstLeafNode: head.readUInt32BE(24), lastLeafNode: head.readUInt32BE(28), nodeSize,
      maxKeyLength: head.readUInt16BE(34), totalNodes: head.readUInt32BE(36), freeNodes: head.readUInt32BE(40),
      clumpSize: head.readUInt32BE(46), btreeType: head[50], keyCompareType: head[51], attributes: head.readUInt32BE(52),
    };
    out.header = hdr;
    const check = (name, ok, detail) => { if (!ok) out.ok = false; this._check(label + ': ' + name, ok, detail); };
    check('node size is a power of two >= 512', nodeSize >= 512 && !(nodeSize & (nodeSize - 1)), nodeSize);
    if (nodeSize < 512 || nodeSize & (nodeSize - 1)) return out;
    check('totalNodes * nodeSize equals the fork size', hdr.totalNodes * nodeSize === treeBytes && treeBytes === fork.totalBlocks * this.blockSize,
      hdr.totalNodes + ' nodes x ' + nodeSize + ' vs ' + treeBytes + ' bytes / ' + fork.totalBlocks + ' blocks');

    const nodeCache = new Map();
    const readNode = async (n) => {
      if (nodeCache.has(n)) return nodeCache.get(n);
      if (n >= hdr.totalNodes) throw new Error(label + ': node ' + n + ' is outside the tree');
      const buf = await this.readExtents(extents, n * nodeSize, nodeSize);
      const node = { number: n, fLink: buf.readUInt32BE(0), bLink: buf.readUInt32BE(4), kind: buf.readInt8(8), height: buf[9], numRecords: buf.readUInt16BE(10), buf, records: [] };
      // Record offsets grow backwards from the end of the node; one extra entry marks the free space.
      let previous = 14;
      let sane = true;
      for (let i = 0; i <= node.numRecords; i++) {
        const off = buf.readUInt16BE(nodeSize - 2 * (i + 1));
        if (i === 0 ? off !== 14 : off < previous || off > nodeSize - 2 * (node.numRecords + 1)) sane = false;
        if (i > 0) node.records.push(buf.subarray(previous, off));
        previous = off;
      }
      node.sane = sane;
      nodeCache.set(n, node);
      if (nodeCache.size > 64) nodeCache.delete(nodeCache.keys().next().value);
      return node;
    };

    const used = new Set([0]);
    const problems = [];
    const note = (msg) => { if (problems.length < 10) problems.push(msg); };

    // Header node + map chain.
    const headerNode = await readNode(0);
    check('header node has kind 1 and three records', headerNode.kind === 1 && headerNode.numRecords === 3 && headerNode.sane,
      'kind ' + headerNode.kind + ', records ' + headerNode.numRecords);
    const mapParts = [Buffer.from(headerNode.records[2] || Buffer.alloc(0))];
    let mapOk = true;
    for (let m = headerNode.fLink, guard = 0; m; guard++) {
      if (guard > hdr.totalNodes || used.has(m)) { mapOk = false; break; }
      const mapNode = await readNode(m);
      used.add(m);
      if (mapNode.kind !== 2 || mapNode.numRecords !== 1 || !mapNode.sane) { mapOk = false; break; }
      mapParts.push(Buffer.from(mapNode.records[0]));
      m = mapNode.fLink;
    }
    const map = Buffer.concat(mapParts);
    check('map node chain is well formed', mapOk, mapParts.length - 1 + ' map node(s)');
    check('map record(s) cover every node', map.length * 8 >= hdr.totalNodes, map.length * 8 + ' bits for ' + hdr.totalNodes + ' nodes');

    // Walk the tree from the root, level by level, checking each node against its parent's pointer.
    const keyOf = (rec) => rec.subarray(0, 2 + rec.readUInt16BE(0));
    let level = hdr.rootNode ? [{ number: hdr.rootNode, expectKey: null }] : [];
    let height = hdr.treeDepth;
    let leafCount = 0;
    let firstLeaf = 0;
    let lastLeaf = 0;
    if (!hdr.treeDepth) check('empty tree has no root', hdr.rootNode === 0 && hdr.firstLeafNode === 0 && hdr.lastLeafNode === 0 && hdr.leafRecords === 0, 'root ' + hdr.rootNode);
    while (level.length && height > 0) {
      const nextLevel = [];
      let previousKey = null;
      for (let i = 0; i < level.length; i++) {
        const { number, expectKey } = level[i];
        if (used.has(number)) { note('node ' + number + ' is referenced twice'); continue; }
        used.add(number);
        const node = await readNode(number);
        const isLeaf = height === 1;
        if (!node.sane) note('node ' + number + ' has a bad offset table');
        if (node.kind !== (isLeaf ? -1 : 0)) note('node ' + number + ' has kind ' + node.kind + ' at height ' + height);
        if (node.height !== height) note('node ' + number + ' says height ' + node.height + ', expected ' + height);
        if (!node.numRecords) note('node ' + number + ' is empty');
        const wantB = i > 0 ? level[i - 1].number : 0;
        const wantF = i + 1 < level.length ? level[i + 1].number : 0;
        if (node.bLink !== wantB || node.fLink !== wantF) note('node ' + number + ' sibling links ' + node.bLink + '/' + node.fLink + ', expected ' + wantB + '/' + wantF);
        node.records.forEach((rec, r) => {
          const keyLength = rec.readUInt16BE(0);
          if (keyLength > hdr.maxKeyLength || 2 + keyLength > rec.length) { note('node ' + number + ' record ' + r + ' has a bad key length'); return; }
          const key = keyOf(rec);
          if (r === 0 && expectKey && !key.equals(expectKey)) note('node ' + number + ': first key differs from the parent index key');
          if (previousKey && compareKeys && compareKeys(previousKey, key) >= 0) note('node ' + number + ' record ' + r + ': keys out of order');
          previousKey = key;
          let dataStart = 2 + keyLength;
          if (dataStart & 1) dataStart++;
          if (isLeaf) {
            out.leafRecords.push({ key, data: rec.subarray(dataStart), node: number });
          } else {
            if (rec.length < dataStart + 4) { note('node ' + number + ' record ' + r + ' has no child pointer'); return; }
            nextLevel.push({ number: rec.readUInt32BE(dataStart), expectKey: Buffer.from(key) });
          }
        });
        if (isLeaf) {
          leafCount += node.numRecords;
          if (i === 0) firstLeaf = number;
          lastLeaf = number;
        }
      }
      level = nextLevel;
      height--;
    }
    check('nodes: kinds, heights, sibling links, key order, index keys', problems.length === 0, problems.length ? problems.join('; ') : used.size + ' nodes visited');
    check('header leaf record count', leafCount === hdr.leafRecords, 'header ' + hdr.leafRecords + ', found ' + leafCount);
    check('header first/last leaf', firstLeaf === hdr.firstLeafNode && lastLeaf === hdr.lastLeafNode, 'header ' + hdr.firstLeafNode + '/' + hdr.lastLeafNode + ', found ' + firstLeaf + '/' + lastLeaf);
    check('header free node count', hdr.freeNodes === hdr.totalNodes - used.size, 'header ' + hdr.freeNodes + ', computed ' + (hdr.totalNodes - used.size));

    // Map bits must be set for exactly the nodes in use; unused nodes must be zeroed
    // (the volume header promises that via kHFSUnusedNodeFixMask).
    let mapMismatch = -1;
    let dirtyFree = -1;
    for (let n = 0; n < hdr.totalNodes; n++) {
      const bit = ((map[n >> 3] || 0) & (0x80 >> (n & 7))) !== 0;
      if (bit !== used.has(n) && mapMismatch < 0) mapMismatch = n;
      if (!used.has(n) && dirtyFree < 0 && hdr.totalNodes - used.size <= 4096) {
        const free = await this.readExtents(extents, n * nodeSize, nodeSize);
        if (!free.equals(Buffer.alloc(nodeSize))) dirtyFree = n;
      }
    }
    let strayBit = false;
    for (let n = hdr.totalNodes; n < map.length * 8; n++) if (map[n >> 3] & (0x80 >> (n & 7))) { strayBit = true; break; }
    check('map bits match the nodes in use', mapMismatch < 0 && !strayBit, mapMismatch < 0 ? (strayBit ? 'bits set beyond totalNodes' : used.size + ' bits') : 'first mismatch at node ' + mapMismatch);
    check('free nodes are zero-filled', dirtyFree < 0, dirtyFree < 0 ? '' : 'node ' + dirtyFree);
    return out;
  }

  async loadVolume() {
    const h = this.header;
    const bs = this.blockSize;

    const alt = await this.image.read(this.base + this.volumeBytes - 1024, 512);
    this._check('volume header: signature and version', (h.signature === 'HX' && h.version === 5) || (h.signature === 'H+' && h.version === 4), h.signature + ' v' + h.version);
    this._check('alternate volume header is identical', alt.equals(this.rawHeader), 'at volume size - 1024');
    this._check('volume is marked cleanly unmounted', (h.attributes & 0x100) !== 0 && (h.attributes & 0x800) === 0, 'attributes 0x' + h.attributes.toString(16));
    this._check('volume fits the image', this.base + this.volumeBytes <= this.image.koly.sectorCount * SECTOR, this.volumeBytes + ' bytes');

    // Extents overflow tree first (other forks may depend on it).
    const extentsTree = await this.loadBTree('extents B-tree', h.extentsFile, (a, b) => {
      // key: len(2) forkType(1) pad(1) fileID(4) startBlock(4)
      return a.readUInt32BE(4) - b.readUInt32BE(4) || a[2] - b[2] || a.readUInt32BE(8) - b.readUInt32BE(8);
    });
    this.overflow = new Map();
    for (const rec of extentsTree.leafRecords) {
      const list = [];
      for (let i = 0; i < 8; i++) {
        const count = rec.data.readUInt32BE(4 + i * 8);
        if (count) list.push({ start: rec.data.readUInt32BE(i * 8), count });
      }
      this.overflow.set(rec.key[2] + ':' + rec.key.readUInt32BE(4) + ':' + rec.key.readUInt32BE(8), list);
    }

    const catalogFork = Object.assign({}, h.catalogFile, { extents: this.forkExtents(h.catalogFile, 4, 0) });
    const peek = await this.readExtents(catalogFork.extents, 0, 512);
    const binaryCompare = peek[14 + 37] === 0xbc;
    this.caseSensitive = binaryCompare;
    const catalogTree = await this.loadBTree('catalog B-tree', catalogFork, (a, b) => {
      const pa = a.readUInt32BE(2);
      const pb = b.readUInt32BE(2);
      if (pa !== pb) return pa - pb;
      // Binary compare = UTF-16 code units, i.e. bytewise on big-endian text. Case-folded
      // trees (plain HFS+) need Apple's folding table; only the parent order is checked there.
      return binaryCompare ? Buffer.compare(a.subarray(8), b.subarray(8)) : -1;
    });
    const ch = catalogTree.header;
    if (h.signature === 'HX') this._check('catalog B-tree: HFSX key compare type', ch.keyCompareType === 0xbc || ch.keyCompareType === 0xcf, '0x' + ch.keyCompareType.toString(16));
    this._check('catalog B-tree: big keys + variable index keys', (ch.attributes & 6) === 6 && ch.maxKeyLength === 516, 'attributes 0x' + ch.attributes.toString(16) + ', maxKeyLength ' + ch.maxKeyLength);

    // Catalog records.
    const items = new Map(); // cnid -> item
    const threads = new Map(); // cnid -> { parent, name, isFolder }
    let rootName = '';
    for (const rec of catalogTree.leafRecords) {
      const parent = rec.key.readUInt32BE(2);
      const name = utf16beToString(rec.key.subarray(8, 8 + rec.key.readUInt16BE(6) * 2));
      const d = rec.data;
      const type = d.readInt16BE(0);
      if (type === 1 || type === 2) {
        const item = {
          cnid: d.readUInt32BE(8), parent, name, isFolder: type === 1, flags: d.readUInt16BE(2),
          createDate: d.readUInt32BE(12), modDate: d.readUInt32BE(16), uid: d.readUInt32BE(32), gid: d.readUInt32BE(36),
          rawMode: d.readUInt16BE(42), special: d.readUInt32BE(44), finderFlags: d.readUInt16BE(56), textEncoding: d.readUInt32BE(80),
        };
        if (type === 1) {
          item.valence = d.readUInt32BE(4);
          item.folderCount = d.readUInt32BE(84);
          item.children = 0;
          item.subfolders = 0;
        } else {
          item.fileType = d.toString('latin1', 48, 52);
          item.creator = d.toString('latin1', 52, 56);
          item.dataFork = parseFork(d, 88);
          item.resourceFork = parseFork(d, 168);
        }
        items.set(item.cnid, item);
        if (parent === 1) rootName = name;
      } else if (type === 3 || type === 4) {
        threads.set(parent, { parent: d.readUInt32BE(4), name: utf16beToString(d.subarray(10, 10 + d.readUInt16BE(8) * 2)), isFolder: type === 3 });
      }
    }

    // Threads <-> records, valence, counts.
    const problems = [];
    const note = (msg) => { if (problems.length < 10) problems.push(msg); };
    let files = 0;
    let folders = 0;
    let maxCnid = 0;
    for (const item of items.values()) {
      maxCnid = Math.max(maxCnid, item.cnid);
      const t = threads.get(item.cnid);
      if (!t) note('no thread record for CNID ' + item.cnid);
      else if (t.parent !== item.parent || t.name !== item.name || t.isFolder !== item.isFolder) note('thread record of CNID ' + item.cnid + ' disagrees with its catalog record');
      if (item.isFolder) { if (item.cnid !== 2) folders++; } else {
        files++;
        if (!(item.flags & 0x0002)) note('file ' + item.cnid + ' lacks kHFSThreadExistsMask');
      }
      if (item.cnid !== 2 && item.cnid < 16) note('CNID ' + item.cnid + ' is in the reserved range');
      const parent = items.get(item.parent);
      if (item.cnid === 2) { if (item.parent !== 1) note('root folder has parent ' + item.parent); } else if (!parent || !parent.isFolder) note('CNID ' + item.cnid + ' has no parent folder');
      else { parent.children++; if (item.isFolder) parent.subfolders++; }
      const typeBits = item.rawMode & S_IFMT;
      if (item.rawMode && (item.isFolder ? typeBits !== 0o040000 : typeBits === 0o040000 || typeBits === 0)) note('CNID ' + item.cnid + ' has file mode 0' + item.rawMode.toString(8));
      if (!item.isFolder && typeBits === S_IFLNK && (item.fileType !== 'slnk' || item.creator !== 'rhap')) note('symlink ' + item.cnid + ' lacks the slnk/rhap Finder type');
    }
    for (const cnid of threads.keys()) if (!items.has(cnid)) note('thread record without a catalog record: CNID ' + cnid);
    for (const item of items.values()) {
      if (!item.isFolder) continue;
      if (item.valence !== item.children) note('folder ' + item.cnid + ' valence ' + item.valence + ', has ' + item.children + ' children');
      if (h.signature === 'HX') {
        if (!(item.flags & 0x0010)) note('folder ' + item.cnid + ' lacks kHFSHasFolderCountMask (required on HFSX)');
        else if (item.folderCount !== item.subfolders) note('folder ' + item.cnid + ' folderCount ' + item.folderCount + ', has ' + item.subfolders);
      }
    }
    this._check('catalog: threads, parents, valence, folder counts, modes', problems.length === 0, problems.length ? problems.join('; ') : items.size + ' items');
    this._check('catalog: root folder present', items.has(2) && items.get(2).isFolder, rootName);
    this._check('volume header file/folder counts', files === h.fileCount && folders === h.folderCount, 'header ' + h.fileCount + '/' + h.folderCount + ', catalog ' + files + '/' + folders);
    this._check('volume header nextCatalogID', h.nextCatalogID > maxCnid, 'next ' + h.nextCatalogID + ', max used ' + maxCnid);

    // Paths (guarding against parent loops).
    const pathOf = (item) => {
      const parts = [];
      for (let cur = item, guard = 0; cur && cur.cnid !== 2; cur = items.get(cur.parent)) {
        if (++guard > 1024) throw new Error('hfs: parent loop at CNID ' + item.cnid);
        parts.push(cur.name.replace(/\//g, ':')); // on-disk '/' is ':' at the POSIX layer
      }
      return parts.reverse().join('/');
    };
    for (const item of items.values()) item.path = pathOf(item);

    this.items = items;
    this.rootName = rootName;
    await this._checkAllocation();
    return items;
  }

  /** Rebuild the allocation bitmap from every extent and compare it with the one on disk. */
  async _checkAllocation() {
    const h = this.header;
    const bs = this.blockSize;
    const total = h.totalBlocks;
    const expected = Buffer.alloc(Math.ceil(total / 8));
    const problems = [];
    const note = (msg) => { if (problems.length < 10) problems.push(msg); };
    const mark = (start, count, owner) => {
      if (start + count > total) { note(owner + ' extends past the volume'); return; }
      for (let b = start; b < start + count; b++) {
        const mask = 0x80 >> (b & 7);
        if (expected[b >> 3] & mask) { note(owner + ' overlaps another extent at block ' + b); return; }
        expected[b >> 3] |= mask;
      }
    };
    // Boot blocks + volume header (first 1536 bytes) and alternate header + reserved tail (last 1024 bytes).
    mark(0, Math.ceil(1536 / bs), 'volume header');
    const tail = Math.ceil(1024 / bs);
    mark(total - tail, tail, 'alternate volume header');
    const special = [['allocation file', h.allocationFile, 6], ['extents file', h.extentsFile, 3], ['catalog file', h.catalogFile, 4], ['attributes file', h.attributesFile, 8], ['startup file', h.startupFile, 7]];
    for (const [owner, fork, cnid] of special) {
      const extents = this.forkExtents(fork, cnid, 0);
      const blocks = extents.reduce((n, e) => n + e.count, 0);
      if (blocks !== fork.totalBlocks) note(owner + ': extents hold ' + blocks + ' blocks, fork says ' + fork.totalBlocks);
      for (const e of extents) mark(e.start, e.count, owner);
    }
    for (const item of this.items.values()) {
      if (item.isFolder) continue;
      for (const [fork, forkType] of [[item.dataFork, 0], [item.resourceFork, 0xff]]) {
        const extents = this.forkExtents(fork, item.cnid, forkType);
        const blocks = extents.reduce((n, e) => n + e.count, 0);
        if (blocks !== fork.totalBlocks) note('CNID ' + item.cnid + ': extents hold ' + blocks + ' blocks, fork says ' + fork.totalBlocks);
        if (fork.totalBlocks < Math.ceil(fork.logicalSize / bs)) note('CNID ' + item.cnid + ': ' + fork.totalBlocks + ' blocks cannot hold ' + fork.logicalSize + ' bytes');
        for (const e of extents) mark(e.start, e.count, 'CNID ' + item.cnid);
      }
    }
    this._check('allocation: extents are in range and do not overlap', problems.length === 0, problems.join('; '));

    const bitmapFork = h.allocationFile;
    this._check('allocation file is large enough', bitmapFork.logicalSize * 8 >= total, bitmapFork.logicalSize + ' bytes for ' + total + ' blocks');
    const onDisk = await this.readExtents(this.forkExtents(bitmapFork, 6, 0), 0, bitmapFork.logicalSize);
    let mismatch = -1;
    let used = 0;
    for (let b = 0; b < total; b++) {
      const mask = 0x80 >> (b & 7);
      const want = (expected[b >> 3] & mask) !== 0;
      const have = (onDisk[b >> 3] & mask) !== 0;
      if (have) used++;
      if (want !== have && mismatch < 0) mismatch = b;
    }
    let stray = false;
    for (let b = total; b < onDisk.length * 8; b++) if (onDisk[b >> 3] & (0x80 >> (b & 7))) { stray = true; break; }
    this._check('allocation bitmap matches the extents exactly', mismatch < 0, mismatch < 0 ? used + ' blocks in use' : 'first difference at block ' + mismatch);
    this._check('allocation bitmap is clear beyond the last block', !stray, '');
    this._check('volume header free block count', h.freeBlocks === total - used, 'header ' + h.freeBlocks + ', bitmap ' + (total - used));
  }

  /** Async iterable over a file's data fork. */
  async *readFile(item, pieceSize = 1 << 20) {
    const extents = this.forkExtents(item.dataFork, item.cnid, 0);
    for (let pos = 0; pos < item.dataFork.logicalSize; pos += pieceSize) {
      yield this.readExtents(extents, pos, Math.min(pieceSize, item.dataFork.logicalSize - pos));
    }
  }

  async readWholeFile(item) {
    const parts = [];
    for await (const piece of this.readFile(item)) parts.push(piece);
    return Buffer.concat(parts);
  }
}

// ---------------------------------------------------------------- public

async function openVolume(image) {
  // `-layout NONE` images start with the filesystem; others carry a partition map, so probe every blkx entry.
  const offsets = [0, ...image.blocks.map((b) => b.firstSector * SECTOR)];
  for (const offset of [...new Set(offsets)]) {
    const sig = (await image.read(offset + 1024, 2)).toString('latin1');
    if (sig === 'H+' || sig === 'HX') {
      const hfs = new HfsReader(image, offset);
      await hfs.init();
      return hfs;
    }
  }
  throw new Error('No HFS+ volume found in the disk image');
}

/**
 * @param {string} dmgPath
 * @param {{verify?:boolean, hashFiles?:boolean}} [opts]  verify: recompute the CRCs (default true);
 *        hashFiles: add a sha256 to every file entry (default false)
 */
async function readDmg(dmgPath, opts = {}) {
  const image = await DmgImage.open(dmgPath);
  try {
    const checks = image.containerChecks();
    if (opts.verify !== false) checks.push(...await image.verifyChecksums());
    const hfs = await openVolume(image);
    const items = await hfs.loadVolume();
    checks.push(...hfs.checks);

    const entries = [];
    let dsStore = null;
    for (const item of items.values()) {
      if (item.cnid === 2) continue;
      const isLink = !item.isFolder && (item.rawMode & S_IFMT) === S_IFLNK;
      const entry = {
        path: item.path, type: item.isFolder ? 'dir' : isLink ? 'symlink' : 'file',
        mode: item.rawMode & 0o7777, size: item.isFolder ? 0 : item.dataFork.logicalSize,
        cnid: item.cnid, parentCnid: item.parent, finderFlags: item.finderFlags, uid: item.uid, gid: item.gid,
        createDate: new Date((item.createDate - HFS_EPOCH_OFFSET) * 1000), modDate: new Date((item.modDate - HFS_EPOCH_OFFSET) * 1000),
      };
      if (!item.isFolder) { entry.fileType = item.fileType; entry.creator = item.creator; entry.resourceForkSize = item.resourceFork.logicalSize; }
      if (isLink) entry.target = (await hfs.readWholeFile(item)).toString('utf8');
      if (opts.hashFiles && !item.isFolder) {
        const hash = crypto.createHash('sha256');
        for await (const piece of hfs.readFile(item)) hash.update(piece);
        entry.sha256 = hash.digest('hex');
      }
      if (item.path === '.DS_Store') {
        try { dsStore = parseDSStore(await hfs.readWholeFile(item)); } catch (err) { dsStore = { error: err.message }; }
      }
      entries.push(entry);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const h = hfs.header;
    const root = items.get(2);
    return {
      koly: image.koly,
      blocks: image.blocks,
      resourceKeys: image.resourceKeys,
      volume: {
        name: hfs.rootName.replace(/\//g, ':'), signature: h.signature, version: h.version, caseSensitive: hfs.caseSensitive,
        blockSize: h.blockSize, totalBlocks: h.totalBlocks, freeBlocks: h.freeBlocks, fileCount: h.fileCount, folderCount: h.folderCount,
        nextCatalogID: h.nextCatalogID, attributes: h.attributes, finderInfo: h.finderInfo, partitionOffset: hfs.base,
        createDateLocal: h.createDate, modifyDate: h.modifyDate, rootFinderFlags: root ? root.finderFlags : 0, rootCreateDate: root ? root.createDate : 0,
      },
      entries, dsStore, checks,
    };
  } finally {
    await image.close();
  }
}

/** Read one file (or a symlink's target text) out of the image by its path on the volume. */
async function extractFile(dmgPath, innerPath) {
  const image = await DmgImage.open(dmgPath);
  try {
    const hfs = await openVolume(image);
    const items = await hfs.loadVolume();
    const wanted = String(innerPath).replace(/^\/+|\/+$/g, '');
    const forms = new Set([wanted, wanted.normalize('NFD'), wanted.normalize('NFC')]);
    for (const item of items.values()) {
      if (item.isFolder || !forms.has(item.path)) continue;
      return await hfs.readWholeFile(item);
    }
    throw new Error('No such file in the disk image: ' + innerPath);
  } finally {
    await image.close();
  }
}

module.exports = { readDmg, extractFile, DmgImage, HfsReader };
