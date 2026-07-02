import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { defineConfig } from 'vite';

const repoTmpDir = resolve(__dirname, '../../tmp').replace(/\\/g, '/');

export default defineConfig({
  plugins: [preact(), tailwindcss()],

  root: 'src',
  publicDir: '../public',

  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/rehype-highlight')) {
            return 'vendor-hljs';
          }
          if (id.includes('node_modules/highlight.js')) {
            return 'vendor-hljs';
          }
          if (id.includes('node_modules/rehype-katex')) {
            return 'vendor-katex';
          }
          if (id.includes('node_modules/katex')) {
            return 'vendor-katex';
          }
          if (
            id.includes('node_modules/unified') ||
            id.includes('node_modules/remark-') ||
            id.includes('node_modules/rehype-')
          ) {
            return 'vendor-markdown';
          }
          if (id.includes('node_modules/mermaid')) {
            return 'vendor-mermaid';
          }
        },
      },
    },
  },

  server: {
    // NOTE: When using dev-server.ts (make dev), these settings are OVERRIDDEN
    // by the createViteServer() options which uses port 5173 internally.
    // These defaults are for standalone Vite development (make web).
    port: 9283,
    strictPort: true,
    host: true,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'ai0.tailcd822a.ts.net',
      'tts.tailcd822a.ts.net',
      'tts',
    ],
    hmr: {
      overlay: true,
      protocol: 'ws',
      host: 'localhost',
    },
    watch: {
      // Watch for changes in all relevant files
      // Exclude database, temporary files, and session workspace worktrees
      // NOTE: We specifically ignore tmp/workspace/.worktrees/ (session worktrees) but NOT
      // the development worktree we might be running from (e.g., .worktrees/session-id/)
      ignored: [
        '**/node_modules/**',
        '**/dist/**',
        '**/data/**',
        `${repoTmpDir}/**`, // Repo-local tmp only; worktrees may live under /Users/.../tmp.
      ],
      usePolling: false, // Use native file system events
    },
    // Proxy API and WebSocket requests to daemon
    proxy: {
      '/api': {
        target: process.env.DAEMON_URL || 'http://localhost:8283',
        changeOrigin: true,
        ws: true, // Enable WebSocket proxying
      },
      // Also proxy WebSocket connections directly
      '/ws': {
        target: 'ws://localhost:8283',
        changeOrigin: true,
        ws: true,
      },
    },
  },

  optimizeDeps: {
    include: ['preact', '@preact/signals', 'clsx'],
    exclude: ['@hyperneo/shared'], // Exclude local packages from pre-bundling
    esbuildOptions: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
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
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
});
