/**
 * Pattern matching utility for reducers and event handlers.
 *
 * This function provides a concise way to handle different action/event types,
 * similar to a switch statement but with better ergonomics and error messages.
 *
 * If the lookup value is a function, it will be called with the provided arguments.
 * If it's a value, it will be returned directly.
 *
 * @param value - The value to match against (typically action.type or event.type)
 * @param lookup - A record mapping possible values to handlers or return values
 * @param args - Additional arguments to pass to handler functions
 * @returns The result of the matched handler or value
 * @throws Error if no handler is defined for the value
 *
 * @example
 * ```ts
 * // In a reducer
 * function reduce(state: State, action: Action): State {
 *   return match(action.type, {
 *     [ActionTypes.Increment]: () => ({ count: state.count + 1 }),
 *     [ActionTypes.Decrement]: () => ({ count: state.count - 1 }),
 *     [ActionTypes.Set]: (state, action) => ({ count: action.value }),
 *   }, state, action);
 * }
 * ```
 *
 * @example
 * ```ts
 * // Simple value lookup
 * const label = match(status, {
 *   'loading': 'Loading...',
 *   'success': 'Complete!',
 *   'error': 'Failed',
 * });
 * ```
 */
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
