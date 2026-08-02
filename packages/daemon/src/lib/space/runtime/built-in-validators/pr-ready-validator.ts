/**
 * PR Ready Built-in Validator
 *
 * Typed replacement for the legacy PR_READY_BASH_SCRIPT. Validates that a
 * GitHub PR is open, mergeable, and has no unresolved review threads before
 * allowing a send_message handoff to a review node.
 */

import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor';
import { parsePrUrl } from '../parse-pr-url';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../rate-limit-detector';
import {
  commandFailureToHookResult,
  extractPrUrlFromParams,
  extractTemplatePrUrl,
  fetchRateLimitResetEpoch,
  remainingTimeoutMs,
  resolveCurrentBranchPrUrl,
  runCommand,
  type CommandFailure,
} from './gh-lookup-helpers';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PrViewResult {
  url: string;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
}

interface ReviewThreadNode {
  id?: string;
  isResolved: boolean;
  comments: { nodes: Array<{ url: string }> };
}

interface ReviewThreadsPage {
  nodes: ReviewThreadNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface GraphQlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: ReviewThreadsPage;
      };
    };
  };
  errors?: unknown[];
}

export function createPrReadyValidator(
  spawnImpl: typeof Bun.spawn = Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
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

    // Run gh pr view. The requested fields (mergeable/mergeStateStatus) are
    // GraphQL PullRequest fields in the GitHub CLI, so a rate-limit probe uses
    // the `graphql` resource window rather than REST `core`.
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

    // Check unresolved review threads
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
  spawnImpl: typeof Bun.spawn,
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

  // Fall back to the current branch's PR. When GH_HOST points to an Enterprise
  // host, the shared resolver forwards it so a rate-limit probe queries the
  // same host.
  const fallback = await resolveCurrentBranchPrUrl(context, spawnImpl, deadlineMs);
  if (!fallback.success) {
    return {
      success: false,
      error: `no PR URL provided and ${fallback.error}`,
      rateLimited: fallback.rateLimited,
      retryAfterMs: fallback.retryAfterMs,
    };
  }
  return { success: true, prUrl: fallback.prUrl, shouldPatchPrUrl: true };
}

function extractDataRecord(context: HookExecutorContext): Record<string, unknown> {
  const data = context.rawParams?.data ?? context.params.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? { ...data } : {};
}

async function runReviewThreadsQuery(
  meta: { host: string; owner: string; repo: string; number: string },
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number
): Promise<
  | { success: true; unresolvedUrls: string[] }
  | ({ success: false; error: string } & Pick<CommandFailure, 'rateLimited' | 'retryAfterMs'>)
> {
  const unresolvedUrls: string[] = [];
  let cursor: string | null = null;

  while (true) {
    const args: string[] = ['gh', 'api', 'graphql', '--hostname', meta.host];
    if (cursor) {
      args.push(
        '-f',
        `owner=${meta.owner}`,
        '-f',
        `name=${meta.repo}`,
        '-F',
        `number=${meta.number}`,
        '-f',
        `cursor=${cursor}`,
        '-f',
        `query=query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}`
      );
    } else {
      args.push(
        '-f',
        `owner=${meta.owner}`,
        '-f',
        `name=${meta.repo}`,
        '-F',
        `number=${meta.number}`,
        '-f',
        `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}`
      );
    }

    const result = await runCommand<GraphQlResponse>(
      args,
      cwd,
      remainingTimeoutMs(deadlineMs),
      spawnImpl,
      { hostHint: meta.host, resourceHint: 'graphql' }
    );
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        rateLimited: result.rateLimited,
        retryAfterMs: result.retryAfterMs,
      };
    }

    const json = result.data;
    if (json.errors) {
      // GraphQL rate-limit errors come as HTTP 200 with an errors payload.
      // Check if any error message indicates a rate limit and retry accordingly.
      const errorsText = JSON.stringify(json.errors);
      if (isSecondaryRateLimitError(errorsText)) {
        // Secondary/abuse throttles do not update /rate_limit; use the minimum
        // backoff rather than an unrelated primary reset window.
        return {
          success: false,
          error: `GraphQL secondary rate limit: ${errorsText}`,
          rateLimited: true,
          retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
        };
      }
      if (isRateLimitError(errorsText)) {
        const resetEpoch = await fetchRateLimitResetEpoch(
          cwd,
          spawnImpl,
          deadlineMs,
          meta.host,
          'graphql'
        );
        return {
          success: false,
          error: `GraphQL rate limit: ${errorsText}`,
          rateLimited: true,
          retryAfterMs: computeRateLimitRetryMs(resetEpoch),
        };
      }
      return { success: false, error: `GraphQL errors: ${errorsText}` };
    }
    const threads = json.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) {
      return { success: false, error: 'Incomplete GraphQL response — reviewThreads data missing' };
    }

    for (const node of threads.nodes) {
      if (!node.isResolved) {
        const url = node.comments.nodes[0]?.url ?? node.id;
        unresolvedUrls.push(url);
      }
    }

    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) {
      return {
        success: false,
        error: 'Incomplete pagination: hasNextPage is true but endCursor is missing',
      };
    }
  }

  return { success: true, unresolvedUrls };
}
