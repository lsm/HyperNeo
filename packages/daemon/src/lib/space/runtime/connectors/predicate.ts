/**
 * L3 predicate language + evaluator (THROWAWAY spike, #2300).
 *
 * A small, DOMAIN-AGNOSTIC expression language the `external_state` validator
 * uses to decide allow/pending/block from a connector op's result. There are
 * no PR/codex/github terms here — those live in the connector (L2) and the
 * preset configs (which compose predicates). That is the whole point of the
 * spike: the rule mechanism is generic.
 *
 * Predicates evaluate against a "scope" — initially the op result, or an array
 * element when inside `exists`. Paths are dot-notation into the scope.
 */

/** Dot-notation path into a scope, e.g. `"state"`, `"reactions"`, `"user.login"`. */
export type Path = string;

export type LeafPredicate =
  | { eq: [Path, unknown] }
  | { neq: [Path, unknown] }
  | { in: [Path, unknown[]] }
  | { nin: [Path, unknown[]] }
  /** Case-insensitive substring test on the stringified field value. */
  | { contains: [Path, string] }
  /** Case-sensitive suffix test on the stringified field value. */
  | { endswith: [Path, string] }
  /** `>=`: numeric when both sides are numbers, otherwise lexicographic
   *  (ISO-8601 date strings compare correctly lexicographically). */
  | { gte: [Path, unknown] }
  | { lt: [Path, unknown] }
  | { present: Path }
  | { empty: Path }
  | { notEmpty: Path };

export type Predicate =
  | LeafPredicate
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  /** True iff `scope[select]` is a non-empty array with at least one element
   *  satisfying `where` (evaluated against that element as the scope). */
  | { exists: { select: Path; where: Predicate } };

/** Resolve a dot path against a scope. Returns undefined when missing. */
export function getPath(scope: unknown, path: Path): unknown {
  if (scope === null || scope === undefined) return undefined;
  if (path === '') return scope;
  let current: unknown = scope;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      // Numeric index into an array; otherwise bail.
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      // Read OWN properties only — without this guard, `present: '__proto__'`
      // is a tautology and `present: 'constructor'` etc. leak prototype values.
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/**
 * Evaluate a predicate against a scope. Throws on a malformed predicate so
 * bugs surface in tests rather than silently passing gates.
 */
export function evaluatePredicate(predicate: Predicate, scope: unknown): boolean {
  if (predicate === null || typeof predicate !== 'object') {
    throw new Error(`predicate: expected object, got ${typeof predicate}`);
  }

  if ('all' in predicate) {
    return predicate.all.every((p) => evaluatePredicate(p, scope));
  }
  if ('any' in predicate) {
    return predicate.any.some((p) => evaluatePredicate(p, scope));
  }
  if ('not' in predicate) {
    return !evaluatePredicate(predicate.not, scope);
  }
  if ('exists' in predicate) {
    const collection = getPath(scope, predicate.exists.select);
    if (!Array.isArray(collection)) return false;
    return collection.some((element) => evaluatePredicate(predicate.exists.where, element));
  }

  if ('eq' in predicate) return getPath(scope, predicate.eq[0]) === predicate.eq[1];
  if ('neq' in predicate) return getPath(scope, predicate.neq[0]) !== predicate.neq[1];
  if ('in' in predicate) {
    const value = getPath(scope, predicate.in[0]);
    return predicate.in[1].some((candidate) => candidate === value);
  }
  if ('nin' in predicate) {
    const value = getPath(scope, predicate.nin[0]);
    return !predicate.nin[1].some((candidate) => candidate === value);
  }
  if ('contains' in predicate) {
    const value = getPath(scope, predicate.contains[0]);
    return (
      typeof value === 'string' && value.toLowerCase().includes(predicate.contains[1].toLowerCase())
    );
  }
  if ('endswith' in predicate) {
    const value = getPath(scope, predicate.endswith[0]);
    return typeof value === 'string' && value.endsWith(predicate.endswith[1]);
  }
  if ('gte' in predicate) {
    const value = getPath(scope, predicate.gte[0]);
    if (value === undefined) return false;
    return compare(value, predicate.gte[1]) >= 0;
  }
  if ('lt' in predicate) {
    const value = getPath(scope, predicate.lt[0]);
    if (value === undefined) return false;
    return compare(value, predicate.lt[1]) < 0;
  }
  if ('present' in predicate) return getPath(scope, predicate.present) !== undefined;
  if ('empty' in predicate) {
    const value = getPath(scope, predicate.empty);
    return !isNonEmptyArray(value);
  }
  if ('notEmpty' in predicate) return isNonEmptyArray(getPath(scope, predicate.notEmpty));

  const keys = Object.keys(predicate as Record<string, unknown>);
  throw new Error(`predicate: unknown predicate shape { ${keys.join(', ')} }`);
}
