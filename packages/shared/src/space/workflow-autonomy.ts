/**
 * Workflow autonomy helpers.
 *
 * Determines whether a `SpaceWorkflow` will auto-close at a given Space
 * autonomy level. The UI uses this to tell users — at a glance — how many
 * of a Space's workflows skip human review at the currently-selected level.
 *
 * Rules (as of PR 4/5 — post completion-action deletion):
 *   - A workflow auto-closes at level N iff `level >= (wf.completionAutonomyLevel ?? 5)`.
 *   - `completionAutonomyLevel` is a first-class field on `SpaceWorkflow`; it
 *     defaults to `5` (effectively always paused) when omitted so legacy
 *     workflows remain conservatively gated until an author opts in.
 *
 * This is a pure function with no DB or runtime dependencies — safe to use
 * from both the daemon and the web bundle.
 */

import type { SpaceWorkflow, SpaceWorkflowSummary } from '../types/space.ts';

/**
 * Returns `true` when `wf` would auto-close (skip human review) at the given
 * Space autonomy `level`. Workflows with no declared
 * `completionAutonomyLevel` are treated as requiring the maximum level (5),
 * which keeps them gated unless the workflow author opts in.
 */
export function isWorkflowAutoClosingAtLevel(
  wf: SpaceWorkflow | SpaceWorkflowSummary,
  level: number
): boolean {
  const threshold = wf.completionAutonomyLevel ?? 5;
  return level >= threshold;
}
