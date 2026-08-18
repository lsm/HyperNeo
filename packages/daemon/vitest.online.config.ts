/// <reference types="vitest" />

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: ['tests/online/**/*.test.ts', 'tests/online/**/*_test.ts'],
    exclude: ['node_modules', 'dist', 'tests/unit/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      HYPERNEO_SDK_STARTUP_TIMEOUT_MS: '30000',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage-online',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: [
      {
        find: /^bun:test$/,
        replacement: resolve(here, 'tests/bun-test-shim.ts'),
      },
      {
        find: /^bun:sqlite$/,
        replacement: resolve(here, 'src/storage/sqlite-compat.ts'),
      },
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
