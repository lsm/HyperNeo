/**
 * A Map subclass that automatically creates values for missing keys using a factory function.
 *
 * This is useful when you want a map that always returns a value, even for keys that
 * haven't been explicitly set. The factory function is called to create the default value.
 *
 * @example
 * ```ts
 * // Create a map that returns an empty array for missing keys
 * const listMap = new DefaultMap<string, string[]>(() => []);
 *
 * listMap.get('a').push('item'); // No need to check if 'a' exists
 * listMap.get('a'); // ['item']
 * ```
 *
 * @example
 * ```ts
 * // Create a map of machines per scope
 * const machines = new DefaultMap<string | null, MyMachine>(() => MyMachine.create());
 * machines.get('scope-1'); // Creates and returns a new machine
 * ```
 */
export class DefaultMap<T = string, V = unknown> extends Map<T, V> {
  /**
   * Creates a new DefaultMap.
   *
   * @param factory - A function that creates the default value for a missing key.
   *                   The key is passed as an argument in case the default depends on it.
   */
  constructor(private factory: (key: T) => V) {
    super();
  }

  /**
   * Gets the value for a key, creating it with the factory if it doesn't exist.
   *
   * @param key - The key to look up
   * @returns The existing value or a newly created one
   */
  get(key: T): V {
    let value = super.get(key);

    if (value === undefined) {
      value = this.factory(key);
      this.set(key, value);
    }

    return value;
  }
}
