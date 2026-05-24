export enum ActivationTrigger {
  Pointer = 0,
  Other = 1,
}

export enum Focus {
  First = 0,
  Previous = 1,
  Next = 2,
  Last = 3,
  Specific = 4,
  Nothing = 5,
}

type Item = { id: string; dataRef: { current: { disabled: boolean } } };

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

export function calculateActiveIndex<T extends Item>(
  action: { focus: Focus.Specific; id: string } | { focus: Exclude<Focus, Focus.Specific> },
  resolvers: {
    resolveItems: () => T[];
    resolveActiveIndex: () => number | null;
    resolveId: (item: T) => string;
    resolveDisabled: (item: T) => boolean;
  }
): number | null {
  const items = resolvers.resolveItems();
  if (items.length <= 0) return null;

  const currentActiveIndex = resolvers.resolveActiveIndex();
  const activeIndex = currentActiveIndex ?? -1;

  const nextActiveIndex = (() => {
    switch (action.focus) {
      case Focus.First:
        return items.findIndex((item) => !resolvers.resolveDisabled(item));

      case Focus.Previous: {
        const idx = items
          .slice()
          .reverse()
          .findIndex((item, i, all) => {
            if (activeIndex !== -1 && all.length - i - 1 >= activeIndex) return false;
            return !resolvers.resolveDisabled(item);
          });
        if (idx === -1) return idx;
        return items.length - 1 - idx;
      }

      case Focus.Next:
        return items.findIndex((item, i) => {
          if (i <= activeIndex) return false;
          return !resolvers.resolveDisabled(item);
        });

      case Focus.Last: {
        const idx = items
          .slice()
          .reverse()
          .findIndex((item) => !resolvers.resolveDisabled(item));
        if (idx === -1) return idx;
        return items.length - 1 - idx;
      }

      case Focus.Specific:
        return items.findIndex((item) => resolvers.resolveId(item) === action.id);

      case Focus.Nothing:
        return null;

      default:
        assertNever(action as never);
    }
  })();

  return nextActiveIndex === -1 ? currentActiveIndex : nextActiveIndex;
}
