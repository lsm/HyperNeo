import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor.ts';
import { collectWithMaxBuffer, parseJsonStdout } from '../script-utils.ts';
import { buildGitHubLookupEnv, fetchRateLimitResetEpoch } from '../gh-lookup-helpers.ts';
import { parsePrUrl } from '../parse-pr-url.ts';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../rate-limit-detector.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1_048_576;

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
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
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

async function inferGitHubHost(
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number
): Promise<string | undefined> {
  if (process.env.GH_HOST) return process.env.GH_HOST;
  if (process.env.GH_REPO) {
    const parts = process.env.GH_REPO.split('/');
    if (parts.length >= 3 && parts[0]) return parts[0];
  }
  const originUrl = await runTextCommand(
    ['git', 'config', '--get', 'remote.origin.url'],
    cwd,
    Math.min(remainingTimeoutMs(deadlineMs), 2_000),
    spawnImpl
  );
  if (!originUrl) return undefined;
  return parseGitRemoteHost(originUrl);
}

function parseGitRemoteHost(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.hostname || undefined;
  } catch {
    const match = trimmed.match(/^[^@]+@([^:]+):/);
    return match?.[1];
  }
}

async function runTextCommand(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof Bun.spawn
): Promise<string | undefined> {
  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      env: buildGitHubLookupEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return undefined;
  }

  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, timeoutMs);

  const [stdoutResult, exitCode] = await Promise.all([
    collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
    proc.exited,
  ]);
  clearTimeout(killTimer);
  if (exitCode !== 0) return undefined;
  return stdoutResult.text.trim() || undefined;
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
      const errorsText = JSON.stringify(json.errors);
      if (isSecondaryRateLimitError(errorsText)) {
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
          Math.min(remainingTimeoutMs(deadlineMs), 5_000),
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

function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

type CommandFailure = {
  success: false;
  error: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
};
type CommandSuccess<T> = { success: true; data: T };
type CommandOutcome<T> = CommandSuccess<T> | CommandFailure;

async function runCommandRaw<T>(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof Bun.spawn
): Promise<CommandOutcome<T>> {
  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      env: buildGitHubLookupEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, timeoutMs);

  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
    collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
    proc.exited,
  ]);

  clearTimeout(killTimer);

  if (exitCode !== 0) {
    return { success: false, error: stderrResult.text.trim() || `gh exited with code ${exitCode}` };
  }

  const parsed = parseJsonStdout(stdoutResult.text);
  if (!parsed) {
    return { success: false, error: 'gh produced empty or non-JSON stdout' };
  }

  return { success: true, data: parsed as T };
}

async function runCommand<T>(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof Bun.spawn,
  options?: { hostHint?: string; resourceHint?: 'core' | 'graphql' }
): Promise<CommandOutcome<T>> {
  const outcome = await runCommandRaw<T>(args, cwd, timeoutMs, spawnImpl);
  if (outcome.success) return outcome;
  if (!isRateLimitError(outcome.error)) return outcome;
  if (isSecondaryRateLimitError(outcome.error)) {
    return {
      success: false,
      error: outcome.error,
      rateLimited: true,
      retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  const resetEpoch = await fetchRateLimitResetEpoch(
    cwd,
    spawnImpl,
    Math.min(timeoutMs, 5_000),
    options?.hostHint,
    options?.resourceHint
  );
  return {
    success: false,
    error: outcome.error,
    rateLimited: true,
    retryAfterMs: computeRateLimitRetryMs(resetEpoch),
  };
}

function commandFailureToHookResult(failure: CommandFailure, prefix: string): WorkflowHookResult {
  if (failure.rateLimited) {
    return {
      type: 'retryable_block',
      reason: `${prefix}: GitHub rate limited — ${failure.error}`,
      retryAfterMs: failure.retryAfterMs ?? RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  return { type: 'block', reason: `${prefix}: ${failure.error}` };
}
