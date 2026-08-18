/// <reference types="vitest" />

import preact from '@preact/preset-vite';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],

  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    testTimeout: 15_000,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      exclude: ['src/index.ts', '**/index.ts'],
    },
  },

  resolve: {
    alias: [
      {
        find: /^@hyperneo\/shared\/(.+)$/,
        replacement: resolve(__dirname, '../shared/src/$1'),
      },
      {
        find: '@hyperneo/shared',
        replacement: resolve(__dirname, '../shared/src/mod.ts'),
      },
      {
        find: /^@hyperneo\/ui\/(.+)$/,
        replacement: resolve(__dirname, '../ui/src/$1'),
      },
      {
        find: '@hyperneo/ui',
        replacement: resolve(__dirname, '../ui/src/mod.ts'),
      },
    ],
  },
});
