import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

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

// The renderer is a plain Vite + React app. `base: './'` so the built files load from file://.
export default defineConfig({
  base: './',
  plugins: [react(), devCsp()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: { port: 5317, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome150' },
})
