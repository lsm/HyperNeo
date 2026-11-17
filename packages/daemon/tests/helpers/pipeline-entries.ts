import type superpipe from 'superpipe';

type Api = Record<string, (...args: unknown[]) => unknown>;

function recordEntry(api: Api, name: string, entered: string[]): Api {
  const proxy: Api = new Proxy(api, {
    get(target, prop: string) {
      const member = target[prop];
      if (typeof member !== 'function') return member;
      if (prop === 'end' || prop === 'endAsync') {
        return (...args: unknown[]) => {
          const run = member.apply(target, args) as (...input: unknown[]) => unknown;
          return (...input: unknown[]) => {
            entered.push(name);
            return run(...input);
          };
        };
      }
      return (...args: unknown[]) => {
        const result = member.apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

export function recordPipelineEntries<T extends { default: typeof superpipe }>(
  real: T,
  entered: string[]
): T {
  return {
    ...real,
    default: (functions?: Record<string, unknown>) => {
      const factory = real.default(functions);
      return (name: string, defs?: never) => {
        const built = factory(name, defs);
        return typeof built === 'object'
          ? recordEntry(built as unknown as Api, name, entered)
          : built;
      };
    },
  };
}
