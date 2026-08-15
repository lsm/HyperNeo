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

// Enforce the documented invariant that unit tests never call real APIs
// (CLAUDE.md: "clears provider keys, and never calls real APIs"). Key-clearing
// alone is not enough: provider availability probes funnel through the global
// fetch with per-probe timeouts (see src/lib/providers/shared/credential-probe.ts),
// so any provider whose availability check passes without an env key still burns
// real network round-trips inside the per-test budget — the root of the
// model-service flakes registered in flaky-tests.json.
//
// The guard admits loopback ONLY on ports that test-spawned servers actually
// bound in this process (e.g. the copilot embedded server tests): patching
// net.Server.prototype.listen records them, so ambient developer-machine
// services (Ollama on localhost:11434, …) stay blocked and results remain
// environment-independent. Redirects are followed manually so every hop is
// re-validated — a test server 3xx cannot smuggle a fetch to a real API.
const realFetch = globalThis.fetch.bind(globalThis);
const testServerPorts = new Set<number>();

type ListeningServer = {
  address(): { address: string; port: number } | string | null;
  on(event: string, listener: () => void): unknown;
};
const loopbackOrAnyAddress = (address: string): boolean =>
  ['127.0.0.1', '::1', 'localhost', '::', '0.0.0.0'].includes(address);

const netServerProto = (
  require('node:net') as typeof import('node:net')
).Server.prototype as { listen: (...args: unknown[]) => unknown };
const originalListen = netServerProto.listen;
netServerProto.listen = function patchedListen(this: ListeningServer, ...args: unknown[]) {
  this.on('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object' && loopbackOrAnyAddress(address.address)) {
      testServerPorts.add(address.port);
      this.on('close', () => testServerPorts.delete(address.port));
    }
  });
  return originalListen.apply(this, args);
};

const guardError = (href: string): Error =>
  new Error(
    `unit test attempted real network fetch: ${href} — unit tests may only reach loopback servers they spawned; stub the provider or move the test to tests/online/ (see tests/vitest.setup.ts)`
  );

const isAllowedUrl = (url: URL): boolean =>
  loopbackOrAnyAddress(url.hostname) &&
  url.port !== '' &&
  testServerPorts.has(Number(url.port));

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw guardError(href);
  }
  if (!isAllowedUrl(url)) {
    throw guardError(href);
  }

  // Follow redirects manually so each hop is re-validated against the guard.
  let method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let headers = init?.headers;
  let body: BodyInit | undefined = init?.body;
  for (let hop = 0; ; hop += 1) {
    if (hop >= 20) throw new Error(`unit-test fetch exceeded 20 redirects: ${href}`);
    const response = await realFetch(url, {
      ...init,
      method,
      headers,
      body,
      redirect: 'manual',
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) {
      return response;
    }
    const next = new URL(location, url);
    if (!isAllowedUrl(next)) {
      throw guardError(next.href);
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = undefined;
    }
    url = next;
  }
}) as typeof fetch;

(globalThis as unknown as Record<string, unknown>).__originalFetch = realFetch;

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
