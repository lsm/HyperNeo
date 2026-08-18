/// <reference types="vitest" />

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: ['tests/**/*.test.ts', 'tests/**/*_test.ts'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: [
      {
        find: /^bun:test$/,
        replacement: resolve(here, '../daemon/tests/bun-test-shim.ts'),
      },
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
