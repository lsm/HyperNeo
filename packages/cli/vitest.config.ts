/// <reference types="vitest" />

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Mirror the daemon: serial file execution matches historical `bun test` behaviour.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    // e2e-coverage suites spin up real Bun.serve servers and use Bun.file/Bun.sleep
    // heavily — they stay on Bun and are migrated with the runtime phase.
    exclude: ['node_modules', 'dist', 'tests/e2e-coverage/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: [
      // bun:test maps to the daemon's vitest shim (shared across packages).
      {
        find: /^bun:test$/,
        replacement: resolve(here, '../daemon/tests/bun-test-shim.ts'),
      },
      // Workspace source aliases (no-build resolution, mirrors tsconfig paths).
      {
        find: /^@hyperneo\/shared\/(.+)$/,
        replacement: resolve(here, '../shared/src/$1'),
      },
      {
        find: /^@hyperneo\/shared$/,
        replacement: resolve(here, '../shared/src/mod.ts'),
      },
      {
        find: /^@hyperneo\/daemon\/(.+)$/,
        replacement: resolve(here, '../daemon/src/$1'),
      },
      {
        find: /^@hyperneo\/daemon$/,
        replacement: resolve(here, '../daemon/main.ts'),
      },
    ],
  },
});
