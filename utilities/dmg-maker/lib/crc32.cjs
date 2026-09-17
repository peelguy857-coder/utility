'use strict';
/**
 * CRC-32 (IEEE 802.3, the zlib/PNG/zip polynomial).
 *
 * Node >= 20.15 / 22.2 ships a native `zlib.crc32(data, seed)`; older runtimes
 * get the classic table implementation. Both take and return an unsigned
 * 32-bit running value so callers can checksum a stream piece by piece.
 */
const zlib = require('zlib');

let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

/** Pure JS fallback. `seed` is the CRC of everything that came before (0 to start). */
function crc32Table(buf, seed = 0) {
  const t = table();
  let c = ~seed >>> 0;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const native = typeof zlib.crc32 === 'function';

function crc32(buf, seed = 0) {
  return native ? zlib.crc32(buf, seed) >>> 0 : crc32Table(buf, seed);
}

module.exports = { crc32, crc32Table, isNative: native };
