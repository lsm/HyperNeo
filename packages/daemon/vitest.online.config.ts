/// <reference types="vitest" />

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

// Online (real-API / dev-proxy) test config. Differs from the unit config:
// - Includes tests/online/** (unit config excludes it).
// - Does NOT alias @anthropic-ai/claude-agent-sdk to the unit-test mock —
//   online tests exercise the real SDK against the dev proxy or live API.
// - bun:test is still shimmed to vitest so the existing imports resolve.
// - Longer per-test timeout (these boot a real daemon subprocess).
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: ['tests/online/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/unit/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage-online',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: [
      // bun:test → vitest shim (online tests use describe/it/expect/beforeEach).
      {
        find: /^bun:test$/,
        replacement: resolve(here, 'tests/bun-test-shim.ts'),
      },
      // bun:sqlite → runtime-agnostic compat layer (matches the unit config).
      {
        find: /^bun:sqlite$/,
        replacement: resolve(here, 'src/storage/sqlite-compat.ts'),
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
