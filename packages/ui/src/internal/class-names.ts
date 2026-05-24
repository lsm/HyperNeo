/**
 * Combines multiple class names into a single string, deduplicating and filtering falsy values.
 *
 * This function:
 * - Flattens all class strings
 * - Removes duplicates
 * - Filters out empty strings
 * - Joins with spaces
 *
 * @param classes - Class names to combine (strings, or falsy values to skip)
 * @returns A single class string with unique, non-empty class names
 *
 * @example
 * ```tsx
 * classNames('foo', 'bar') // 'foo bar'
 * classNames('foo', false, 'bar', null, undefined) // 'foo bar'
 * classNames('foo bar', 'bar baz') // 'foo bar baz' (deduped)
 * ```
 */
export function classNames(...classes: (false | null | undefined | string)[]): string {
  return Array.from(
    new Set(
      classes.flatMap((value) => {
        if (typeof value === 'string') {
          return value.split(' ');
        }

        return [];
      })
    )
  )
    .filter(Boolean)
    .join(' ');
}
