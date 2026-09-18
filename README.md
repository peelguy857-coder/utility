# Utility

One desktop app, many small tools. Every utility is a folder under [`utilities/`](utilities) — add a
folder and it appears in the sidebar, the home grid and the `Ctrl K` palette. Windows-first
(Electron + React + TypeScript), no accounts, nothing leaves the PC unless a tool says so.

| | Utility | What it does | Status |
|---|---|---|---|
| Build & ship | **DMG Maker** | Turns a Mac `.app` (folder or `.zip`) into a drag-to-install `.dmg` — on Windows, no Mac needed. Cover picture, icon layout, disk icon. | Verified on real Macs (macOS 15 + 26) by CI |
| | **Icon Forge** | One picture → `.ico`, `.icns`, PNG set, favicons, Electron and Tauri icon folders. | Working |
| | **Steam Page Kit** | Every capsule, hero, logo and screenshot size a Steam store page needs, cropped to exact size. | Working |
| | **3D Model Viewer** | Drop a `.glb`: spin it, triangles, materials, textures, animations. | Working |
| Phone | **Phone Mirror** | iPhone screen in a window via AirPlay (receiver written in JS): sound (AAC-ELD via FFmpeg-wasm), volume, MP4 recording. | Works with a real iPhone; engine not in the repo yet (licence decision pending) |
| | **Phone Drop** | Files, photos and text between PC and phone over Wi-Fi: scan a QR code, done. | Working |
| | **QR Maker** | Links, text and Wi-Fi logins as PNG/SVG QR codes. | Working |
| Images & colour | **Thumbnail Tester** | Your YouTube thumbnail in the home feed, search, sidebar and on a phone, next to other videos — plus size/ratio/2 MB checks. | Working |
| | **Screen Recorder** | Whole screen or one window → MP4 with PC sound and/or microphone. | Working |
| | **Image Lab** | Resize, convert, squeeze — presets for YouTube, Steam and Discord. | Working |
| | **Color Studio** | Screen eyedropper, every colour format (CSS, Godot, Three.js), OKLCH scales, harmonies, WCAG contrast. | Working |
| Games & fun | **Mystery Maker** | Build an ARG-style treasure hunt: ciphers (Caesar, Vigenère, Base64, Morse, invisible ink…), messages hidden in PNG pixels/metadata and in a WAV's spectrogram, password zips, decoy folder mazes, QR codes, a final reveal page with an unlisted video — plus a solution sheet and a decode-anything tab. | Working |
| Developer | **Project Launcher** | All your Node projects on one page: start `npm run dev`, watch the log, open the URL, stop. | Working |
| | **Port Doctor** | What is listening on which port, and end the process that is hogging it. | Working |
| | **Text Tools** | JSON, Base64, URLs, UUIDs, passwords, timestamps, case changes, hashes. | Working |
| | **File Hash** | Checksums for any file and a one-paste download check. | Working |

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
