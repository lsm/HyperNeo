// bun:test compatibility shim for Vitest. The daemon's vitest config aliases
// the `bun:test` specifier to this module, which re-exports Vitest equivalents
// so the existing suites run without editing their import lines.

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

/**
 * bun:test allows `it(name, fn, { timeout })` / `it(name, fn, timeoutMs)`.
 * Vitest 4 removed the options-object-as-third-argument form and wants
 * `it(name, options, fn)` instead. Transparently reorder the arguments so
 * existing bun-style call sites keep working. A numeric third argument is
 * already a valid Vitest signature and is passed through untouched.
 */
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

/**
 * bun:test hooks accept `(fn, { timeout })` (options object as 2nd arg).
 * Vitest 4 dropped the options-object form for hooks and expects a numeric
 * timeout (`beforeEach(fn, timeout)`). Normalize: if the 2nd arg is a
 * `{ timeout }` object, pass the number instead — otherwise Vitest prints
 * "Hook timed out in [object Object]ms" and ignores the timeout.
 */
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

/** bun's `jest` namespace maps to Vitest's `vi`. */
export const jest = vi;

/** bun's `mock(fn?)` maps to Vitest `vi.fn(fn?)`. Also carries `.module` and `.restore`. */
type MockFn = typeof vi.fn & {
  module: typeof vi.mock;
  /** bun's `mock.restore()` restores all spies — Vitest: `vi.restoreAllMocks()`. */
  restore: typeof vi.restoreAllMocks;
};
export const mock: MockFn = Object.assign(vi.fn.bind(vi), {
  module: vi.mock.bind(vi),
  restore: vi.restoreAllMocks.bind(vi),
}) as MockFn;

/** bun's `spyOn` maps to Vitest `vi.spyOn`. */
export const spyOn = vi.spyOn.bind(vi);

/**
 * bun's `setDefaultTimeout(ms)` sets the per-test timeout for the file.
 * Vitest configures this globally, so we forward to `vi.setConfig`.
 */
export function setDefaultTimeout(ms: number): void {
  vi.setConfig({ testTimeout: ms });
}

/** bun re-exports `Mock` as a type; Vitest's closest is `Mock` from 'vitest'. */
export type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// bun-specific matchers that Vitest/Chai does not provide.
// Only the matchers actually used by the suites are implemented.
// ---------------------------------------------------------------------------

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
