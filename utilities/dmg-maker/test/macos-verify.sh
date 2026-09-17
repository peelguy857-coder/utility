#!/bin/bash
# Runs on a real Mac (GitHub Actions): does macOS accept the image our Windows-side writer produced?
#   macos-verify.sh <image.dmg> <manifest.json> <report.txt> [screenshot.png]
# Exit code 0 only when every hard check passed. The report is always completed.
set -u
DMG="$1"; MANIFEST="$2"; REPORT="$3"; SHOT="${4:-}"
FAIL=0
: > "$REPORT"

log()  { echo "$@" | tee -a "$REPORT"; }
step() { log ""; log "=================================================================="; log "== $*"; }
run()  { log "\$ $*"; "$@" 2>&1 | tee -a "$REPORT"; return "${PIPESTATUS[0]}"; }
ok()   { log "RESULT ok    $*"; }
bad()  { log "RESULT FAIL  $*"; FAIL=1; }

step "system"
run sw_vers
run uname -m

step "hdiutil imageinfo"
if run hdiutil imageinfo "$DMG"; then ok "imageinfo"; else bad "imageinfo"; fi

step "hdiutil verify (checksums)"
if run hdiutil verify "$DMG"; then ok "verify"; else bad "verify"; fi

step "fsck_hfs on the unmounted volume"
ATTACH_OUT=$(hdiutil attach -nomount -readonly "$DMG" 2>&1); log "$ATTACH_OUT"
DEV=$(echo "$ATTACH_OUT" | awk '/^\/dev\//{print $1}' | tail -1)
if [ -n "$DEV" ]; then
  if run fsck_hfs -fn "$DEV"; then ok "fsck_hfs"; else bad "fsck_hfs reported problems"; fi
  run hdiutil detach "$DEV"
else
  bad "could not attach the image without mounting"
fi

step "mount read-only and compare every entry with the manifest"
MNT=$(mktemp -d /tmp/dmgverify.XXXXXX)
if run hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$DMG"; then
  ok "mount"
  run diskutil info "$MNT"
  python3 - "$MNT" "$MANIFEST" <<'PY' 2>&1 | tee -a "$REPORT"
import hashlib, json, os, stat, sys, unicodedata
mnt, manifest = sys.argv[1], json.load(open(sys.argv[2], encoding="utf-8"))
problems, checked = [], 0
for e in manifest["entries"]:
    p = os.path.join(mnt, e["path"])
    try:
        st = os.lstat(p)
    except OSError as err:
        problems.append(f"missing: {e['path']} ({err})"); continue
    kind = "symlink" if stat.S_ISLNK(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "file"
    if kind != e["type"]:
        problems.append(f"{e['path']}: is a {kind}, expected {e['type']}"); continue
    if (st.st_mode & 0o777) != (e["mode"] & 0o777):
        problems.append(f"{e['path']}: mode {oct(st.st_mode & 0o777)} expected {oct(e['mode'] & 0o777)}")
    if kind == "symlink" and os.readlink(p) != e["target"]:
        problems.append(f"{e['path']}: link -> {os.readlink(p)} expected {e['target']}")
    if kind == "file":
        if st.st_size != e["size"]:
            problems.append(f"{e['path']}: size {st.st_size} expected {e['size']}")
        elif e.get("sha256"):
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""): h.update(block)
            if h.hexdigest() != e["sha256"]: problems.append(f"{e['path']}: content differs")
    checked += 1
# anything on the volume that the manifest does not know about?
known = {unicodedata.normalize("NFD", e["path"]) for e in manifest["entries"]}
extra = []
for root, dirs, files in os.walk(mnt):
    for name in dirs + files:
        rel = unicodedata.normalize("NFD", os.path.relpath(os.path.join(root, name), mnt))
        if rel not in known and not rel.startswith(".fseventsd") and rel != ".Trashes": extra.append(rel)
print(f"compared {checked} of {len(manifest['entries'])} entries; {len(problems)} problems; {len(extra)} unexpected entries")
for line in problems[:40]: print("  PROBLEM", line)
for line in extra[:20]: print("  EXTRA  ", line)
sys.exit(1 if problems or extra else 0)
PY
  if [ "${PIPESTATUS[0]}" -eq 0 ]; then ok "every entry matches (type, mode, size, sha256, link target)"; else bad "volume contents differ from the manifest"; fi

  step "things a person would notice"
  WANT_NAME=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['volumeName'])" "$MANIFEST")
  GOT_NAME=$(diskutil info "$MNT" | awk -F': *' '/Volume Name/{print $2}')
  if [ "$GOT_NAME" = "$WANT_NAME" ]; then ok "volume name is '$GOT_NAME'"; else bad "volume name is '$GOT_NAME', expected '$WANT_NAME'"; fi

  if [ "$(readlink "$MNT/Applications")" = "/Applications" ] && [ -d "$MNT/Applications/" ]; then ok "Applications shortcut resolves"; else bad "Applications shortcut is broken"; fi

  FINDER_INFO=$(xattr -px com.apple.FinderInfo "$MNT" 2>/dev/null | tr -d ' \n')
  log "root FinderInfo: ${FINDER_INFO:-<none>}"
  FLAG_BYTE=$((16#${FINDER_INFO:16:2}))
  if [ -n "$FINDER_INFO" ] && [ $((FLAG_BYTE & 4)) -ne 0 ] && [ -f "$MNT/.VolumeIcon.icns" ]; then ok "custom volume icon flag is set"; else bad "custom volume icon flag is not set"; fi

  COPY=$(mktemp -d /tmp/dmgcopy.XXXXXX)
  if run cp -R "$MNT/Demo.app" "$COPY/"; then
    if [ -x "$COPY/Demo.app/Contents/MacOS/Demo" ] && [ -L "$COPY/Demo.app/Contents/Frameworks/Thing.framework/Versions/Current" ] && [ -f "$COPY/Demo.app/Contents/Frameworks/Thing.framework/Thing" ]; then
      ok "drag-install copy keeps the executable bit and the framework links"
    else bad "the copied app lost its executable bit or framework links"; fi
  else bad "cp -R of the app failed"; fi
  run file "$COPY/Demo.app/Contents/MacOS/Demo"

  step ".DS_Store as the reference parser sees it (informational)"
  ( python3 -m venv /tmp/dsvenv && /tmp/dsvenv/bin/pip -q install ds_store mac_alias ) >/dev/null 2>&1
  /tmp/dsvenv/bin/python - "$MNT/.DS_Store" <<'PY' 2>&1 | tee -a "$REPORT"
import sys
try:
    from ds_store import DSStore
    from mac_alias import Alias, Bookmark
except Exception as err:
    print("reference parsers unavailable:", err); sys.exit(0)
with DSStore.open(sys.argv[1], "r") as d:
    for rec in d:
        value = rec.value
        if rec.code in (b"icvp", b"bwsp") and isinstance(value, dict):
            shown = {k: (f"<{len(v)} bytes>" if isinstance(v, (bytes, bytearray)) else v) for k, v in value.items()}
            print(rec.filename, rec.code.decode(), shown)
            blob = value.get("backgroundImageAlias")
            if blob:
                try:
                    a = Alias.from_bytes(bytes(blob)); print("  alias:", a.volume.name, "|", a.target.filename, "| cnid", a.target.cnid_path, "| posix", a.target.posix_path)
                except Exception as err: print("  alias did not parse:", err)
        elif rec.code == b"pBBk":
            try:
                b = Bookmark.from_bytes(bytes(value)); print(rec.filename, "pBBk bookmark ok, path:", b.get(0x1004, None))
            except Exception as err: print(rec.filename, "pBBk did not parse:", err)
        else:
            print(rec.filename, rec.code.decode(errors="replace"), value if not isinstance(value, (bytes, bytearray)) else f"<{len(value)} bytes>")
PY

  run hdiutil detach "$MNT"
else
  bad "macOS refused to mount the image"
fi

step "what Finder shows (best effort, never fails the run)"
if [ -n "$SHOT" ]; then
  if hdiutil attach "$DMG" >> "$REPORT" 2>&1; then
    sleep 3
    open "/Volumes/$WANT_NAME" >> "$REPORT" 2>&1
    sleep 6
    if screencapture -x "$SHOT" >> "$REPORT" 2>&1 && [ -s "$SHOT" ]; then log "screenshot saved: $SHOT"; else log "screencapture not possible on this runner"; fi
    osascript -e 'tell application "Finder" to get {bounds, current view} of front window' >> "$REPORT" 2>&1
    osascript -e 'tell application "Finder" to get {icon size, background picture} of icon view options of front window' >> "$REPORT" 2>&1
    osascript -e 'tell application "Finder" to get {name, position} of every item of front window' >> "$REPORT" 2>&1
    hdiutil detach "/Volumes/$WANT_NAME" >> "$REPORT" 2>&1
  else
    log "normal attach failed"
  fi
fi

step "summary"
if [ "$FAIL" -eq 0 ]; then log "ALL HARD CHECKS PASSED"; else log "SOME CHECKS FAILED"; fi
exit "$FAIL"
