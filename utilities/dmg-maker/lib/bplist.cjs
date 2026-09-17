'use strict';
/**
 * Binary property list ("bplist00") writer and reader.
 *
 * Writer input mapping:
 *   string -> ASCII (0x5n) or UTF-16BE (0x6n) string      boolean -> 0x08 / 0x09
 *   integer number / bigint -> int (0x1n)                  Real(n) or fractional number -> float64 (0x23)
 *   Buffer / Uint8Array -> data (0x4n)                     Date -> date (0x33)
 *   Array -> array (0xAn)                                  plain object -> dict (0xDn), keys sorted
 *
 * Finder stores numbers such as iconSize as reals, and a whole number like
 * 128 would otherwise be written as an int, so wrap those in `new Real(128)`.
 */

class Real {
  constructor(value) { this.value = Number(value); }
}
class UID {
  constructor(value) { this.value = value; }
}

// Seconds between the Unix epoch and the CoreFoundation epoch (2001-01-01).
const CF_EPOCH_OFFSET = 978307200;

// ---------------------------------------------------------------- writer

function isAscii(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

function intBytes(v) {
  // Non-negative ints use the smallest of 1/2/4/8 bytes (unsigned for 1/2/4);
  // negative ints are always 8 bytes, two's complement.
  let n = BigInt(v);
  let size;
  if (n < 0n) size = 8;
  else if (n <= 0xffn) size = 1;
  else if (n <= 0xffffn) size = 2;
  else if (n <= 0xffffffffn) size = 4;
  else size = 8;
  const b = Buffer.alloc(size);
  if (size === 8) b.writeBigInt64BE(BigInt.asIntN(64, n));
  else if (size === 4) b.writeUInt32BE(Number(n));
  else if (size === 2) b.writeUInt16BE(Number(n));
  else b.writeUInt8(Number(n));
  return b;
}

function sizedMarker(type, count) {
  // Marker byte with the count in the low nibble, or 0xF + an int object.
  if (count < 15) return Buffer.from([type | count]);
  const ib = intBytes(count);
  return Buffer.concat([Buffer.from([type | 0x0f, 0x10 | Math.log2(ib.length)]), ib]);
}

function uintBE(value, size) {
  const b = Buffer.alloc(size);
  if (size === 8) b.writeBigUInt64BE(BigInt(value));
  else b.writeUIntBE(value, 0, size);
  return b;
}

function byteSizeFor(maxValue) {
  if (maxValue <= 0xff) return 1;
  if (maxValue <= 0xffff) return 2;
  if (maxValue <= 0xffffffff) return 4;
  return 8;
}

/** Serialize a JS value as a binary plist. */
function writeBplist(root) {
  // Pass 1: flatten into an object table. Scalars are uniqued the way
  // CoreFoundation does it; containers hold indexes into the table.
  const objects = [];
  const unique = new Map();

  function uniqueKey(v) {
    if (typeof v === 'string') return 's:' + v;
    if (typeof v === 'boolean') return 'b:' + v;
    if (typeof v === 'bigint') return 'i:' + v;
    if (typeof v === 'number') return (Number.isInteger(v) ? 'i:' : 'r:') + v;
    if (v instanceof Real) return 'r:' + v.value;
    return null;
  }

  function add(v) {
    if (v === null || v === undefined) throw new TypeError('bplist: null/undefined cannot be stored');
    const k = uniqueKey(v);
    if (k !== null && unique.has(k)) return unique.get(k);
    const index = objects.length;
    if (k !== null) unique.set(k, index);
    if (Array.isArray(v)) {
      const entry = { kind: 'array', refs: [] };
      objects.push(entry);
      for (const item of v) entry.refs.push(add(item));
    } else if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      objects.push({ kind: 'data', value: Buffer.from(v) });
    } else if (v instanceof Date || v instanceof Real || v instanceof UID || typeof v !== 'object') {
      objects.push({ kind: 'scalar', value: v });
    } else {
      const entry = { kind: 'dict', keyRefs: [], valRefs: [] };
      objects.push(entry);
      const keys = Object.keys(v).filter((key) => v[key] !== undefined).sort();
      for (const key of keys) entry.keyRefs.push(add(String(key)));
      for (const key of keys) entry.valRefs.push(add(v[key]));
    }
    return index;
  }
  add(root);

  const refSize = byteSizeFor(objects.length);
  const refs = (list) => Buffer.concat(list.map((r) => uintBE(r, refSize)));

  // Pass 2: encode every object and remember where it starts.
  const parts = [Buffer.from('bplist00', 'latin1')];
  let offset = 8;
  const offsets = [];
  for (const o of objects) {
    let b;
    if (o.kind === 'array') {
      b = Buffer.concat([sizedMarker(0xa0, o.refs.length), refs(o.refs)]);
    } else if (o.kind === 'dict') {
      b = Buffer.concat([sizedMarker(0xd0, o.keyRefs.length), refs(o.keyRefs), refs(o.valRefs)]);
    } else if (o.kind === 'data') {
      b = Buffer.concat([sizedMarker(0x40, o.value.length), o.value]);
    } else {
      const v = o.value;
      if (typeof v === 'boolean') {
        b = Buffer.from([v ? 0x09 : 0x08]);
      } else if (typeof v === 'string') {
        if (isAscii(v)) {
          b = Buffer.concat([sizedMarker(0x50, v.length), Buffer.from(v, 'latin1')]);
        } else {
          const le = Buffer.from(v, 'utf16le');
          le.swap16(); // -> UTF-16BE
          b = Buffer.concat([sizedMarker(0x60, v.length), le]);
        }
      } else if (typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))) {
        const ib = intBytes(v);
        b = Buffer.concat([Buffer.from([0x10 | Math.log2(ib.length)]), ib]);
      } else if (typeof v === 'number' || v instanceof Real) {
        b = Buffer.alloc(9);
        b[0] = 0x23;
        b.writeDoubleBE(typeof v === 'number' ? v : v.value, 1);
      } else if (v instanceof Date) {
        b = Buffer.alloc(9);
        b[0] = 0x33;
        b.writeDoubleBE(v.getTime() / 1000 - CF_EPOCH_OFFSET, 1);
      } else if (v instanceof UID) {
        const ib = intBytes(v.value);
        b = Buffer.concat([Buffer.from([0x80 | (ib.length - 1)]), ib]);
      } else {
        throw new TypeError('bplist: unsupported value ' + Object.prototype.toString.call(v));
      }
    }
    offsets.push(offset);
    offset += b.length;
    parts.push(b);
  }

  // Offset table + 32-byte trailer.
  const offsetSize = byteSizeFor(offset);
  for (const o of offsets) parts.push(uintBE(o, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16); // top object is always index 0
  trailer.writeBigUInt64BE(BigInt(offset), 24);
  parts.push(trailer);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- reader

function isBplist(buf) {
  return buf.length >= 40 && buf.toString('latin1', 0, 6) === 'bplist';
}

/**
 * Parse a binary plist. Dicts become plain objects, data becomes Buffer,
 * dates become Date, UIDs become UID. Integers that do not fit a double
 * exactly come back as bigint.
 */
function readBplist(buf) {
  if (!isBplist(buf)) throw new Error('not a binary plist');
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));
  if (!offsetSize || !refSize || tableOffset + numObjects * offsetSize > buf.length - 32) {
    throw new Error('bplist: corrupt trailer');
  }

  const readUInt = (pos, size) => {
    if (pos + size > buf.length) throw new Error('bplist: read past end');
    if (size === 8) return Number(buf.readBigUInt64BE(pos));
    if (size > 8) return Number(buf.readBigUInt64BE(pos + size - 8));
    return buf.readUIntBE(pos, size);
  };
  const objectOffset = (index) => {
    if (index >= numObjects) throw new Error('bplist: bad object reference');
    return readUInt(tableOffset + index * offsetSize, offsetSize);
  };

  const active = new Set(); // guards against reference cycles

  function readCount(pos, low) {
    // Returns [count, positionAfterCount].
    if (low !== 0x0f) return [low, pos];
    const marker = buf[pos];
    if ((marker & 0xf0) !== 0x10) throw new Error('bplist: bad length marker');
    const size = 1 << (marker & 0x0f);
    return [readUInt(pos + 1, size), pos + 1 + size];
  }

  function readObject(index) {
    if (active.has(index)) throw new Error('bplist: cyclic reference');
    let pos = objectOffset(index);
    const marker = buf[pos++];
    const type = marker & 0xf0;
    const low = marker & 0x0f;
    switch (type) {
      case 0x00:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null; // 0x00 null, 0x0f fill
      case 0x10: {
        const size = 1 << low;
        if (size === 8) {
          const v = buf.readBigInt64BE(pos);
          return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        }
        if (size === 16) return buf.readBigInt64BE(pos + 8);
        return readUInt(pos, size);
      }
      case 0x20:
        return low === 2 ? buf.readFloatBE(pos) : buf.readDoubleBE(pos);
      case 0x30:
        return new Date((buf.readDoubleBE(pos) + CF_EPOCH_OFFSET) * 1000);
      case 0x40: {
        const [count, p] = readCount(pos, low);
        return Buffer.from(buf.subarray(p, p + count));
      }
      case 0x50: {
        const [count, p] = readCount(pos, low);
        return buf.toString('latin1', p, p + count);
      }
      case 0x60: {
        const [count, p] = readCount(pos, low);
        const be = Buffer.from(buf.subarray(p, p + count * 2));
        be.swap16();
        return be.toString('utf16le');
      }
      case 0x80:
        return new UID(readUInt(pos, low + 1));
      case 0xa0:
      case 0xc0: {
        const [count, p] = readCount(pos, low);
        active.add(index);
        const out = [];
        for (let i = 0; i < count; i++) out.push(readObject(readUInt(p + i * refSize, refSize)));
        active.delete(index);
        return out;
      }
      case 0xd0: {
        const [count, p] = readCount(pos, low);
        active.add(index);
        const out = {};
        for (let i = 0; i < count; i++) {
          const key = readObject(readUInt(p + i * refSize, refSize));
          const val = readObject(readUInt(p + (count + i) * refSize, refSize));
          out[String(key)] = val;
        }
        active.delete(index);
        return out;
      }
      default:
        throw new Error('bplist: unknown marker 0x' + marker.toString(16));
    }
  }

  return readObject(topObject);
}

module.exports = { writeBplist, readBplist, isBplist, Real, UID };
