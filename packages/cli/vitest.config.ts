/// <reference types="vitest" />

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/e2e-coverage/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: [
      {
        find: /^bun:test$/,
        replacement: resolve(here, '../daemon/tests/bun-test-shim.ts'),
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
