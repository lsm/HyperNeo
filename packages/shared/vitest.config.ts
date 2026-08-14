/// <reference types="vitest" />

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Match the daemon shard behaviour (historical `bun test --jobs=1`):
    // several suites rely on module-level state and are not file-parallel-safe.
    fileParallelism: false,
    // Match both `.test.ts` and `_test.ts` (the daemon shard does the same) so
    // the universal coverage guard's both-suffix model holds for shared too.
    include: ['tests/**/*.test.ts', 'tests/**/*_test.ts'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: [
      // bun:test maps to the daemon-owned vitest shim (single source for the
      // bun:test API surface and custom matchers).
      {
        find: /^bun:test$/,
        replacement: resolve(here, '../daemon/tests/bun-test-shim.ts'),
      },
      // Workspace source aliases (no-build resolution, mirrors tsconfig paths).
      {
        find: /^@hyperneo\/shared\/(.+)$/,
        replacement: resolve(here, 'src/$1'),
      },
      {
        find: /^@hyperneo\/shared$/,
        replacement: resolve(here, 'src/mod.ts'),
      },
    ],
  },
});
