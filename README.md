# Utility

One desktop app, many small tools. Every utility is a folder under [`utilities/`](utilities) — add a
folder and it appears in the sidebar, the home grid and the `Ctrl K` palette. Windows-first
(Electron + React + TypeScript), no accounts, nothing leaves the PC unless a tool says so.

| | Utility | What it does | Status |
|---|---|---|---|
| Build & ship | **DMG Maker** | Turns a Mac `.app` (folder or `.zip`) into a drag-to-install `.dmg` — on Windows, no Mac needed. Cover picture, icon layout, disk icon. | Engine done: images are verified on real Macs (macOS 15 + 26) by CI — `hdiutil verify`, `fsck_hfs`, mount, every file compared, Finder layout |
| | **Icon Forge** | One picture → `.ico`, `.icns`, PNG set, favicons, Electron and Tauri icon folders. | Working |
| Phone | **Phone Drop** | Files, photos and text between PC and phone over Wi-Fi: scan a QR code, done. | Working |
| | **QR Maker** | Links, text and Wi-Fi logins as PNG/SVG QR codes. | Working |
| | **Phone Mirror** | iPhone screen in a window via AirPlay (receiver written in JS), with sound, volume and MP4 recording. | Works with a real iPhone; engine not in the repo yet (licence decision pending) |
| Images & colour | **Thumbnail Tester** | Your YouTube thumbnail in the home feed, search, sidebar and on a phone, next to other videos — plus size/ratio/2 MB checks. | Working |
| | **Image Lab** | Resize, convert, squeeze — presets for YouTube, Steam and Discord. | Built, needs a polish pass |
| Developer | **Port Doctor** | What is listening on which port, and end the process that is hogging it. | Working |
| | **File Hash** | Checksums for any file and a one-paste download check. | Working |

Planned next: Color Studio (eyedropper, palettes, contrast) and Text Tools (JSON, Base64, UUIDs, timestamps).

## Run it

```
npm install
npm run dev        # hot reload
npm start          # build the UI, then run the app
```

## Work on it

```
npm run typecheck
npm test           # every utilities/<id>/test/selftest.cjs
npm run shots      # drives the real app and saves screenshots of every screen to .shots/
```

How to add a utility: [docs/ADDING-A-UTILITY.md](docs/ADDING-A-UTILITY.md).

```
electron/     main process: window, core services (dialogs, files, clipboard, network check), utility router
src/          the shell: title bar, sidebar, palette, pages, shared UI kit, theme tokens
utilities/    one folder per utility: meta.ts + ui.tsx (+ main.cjs backend, lib/, test/)
tools/        dev server launcher, test runner, screenshot runner, packaging
```
