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
    testTimeout: 15_000,
    fileParallelism: false,
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
      {
        find: /^bun:test$/,
        replacement: resolve(here, 'tests/bun-test-shim.ts'),
      },
      {
        find: /^bun:sqlite$/,
        replacement: resolve(here, 'src/storage/sqlite-compat.ts'),
      },
      {
        find: /^@anthropic-ai\/claude-agent-sdk$/,
        replacement: resolve(here, 'tests/sdk-mock.ts'),
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
