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

const GITHUB_LOOKUP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
]);
const BASIC_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'AppData',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
]);

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
    const prUrlResult = await resolvePrUrl(context, spawnImpl);
    if (!prUrlResult.success) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: ${prUrlResult.error}`,
      };
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
  spawnImpl: typeof Bun.spawn
): Promise<
  { success: true; prUrl: string; shouldPatchPrUrl: boolean } | { success: false; error: string }
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
    DEFAULT_TIMEOUT_MS,
    spawnImpl
  );
  if (!currentBranchPr.success) {
    return {
      success: false,
      error: `no PR URL provided and current-branch PR discovery failed: ${currentBranchPr.error}`,
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

function buildGitHubLookupEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASIC_ENV_KEYS, ...GITHUB_LOOKUP_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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
