import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    'packages/cli': {
      entry: ['src/dev-server.ts', 'src/prod-server.ts', 'prod-entry.ts', 'tests/**/*.ts'],
    },
    'packages/daemon': {
      entry: ['src/app.ts', 'src/lib/rpc-handlers/*.ts', 'tests/**/*.ts'],
    },
    'packages/neo': {
      entry: ['src/index.ts'],
    },
    'packages/shared': {
      entry: ['src/mod.ts', 'tests/**/*.ts'],
    },
    'packages/web': {
      entry: ['src/client.tsx', 'src/index.html'],
    },
    'packages/desktop': {
      entry: [],
    },
  },

  ignore: [
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/__tests__/**',
    '**/dist/**',
    '**/node_modules/**',
    '**/*.d.ts',
    'packages/e2e/**',
    'e2e/**',
    'docs/**',
    'examples/**',
    'scripts/**',
    'npm/**',
    '**/*.config.ts',
    '**/*.config.js',
    'packages/web/vite.config.ts',
    'packages/web/tailwind.config.ts',
    'packages/web/postcss.config.js',
    'packages/web/src/index.ts',
    'packages/web/src/lib/router.ts',
    'packages/neo/src/**/*.ts',
    'packages/daemon/scripts/**',
    'packages/daemon/tests/manual/**',
    'packages/daemon/tests/mocks/**',
    'packages/daemon/tests/helpers/**',
    'packages/shared/src/sdk/**',
    '.claude/**',
  ],

  ignoreFiles: [
    'packages/daemon/src/lib/agent/reference-resolver.ts',
    'packages/daemon/src/lib/id-resolution.ts',
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

  ignoreWorkspaces: [],

  ignoreBinaries: ['tailwindcss', 'playwright'],

  ignoreDependencies: [
    '@hyperneo/*',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    '@testing-library/preact',
    'dotenv',
    'happy-dom',
  ],

  ignoreExportsUsedInFile: {
    interface: true,
    type: true,
  },

  includeEntryExports: true,

  /**
   * Exports marked with @public JSDoc tag won't be reported as unused.
   * This is used for Preact signals accessed via .value in JSX.
   */
};

export default config;
