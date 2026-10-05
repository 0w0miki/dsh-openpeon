/** Host-half build: the Cordis plugin the Loader imports as `lib/index.js`. */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  outDir: 'lib',
  dts: false,
  sourcemap: false,
  // The browser build runs first and owns cleaning the output directory.
  clean: false,
  outputOptions: { entryFileNames: 'index.js' },
})
