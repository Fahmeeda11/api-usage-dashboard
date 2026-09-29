import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    setupFiles: ['apps/api/src/test/env-setup.ts'],
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'apps/api/**/*.test.ts',
      'apps/worker/**/*.test.ts',
      // reorder.ts is deliberately pure (no React, no dnd-kit), so its tests run
      // in the node environment alongside everything else - no jsdom needed.
      'apps/web/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
