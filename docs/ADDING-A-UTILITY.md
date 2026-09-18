# Adding a utility

A utility is **one folder** under `utilities/`. Nothing else has to be edited: the app finds the
folder by itself and puts it in the sidebar, the home grid and the Ctrl+K palette.

```
utilities/my-tool/
  meta.ts      required  name, tagline, category, icon, hue
  ui.tsx       required  default-exported React component (the screen)
  ui.css       optional  styles for this utility only (import it from ui.tsx)
  main.cjs     optional  backend: anything that needs Node (files, network, processes)
  lib/         optional  pure logic, testable with plain `node`
  test/        optional  `*.cjs` self-tests, run by `npm test`
```

The folder name is the utility id: lowercase letters, digits and dashes.

## meta.ts

```ts
import { Wrench } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'my-tool',                 // must equal the folder name
  name: 'My Tool',
  tagline: 'One short sentence: what it does for you.',
  category: 'dev',               // 'ship' | 'phone' | 'media' | 'play' | 'dev' | 'system'  (see src/lib/registry.ts)
  icon: Wrench,                  // any lucide-react icon
  hue: 210,                      // 0-360, the tile colour; pick one no neighbour uses
  keywords: ['extra', 'search', 'words'],
  status: 'beta',                // optional badge
  order: 50,                     // optional, lower sorts first inside the category
}
export default meta
```

## ui.tsx

Build the screen from the shared kit so it looks like the rest of the app:

- `@/components/ui` — `Workbench` (main column + options column), `Panel`, `Stack`, `Row`, `Button`,
  `IconButton`, `CopyButton`, `Field`, `TextInput`, `NumberInput`, `TextArea`, `Select`, `Toggle`,
  `Segmented`, `Slider`, `Checkbox`, `Progress`, `Badge`, `Kbd`, `Notice`, `Facts`, `LogView`, `Empty`, `Spinner`
- `@/components/Dropzone` — `Dropzone` (drop or browse, gives real paths) and `PathChip`
- `@/components/Toasts` — `useToast()` for results and errors
- `@/lib/bridge` — `core.*` (file dialogs, read/write a user-chosen file, reveal in Explorer, clipboard,
  open a link), `useBackend(id)`, `useBackendEvent(id, event, handler)`, `errorMessage(err)`
- `@/lib/format` — `formatBytes`, `formatDuration`, `baseName`, `cx`, …
- `@/lib/active` — `useIsActive()`; opened utilities stay mounted in the background (so jobs survive
  navigation), pause animation/polling when this is false

Colours come from CSS variables (`--bg-raised`, `--line`, `--text-dim`, `--accent`, … in
`src/styles/tokens.css`); `--tint` / `--tint-soft` are this utility's own colour. Never hard-code a
colour that has to work in both themes. `qr-maker` is the smallest complete example.

## main.cjs (only when the browser side cannot do it)

```js
module.exports = {
  async init(ctx) {},          // optional, once, before the first call
  async dispose() {},          // optional, on quit: stop servers, kill child processes
  handlers: {
    async doThing(args, ctx) { // UI: const api = useBackend('my-tool'); await api.invoke('doThing', {...})
      ctx.emit('progress', { done: 1, total: 3 })   // UI: useBackendEvent('my-tool', 'progress', fn)
      return { ok: true }
    },
  },
}
```

`ctx` gives `emit`, `dataDir()` (persistent folder for this utility), `tempDir()`, `settings.get/set`,
`window()`, `allow(path)` / `isAllowed(path)` and `appInfo`. The backend is loaded the first time the
UI calls it. Throw a normal `Error` with a message a person can act on; the UI shows it in a toast.

Rules that keep the app safe and fast:

- The UI has no Node access. It talks to the backend only through `invoke` / events.
- Generic file reads/writes (`core.readFile`, `core.writeFile`) only work on paths the user picked or dropped.
- Long work must report progress and be cancellable; never block the main process with sync loops over big data.
- No new npm dependency without a good reason; say why in the commit.

## Checking your work

```
npm run typecheck      # types
npm test               # every utilities/*/test/selftest.cjs
npm run shots          # screenshots of every screen into .shots/ (own throwaway profile)
npm run shots -- my-tool   # only screens whose name contains "my-tool"
npm run dev            # the app with hot reload
```

`npm run shots` opens each utility and saves `NN-<id>.png`. To screenshot more than the empty state,
add `utilities/<id>/test/shots.cjs`; it runs right after the first capture and can drive the real UI:

```js
module.exports = async (t) => {
  t.queuePick(['C:/path/to/input.png'])   // the next file/folder/save dialog returns this instead of opening
  await t.clickText('Browse')             // click a visible button by (part of) its text
  await t.setInput('.my-tool input', '64')
  await t.sleep(600)
  await t.capture('loaded')               // -> NN-my-tool--loaded.png
  const shown = await t.text('.my-tool__result')   // read text back to assert on it
  if (!shown.includes('64')) throw new Error('size not applied')
}
```

Also available: `t.exec(js)` (run JS in the page), `t.click(selector)`, `t.tmpDir()` (scratch folder for
generated fixtures), `t.win`. A thrown error or an uncaught page error fails the run.

Two runs can happen at once if each uses its own folders:
`UTILITY_DIST=.dist-x UTILITY_SHOTS_OUT=.shots-x node tools/shots.cjs my-tool`.
