'use strict';
/**
 * Just enough Mach-O knowledge to (a) decide whether a file that lost its
 * Unix mode on Windows should get the executable bit back and (b) list the
 * CPU architectures of an app's main executable.
 */

const MH_MAGIC = 0xfeedface; // 32-bit, big-endian on disk
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM = 0xcefaedfe; // same two, little-endian on disk (every Intel/ARM Mac)
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe; // universal binary; ALSO the Java .class magic
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM = 0xbebafeca;
const FAT_CIGAM_64 = 0xbfbafeca;

// A Java class file stores minor(2)+major(2) version where a fat header keeps
// nfat_arch; the smallest Java major version is 45, real fat files have a
// handful of slices, so anything below this bound is a universal binary.
const MAX_FAT_ARCHS = 30;

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_ARCH_ABI64_32 = 0x02000000;
const CPU_NAMES = new Map([
  [7, 'i386'],
  [7 | CPU_ARCH_ABI64, 'x86_64'],
  [12, 'arm'],
  [12 | CPU_ARCH_ABI64, 'arm64'],
  [12 | CPU_ARCH_ABI64_32, 'arm64_32'],
  [18, 'ppc'],
  [18 | CPU_ARCH_ABI64, 'ppc64'],
]);

function cpuName(cputype, cpusubtype) {
  const name = CPU_NAMES.get(cputype >>> 0);
  if (!name) return 'cpu-0x' + (cputype >>> 0).toString(16);
  // arm64e is arm64 with CPU_SUBTYPE_ARM64E (2) in the low byte.
  if (name === 'arm64' && (cpusubtype & 0xff) === 2) return 'arm64e';
  return name;
}

function isThinMagic(m) {
  return m === MH_MAGIC || m === MH_MAGIC_64 || m === MH_CIGAM || m === MH_CIGAM_64;
}

function fatArchCount(head) {
  if (head.length < 8) return -1;
  const m = head.readUInt32BE(0);
  if (m === FAT_MAGIC || m === FAT_MAGIC_64) return head.readUInt32BE(4);
  if (m === FAT_CIGAM || m === FAT_CIGAM_64) return head.readUInt32LE(4);
  return -1;
}

/** True when the first bytes look like a Mach-O image or a universal binary. */
function isMachO(head) {
  if (!head || head.length < 4) return false;
  if (isThinMagic(head.readUInt32BE(0))) return true;
  const n = fatArchCount(head);
  return n >= 1 && n <= MAX_FAT_ARCHS;
}

/** True when a file starting with these bytes should be executable on a Mac. */
function looksExecutable(head) {
  if (!head || head.length < 2) return false;
  if (head[0] === 0x23 && head[1] === 0x21) return true; // "#!"
  return isMachO(head);
}

/** Architectures found in a Mach-O header (pass the first 4 KiB of the file). */
function parseArchs(head) {
  if (!head || head.length < 8) return [];
  const magic = head.readUInt32BE(0);
  if (isThinMagic(magic)) {
    const le = magic === MH_CIGAM || magic === MH_CIGAM_64;
    if (head.length < 12) return [];
    const cputype = le ? head.readUInt32LE(4) : head.readUInt32BE(4);
    const cpusubtype = le ? head.readUInt32LE(8) : head.readUInt32BE(8);
    return [cpuName(cputype, cpusubtype)];
  }
  const n = fatArchCount(head);
  if (n < 1 || n > MAX_FAT_ARCHS) return [];
  const le = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
  const is64 = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
  const entrySize = is64 ? 32 : 20; // fat_arch_64 widens offset/size and adds a reserved word
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = 8 + i * entrySize;
    if (p + 8 > head.length) break;
    const cputype = le ? head.readUInt32LE(p) : head.readUInt32BE(p);
    const cpusubtype = le ? head.readUInt32LE(p + 4) : head.readUInt32BE(p + 4);
    const name = cpuName(cputype, cpusubtype);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

module.exports = { isMachO, looksExecutable, parseArchs };
