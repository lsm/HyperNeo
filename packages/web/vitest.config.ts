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
      // Handle subpath imports (e.g., @neokai/shared/sdk/type-guards)
      {
        find: /^@neokai\/shared\/(.+)$/,
        replacement: resolve(__dirname, '../shared/src/$1'),
      },
      // Handle main package import
      {
        find: '@neokai/shared',
        replacement: resolve(__dirname, '../shared/src/mod.ts'),
      },
      {
        find: /^@neokai\/ui\/(.+)$/,
        replacement: resolve(__dirname, '../ui/src/$1'),
      },
      {
        find: '@neokai/ui',
        replacement: resolve(__dirname, '../ui/src/mod.ts'),
      },
    ],
  },
});
