'use strict';
/**
 * Source adapter that reads a Mac app straight out of a `.zip`.
 *
 * This is the path that keeps an app intact on Windows: a zip made on macOS
 * (Finder "Compress", `ditto -c -k`, `zip -y`) records Unix permissions and
 * symlinks in each entry's external attributes, and both are lost the moment
 * the archive is extracted to NTFS. So the archive is never extracted: the
 * central directory is parsed here and every entry is inflated directly into
 * the image as it is written.
 *
 * Supported: zip64, data descriptors (sizes come from the central directory),
 * stored + deflate, UTF-8 / CP437 names, Info-ZIP unicode path and extended
 * timestamp extras. Not supported: encryption, multi-disk archives, other
 * compression methods.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline, Readable } = require('stream');
const { crc32 } = require('./crc32.cjs');
const { looksExecutable } = require('./macho.cjs');
const { frameworkWarnings, comparePaths, fileReader } = require('./source-folder.cjs');
const { throwIfAborted } = require('./util.cjs');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const HOST_UNIX = 3;
const HOST_DARWIN = 19;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const SMALL_ENTRY = 4 << 20; // entries up to this size (packed and unpacked) are inflated in one call
const READ_CHUNK = 1 << 20;
const MAX_CENTRAL_DIRECTORY = 512 << 20;
const MAX_SYMLINK_BYTES = 1024;

// Upper half of IBM code page 437, the zip default when the UTF-8 flag is absent.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function decodeName(raw, utf8Flag) {
  if (utf8Flag) return raw.toString('utf8');
  // macOS writes UTF-8 names without setting the flag, so try that first.
  try { return utf8Strict.decode(raw); } catch (_) { /* fall through to CP437 */ }
  let out = '';
  for (const byte of raw) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return out;
}

function dosDateTime(date, time) {
  // Local time, 2-second resolution, no time zone: all a plain zip knows.
  return new Date(1980 + (date >> 9), ((date >> 5) & 0x0f) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (!bytesRead) throw new Error('zip: unexpected end of file');
    done += bytesRead;
  }
  return buf;
}

/** Find and read the central directory. Returns { handle, entries, shift }. */
async function openZip(zipPath) {
  const handle = await fs.promises.open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw new Error('Not a zip file (too small): ' + zipPath);
    // The end-of-central-directory record is the last thing in the file, followed only by a comment (max 65535).
    const tailLength = Math.min(size, 22 + 0xffff);
    const tailStart = size - tailLength;
    const tail = await readAt(handle, tailStart, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record): ' + zipPath);
    const eocdPos = tailStart + eocd;
    if (tail.readUInt16LE(eocd + 4) !== 0 && tail.readUInt16LE(eocd + 4) !== 0xffff) throw new Error('Multi-disk zip archives are not supported');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    let cdEnd = eocdPos;

    // zip64: a locator right before the EOCD points at the 64-bit record.
    if (eocdPos >= 20) {
      const locator = await readAt(handle, eocdPos - 20, 20);
      if (locator.readUInt32LE(0) === SIG_EOCD64_LOCATOR) {
        const recordPos = Number(locator.readBigUInt64LE(8));
        const record = await readAt(handle, recordPos, 56);
        if (record.readUInt32LE(0) !== SIG_EOCD64) throw new Error('zip: damaged zip64 end record');
        count = Number(record.readBigUInt64LE(32));
        cdSize = Number(record.readBigUInt64LE(40));
        cdOffset = Number(record.readBigUInt64LE(48));
        cdEnd = recordPos;
      }
    }
    if (cdSize > MAX_CENTRAL_DIRECTORY) throw new Error('zip: central directory is implausibly large');
    // Data prepended to the archive (self-extractors) shifts every stored offset by the same amount.
    let shift = 0;
    if (cdOffset + cdSize !== cdEnd && cdEnd - cdSize >= 0) {
      const probe = await readAt(handle, cdEnd - cdSize, 4).catch(() => null);
      if (probe && probe.readUInt32LE(0) === SIG_CENTRAL) shift = cdEnd - cdSize - cdOffset;
    }
    const cd = await readAt(handle, cdOffset + shift, cdSize);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip: damaged central directory');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const e = {
        host: madeBy >> 8, flags, method: cd.readUInt16LE(p + 10),
        mtime: dosDateTime(cd.readUInt16LE(p + 14), cd.readUInt16LE(p + 12)),
        crc: cd.readUInt32LE(p + 16), compressedSize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24),
        externalAttributes: cd.readUInt32LE(p + 38), localOffset: cd.readUInt32LE(p + 42),
      };
      const rawName = cd.subarray(p + 46, p + 46 + nameLength);
      e.name = decodeName(rawName, (flags & 0x0800) !== 0);
      const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      for (let x = 0; x + 4 <= extra.length;) {
        const id = extra.readUInt16LE(x);
        const len = extra.readUInt16LE(x + 2);
        const body = extra.subarray(x + 4, x + 4 + len);
        if (id === 0x0001) {
          // zip64: only the fields that overflowed are present, in this fixed order.
          let q = 0;
          if (e.size === 0xffffffff && q + 8 <= body.length) { e.size = Number(body.readBigUInt64LE(q)); q += 8; }
          if (e.compressedSize === 0xffffffff && q + 8 <= body.length) { e.compressedSize = Number(body.readBigUInt64LE(q)); q += 8; }
          if (e.localOffset === 0xffffffff && q + 8 <= body.length) { e.localOffset = Number(body.readBigUInt64LE(q)); q += 8; }
        } else if (id === 0x5455 && body.length >= 5 && (body[0] & 1)) {
          e.mtime = body.readInt32LE(1) * 1000; // extended timestamp: Unix mtime, UTC
        } else if (id === 0x7075 && body.length > 5 && body[0] === 1 && body.readUInt32LE(1) === crc32(rawName)) {
          e.name = body.toString('utf8', 5); // Info-ZIP unicode path, valid only for this exact raw name
        }
        x += 4 + len;
      }
      e.localOffset += shift;
      entries.push(e);
      p += 46 + nameLength + extraLength + commentLength;
    }
    return { handle, entries, size };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/** Byte position of an entry's data (the local header repeats name/extra with its own lengths). */
async function dataStart(handle, e) {
  if (e.dataStart !== undefined) return e.dataStart;
  const local = await readAt(handle, e.localOffset, 30);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error('zip: damaged local header for ' + e.name);
  e.dataStart = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  return e.dataStart;
}

function checkSupported(e) {
  if (e.flags & 0x0001) throw new Error('Encrypted zip entries are not supported: ' + e.name);
  if (e.method !== 0 && e.method !== 8) throw new Error('Unsupported zip compression method ' + e.method + ': ' + e.name);
}

/** The stored (still compressed) bytes of an entry, read through the shared handle without owning it. */
async function* rawChunks(handle, start, length, name) {
  for (let pos = 0; pos < length;) {
    const want = Math.min(READ_CHUNK, length - pos);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buf, 0, want, start + pos);
    if (!bytesRead) throw new Error('zip: unexpected end of file in ' + name);
    pos += bytesRead;
    yield buf.subarray(0, bytesRead);
  }
}

/** Async iterable over an entry's uncompressed bytes; verifies length and CRC-32. */
function entryReader(handle, e) {
  return async function* open() {
    checkSupported(e);
    const start = await dataStart(handle, e);
    let crc = 0;
    let total = 0;
    const account = (chunk) => { crc = crc32(chunk, crc); total += chunk.length; };

    if (e.method === 0) {
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(e.compressedSize, READ_CHUNK)));
      for (let pos = 0; pos < e.compressedSize;) {
        const want = Math.min(buf.length, e.compressedSize - pos);
        const { bytesRead } = await handle.read(buf, 0, want, start + pos);
        if (!bytesRead) throw new Error('zip: unexpected end of file in ' + e.name);
        pos += bytesRead;
        account(buf.subarray(0, bytesRead));
        yield buf.subarray(0, bytesRead);
      }
    } else if (e.compressedSize <= SMALL_ENTRY && e.size <= SMALL_ENTRY) {
      const packed = await readAt(handle, start, e.compressedSize);
      const data = await new Promise((resolve, reject) => {
        // maxOutputLength stops a lying header from inflating without bound.
        zlib.inflateRaw(packed, { maxOutputLength: Math.max(1, e.size) }, (err, out) => (err ? reject(err) : resolve(out)));
      }).catch((err) => { throw new Error('zip: cannot inflate ' + e.name + ': ' + err.message); });
      account(data);
      yield data;
    } else {
      // Not handle.createReadStream(): destroying such a stream closes the FileHandle itself (even with
      // autoClose: false), and this handle is shared by every entry of the archive.
      const input = Readable.from(rawChunks(handle, start, e.compressedSize, e.name));
      const inflate = zlib.createInflateRaw();
      pipeline(input, inflate, () => {}); // errors surface through the iteration below
      try {
        for await (const chunk of inflate) {
          account(chunk);
          if (total > e.size) throw new Error('zip: ' + e.name + ' inflates to more than its declared size');
          yield chunk;
        }
      } finally {
        input.destroy();
        inflate.destroy();
      }
    }
    if (total !== e.size) throw new Error('zip: ' + e.name + ' has the wrong length (corrupt archive?)');
    if (crc !== e.crc) throw new Error('zip: CRC mismatch in ' + e.name + ' (corrupt archive?)');
  };
}

/** First `length` uncompressed bytes of an entry (may return fewer). */
async function readEntryHead(handle, e, length) {
  checkSupported(e);
  if (!e.size) return Buffer.alloc(0);
  const start = await dataStart(handle, e);
  if (e.method === 0) return readAt(handle, start, Math.min(length, e.compressedSize));
  // Inflate just the beginning: Z_SYNC_FLUSH returns whatever could be decoded from a truncated input.
  const packed = await readAt(handle, start, Math.min(e.compressedSize, length + 4096));
  try {
    const out = zlib.inflateRawSync(packed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return out.subarray(0, length);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

async function readEntryFully(handle, e, limit) {
  if (e.size > limit) throw new Error('zip: ' + e.name + ' is too large here');
  const parts = [];
  for await (const chunk of entryReader(handle, e)()) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** Mode bits from the external attributes, or null when the archive does not carry them. */
function unixMode(e) {
  const mode = e.externalAttributes >>> 16;
  const type = mode & S_IFMT;
  if (e.host === HOST_UNIX || e.host === HOST_DARWIN) return mode || null;
  // Some Windows tools keep a Unix mode in the high word anyway; trust it only if it is well-formed.
  if (type === S_IFREG || type === S_IFDIR || type === S_IFLNK) return mode;
  return null;
}

/** Split, clean and validate an entry name. Returns null for entries to skip. */
function cleanPath(name, host) {
  let n = name;
  if (!n.includes('/') && n.includes('\\') && host !== HOST_UNIX && host !== HOST_DARWIN) n = n.replace(/\\/g, '/');
  const isDir = n.endsWith('/');
  const parts = n.split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length) return null;
  if (parts.includes('..') || /^[A-Za-z]:$/.test(parts[0])) throw new Error('Unsafe path inside zip: ' + name);
  if (parts.includes('__MACOSX') || parts[parts.length - 1] === '.DS_Store') return null;
  return { parts, isDir };
}

/**
 * @param {string} zipPath
 * @param {{signal?:AbortSignal, onProgress?:function}} [o]
 */
async function scanZip(zipPath, o = {}) {
  const zip = await openZip(zipPath);
  const warnings = [];
  try {
    // Pass 1: clean names and find the app (at the root, or one folder down).
    const items = [];
    for (const e of zip.entries) {
      const cleaned = cleanPath(e.name, e.host);
      if (cleaned) items.push({ e, parts: cleaned.parts, isDir: cleaned.isDir });
    }
    const rootApps = new Set();
    const nestedApps = new Set();
    for (const it of items) {
      const [a, b] = it.parts;
      const aIsFolder = it.parts.length > 1 || it.isDir;
      if (/\.app$/i.test(a) && aIsFolder) rootApps.add(a);
      else if (b && /\.app$/i.test(b) && (it.parts.length > 2 || it.isDir)) nestedApps.add(a + '/' + b);
    }
    const candidates = rootApps.size ? [...rootApps].sort() : [...nestedApps].sort();
    if (!candidates.length) {
      // No app inside: the zip itself becomes the payload, like any other file.
      await zip.handle.close();
      const st = await fs.promises.stat(zipPath);
      const rootName = path.basename(zipPath);
      return {
        kind: 'file', rootName,
        entries: [{ path: rootName, type: 'file', mode: 0o644, size: st.size, mtime: st.mtimeMs, open: fileReader(path.resolve(zipPath), st.size) }],
        warnings: ['No .app bundle found inside the zip (looked at the top level and one folder down); the zip file itself will be placed on the disk image.'],
        hasUnixModes: false, close: async () => {},
      };
    }
    const appPrefix = candidates[0].split('/');
    const appName = appPrefix[appPrefix.length - 1];
    if (candidates.length > 1) warnings.push('The zip contains ' + candidates.length + ' apps; using "' + candidates[0] + '" and ignoring ' + candidates.slice(1).join(', ') + '.');

    // Pass 2: build the entry list for everything under the app.
    const byPath = new Map();
    let sawUnixMode = false;
    let ignoredOutside = 0;
    const pendingHeads = [];
    for (const it of items) {
      throwIfAborted(o.signal);
      if (it.parts.length < appPrefix.length || appPrefix.some((seg, i) => it.parts[i] !== seg)) { ignoredOutside++; continue; }
      const rel = [appName, ...it.parts.slice(appPrefix.length)].join('/');
      if (byPath.has(rel)) { warnings.push('Duplicate zip entry ignored: ' + it.e.name); continue; }
      const mode = unixMode(it.e);
      if (mode !== null) sawUnixMode = true;
      const type = mode !== null ? mode & S_IFMT : 0;
      let entry;
      if (it.isDir || type === S_IFDIR) {
        entry = { path: rel, type: 'dir', mode: mode && (mode & 0o777) ? mode & 0o7777 : 0o755, size: 0, mtime: it.e.mtime };
      } else if (type === S_IFLNK) {
        if (it.e.size > MAX_SYMLINK_BYTES) throw new Error('zip: symlink target too long: ' + it.e.name);
        const target = (await readEntryFully(zip.handle, it.e, MAX_SYMLINK_BYTES)).toString('utf8');
        entry = { path: rel, type: 'symlink', mode: 0o755, size: Buffer.byteLength(target), mtime: it.e.mtime, target };
      } else if (type && type !== S_IFREG) {
        warnings.push('Skipped special file in zip: ' + it.e.name);
        continue;
      } else {
        checkSupported(it.e);
        entry = {
          path: rel, type: 'file', mode: mode && (mode & 0o777) ? mode & 0o7777 : 0o644,
          size: it.e.size, mtime: it.e.mtime, open: entryReader(zip.handle, it.e),
          head: (n) => readEntryHead(zip.handle, it.e, n),
        };
        if (mode === null) pendingHeads.push({ entry, zipEntry: it.e });
      }
      byPath.set(rel, entry);
      if (o.onProgress && byPath.size % 500 === 0) o.onProgress(byPath.size);
    }

    // Zips do not have to list folders; add the missing ones.
    for (const rel of [...byPath.keys()]) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!byPath.has(dir)) byPath.set(dir, { path: dir, type: 'dir', mode: 0o755, size: 0, mtime: byPath.get(rel).mtime });
      }
    }
    if (!byPath.has(appName)) byPath.set(appName, { path: appName, type: 'dir', mode: 0o755, size: 0, mtime: Date.now() });

    // A zip without Unix attributes (made on Windows): guess executables the same way the folder adapter does.
    if (!sawUnixMode) {
      for (const { entry, zipEntry } of pendingHeads) {
        throwIfAborted(o.signal);
        if (/(^|\/)Contents\/MacOS\/[^/]+$/.test(entry.path)) entry.mode = 0o755;
        else if (zipEntry.size >= 2 && looksExecutable(await readEntryHead(zip.handle, zipEntry, 8))) entry.mode = 0o755;
      }
      warnings.push('This zip carries no Unix permissions (it was probably created on Windows), so executable files were guessed from their contents and symlinks cannot be restored. A zip made on the Mac (Finder "Compress" or `ditto -c -k --keepParent`) is the reliable input.');
    }
    if (ignoredOutside) warnings.push(ignoredOutside + ' zip entr' + (ignoredOutside === 1 ? 'y' : 'ies') + ' outside "' + candidates[0] + '" were ignored.');

    const entries = [...byPath.values()].sort((a, b) => comparePaths(a.path, b.path));
    // A file cannot also be a folder: refuse archives where a file has children.
    for (const e of entries) {
      const parent = e.path.includes('/') ? byPath.get(e.path.slice(0, e.path.lastIndexOf('/'))) : null;
      if (parent && parent.type !== 'dir') throw new Error('zip: "' + parent.path + '" is both a file and a folder');
    }
    warnings.push(...frameworkWarnings(entries));

    return {
      kind: 'app-zip', rootName: appName, entries, warnings, hasUnixModes: sawUnixMode,
      close: () => zip.handle.close().catch(() => {}),
    };
  } catch (err) {
    await zip.handle.close().catch(() => {});
    throw err;
  }
}

module.exports = { scanZip, openZip };
