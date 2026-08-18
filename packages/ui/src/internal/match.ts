export function match<TValue extends string | number = string, TReturnValue = unknown>(
  value: TValue,
  lookup: Record<TValue, TReturnValue | ((...args: unknown[]) => TReturnValue)>,
  ...args: unknown[]
): TReturnValue {
  if (value in lookup) {
    const returnValue = lookup[value];
    if (typeof returnValue === 'function') {
      return (returnValue as (...args: unknown[]) => TReturnValue)(...args);
    }
    return returnValue as TReturnValue;
  }

  const error = new Error(
    `Tried to handle "${value}" but there is no handler defined. Only defined handlers are: ${Object.keys(
      lookup
    )
      .map((key) => `"${key}"`)
      .join(', ')}.`
  );
  if (Error.captureStackTrace) {
    Error.captureStackTrace(error, match);
  }
  throw error;
}
