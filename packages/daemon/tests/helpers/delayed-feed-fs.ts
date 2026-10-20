import type * as fs from 'node:fs';
import type * as promises from 'node:fs/promises';

export type FeedFsDelay = { path: string; operation: string; ms: number };

function delayed<T extends (...args: never[]) => unknown>(
  fn: T,
  state: FeedFsDelay,
  operation: string,
  asynchronous: boolean
): T {
  return new Proxy(fn, {
    apply(target, receiver, args: unknown[]) {
      if (String(args[0]) !== state.path || operation !== state.operation)
        return Reflect.apply(target, receiver, args);
      if (asynchronous)
        return new Promise((resolve) => setTimeout(resolve, state.ms)).then(() =>
          Reflect.apply(target, receiver, args)
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.ms);
      return Reflect.apply(target, receiver, args);
    },
  });
}

export function delayedFeedSync(native: typeof fs, state: FeedFsDelay): typeof fs {
  return {
    ...native,
    readdirSync: delayed(native.readdirSync, state, 'list', false),
    existsSync: delayed(native.existsSync, state, 'prune', false),
    statSync: delayed(native.statSync, state, 'known', false),
  };
}

export function delayedFeedAsync(native: typeof promises, state: FeedFsDelay): typeof promises {
  return {
    ...native,
    readdir: delayed(native.readdir, state, 'list', true),
    access: delayed(native.access, state, 'prune', true),
    stat: delayed(native.stat, state, 'known', true),
  };
}
