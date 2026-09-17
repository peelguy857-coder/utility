# DMG Maker — where the knowledge came from

All code in `lib/` was written for this project. No third-party source code is included. The on-disk
formats were implemented from public descriptions:

- **HFS Plus / HFSX volume format** — Apple Technical Note TN1150, "HFS Plus Volume Format".
- **UDIF (`.dmg`) container** (koly trailer, `blkx`/`mish` block tables, chunk types, CRC-32 checksums) —
  public reverse-engineering write-ups of the format, and what Apple's own `hdiutil` writes (compared
  field by field in CI, see `test/macos-verify.sh`).
- **`.DS_Store`, alias and bookmark records** — the format descriptions that accompany the Python packages
  `ds_store` and `mac_alias` by Alastair Houghton (MIT licence). Those packages are also used in CI as an
  independent parser to cross-check what this library writes. No code from them is included here.
- **ZIP** — PKWARE's APPNOTE.TXT.

macOS is the judge of whether an image is correct: the CI job mounts the test image on real Macs, runs
`hdiutil verify` and `fsck_hfs`, and compares every file with the manifest.
