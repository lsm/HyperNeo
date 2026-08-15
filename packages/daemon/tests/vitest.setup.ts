/**
 * Vitest global setup for daemon unit tests.
 *
 * Replicates the non-mocking half of the historical bun:test preload
 * (`tests/unit/setup.ts`): clears provider/API env vars, silences the logger
 * and console, and resets the provider registry so tests start from a clean,
 * deterministic state. The SDK module mock is handled separately via a
 * `resolve.alias` in `vitest.config.ts` (see `tests/sdk-mock.ts`).
 */

import * as nodeDns from 'node:dns';
import * as nodeNet from 'node:net';
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
// environment-independent. Redirects are disabled outright (redirect:'error')
// rather than followed — a test server 3xx can never smuggle a fetch to a
// real API, and no unit-tested server emits redirects.

// The setup file is evaluated once per test file while a worker (and its
// prototype patch) persists across files — the registry must live on
// globalThis so every evaluation shares one set.
type UnitFetchGuardStash = { boundPorts: Map<number, Set<string>> };
const stash = globalThis as unknown as Record<string, unknown>;
const guardStash = (stash.__unitFetchGuard ??= {
  boundPorts: new Map<number, Set<string>>(),
}) as UnitFetchGuardStash;

type ListeningServer = {
  address(): { address: string; port: number } | string | null;
  on(event: string, listener: () => void): unknown;
};

// `new URL('http://[::1]:x/')` reports hostname '[::1]' (bracketed) while
// `server.address()` reports '::1' — normalize before comparing.
const normalizeHost = (host: string): string => host.replace(/^\[/, '').replace(/\]$/, '');
const ANY_ADDRESSES = new Set(['::', '0.0.0.0']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);
const loopbackOrAnyAddress = (host: string): boolean => {
  const normalized = normalizeHost(host);
  return ANY_ADDRESSES.has(normalized) || LOOPBACK_ADDRESSES.has(normalized);
};

type PatchableListen = ((this: ListeningServer, ...args: unknown[]) => unknown) & {
  __unitFetchGuard?: boolean;
};
const netServerProto = nodeNet.Server.prototype as unknown as { listen: PatchableListen };
if (!netServerProto.listen.__unitFetchGuard) {
  const originalListen = netServerProto.listen;
  const patchedListen = function patchedListen(this: ListeningServer, ...args: unknown[]): unknown {
    this.on('listening', () => {
      const address = this.address();
      if (address && typeof address === 'object' && loopbackOrAnyAddress(address.address)) {
        const hosts = guardStash.boundPorts.get(address.port) ?? new Set<string>();
        hosts.add(normalizeHost(address.address));
        guardStash.boundPorts.set(address.port, hosts);
        this.on('close', () => {
          const remaining = guardStash.boundPorts.get(address.port);
          if (remaining) {
            remaining.delete(normalizeHost(address.address));
            if (remaining.size === 0) {
              guardStash.boundPorts.delete(address.port);
            }
          }
        });
      }
    });
    return originalListen.apply(this, args);
  } as PatchableListen;
  patchedListen.__unitFetchGuard = true;
  netServerProto.listen = patchedListen;
}

const guardError = (href: string): Error =>
  new Error(
    `unit test attempted real network fetch: ${href} — unit tests may only reach loopback servers they spawned; stub the provider or move the test to tests/online/ (see tests/vitest.setup.ts)`
  );

// 'localhost' resolves to either loopback family depending on the host and
// resolver order — resolve it and check the address native fetch would dial,
// so an unrelated service on the other family at the same port stays blocked.
const resolvesToBoundLoopback = async (host: string, bound: Set<string>): Promise<boolean> => {
  const ipAllowed = (ip: string): boolean =>
    bound.has(ip) || bound.has('::') || (bound.has('0.0.0.0') && ip === '127.0.0.1');
  if (host !== 'localhost') {
    return ipAllowed(host);
  }
  try {
    const lookup = await nodeDns.promises.lookup('localhost', { all: true });
    // undici dials the resolver's first answer; require that one to be bound.
    return lookup.length > 0 && ipAllowed(lookup[0].address);
  } catch {
    return false;
  }
};

const isAllowedUrl = async (url: URL): Promise<boolean> => {
  // The URL host must be loopback no matter what the server bound — a
  // wildcard-bound server never licenses non-loopback destinations.
  const host = normalizeHost(url.hostname);
  if (!LOOPBACK_ADDRESSES.has(host) || url.port === '') {
    return false;
  }
  const bound = guardStash.boundPorts.get(Number(url.port));
  if (!bound) {
    return false;
  }
  return resolvesToBoundLoopback(host, bound);
};

type GuardedFetch = typeof fetch & { __unitFetchGuard?: boolean };
const currentFetch = globalThis.fetch as GuardedFetch;
// Install once per worker: on re-evaluation globalThis.fetch is already the
// guard, and re-installing would wrap it around itself.
if (!currentFetch.__unitFetchGuard) {
  const realFetch = currentFetch.bind(globalThis);
  const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw guardError(href);
    }
    if (!(await isAllowedUrl(url))) {
      throw guardError(href);
    }

    // Caller-controlled redirect modes keep their native semantics; init does
    // not override a Request object's own mode when it omits `redirect`.
    const requestedRedirect =
      init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
    if (requestedRedirect === 'manual' || requestedRedirect === 'error') {
      return realFetch(input as RequestInfo, init);
    }

    try {
      return await realFetch(input as RequestInfo, { ...init, redirect: 'error' });
    } catch (error) {
      // Node reports redirect violations as a top-level TypeError whose
      // message is just "fetch failed"; the detail lives in error.cause.
      const cause = (error as { cause?: unknown }).cause;
      const detail =
        error instanceof Error
          ? `${error.message} ${cause instanceof Error ? cause.message : ''}`
          : '';
      if (error instanceof TypeError && /redirect/i.test(detail)) {
        throw new Error(
          `unit-test fetch to ${href} followed a redirect — test servers must not redirect in unit tests (see tests/vitest.setup.ts)`
        );
      }
      throw error;
    }
  }) as GuardedFetch;
  guardedFetch.__unitFetchGuard = true;
  globalThis.fetch = guardedFetch;
  (globalThis as unknown as Record<string, unknown>).__originalFetch = realFetch;
}

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
