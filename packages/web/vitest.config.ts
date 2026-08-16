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
    // Component tests assert through real-timer waitFor against multi-effect
    // data loads; the 5s default intermittently kills correct tests on loaded
    // CI runners (see the SpaceGoals entry in flaky-tests.json).
    testTimeout: 15_000,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      exclude: [
        'src/index.ts', // Bun server - not testable in vitest
        '**/index.ts', // Barrel exports - just re-exports
      ],
    },
  },

  resolve: {
    alias: [
      // Handle subpath imports (e.g., @hyperneo/shared/sdk/type-guards)
      {
        find: /^@hyperneo\/shared\/(.+)$/,
        replacement: resolve(__dirname, '../shared/src/$1'),
      },
      // Handle main package import
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
