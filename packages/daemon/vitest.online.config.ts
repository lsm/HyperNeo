/// <reference types="vitest" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = __dirname;

const rawMarkdown = {
  name: 'raw-markdown',
  enforce: 'pre' as const,
  load(id: string) {
    if (id.endsWith('.md')) {
      return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`;
    }
    return undefined;
  },
};

export default defineConfig({
  plugins: [rawMarkdown],
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: ['tests/online/**/*.test.ts', 'tests/online/**/*_test.ts'],
    exclude: ['node_modules', 'dist', 'tests/unit/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS: '30000',
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
