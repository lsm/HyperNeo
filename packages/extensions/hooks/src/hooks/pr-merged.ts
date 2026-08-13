import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { ghGetPr, githubFailureToFlow } from '../github';
import { getPrimaryLink } from '../primary-link';

/**
 * `pr_merged` — the `mark_complete` merge gate. The run's reviewed PR must be
 * `MERGED` before the task may complete. `OPEN` is pending (the merge is in
 * flight → retry); `CLOSED` without merge, a missing PR identity, or a terminal
 * lookup failure is a hard stop. A rate-limited lookup retries.
 *
 * No agent-supplied input is needed — the hook reads the run's authoritative PR
 * from its artifacts — so `requiredData` is empty.
 */
export const prMergedHook: Hook = {
  id: 'pr_merged',
  requiredData: [],
  run: async (_action: HookAction, ctx): Promise<HookReturn> => {
    const link = getPrimaryLink(ctx);
    if (!link) {
      return { flow: 'stop', reason: 'Cannot verify merge: this run has no reviewed PR identity.' };
    }
    const result = await ghGetPr(ctx, link);
    if (!result.ok) return githubFailureToFlow(result);

    if (result.data.state === 'MERGED') return { flow: 'continue' };
    if (result.data.state === 'OPEN') return { flow: 'retry', reason: 'PR is not merged yet.' };
    return { flow: 'stop', reason: `PR state is ${result.data.state}; expected MERGED.` };
  },
};
