/**
 * PR Ready Built-in Validator
 *
 * Typed replacement for the legacy PR_READY_BASH_SCRIPT. Validates that a
 * GitHub PR is open, mergeable, and has no unresolved review threads before
 * allowing a send_message handoff to a review node.
 */

import type { WorkflowHookResult } from '@neokai/shared';
import type { HookExecutorContext } from '../hook-executor';
import { collectWithMaxBuffer, parseJsonStdout } from '../gate-script-executor';

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

export function createPrReadyValidator(
  spawnImpl: typeof Bun.spawn = Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
    const prUrl = extractPrUrl(context);
    if (!prUrl) {
      return {
        type: 'block',
        reason: 'PR is not ready for Review: no PR URL provided',
      };
    }

    const prMeta = parsePrUrl(prUrl);
    if (!prMeta) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: unable to parse GitHub PR URL: ${prUrl}`,
      };
    }

    // Run gh pr view
    const prView = await runCommand<PrViewResult>(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      context.workspacePath,
      DEFAULT_TIMEOUT_MS,
      spawnImpl
    );
    if (!prView.success) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: ${prView.error}`,
      };
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
    const threadsResult = await runReviewThreadsQuery(prMeta, context.workspacePath, spawnImpl);
    if (!threadsResult.success) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: ${threadsResult.error}`,
      };
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

    return {
      type: 'allow',
      data: { pr_url: prJson.url },
    };
  };
}

function extractPrUrl(context: HookExecutorContext): string | undefined {
  const paramsData = context.params?.data;
  if (
    typeof paramsData === 'object' &&
    paramsData !== null &&
    typeof (paramsData as Record<string, unknown>).pr_url === 'string'
  ) {
    return (paramsData as Record<string, unknown>).pr_url as string;
  }
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

function parsePrUrl(
  url: string
): { host: string; owner: string; repo: string; number: string } | null {
  const match = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)/);
  if (!match) return null;
  return { host: match[1], owner: match[2], repo: match[3], number: match[4] };
}

async function runReviewThreadsQuery(
  meta: { host: string; owner: string; repo: string; number: string },
  cwd: string,
  spawnImpl: typeof Bun.spawn
): Promise<{ success: true; unresolvedUrls: string[] } | { success: false; error: string }> {
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

    const result = await runCommand<GraphQlResponse>(args, cwd, DEFAULT_TIMEOUT_MS, spawnImpl);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const json = result.data;
    if (json.errors) {
      return { success: false, error: `GraphQL errors: ${JSON.stringify(json.errors)}` };
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

async function runCommand<T>(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof Bun.spawn
): Promise<{ success: true; data: T } | { success: false; error: string }> {
  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
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
