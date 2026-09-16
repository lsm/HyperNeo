import type { WorkflowHookResult } from '@hyperneo/shared';
import { parsePrUrl } from '../../github/parse-pr-url.ts';
import { type SpawnFn, spawnProcess } from '../../runtime-spawn/index.ts';
import type { HookExecutorContext } from '../hook-executor.ts';
import {
  type CommandFailure,
  commandFailureToHookResult,
  inferGitHubHost,
  remainingTimeoutMs,
  runCommand,
  runReviewThreadsQuery,
} from './pr-ready-gh-commands.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
interface PrViewResult {
  url: string;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
}

const POST_APPROVAL_MERGE_REASONS = new Set(['merge_blocked', 'merge_fix_pushed']);

function readSendReason(context: HookExecutorContext): string | undefined {
  const data = (context.rawParams ?? context.params)?.data;
  if (data && typeof data === 'object' && 'reason' in data) {
    const reason = (data as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
  }
  return undefined;
}

export function createPrReadyValidator(
  spawnImpl: SpawnFn = spawnProcess
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
    if (context.taskStatus === 'approved') {
      const data = (context.rawParams ?? context.params)?.data;
      const suppliedPrUrl =
        data && typeof data === 'object' && 'pr_url' in data
          ? (data as { pr_url?: unknown }).pr_url
          : undefined;
      const frozenPrUrl =
        typeof context.frozenPrUrl === 'string'
          ? context.frozenPrUrl
          : typeof context.hookLocalState.pr_url === 'string'
            ? context.hookLocalState.pr_url
            : typeof context.hookLocalState.prUrl === 'string'
              ? context.hookLocalState.prUrl
              : undefined;
      const isMergeReason = POST_APPROVAL_MERGE_REASONS.has(readSendReason(context) ?? '');
      if (isMergeReason) {
        if (typeof suppliedPrUrl !== 'string') {
          return {
            type: 'block',
            reason:
              'Post-approval blocker/fix handoff must carry data.pr_url bound to the reviewed PR (omission is not safe).',
          };
        }
        if (!frozenPrUrl) {
          return {
            type: 'block',
            reason:
              'Post-approval blocker/fix handoff cannot be bound because this PR-ready hook has no frozen reviewed PR identity.',
          };
        }
        if (suppliedPrUrl !== frozenPrUrl) {
          return {
            type: 'block',
            reason: `Post-approval blocker/fix handoff PR ${suppliedPrUrl} does not match the reviewed PR ${frozenPrUrl}`,
          };
        }
        return { type: 'allow' };
      }
      if (typeof suppliedPrUrl === 'string') {
        if (!frozenPrUrl) {
          return {
            type: 'block',
            reason:
              'Post-approval handoff cannot set a PR URL because this PR-ready hook has no frozen reviewed PR identity.',
          };
        }
        if (suppliedPrUrl !== frozenPrUrl) {
          return {
            type: 'block',
            reason: `Post-approval handoff PR ${suppliedPrUrl} does not match the reviewed PR ${frozenPrUrl}`,
          };
        }
      }
    }
    const deadlineMs = Date.now() + DEFAULT_TIMEOUT_MS;
    const prUrlResult = await resolvePrUrl(context, spawnImpl, deadlineMs);
    if (!prUrlResult.success) {
      return commandFailureToHookResult(prUrlResult, 'PR is not ready for Review');
    }
    const prUrl = prUrlResult.prUrl;
    const shouldPatchPrUrl = prUrlResult.shouldPatchPrUrl;

    const prMeta = parsePrUrl(prUrl);
    if (!prMeta) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: unable to parse GitHub PR URL: ${prUrl}`,
      };
    }

    const prView = await runCommand<PrViewResult>(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      context.workspacePath,
      remainingTimeoutMs(deadlineMs),
      spawnImpl,
      { hostHint: prMeta.host, resourceHint: 'graphql' }
    );
    if (!prView.success) {
      return commandFailureToHookResult(prView, 'PR is not ready for Review');
    }

    const prJson = prView.data;
    const prState = prJson.state;
    if (prState !== 'OPEN') {
      return {
        type: 'block',
        reason: `PR is not ready for Review: PR state is ${prState ?? 'unknown'} (expected OPEN)`,
      };
    }

    const mergeable = prJson.mergeable;
    if (mergeable === 'UNKNOWN') {
      return {
        type: 'retryable_block',
        reason: 'Waiting for GitHub mergeability/checks',
        retryAfterMs: 30_000,
      };
    }
    if (mergeable !== 'MERGEABLE') {
      return {
        type: 'block',
        reason: `PR is not ready for Review: PR is not mergeable (mergeable: ${mergeable ?? 'unknown'})`,
      };
    }

    const mergeStateStatus = prJson.mergeStateStatus;
    if (mergeStateStatus === 'UNKNOWN') {
      return {
        type: 'retryable_block',
        reason: 'Waiting for GitHub mergeability/checks',
        retryAfterMs: 30_000,
      };
    }
    if (
      mergeStateStatus !== 'CLEAN' &&
      mergeStateStatus !== 'HAS_HOOKS' &&
      mergeStateStatus !== 'BLOCKED'
    ) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: PR merge checks not satisfied (mergeStateStatus: ${mergeStateStatus ?? 'unknown'})`,
      };
    }

    const threadsResult = await runReviewThreadsQuery(
      prMeta,
      context.workspacePath,
      spawnImpl,
      deadlineMs
    );
    if (!threadsResult.success) {
      return commandFailureToHookResult(threadsResult, 'PR is not ready for Review');
    }

    const unresolvedUrls = threadsResult.unresolvedUrls;
    if (unresolvedUrls.length > 0) {
      return {
        type: 'block',
        reason:
          `PR is not ready for Review: PR has ${unresolvedUrls.length} unresolved review conversation(s); resolve them before handoff:\n` +
          unresolvedUrls.join('\n'),
      };
    }

    if (shouldPatchPrUrl) {
      return {
        type: 'patch_params',
        patch: { data: { ...extractDataRecord(context), pr_url: prJson.url } },
        data: { pr_url: prJson.url },
      };
    }

    return {
      type: 'allow',
      data: { pr_url: prJson.url },
    };
  };
}

async function resolvePrUrl(
  context: HookExecutorContext,
  spawnImpl: SpawnFn,
  deadlineMs: number
): Promise<
  | { success: true; prUrl: string; shouldPatchPrUrl: boolean }
  | ({ success: false; error: string } & Pick<CommandFailure, 'rateLimited' | 'retryAfterMs'>)
> {
  const boundedPrUrl = extractPrUrlFromParams(context.params);
  if (boundedPrUrl) return { success: true, prUrl: boundedPrUrl, shouldPatchPrUrl: false };

  const rawPrUrl = context.rawParams ? extractPrUrlFromParams(context.rawParams) : undefined;
  if (rawPrUrl) return { success: true, prUrl: rawPrUrl, shouldPatchPrUrl: false };

  const templatePrUrl = extractTemplatePrUrl(context);
  if (templatePrUrl) return { success: true, prUrl: templatePrUrl, shouldPatchPrUrl: true };

  const currentBranchPr = await runCommand<{ url?: string }>(
    ['gh', 'pr', 'view', '--json', 'url'],
    context.workspacePath,
    remainingTimeoutMs(deadlineMs),
    spawnImpl,
    {
      resourceHint: 'graphql',
      hostHint: await inferGitHubHost(context.workspacePath, spawnImpl, deadlineMs),
    }
  );
  if (!currentBranchPr.success) {
    return {
      success: false,
      error: `no PR URL provided and current-branch PR discovery failed: ${currentBranchPr.error}`,
      rateLimited: currentBranchPr.rateLimited,
      retryAfterMs: currentBranchPr.retryAfterMs,
    };
  }
  if (typeof currentBranchPr.data.url !== 'string' || currentBranchPr.data.url.length === 0) {
    return {
      success: false,
      error: 'no PR URL provided and current-branch PR discovery returned no URL',
    };
  }
  return { success: true, prUrl: currentBranchPr.data.url, shouldPatchPrUrl: true };
}

function extractDataRecord(context: HookExecutorContext): Record<string, unknown> {
  const data = context.rawParams?.data ?? context.params.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? { ...data } : {};
}

function extractTemplatePrUrl(context: HookExecutorContext): string | undefined {
  const templateData = context.templateData;
  if (
    typeof templateData === 'object' &&
    templateData !== null &&
    typeof templateData.pr_url === 'string'
  ) {
    return templateData.pr_url;
  }
  return undefined;
}

function extractPrUrlFromParams(params: Record<string, unknown>): string | undefined {
  const data = params.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).pr_url === 'string'
  ) {
    return (data as Record<string, unknown>).pr_url as string;
  }
  return undefined;
}
