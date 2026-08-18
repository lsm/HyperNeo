{
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
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

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

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

const localStorageMock = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(() => {}),
  removeItem: vi.fn(() => {}),
  clear: vi.fn(() => {}),
  length: 0,
  key: vi.fn(() => null),
};
global.localStorage = localStorageMock as unknown as Storage;

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
  vi.clearAllMocks();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  localStorageMock.clear.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});
