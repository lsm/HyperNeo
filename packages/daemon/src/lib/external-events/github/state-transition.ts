/**
 * Generic per-key state transition detection.
 *
 * The GitHub poll loop is cursor-based: it advances timestamp/ETag watermarks
 * and asks "what is newer than my high-water mark?". That model does not fit a
 * state field like a PR's GraphQL `mergeStateStatus`, which has no monotonic
 * timestamp — only a current value drawn from a small set of states that flips
 * back and forth. Detecting a *change* requires remembering the last observed
 * value per key and comparing, which is exactly what this helper does.
 *
 * Pure and source-agnostic: the merge-state consumer supplies the classification
 * (status → 'mergeable' | 'merge_blocked') and the per-PR key; this helper only
 * reports which keys changed state between two observations. Keeping it generic
 * (rather than merge-state-specific) lets future state-only pollers reuse it.
 */

/** A single observed key→state reading. */
export interface StateObservation<T extends string> {
  key: string;
  state: T;
}

/** A detected change in a key's state between two observations. */
export interface StateTransition<T extends string> {
  key: string;
  /** Previous state, or `null` for a first-ever observation (no prior value). */
  from: T | null;
  to: T;
}

/**
 * Returns the entries in `current` whose state differs from `previous`.
 *
 * - A key present in `current` but not `previous` is a first observation
 *   (`from: null`). Callers that want to suppress first-observation "backfill"
 *   filter on `from !== null` (e.g. merge-state polling seeds silently).
 * - A key absent from `current` is ignored: this helper reports only what is
 *   currently observed. Pruning of dropped keys (e.g. a PR that closed) is the
 *   caller's responsibility, since "absent" may mean "removed" or "not polled
 *   this cycle" and only the caller can distinguish.
 * - Result order follows `current`; duplicate keys are deduped (first wins).
 */
export function detectStateTransitions<T extends string>(
  previous: Readonly<Record<string, T>>,
  current: readonly StateObservation<T>[]
): StateTransition<T>[] {
  const transitions: StateTransition<T>[] = [];
  const seen = new Set<string>();
  for (const obs of current) {
    if (seen.has(obs.key)) continue;
    seen.add(obs.key);
    const prev = previous[obs.key];
    if (prev === undefined) {
      transitions.push({ key: obs.key, from: null, to: obs.state });
    } else if (prev !== obs.state) {
      transitions.push({ key: obs.key, from: prev, to: obs.state });
    }
  }
  return transitions;
}
