/**
 * Merge-state polling helpers.
 *
 * Pure logic for the "consumer" half of merge-state transition polling:
 * classifying GraphQL `mergeStateStatus`, and building/decoding the batched
 * GraphQL read that fetches it for a set of PRs in one request. The poll loop
 * (`github-event-extension.ts`) wires these into a transition-detection phase
 * backed by the generic `detectStateTransitions` helper.
 *
 * Relationship to the gate-time `pr-ready-validator`: that validator makes the
 * AUTHORITATIVE mergeability decision at handoff (a synchronous pull). This
 * polling path is a COMPLEMENTARY push model — it emits transition events as a
 * PR's merge state changes between cycles so consumers can react early, before
 * a handoff is even attempted. It does not replace the validator.
 */

/** Binary collapse of `mergeStateStatus` into the two emitted signal buckets. */
export type MergeStateClassification = 'mergeable' | 'merge_blocked';

/**
 * States GitHub reports as cleanly mergeable. Everything else determinate is a
 * blocker; see {@link classifyMergeStateStatus}.
 */
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);

/**
 * Collapse a GraphQL `mergeStateStatus` into a binary classification.
 *
 * - `'mergeable'`     — GitHub merges the PR as-is: `CLEAN`, `HAS_HOOKS`.
 * - `'merge_blocked'` — a state-only blocker prevents merging: `BEHIND` (needs
 *   rebase), `BLOCKED` (required checks/reviews unmet), `UNSTABLE` (failing but
 *   admin-mergeable), `DRAFT`, and `DIRTY` (merge conflict). The task names the
 *   four state-only blockers BEHIND/BLOCKED/UNSTABLE/DRAFT; `DIRTY` is included
 *   because a conflicting PR is plainly not mergeable and a CLEAN→DIRTY flip
 *   should emit `merge_blocked`.
 * - `null` — `UNKNOWN` (or missing): GitHub has not finished computing
 *   mergeability. Returns `null` so the caller treats it as indeterminate and
 *   skips the cycle rather than emitting a spurious flip.
 */
export function classifyMergeStateStatus(
  status: string | undefined
): MergeStateClassification | null {
  if (!status || status === 'UNKNOWN') return null;
  return MERGEABLE_STATES.has(status) ? 'mergeable' : 'merge_blocked';
}

/** A decoded per-PR merge-state reading from a GraphQL response. */
export interface MergeStateObservation {
  prNumber: number;
  mergeStateStatus: string;
  /** PR state (`OPEN`, `CLOSED`, `MERGED`); closed/merged PRs are not merge targets. */
  state: string;
}

/**
 * Build a batched GraphQL query that fetches `mergeStateStatus` + `state` for a
 * set of PR numbers in a SINGLE request (one read covers every tracked PR),
 * using aliased `pullRequest` selections.
 *
 * Returns the query text, the query variables, and `aliasToNumber` — a map from
 * response alias back to PR number — so {@link parseMergeStateResponse} can
 * decode the response. Aliases are `pr_{number}` (valid GraphQL alias names).
 *
 * PR numbers cannot be parameterized into field selections via GraphQL
 * variables, so they are baked into the query text. This is safe because the
 * values are integers originating from the cursor's tracked-PR list (already
 * validated as PR numbers by the `/pulls` scan), never user input.
 *
 * An empty `prNumbers` list yields an empty selection; callers should skip the
 * request entirely when there is nothing to query.
 */
export function buildMergeStateQuery(
  owner: string,
  repo: string,
  prNumbers: readonly number[]
): {
  query: string;
  variables: { owner: string; name: string };
  aliasToNumber: Record<string, number>;
} {
  const aliasToNumber: Record<string, number> = {};
  const selections = prNumbers
    .map((prNumber) => {
      const alias = `pr_${prNumber}`;
      aliasToNumber[alias] = prNumber;
      return `${alias}: pullRequest(number: ${prNumber}) { mergeStateStatus state number }`;
    })
    .join('\n      ');

  const query = `query MergeState($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${selections}
  }
}`;
  return { query, variables: { owner, name: repo }, aliasToNumber };
}

/**
 * Decode a GraphQL response body into per-PR merge-state observations.
 *
 * Aliases not present in `aliasToNumber` are ignored. A `null` PR value (the PR
 * was deleted, or the token lacks access) is dropped — the caller prunes it from
 * the tracked set via the cursor rebuild. Returns an empty array when the
 * `repository` data is missing (access denied, renamed repo, or a GraphQL
 * error payload — the poll loop inspects `errors` separately).
 */
export function parseMergeStateResponse(
  body: unknown,
  aliasToNumber: Record<string, number>
): MergeStateObservation[] {
  const repository = (body as { data?: { repository?: Record<string, unknown> | null } } | null)
    ?.data?.repository;
  if (!repository || typeof repository !== 'object') return [];

  const observations: MergeStateObservation[] = [];
  for (const [alias, value] of Object.entries(repository)) {
    const prNumber = aliasToNumber[alias];
    if (!prNumber || !value || typeof value !== 'object') continue;
    const pr = value as { mergeStateStatus?: unknown; state?: unknown };
    const mergeStateStatus = typeof pr.mergeStateStatus === 'string' ? pr.mergeStateStatus : '';
    const state = typeof pr.state === 'string' ? pr.state : '';
    observations.push({ prNumber, mergeStateStatus, state });
  }
  return observations;
}
