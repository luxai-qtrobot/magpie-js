import { defineConfig } from 'tsup'

export default defineConfig([
  // ESM + CJS for npm / Node.js
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  // UMD bundle for CDN — everything bundled, exposed as window.Magpie
  {
    entry: { magpie: 'src/index.ts' },
    format: ['iife'],
    globalName: 'Magpie',
    platform: 'browser',
    define: { global: 'globalThis' },
    outExtension: () => ({ js: '.umd.js' }),
    sourcemap: true,
    minify: true,
  },
])
