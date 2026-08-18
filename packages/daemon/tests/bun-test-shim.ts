import {
  afterAll as afterAllRaw,
  afterEach as afterEachRaw,
  beforeAll as beforeAllRaw,
  beforeEach as beforeEachRaw,
  describe,
  expect,
  it as vitestIt,
  test as vitestTest,
  vi,
} from 'vitest';

export { describe, expect, vi };

function wrapTestFn<T extends object>(fn: T): T {
  return new Proxy(fn, {
    apply(target, thisArg, args: unknown[]) {
      if (args.length === 3 && typeof args[1] === 'function' && typeof args[2] === 'object') {
        return Reflect.apply(target, thisArg, [args[0], args[2], args[1]]);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

export const it = wrapTestFn(vitestIt);
export const test = wrapTestFn(vitestTest);

function wrapHookFn<T extends object>(fn: T): T {
  return new Proxy(fn, {
    apply(target, thisArg, args: unknown[]) {
      if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null) {
        const opts = args[1] as { timeout?: unknown };
        if (typeof opts.timeout === 'number') {
          const rest = args.slice(2);
          return Reflect.apply(target, thisArg, [args[0], opts.timeout, ...rest]);
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

export const beforeEach = wrapHookFn(beforeEachRaw);
export const afterEach = wrapHookFn(afterEachRaw);
export const beforeAll = wrapHookFn(beforeAllRaw);
export const afterAll = wrapHookFn(afterAllRaw);

export const jest = vi;

type MockFn = typeof vi.fn & {
  module: typeof vi.mock;
  restore: typeof vi.restoreAllMocks;
};
export const mock: MockFn = Object.assign(vi.fn.bind(vi), {
  module: vi.mock.bind(vi),
  restore: vi.restoreAllMocks.bind(vi),
}) as MockFn;

export const spyOn = vi.spyOn.bind(vi);

export function setDefaultTimeout(ms: number): void {
  vi.setConfig({ testTimeout: ms });
}

export type { Mock } from 'vitest';

function passFail(pass: boolean, message: () => string) {
  return { pass, message };
}

expect.extend({
  toBeString(received: unknown) {
    return passFail(
      typeof received === 'string',
      () => `expected ${String(received)} to be a string`
    );
  },
  toBeNumber(received: unknown) {
    return passFail(
      typeof received === 'number',
      () => `expected ${String(received)} to be a number`
    );
  },
  toBeBoolean(received: unknown) {
    return passFail(
      typeof received === 'boolean',
      () => `expected ${String(received)} to be a boolean`
    );
  },
  toBeArray(received: unknown) {
    return passFail(Array.isArray(received), () => `expected ${String(received)} to be an array`);
  },
  toBeOneOf(received: unknown, expected: unknown[]) {
    const list = Array.isArray(expected) ? expected : [expected];
    return passFail(
      list.includes(received),
      () => `expected ${String(received)} to be one of ${JSON.stringify(list)}`
    );
  },
  toStartWith(received: unknown, prefix: string) {
    return passFail(
      typeof received === 'string' && received.startsWith(prefix),
      () => `expected ${String(received)} to start with ${prefix}`
    );
  },
  toEndWith(received: unknown, suffix: string) {
    return passFail(
      typeof received === 'string' && received.endsWith(suffix),
      () => `expected ${String(received)} to end with ${suffix}`
    );
  },
  toBeTypeOf(received: unknown, type: string) {
    return passFail(
      typeof received === type,
      () => `expected ${String(received)} to be of type ${type}`
    );
  },
});
