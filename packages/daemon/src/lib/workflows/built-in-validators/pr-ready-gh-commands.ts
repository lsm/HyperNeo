import type { WorkflowHookResult } from '@hyperneo/shared';
import type { SpawnFn } from '../../runtime-spawn/index.ts';
import { buildGitHubLookupEnv, fetchRateLimitResetEpoch } from '../../github/gh-lookup-helpers.ts';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../../session/rate-limit-detector.ts';
import { collectWithMaxBuffer, parseJsonStdout } from '../../utils/script-utils.ts';

const MAX_BUFFER_BYTES = 1_048_576;

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

export async function inferGitHubHost(
  cwd: string,
  spawnImpl: SpawnFn,
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
  spawnImpl: SpawnFn
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

export async function runReviewThreadsQuery(
  meta: { host: string; owner: string; repo: string; number: string },
  cwd: string,
  spawnImpl: SpawnFn,
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

export function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

export type CommandFailure = {
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
  spawnImpl: SpawnFn
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

export async function runCommand<T>(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: SpawnFn,
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

export function commandFailureToHookResult(
  failure: CommandFailure,
  prefix: string
): WorkflowHookResult {
  if (failure.rateLimited) {
    return {
      type: 'retryable_block',
      reason: `${prefix}: GitHub rate limited — ${failure.error}`,
      retryAfterMs: failure.retryAfterMs ?? RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  return { type: 'block', reason: `${prefix}: ${failure.error}` };
}
