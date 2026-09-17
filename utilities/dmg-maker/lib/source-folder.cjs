'use strict';
/**
 * Source adapter for a folder (usually `Something.app`) or a single file.
 *
 * Every adapter returns the same shape:
 *   { kind, rootName, entries, warnings, hasUnixModes, close() }
 * where an entry is
 *   { path, type:'dir'|'file'|'symlink', mode, size, mtime, target?, open() }
 * `path` is relative to the future volume root and uses '/'; parents always
 * come before their children; `open()` returns an async iterable of Buffers
 * that may be reused between iterations.
 *
 * Windows keeps neither Unix permissions nor (usually) symlinks, so on win32
 * the executable bit is reconstructed: a file is 0755 when it starts with a
 * Mach-O/universal magic or "#!", or sits directly in Contents/MacOS.
 */
const fs = require('fs');
const path = require('path');
const { looksExecutable } = require('./macho.cjs');
const { throwIfAborted } = require('./util.cjs');

const READ_CHUNK = 1 << 20;
const SKIP_NAMES = new Set(['.DS_Store', '__MACOSX']);

/** Stream a file in chunks of at most 1 MiB, never holding more than one. */
function fileReader(filePath, size) {
  return async function* open() {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(size, READ_CHUNK)));
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        yield buf.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
  };
}

async function readHead(filePath, length) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Run `worker` over `items` with bounded concurrency. */
async function pool(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** A symlink target as macOS should see it: '/'-separated, relative unless it was meant absolute. */
function normalizeLinkTarget(target, linkPath) {
  if (process.platform !== 'win32') return target;
  let t = target.replace(/^\\\\\?\\/, '');
  if (/^[A-Za-z]:[\\/]/.test(t)) t = path.relative(path.dirname(linkPath), t); // junctions store absolute paths
  return t.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
}

/**
 * Frameworks are versioned bundles held together by symlinks
 * (Versions/Current -> A, Foo -> Versions/Current/Foo). If the real version
 * folder is there but the `Current` link is not, the app was unpacked by
 * something that cannot create symlinks - it will not launch.
 */
function frameworkWarnings(entries) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const broken = [];
  for (const e of entries) {
    if (e.type !== 'dir' || !/\.framework$/i.test(e.path)) continue;
    const versions = byPath.get(e.path + '/Versions');
    if (!versions || versions.type !== 'dir') continue;
    const prefix = e.path + '/Versions/';
    const hasRealVersion = entries.some((x) => x.type === 'dir' && x.path.startsWith(prefix) &&
      !x.path.slice(prefix.length).includes('/') && x.path.slice(prefix.length) !== 'Current');
    const current = byPath.get(prefix + 'Current');
    if (hasRealVersion && (!current || current.type !== 'symlink')) broken.push(e.path);
  }
  if (!broken.length) return [];
  return [
    broken.length + ' framework(s) have a Versions folder but no "Versions/Current" symlink (first: ' + broken[0] +
    '). This app was probably unzipped on Windows, which drops symlinks and makes the app unusable; pass the original .zip instead.',
  ];
}

/**
 * @param {string} sourcePath
 * @param {{signal?:AbortSignal, onProgress?:function}} [o]
 */
async function scanFolder(sourcePath, o = {}) {
  const abs = path.resolve(sourcePath);
  const rootName = path.basename(abs);
  const rootStat = await fs.promises.lstat(abs);
  const isWindows = process.platform === 'win32';
  const warnings = [];
  const entries = [];

  if (!rootStat.isDirectory()) {
    if (!rootStat.isFile()) throw new Error('Source is neither a file nor a folder: ' + sourcePath);
    const entry = {
      path: rootName, type: 'file', mode: isWindows ? 0o644 : rootStat.mode & 0o7777,
      size: rootStat.size, mtime: rootStat.mtimeMs, open: fileReader(abs, rootStat.size),
    };
    if (isWindows && looksExecutable(await readHead(abs, 8))) entry.mode = 0o755;
    return { kind: 'file', rootName, entries: [entry], warnings, hasUnixModes: !isWindows, close: async () => {} };
  }

  entries.push({ path: rootName, type: 'dir', mode: isWindows ? 0o755 : rootStat.mode & 0o7777, size: 0, mtime: rootStat.mtimeMs });
  const toSniff = [];
  const stack = [{ dir: abs, rel: rootName }];
  while (stack.length) {
    throwIfAborted(o.signal);
    const { dir, rel } = stack.pop();
    const names = (await fs.promises.readdir(dir)).filter((n) => !SKIP_NAMES.has(n)).sort();
    const subdirs = [];
    for (const name of names) {
      const full = path.join(dir, name);
      const relPath = rel + '/' + name;
      const st = await fs.promises.lstat(full);
      if (st.isSymbolicLink()) {
        const target = normalizeLinkTarget(await fs.promises.readlink(full), full);
        entries.push({ path: relPath, type: 'symlink', mode: 0o755, size: Buffer.byteLength(target), mtime: st.mtimeMs, target });
      } else if (st.isDirectory()) {
        entries.push({ path: relPath, type: 'dir', mode: isWindows ? 0o755 : st.mode & 0o7777, size: 0, mtime: st.mtimeMs });
        subdirs.push({ dir: full, rel: relPath });
      } else if (st.isFile()) {
        const entry = {
          path: relPath, type: 'file', mode: isWindows ? 0o644 : st.mode & 0o7777,
          size: st.size, mtime: st.mtimeMs, open: fileReader(full, st.size),
        };
        entries.push(entry);
        if (isWindows) {
          if (/(^|\/)Contents\/MacOS$/.test(rel)) entry.mode = 0o755;
          else if (st.size >= 2) toSniff.push({ entry, full });
        }
      } else {
        warnings.push('Skipped "' + relPath + '": not a regular file, folder or symlink.');
      }
      if (o.onProgress && entries.length % 200 === 0) o.onProgress(entries.length);
    }
    // Depth-first, in name order: push in reverse so the first subfolder is handled next.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }

  await pool(toSniff, 8, async ({ entry, full }) => {
    throwIfAborted(o.signal);
    if (looksExecutable(await readHead(full, 8))) entry.mode = 0o755;
  });

  // The walk above lists a folder's children before descending, so re-sort
  // into strict path order (parents first, then depth-first by name).
  entries.sort((a, b) => comparePaths(a.path, b.path));
  warnings.push(...frameworkWarnings(entries));

  return {
    kind: /\.app$/i.test(rootName) ? 'app-folder' : 'folder',
    rootName, entries, warnings, hasUnixModes: !isWindows, close: async () => {},
  };
}

/** Order paths component-wise so that "a/b" sorts before "a.b" and parents come first. */
function comparePaths(a, b) {
  const pa = a.split('/');
  const pb = b.split('/');
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

module.exports = { scanFolder, frameworkWarnings, comparePaths, fileReader };
