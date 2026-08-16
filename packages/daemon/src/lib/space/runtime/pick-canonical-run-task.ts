/**
 * Pure canonical-task selection for workflow runs (one-task-per-run mode).
 *
 * Extracted from `space-runtime.ts` so `tools/end-node-handlers.ts` can share
 * the exact selection rule WITHOUT importing the runtime megamodule (its init
 * graph) — the small pure-helper module idiom of `delivery-mode.ts` /
 * `workflow-run-status-machine.ts`. The runtime re-exports this for backward
 * compatibility.
 */

import type { SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';

/**
 * Choose the canonical task for a workflow run in one-task-per-run mode.
 *
 * Preference:
 * 1. Title exactly matches run title (case-insensitive, trimmed)
 * 2. Lowest task number
 * 3. Earliest created_at
 *
 * External completion paths (`complete_validation_task` on node-agent
 * servers) apply the EXACT same selection rule the tick loop uses when it
 * later archives non-canonical duplicates — a completion recorded on a
 * duplicate would be discarded by that archive while its side effects
 * (evidence capture, dependent unblocking) persisted.
 */
export function pickCanonicalRunTask(
  run: SpaceWorkflowRun,
  runTasks: SpaceTask[]
): SpaceTask | null {
  if (runTasks.length === 0) return null;

  const normalize = (value: string | null | undefined): string =>
    (value ?? '').trim().toLowerCase();
  const runTitle = normalize(run.title);
  const titleMatches = runTasks.filter((task) => normalize(task.title) === runTitle);
  const pool = titleMatches.length > 0 ? titleMatches : runTasks;

  const sorted = [...pool].sort((a, b) => {
    if (a.taskNumber !== b.taskNumber) return a.taskNumber - b.taskNumber;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  return sorted[0] ?? null;
}
