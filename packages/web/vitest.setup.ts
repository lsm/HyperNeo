/**
 * Vitest Setup File
 *
 * This file runs before all tests to set up the test environment.
 * Note: happy-dom environment is automatically initialized by vitest.config.ts
 */

// Suppress TLS certificate errors from happy-dom making real HTTPS requests
// (e.g., https://example.com/oauth in ProvidersSettings tests). Happy-dom
// attempts actual network requests for URLs rendered in test fixtures. On
// systems with custom CA certificates (VPN/proxy), these fail with "unable
// to get local issuer certificate". The errors are harmless (tests don't
// depend on the HTTPS response) but produce noisy stderr output.
{
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
  // Narrow pattern: only suppress the specific OpenSSL/Node TLS error that
  // happy-dom triggers when it fetches https://example.com URLs.
  const TLS_NOISE = /unable to get local issuer certificate/;
  process.stderr.write = function (chunk: unknown, ...args: unknown[]) {
    if (typeof chunk === 'string' && TLS_NOISE.test(chunk)) {
      const cb =
        typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as Function) : null;
      cb?.();
      return true;
    }
    if (Buffer.isBuffer(chunk) && TLS_NOISE.test(chunk.toString())) {
      const cb =
        typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as Function) : null;
      cb?.();
      return true;
    }
    return (_origStderrWrite as Function)(chunk, ...args);
  } as typeof process.stderr.write;
}

import { beforeEach, afterEach, vi } from 'vitest';

// happy-dom lacks ResizeObserver (VoiceWaveform uses it to size its columns).
// Components derive their initial measurement synchronously, so a no-op stub
// suffices; tests that exercise resize behavior stub clientWidth directly.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Mock window.location with specific values (happy-dom doesn't set all properties)
Object.defineProperty(global.window, 'location', {
  value: {
    href: 'http://localhost:9283',
    origin: 'http://localhost:9283',
    protocol: 'http:',
    host: 'localhost:9283',
    hostname: 'localhost',
    port: '9283',
    pathname: '/',
    search: '',
    hash: '',
  },
  writable: true,
});

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(() => {}),
  removeItem: vi.fn(() => {}),
  clear: vi.fn(() => {}),
  length: 0,
  key: vi.fn(() => null),
};
global.localStorage = localStorageMock as unknown as Storage;

// Unit tests must never open real network connections. A stray WebSocket
// construct (e.g. an unmocked component path reaching the shared
// websocket-client-transport) surfaces as dozens of timing-dependent
// "closed before open (code=1006)" unhandled rejections attributed to
// whatever test happens to be running — a flaky CI failure the
// flaky-tests registry cannot absorb (no JUnit testcase fails). Replace
// the constructor with one that fails loudly at the call site instead.
// The original is stashed for tests that explicitly opt into a real socket.
type WebSocketCtor = typeof WebSocket;
const RealWebSocket = globalThis.WebSocket as WebSocketCtor | undefined;
(globalThis as unknown as Record<string, unknown>).__originalWebSocket = RealWebSocket;
if (RealWebSocket) {
  class GuardedWebSocket {
    constructor(url: string | URL) {
      throw new Error(
        `unit test attempted real WebSocket connection: ${String(url)} — mock the connection layer (see packages/web/vitest.setup.ts)`
      );
    }
  }
  globalThis.WebSocket = GuardedWebSocket as unknown as WebSocketCtor;
}

beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  localStorageMock.clear.mockClear();
});

afterEach(() => {
  // Cleanup after each test
  vi.restoreAllMocks();
});
