import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor';

const POST_APPROVAL_MERGE_REASONS = new Set(['merge_blocked', 'merge_fix_pushed']);

function readSendReason(context: HookExecutorContext): string | undefined {
  const data = (context.rawParams ?? context.params)?.data;
  if (data && typeof data === 'object' && 'reason' in data) {
    const reason = (data as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
  }
  return undefined;
}

function readSuppliedPrUrl(context: HookExecutorContext): string | undefined {
  const data = (context.rawParams ?? context.params)?.data;
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as Record<string, unknown>).pr_url === 'string'
  ) {
    return (data as Record<string, unknown>).pr_url as string;
  }
  return undefined;
}

export function createPostApprovalOnlyValidator(): (
  context: HookExecutorContext
) => Promise<WorkflowHookResult> {
  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
    if (
      context.taskStatus === 'approved' &&
      POST_APPROVAL_MERGE_REASONS.has(readSendReason(context) ?? '')
    ) {
      const suppliedPrUrl = readSuppliedPrUrl(context);
      if (typeof suppliedPrUrl !== 'string') {
        return {
          type: 'block',
          reason:
            'Post-approval blocker/fix handoff must carry data.pr_url bound to the reviewed PR (omission is not safe).',
        };
      }
      if (!context.frozenPrUrl) {
        return {
          type: 'block',
          reason:
            'Post-approval blocker handoff carries a pr_url, but this run has no frozen reviewed PR identity to bind it to.',
        };
      }
      if (suppliedPrUrl !== context.frozenPrUrl) {
        return {
          type: 'block',
          reason: `Post-approval blocker handoff PR ${suppliedPrUrl} does not match this run's reviewed PR ${context.frozenPrUrl}.`,
        };
      }
      return { type: 'allow' };
    }
    return {
      type: 'block',
      reason:
        'This channel is post-approval only: it carries merge-blocker / fix-push reports to the ' +
        'approval authority after the task is approved. It is not available during implementation — ' +
        'hand the PR to Review instead.',
    };
  };
}
