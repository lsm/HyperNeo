export function resolveCompare<T>(
  by?: string | ((a: T, b: T) => boolean)
): (a: T, b: T) => boolean {
  if (typeof by === 'function') return by;
  if (typeof by === 'string') {
    const key = by;
    return (a: T, b: T) =>
      (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key];
  }
  return (a: T, b: T) => a === b;
}
