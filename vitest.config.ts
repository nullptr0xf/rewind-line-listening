import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The app imports its own modules through the "@/*" tsconfig path alias.
 * Vitest does not read tsconfig paths, so the alias is mirrored here — without
 * it every test that touches lib/sync or lib/server fails to resolve.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
})
