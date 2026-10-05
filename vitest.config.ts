/**
 * Standalone spec run: node environment by default, with the component and
 * wiring specs opting into jsdom through their own `@vitest-environment`
 * pragma. The setup file seeds the globals the shell normally provides, and
 * the DSH packages are inlined so Vite compiles the CSS Modules their
 * published bundles import.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/support/setup.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    server: { deps: { inline: [/@deepseek-ai\//] } },
  },
})
