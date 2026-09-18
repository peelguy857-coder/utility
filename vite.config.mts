import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

// React fast-refresh injects an inline script in dev, which the strict production CSP
// would block. Relax script-src for the dev server only; the built index.html keeps it strict.
function devCsp(): Plugin {
  return {
    name: 'utility-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    },
  }
}

// FFmpeg compiled to WebAssembly (used by Phone Mirror to decode the iPhone's AAC-ELD audio) is
// served from /ffmpeg/ in dev and copied to dist/ffmpeg/ in builds, straight from node_modules.
function ffmpegFiles(): Plugin {
  const src = path.resolve(import.meta.dirname, 'node_modules/@ffmpeg/core/dist/umd')
  const names = ['ffmpeg-core.js', 'ffmpeg-core.wasm']
  return {
    name: 'utility-ffmpeg-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/ffmpeg\/(ffmpeg-core\.(?:js|wasm))(?:\?.*)?$/.exec(req.url || '')
        if (!m) return next()
        res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        fs.createReadStream(path.join(src, m[1])).pipe(res)
      })
    },
    closeBundle() {
      const out = path.resolve(import.meta.dirname, process.env.UTILITY_DIST || 'dist', 'ffmpeg')
      fs.mkdirSync(out, { recursive: true })
      for (const n of names) fs.copyFileSync(path.join(src, n), path.join(out, n))
    },
  }
}

// The renderer is a plain Vite + React app. `base: './'` so the built files load from file://.
export default defineConfig({
  base: './',
  plugins: [react(), devCsp(), ffmpegFiles()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: { port: 5317, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome150' },
})
