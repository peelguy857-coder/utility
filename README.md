# Utility

One desktop app, many small tools. Every utility is a folder under [`utilities/`](utilities) — add a
folder and it appears in the sidebar, the home grid and the `Ctrl K` palette. Windows-first
(Electron + React + TypeScript), no accounts, nothing leaves the PC unless a tool says so.

| | Utility | What it does |
|---|---|---|
| Build & ship | **DMG Maker** | Turns a Mac `.app` (folder or `.zip`) into a drag-to-install `.dmg` — on Windows, no Mac needed. Background picture, icon layout, volume icon. |
| | **Icon Forge** | One picture → `.ico`, `.icns`, PNG set, favicons, Electron and Tauri icon folders. |
| Phone | **Phone Mirror** | Shows the iPhone's screen in a window. The PC appears under *Screen Mirroring* in Control Center (AirPlay receiver written in JS). |
| | **Phone Drop** | Files, photos and text between PC and phone over Wi-Fi: scan a QR code, done. |
| | **QR Maker** | Links, text and Wi-Fi logins as PNG/SVG QR codes. |
| Images & colour | **Image Lab** | Resize, convert, squeeze — presets for YouTube, Steam and Discord. |
| | **Color Studio** | Screen eyedropper, conversions, palettes, contrast check. |
| Developer | **Port Doctor** | What is listening on which port, and end the process that is hogging it. |
| | **Text Tools** | JSON, Base64, URLs, UUIDs, timestamps, case conversion. |
| | **File Hash** | Checksums for any file and a one-paste download check. |

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
