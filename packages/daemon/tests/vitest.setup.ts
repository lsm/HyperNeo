/**
 * Vitest global setup for daemon unit tests.
 *
 * Replicates the non-mocking half of the historical bun:test preload
 * (`tests/unit/setup.ts`): clears provider/API env vars, silences the logger
 * and console, and resets the provider registry so tests start from a clean,
 * deterministic state. The SDK module mock is handled separately via a
 * `resolve.alias` in `vitest.config.ts` (see `tests/sdk-mock.ts`).
 */

import { configureLogger, LogLevel } from '@hyperneo/shared';
import { resetProviderRegistry } from '../src/lib/providers/registry';

process.env.NODE_ENV = 'test';

// Reset provider registry to ensure clean state for each test run.
resetProviderRegistry();

// Silence the logger and console during tests (intentional test errors
// shouldn't clutter output). Originals are stashed for tests that restore.
configureLogger({ level: LogLevel.SILENT });

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

console.error = () => {};
console.warn = () => {};
console.log = () => {};

(globalThis as unknown as Record<string, unknown>).__originalConsole = {
  error: originalConsoleError,
  warn: originalConsoleWarn,
  log: originalConsoleLog,
};

// Clear all API keys so unit tests don't make real API calls.
process.env.ANTHROPIC_API_KEY = '';
process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
process.env.GLM_API_KEY = '';
process.env.ZHIPU_API_KEY = '';
process.env.MINIMAX_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.KIMI_API_KEY = '';
process.env.MOONSHOT_API_KEY = '';
process.env.HYPERNEO_ACP_COMMAND = '';

// Delete Claude Code session behaviour vars (see historical setup.ts for the
// full rationale — module-level snapshots must observe a clean shell).
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
