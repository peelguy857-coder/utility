'use strict';
/**
 * UDIF (.dmg) container writer.
 *
 * File layout:   [data fork: the chunks, back to back][XML plist]['koly' trailer, 512 bytes]
 *
 * The disk is cut into 1 MiB chunks (2048 sectors). Each chunk is stored
 * zlib-compressed (UDZO), raw when compression does not pay, or not at all
 * when it is entirely zero. The chunk table lives in a 'mish' block inside
 * the plist's `resource-fork/blkx` array. The image uses `-layout NONE`
 * semantics: no partition map, one blkx entry covering the whole HFS volume.
 *
 * Checksums (all CRC-32, all verified by macOS when the image is opened):
 *   mish.checksum        over the UNCOMPRESSED disk bytes of that blkx entry
 *   koly.dataChecksum    over the data fork exactly as stored in the file
 *   koly.masterChecksum  over the concatenated big-endian blkx checksums
 */
const zlib = require('zlib');
const crypto = require('crypto');
const { crc32 } = require('./crc32.cjs');
const { buildXmlPlist } = require('./plist.cjs');

const SECTOR = 512;
const CHUNK_SECTORS = 2048;
const CHUNK_BYTES = CHUNK_SECTORS * SECTOR;

const CHUNK_ZERO = 0x00000000;
const CHUNK_RAW = 0x00000001;
const CHUNK_IGNORE = 0x00000002;
const CHUNK_ZLIB = 0x80000005;
const CHUNK_TERMINATOR = 0xffffffff;
const CHECKSUM_CRC32 = 2;

const ZEROS = Buffer.alloc(CHUNK_BYTES);

function deflate(buf, level) {
  return new Promise((resolve, reject) => {
    zlib.deflate(buf, { level }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

class UdifWriter {
  /**
   * @param {import('fs').promises.FileHandle} handle  open for writing, positioned at 0
   * @param {object} o
   * @param {'zlib'|'none'} [o.compression='zlib']
   * @param {number} [o.level=6]
   * @param {number} [o.concurrency=4]   chunks compressed at once (the libuv pool has 4 threads)
   * @param {string} [o.partitionName]
   */
  constructor(handle, o = {}) {
    this.handle = handle;
    this.compression = o.compression || 'zlib';
    this.level = o.level === undefined ? 6 : o.level;
    this.concurrency = Math.max(1, o.concurrency || 4);
    this.partitionName = o.partitionName || 'whole disk (Apple_HFS : 0)';
    this.current = Buffer.allocUnsafe(CHUNK_BYTES);
    this.fill = 0;
    this.pending = []; // promises, in disk order
    this.chunks = []; // { type, sector, sectors, offset, length }
    this.sector = 0;
    this.fileOffset = 0;
    this.diskCrc = 0;
    this.dataCrc = 0;
  }

  /** Append disk bytes. The buffer may be reused by the caller once this resolves. */
  async write(buf) {
    let pos = 0;
    while (pos < buf.length) {
      const n = Math.min(buf.length - pos, CHUNK_BYTES - this.fill);
      buf.copy(this.current, this.fill, pos, pos + n);
      this.fill += n;
      pos += n;
      if (this.fill === CHUNK_BYTES) await this._submit();
    }
  }

  async _submit() {
    const chunk = this.current.subarray(0, this.fill);
    if (chunk.length % SECTOR) throw new Error('udif: disk size is not a whole number of sectors');
    this.current = Buffer.allocUnsafe(CHUNK_BYTES);
    this.fill = 0;
    this.diskCrc = crc32(chunk, this.diskCrc); // zero chunks are part of the disk, too
    while (this.pending.length >= this.concurrency) await this._drainOne();
    const job = this._encode(chunk);
    job.catch(() => {}); // the error is reported when the job is drained, not as an unhandled rejection
    this.pending.push(job);
  }

  async _encode(chunk) {
    // All-zero chunks are stored as "zero fill" entries without data. (hdiutil also uses the
    // "ignore" type for free space; zero fill is the one whose checksum semantics are unambiguous.)
    if (chunk.equals(ZEROS.subarray(0, chunk.length))) return { type: CHUNK_ZERO, sectors: chunk.length / SECTOR, data: null };
    if (this.compression === 'zlib') {
      const packed = await deflate(chunk, this.level);
      if (packed.length < chunk.length) return { type: CHUNK_ZLIB, sectors: chunk.length / SECTOR, data: packed };
    }
    return { type: CHUNK_RAW, sectors: chunk.length / SECTOR, data: chunk };
  }

  async _drainOne() {
    const c = await this.pending.shift();
    const last = this.chunks[this.chunks.length - 1];
    if (c.type === CHUNK_ZERO && last && last.type === CHUNK_ZERO) {
      last.sectors += c.sectors; // merge runs of empty chunks into one entry
    } else {
      this.chunks.push({ type: c.type, sector: this.sector, sectors: c.sectors, offset: this.fileOffset, length: c.data ? c.data.length : 0 });
    }
    this.sector += c.sectors;
    if (c.data) {
      await writeAll(this.handle, c.data, this.fileOffset);
      this.dataCrc = crc32(c.data, this.dataCrc);
      this.fileOffset += c.data.length;
    }
  }

  /** Wait for in-flight compression jobs after a failure, so nothing outlives the file handle. */
  async settle() {
    await Promise.allSettled(this.pending);
    this.pending = [];
  }

  /** Bytes of the data fork written so far (for progress/ratio reporting). */
  get compressedBytes() { return this.fileOffset; }

  /** Flush, then write the plist and the koly trailer. Returns a summary. */
  async finish() {
    if (this.fill) await this._submit();
    while (this.pending.length) await this._drainOne();
    // If a worker failed we never get here: the rejection surfaces in _drainOne.

    const sectorCount = this.sector;
    const dataForkLength = this.fileOffset;
    const mish = this._mish(sectorCount, dataForkLength);
    const xml = Buffer.from(buildXmlPlist({
      'resource-fork': {
        blkx: [{
          Attributes: '0x0050',
          CFName: this.partitionName,
          Data: mish,
          ID: '0',
          Name: this.partitionName,
        }],
      },
    }), 'utf8');
    await writeAll(this.handle, xml, dataForkLength);

    const master = Buffer.alloc(4);
    master.writeUInt32BE(this.diskCrc, 0);

    const koly = Buffer.alloc(512);
    koly.write('koly', 0, 'latin1');
    koly.writeUInt32BE(4, 4); // version
    koly.writeUInt32BE(512, 8); // header size
    koly.writeUInt32BE(1, 12); // flags: flattened
    // 16: running data fork offset, 24: data fork offset (both 0)
    koly.writeBigUInt64BE(BigInt(dataForkLength), 32);
    // 40/48: resource fork offset/length (unused; the plist replaces it)
    koly.writeUInt32BE(1, 56); // segment number
    koly.writeUInt32BE(1, 60); // segment count
    crypto.randomBytes(16).copy(koly, 64); // segment id
    koly.writeUInt32BE(CHECKSUM_CRC32, 80);
    koly.writeUInt32BE(32, 84); // checksum size in bits
    koly.writeUInt32BE(this.dataCrc, 88);
    koly.writeBigUInt64BE(BigInt(dataForkLength), 216); // XML offset
    koly.writeBigUInt64BE(BigInt(xml.length), 224);
    koly.writeUInt32BE(CHECKSUM_CRC32, 352);
    koly.writeUInt32BE(32, 356);
    koly.writeUInt32BE(crc32(master), 360); // master checksum
    koly.writeUInt32BE(1, 488); // image variant
    koly.writeBigUInt64BE(BigInt(sectorCount), 492);
    await writeAll(this.handle, koly, dataForkLength + xml.length);

    return {
      bytes: dataForkLength + xml.length + koly.length,
      dataForkLength, sectorCount, chunkCount: this.chunks.length,
      diskCrc: this.diskCrc, dataCrc: this.dataCrc,
    };
  }

  /** 'mish' block: 204-byte header + 40-byte chunk entries, terminator last. */
  _mish(sectorCount, dataForkLength) {
    const entries = [...this.chunks, { type: CHUNK_TERMINATOR, sector: sectorCount, sectors: 0, offset: dataForkLength, length: 0 }];
    const b = Buffer.alloc(204 + 40 * entries.length);
    b.write('mish', 0, 'latin1');
    b.writeUInt32BE(1, 4); // version
    b.writeBigUInt64BE(0n, 8); // first sector
    b.writeBigUInt64BE(BigInt(sectorCount), 16);
    b.writeBigUInt64BE(0n, 24); // data offset
    b.writeUInt32BE(CHUNK_SECTORS + 8, 32); // buffers needed (what hdiutil writes for 1 MiB chunks)
    b.writeUInt32BE(0, 36); // block descriptor / partition number
    b.writeUInt32BE(CHECKSUM_CRC32, 64);
    b.writeUInt32BE(32, 68);
    b.writeUInt32BE(this.diskCrc, 72);
    b.writeUInt32BE(entries.length, 200);
    entries.forEach((c, i) => {
      const p = 204 + i * 40;
      b.writeUInt32BE(c.type, p);
      b.writeUInt32BE(0, p + 4); // comment
      b.writeBigUInt64BE(BigInt(c.sector), p + 8);
      b.writeBigUInt64BE(BigInt(c.sectors), p + 16);
      b.writeBigUInt64BE(BigInt(c.offset), p + 24);
      b.writeBigUInt64BE(BigInt(c.length), p + 32);
    });
    return b;
  }
}

async function writeAll(handle, buf, position) {
  let done = 0;
  while (done < buf.length) {
    const { bytesWritten } = await handle.write(buf, done, buf.length - done, position + done);
    if (!bytesWritten) throw new Error('udif: short write');
    done += bytesWritten;
  }
}

module.exports = {
  UdifWriter, SECTOR, CHUNK_SECTORS, CHUNK_BYTES,
  CHUNK_ZERO, CHUNK_RAW, CHUNK_IGNORE, CHUNK_ZLIB, CHUNK_TERMINATOR, CHECKSUM_CRC32,
};
