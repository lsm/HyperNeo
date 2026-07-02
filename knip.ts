import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // Monorepo workspace configuration
  workspaces: {
    'packages/cli': {
      entry: ['src/dev-server.ts', 'src/prod-server.ts', 'prod-entry.ts', 'tests/**/*.ts'],
    },
    'packages/daemon': {
      entry: ['src/app.ts', 'src/lib/rpc-handlers/*.ts', 'tests/**/*.ts'],
    },
    'packages/neo': {
      // Neo package exports public API for external use
      entry: ['src/index.ts'],
    },
    'packages/shared': {
      entry: ['src/mod.ts', 'tests/**/*.ts'],
    },
    'packages/web': {
      // Web entry is client.tsx (rendered by vite), not index.ts
      entry: ['src/client.tsx', 'src/index.html'],
    },
    'packages/desktop': {
      // Pure Tauri/Rust shell — no TS/JS sources, scripts only.
      entry: [],
    },
  },

  // Ignore patterns
  ignore: [
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/__tests__/**',
    '**/dist/**',
    '**/node_modules/**',
    '**/*.d.ts',
    'packages/e2e/**', // E2E tests have different patterns
    'e2e/**', // E2E test files
    'docs/**',
    'examples/**', // Example scripts
    'scripts/**', // Utility scripts
    'npm/**', // npm distribution launcher
    '**/*.config.ts',
    '**/*.config.js',
    'packages/web/vite.config.ts',
    'packages/web/tailwind.config.ts',
    'packages/web/postcss.config.js',
    'packages/web/src/index.ts', // Standalone dev server, not used in production
    'packages/web/src/lib/router.ts', // Router functions called via navigateToRoom etc
    'packages/neo/src/**/*.ts', // Neo package - public API for external use
    'packages/daemon/scripts/**', // Database recovery scripts
    'packages/daemon/tests/manual/**', // Manual test scripts
    'packages/daemon/tests/mocks/**', // Test mocks
    'packages/daemon/tests/helpers/**', // Test helpers (used by online tests outside knip scan)
    'packages/shared/src/sdk/**', // SDK types from Claude Agent SDK (not all used)
    '.claude/**', // Claude Code worktrees and session files
  ],

  ignoreFiles: [
    'packages/daemon/src/lib/agent/reference-resolver.ts', // Legacy resolver kept for compatibility
    'packages/daemon/src/lib/id-resolution.ts', // Legacy resolver kept for compatibility
  ],

  ignoreIssues: {
    'packages/daemon/src/lib/agent/loop-detector-hook.ts': ['exports'],
    'packages/daemon/src/lib/db-query/scope-config.ts': ['exports'],
    'packages/daemon/src/lib/external-events/topic-trie.ts': ['exports'],
    'packages/daemon/src/lib/model-service.ts': ['exports'],
    'packages/daemon/src/lib/provider-service.ts': ['exports'],
    'packages/daemon/src/lib/providers/openai-chat-bridge/server.ts': ['exports'],
    'packages/daemon/src/lib/providers/openai-responses-bridge/server.ts': ['exports'],
    'packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts': ['exports'],
    'packages/daemon/src/lib/space/agents/agent-template-hash.ts': ['exports'],
    'packages/daemon/src/lib/space/agents/custom-agent.ts': ['exports'],
    'packages/daemon/src/lib/space/agents/seed-agents.ts': ['exports'],
    'packages/daemon/src/lib/space/artifact-git-ops.ts': ['exports'],
    'packages/daemon/src/lib/space/managers/node-execution-manager.ts': ['exports'],
    'packages/daemon/src/lib/space/messaging-adapter.ts': ['exports'],
    'packages/daemon/src/lib/space/runtime/gate-evaluator.ts': ['exports'],
    'packages/daemon/src/lib/space/runtime/post-approval-router.ts': ['exports'],
    'packages/daemon/src/lib/space/runtime/retry-utils.ts': ['exports'],
    'packages/daemon/src/lib/space/workflows/template-hash.ts': ['exports'],
    'packages/daemon/src/storage/repositories/goal-repository.ts': ['exports'],
  },

  // Workspace dependencies (don't flag as unlisted)
  ignoreWorkspaces: [],

  // Ignore specific binaries (build tools)
  ignoreBinaries: [
    'tailwindcss', // PostCSS plugin
    'playwright', // E2E testing
  ],

  // Ignore specific dependencies (external tools, runtime only)
  ignoreDependencies: [
    '@hyperneo/*', // Workspace dependencies
    '@anthropic-ai/sdk', // SDK peer/type anchor used through generated shared SDK declarations
    '@modelcontextprotocol/sdk', // MCP peer/type anchor used through generated shared SDK declarations
    '@testing-library/preact', // Used in tests
    'dotenv', // Used in development scripts
    'happy-dom', // Used in unit tests
  ],

  // Ignore unused exports from these files
  ignoreExportsUsedInFile: {
    interface: true,
    type: true,
  },

  /**
   * Remaining 84 unused exports are intentionally kept:
   *
   * 1. Preact signals (packages/web/src/lib/state.ts):
   *    - Knip can't detect .value access in JSX templates
   *    - systemState, healthStatus, currentSession, etc.
   *
   * 2. Low-level utilities (packages/shared/src/*):
   *    - logger.ts - May be used via dynamic imports
   *    - message-hub/* - Internal protocol utilities
   *
   * 3. Stable internal APIs:
   *    - Tool registry utilities
   *    - Error classes
   *    - Timeout utilities
   *
   * These provide stable APIs for future features and can't be
   * automatically detected due to Preact signals pattern.
   */

  // Include entry source files in project
  includeEntryExports: true,

  /**
   * Exports marked with @public JSDoc tag won't be reported as unused.
   * This is used for Preact signals accessed via .value in JSX.
   */
};

export default config;
