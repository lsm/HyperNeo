import * as nodeDns from 'node:dns';
import * as nodeNet from 'node:net';
import { configureLogger, LogLevel } from '@hyperneo/shared';
import { resetProviderRegistry } from '../src/lib/providers/registry';

process.env.NODE_ENV = 'test';

resetProviderRegistry();

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

type UnitFetchGuardStash = { boundPorts: Map<number, Set<string>> };
const stash = globalThis as unknown as Record<string, unknown>;
const guardStash = (stash.__unitFetchGuard ??= {
  boundPorts: new Map<number, Set<string>>(),
}) as UnitFetchGuardStash;

type ListeningServer = {
  address(): { address: string; port: number } | string | null;
  on(event: string, listener: () => void): unknown;
};

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

const resolvesToBoundLoopback = async (host: string, bound: Set<string>): Promise<boolean> => {
  const ipAllowed = (ip: string): boolean =>
    bound.has(ip) || bound.has('::') || (bound.has('0.0.0.0') && ip === '127.0.0.1');
  if (host !== 'localhost') {
    return ipAllowed(host);
  }
  try {
    const lookup = await nodeDns.promises.lookup('localhost', { all: true });
    return lookup.length > 0 && ipAllowed(lookup[0].address);
  } catch {
    return false;
  }
};

const isAllowedUrl = async (url: URL): Promise<boolean> => {
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

    const requestedRedirect =
      init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
    if (requestedRedirect === 'manual' || requestedRedirect === 'error') {
      return realFetch(input as RequestInfo, init);
    }

    try {
      return await realFetch(input as RequestInfo, { ...init, redirect: 'error' });
    } catch (error) {
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

process.env.ANTHROPIC_API_KEY = '';
process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
process.env.GLM_API_KEY = '';
process.env.ZHIPU_API_KEY = '';
process.env.MINIMAX_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.KIMI_API_KEY = '';
process.env.MOONSHOT_API_KEY = '';
process.env.HYPERNEO_ACP_COMMAND = '';

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
delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
