/**
 * Unit Test Setup
 *
 * This file is preloaded before unit tests run.
 * It clears API keys to ensure tests don't accidentally make real API calls,
 * and provides stubs for external SDK dependencies.
 */

import { mock } from 'bun:test';

// Mock the Claude Agent SDK.  The real SDK must be mocked in unit tests for two reasons:
//
// 1. Unit tests must not make real API calls — query/interrupt are stubbed out.
//
// 2. The real createSdkMcpServer returns an McpServer whose _registeredTools is
//    PRIVATE (no public listTools() API, no way to inspect or invoke handlers
//    outside the MCP protocol).  Several test suites (task-agent-tools, leader-agent,
//    room-agent-tools, provision-global-agent) rely on inspecting
//    server.instance._registeredTools to verify tool names, descriptions, schemas,
//    and to invoke handlers directly.  The mock provides a testable surface area
//    that the real McpServer class does not expose.
//
// Individual test files that need different mock behaviour call mock.module() at the
// top of their own file to override this default.
mock.module('@anthropic-ai/claude-agent-sdk', () => {
  // ---------------------------------------------------------------------------
  // MockMcpServer — replicates the MCP server surface area needed by tests.
  // ---------------------------------------------------------------------------
  class MockMcpServer {
    readonly _registeredTools: Record<string, object> = {};

    connect(): void {}
    disconnect(): void {}
  }

  // Per-call tool capture:
  //   tool() is called with (name, description, inputSchema, handler) — we
  //   store defs here keyed by name.  createSdkMcpServer drains the batch
  //   into the server instance and resets so subsequent servers start clean.
  let _toolBatch: Array<{ name: string; def: object }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function tool(name: string, description: string, inputSchema: any, handler: unknown): object {
    const def = { name, description, inputSchema, handler };
    _toolBatch.push({ name, def });
    return def;
  }

  return {
    query: mock(async () => ({
      interrupt: () => {},
    })),
    interrupt: mock(async () => {}),
    supportedModels: mock(async () => {
      throw new Error('SDK unavailable in unit test');
    }),
    createSdkMcpServer: mock((_options: { name: string; version?: string; tools?: unknown[] }) => {
      const server = new MockMcpServer();
      // Drain the batch into this server's _registeredTools
      for (const { name, def } of _toolBatch) {
        server._registeredTools[name] = def;
      }
      // Fallback: if _toolBatch was empty (e.g. module isolation in CI causes
      // tool() and createSdkMcpServer to reference different closures), recover
      // tool defs from the `tools` option passed by the caller.  Each element is
      // the return value of tool() which is { name, description, inputSchema, handler }.
      if (Object.keys(server._registeredTools).length === 0 && Array.isArray(_options.tools)) {
        for (const t of _options.tools) {
          const td = t as {
            name?: string;
            description?: string;
            inputSchema?: unknown;
            handler?: unknown;
          };
          if (td.name) {
            server._registeredTools[td.name] = td;
          }
        }
      }
      _toolBatch = [];

      return {
        type: 'sdk' as const,
        name: _options.name,
        version: _options.version ?? '1.0.0',
        tools: _options.tools ?? [],
        instance: server,
      };
    }),
    tool,
  };
});

import { configureLogger, LogLevel } from '@hyperneo/shared';
import { resetProviderRegistry } from '../../src/lib/providers/registry';

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Reset provider registry to ensure clean state for each test run
// This prevents cross-test pollution from provider registrations
resetProviderRegistry();

// Explicitly configure logger to SILENT to suppress all console output during tests
// This prevents test error logs from cluttering the output
configureLogger({ level: LogLevel.SILENT });

// Suppress console.error, console.warn, and console.log during tests
// to prevent intentional test errors from cluttering output
// Store originals in case tests need to restore them
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

console.error = () => {};
console.warn = () => {};
console.log = () => {};

// Export originals for tests that need to restore console output
(globalThis as unknown as Record<string, unknown>).__originalConsole = {
  error: originalConsoleError,
  warn: originalConsoleWarn,
  log: originalConsoleLog,
};

// Clear all API keys to ensure unit tests don't make real API calls
// Use delete rather than empty strings so that tests expecting undefined work correctly
process.env.ANTHROPIC_API_KEY = '';
process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
process.env.GLM_API_KEY = '';
process.env.ZHIPU_API_KEY = '';
process.env.MINIMAX_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.OPENAI_API_KEY = '';
// Kimi/Moonshot and ACP — cleared so provider credential probes triggered by
// model-service loadModelsFromProviders() don't hit the real upstream and
// stall unit tests that exercise the empty-cache fallback path. Providers
// that expose these keys (KimiProvider, AcpProvider) treat them as
// isAvailable()=false when unset, which short-circuits the probe.
process.env.KIMI_API_KEY = '';
process.env.MOONSHOT_API_KEY = '';
process.env.HYPERNEO_ACP_COMMAND = '';

// Clear Claude Code session behavior vars. provider-service.ts snapshots these
// into module-level "user configured" constants at import time, and
// applyEnvVarsToProcess preserves any value matching that snapshot. When tests
// run from inside a Claude Code session (which exports ENABLE_TOOL_SEARCH and
// friends), the snapshot captures the session's values and the env-clearing
// tests in provider-service.test.ts fail. Delete (not '') so the snapshot is
// undefined, matching a clean shell.
delete process.env.ENABLE_TOOL_SEARCH;
delete process.env.ANTHROPIC_MODEL;
delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.API_TIMEOUT_MS;
// query-runner.ts snapshots HYPERNEO_SDK_STARTUP_TIMEOUT_MS at module load.
// NOTE: no automated runner loads this preload — test-daemon.sh (and its
// test:unit alias) run vitest, whose equivalent delete lives in
// tests/vitest.setup.ts, and bunfig.toml intentionally has no [test] preload
// (it would hit online runs). This delete only covers manual
// `--preload tests/unit/setup.ts` bun runs, where Bun auto-loading
// packages/daemon/.env would otherwise leak an ambient override into the
// pinned 'current: 60000ms' assertion. Tests that need the override set it
// AFTER this preload runs.
delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
