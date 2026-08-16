/// <reference types="vitest" />

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Generous per-test budget: several suites pay real setup cost per test
    // (migration files replay the full schema chain; model-service tests
    // register the provider stack). The vitest 5s default is calibrated for
    // isolated fast tests and intermittently kills correct tests on loaded
    // CI runners — the exact flakes registered in flaky-tests.json.
    testTimeout: 15_000,
    // Run files serially within a shard: several suites rely on module-level
    // state (provider registry, SDK mock) and are not parallel-safe at the
    // file level, matching the historical `bun test --jobs=1` behaviour.
    fileParallelism: false,
    // Match both `.test.ts` and `_test.ts` (bun:test ran both by default; the
    // migrations suite uses the `_test.ts` suffix — 45 files / ~395 cases that
    // a `.test.ts`-only glob silently drops). Vitest applies `include` even to
    // explicitly-passed CLI paths, so omitting `_test.ts` here skips them.
    include: ['tests/**/*.test.ts', 'tests/**/*_test.ts'],
    exclude: ['node_modules', 'dist', 'tests/online/**'],
    setupFiles: [resolve(here, 'tests/vitest.setup.ts')],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: [
      // bun:test maps to a vitest shim (so ~500 test files need no import edit).
      {
        find: /^bun:test$/,
        replacement: resolve(here, 'tests/bun-test-shim.ts'),
      },
      // bun:sqlite maps to the runtime-agnostic compat layer (node:sqlite).
      // Catches any test file that still imports `bun:sqlite` directly (e.g.
      // files merged from dev post-codemod) so they need no per-file edit.
      {
        find: /^bun:sqlite$/,
        replacement: resolve(here, 'src/storage/sqlite-compat.ts'),
      },
      // The global SDK mock (replaces the bun:test mock.module preload).
      {
        find: /^@anthropic-ai\/claude-agent-sdk$/,
        replacement: resolve(here, 'tests/sdk-mock.ts'),
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
        find: /^@\/(.+)$/,
        replacement: resolve(here, 'src/$1'),
      },
    ],
  },
});
