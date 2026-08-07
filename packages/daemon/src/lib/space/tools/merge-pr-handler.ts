/**
 * `merge_pr` Space MCP tool handler.
 *
 * The deterministic post-approval merge gate (task #866). This is the ONLY path
 * by which a post-approval Merger may merge a PR — raw `gh pr merge` is blocked
 * on the Merger slot by a declarative Bash guard, so the agent cannot bypass
 * this validation by reasoning around prompt text (the #857 failure).
 *
 * ## Authorization
 *
 * The tool lives on the shared `space-agent-tools` server (attached to every
 * Space member), so the handler MUST authorize the caller — otherwise any Space
 * member (e.g. a coder) could merge an otherwise-ready PR before the task is
 * approved. A call is accepted only when ALL hold:
 *   - `task_id` is provided and resolves to a task in THIS Space;
 *   - that task is in the `approved` state (post-approval in flight);
 *   - the caller's session (`config.mySessionId`) is the task's designated
 *     post-approval merger session (`task.postApprovalSessionId`) — i.e. the
 *     merger spawned for this specific task.
 *
 * ## Flow
 *   1. Authorize (above).
 *   2. Fetch a GitHub snapshot of the PR (state, head, checks, reviews, threads).
 *   3. {@link evaluateMergeReadiness} computes structured blockers (pure).
 *   4. If blocked → return the blockers (the Merger relays them to the approval
 *      authority). No merge is attempted.
 *   5. If ready → `gh pr merge --squash --match-head-commit <validatedHead>`.
 *      `--match-head-commit` makes a concurrent push fail safely; a failure is
 *      classified by {@link classifyMergeFailure}.
 *   6. Record an audit entry (best-effort) via `config.auditLogRepo`.
 *
 * The handler NEVER consults Space task-approval provenance (`approvalSource`).
 * Only a real GitHub approval covering the current head authorizes the merge.
 */

import { buildMergePrDeps, type MergePrDeps } from '../runtime/merge-pr-gh';
import { parsePrUrl } from '../runtime/parse-pr-url';
import {
  classifyMergeFailure,
  evaluateMergeReadiness,
  type MergeBlocker,
} from '../runtime/merge-pr-validator';
import type { SpaceAgentToolsConfig } from './space-agent-tools';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';

export interface MergePrArgs {
  /** The Space task whose approved PR is being merged (required — authorizes the call). */
  task_id: string;
  pr_url: string;
}

export interface MergePrToolResult {
  /** True when the merge command was accepted (exit 0). */
  ok: boolean;
  /** True only when the PR state is MERGED after the attempt. */
  merged: boolean;
  /** PR state after the attempt (MERGED | OPEN when enqueued). */
  state?: string | null;
  /** Head OID the merge was bound to (== validated approval head). */
  headRefOid?: string;
  /** Structured blockers (empty when ok). */
  blockers: MergeBlocker[];
  /** Raw merge error when the merge attempt failed. */
  mergeError?: string;
}

/** Resolve a working cwd for `gh` subprocesses: the Space workspace, else cwd. */
async function resolveGhCwd(config: SpaceAgentToolsConfig): Promise<string> {
  const spaceId = config.spaceId;
  const space = config.spaceManager ? await config.spaceManager.getSpace(spaceId) : undefined;
  return space?.workspacePath ?? process.cwd();
}

/** Best-effort audit of a merge_pr attempt. Never throws. */
function auditMergePr(
  config: SpaceAgentToolsConfig,
  args: MergePrArgs,
  summary: Record<string, unknown>,
  workflowRunId?: string | null
): void {
  if (!config.auditLogRepo) return;
  try {
    config.auditLogRepo.createEntry({
      agentName: config.myAgentName ?? null,
      sessionId: config.mySessionId ?? null,
      toolName: 'merge_pr',
      paramsSummary: JSON.stringify(summary),
      spaceId: config.spaceId,
      taskId: args.task_id,
      workflowRunId: workflowRunId ?? null,
    });
  } catch {
    // Audit logging is best-effort; never block the tool operation.
  }
}

function blocked(result: MergePrToolResult): ToolResult {
  return jsonResult(result);
}

/**
 * Run the merge gate. `config.mergePrDeps` lets tests inject a fully-mocked
 * dependency (no real `gh` / network); production builds it from `Bun.spawn`.
 */
export async function runMergePr(
  args: MergePrArgs,
  config: SpaceAgentToolsConfig
): Promise<ToolResult> {
  const taskId = (args?.task_id ?? '').trim();
  const prUrl = (args?.pr_url ?? '').trim();

  if (!taskId || !prUrl) {
    return blocked({
      ok: false,
      merged: false,
      blockers: [
        {
          kind: 'fetch_failed',
          detail: 'merge_pr requires both task_id (the approved Space task) and pr_url.',
        },
      ],
    });
  }

  // --- Authorize: only THIS task's designated post-approval merger may merge. ---
  const task = config.taskRepo.getTask(taskId);
  const mySession = config.mySessionId ?? null;
  const approvedSession = task?.postApprovalSessionId ?? null;
  if (
    !task ||
    task.spaceId !== config.spaceId ||
    task.status !== 'approved' ||
    !approvedSession ||
    approvedSession !== mySession
  ) {
    auditMergePr(
      config,
      args,
      { pr_url: prUrl, authorized: false, reason: 'not-this-tasks-merger' },
      task?.workflowRunId
    );
    return blocked({
      ok: false,
      merged: false,
      blockers: [
        {
          kind: 'unauthorized',
          detail:
            'merge_pr may only be called by the designated post-approval merger session for an approved task in this Space. ' +
            'It is not available to coders or other members, and a Space task approval does not grant merge authority.',
        },
      ],
    });
  }

  // --- Bind the caller-supplied pr_url to THIS task's recorded PR. ---
  // The caller controls pr_url; without this check an authorized merger for task
  // A could merge task B's otherwise-ready PR. Compare normalized GitHub identity
  // (host/owner/repo/number) against the run's recorded PR. Fail closed when the
  // run has no resolvable PR or the identities differ.
  const recordedPrUrl = config.runtime.getApprovedPrUrlForRun(task!.workflowRunId ?? '');
  const requested = parsePrUrl(prUrl);
  const recorded = recordedPrUrl ? parsePrUrl(recordedPrUrl) : null;
  const samePr =
    !!requested &&
    !!recorded &&
    requested.host.toLowerCase() === recorded.host.toLowerCase() &&
    requested.owner.toLowerCase() === recorded.owner.toLowerCase() &&
    requested.repo.toLowerCase() === recorded.repo.toLowerCase() &&
    requested.number === recorded.number;
  if (!samePr) {
    auditMergePr(
      config,
      args,
      { pr_url: prUrl, authorized: false, reason: 'pr-url-not-bound-to-task' },
      task!.workflowRunId
    );
    return blocked({
      ok: false,
      merged: false,
      blockers: [
        {
          kind: 'unauthorized',
          detail:
            'merge_pr may only merge the PR recorded for this task. The supplied pr_url does not match ' +
            'the approved task’s PR (or the task has no recorded PR); pass the task’s own PR.',
        },
      ],
    });
  }

  let deps: MergePrDeps;
  try {
    deps =
      config.mergePrDeps ?? buildMergePrDeps({ spawn: Bun.spawn, cwd: await resolveGhCwd(config) });
  } catch (err) {
    return blocked({
      ok: false,
      merged: false,
      blockers: [
        {
          kind: 'fetch_failed',
          detail: `Could not initialise gh deps: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    });
  }

  let snapshot;
  try {
    snapshot = await deps.fetchSnapshot(prUrl);
  } catch (err) {
    auditMergePr(config, args, { pr_url: prUrl, outcome: 'fetch_threw' }, task.workflowRunId);
    return blocked({
      ok: false,
      merged: false,
      blockers: [
        {
          kind: 'fetch_failed',
          detail: `GitHub state fetch threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    });
  }

  const readiness = evaluateMergeReadiness(snapshot);
  if (!readiness.ok) {
    auditMergePr(
      config,
      args,
      { pr_url: prUrl, outcome: 'blocked', blockers: readiness.blockers.map((b) => b.kind) },
      task.workflowRunId
    );
    return blocked({
      ok: false,
      merged: false,
      headRefOid: snapshot.headRefOid ?? undefined,
      blockers: readiness.blockers,
    });
  }

  const validatedHead = readiness.validatedHeadOid!;
  let outcome;
  try {
    outcome = await deps.performMerge(prUrl, validatedHead);
  } catch (err) {
    auditMergePr(
      config,
      args,
      { pr_url: prUrl, outcome: 'merge_threw', headRefOid: validatedHead },
      task.workflowRunId
    );
    return blocked({
      ok: false,
      merged: false,
      headRefOid: validatedHead,
      blockers: [
        {
          kind: 'merge_failed',
          detail: `merge attempt threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    });
  }

  if (!outcome.ok) {
    const blocker = classifyMergeFailure(outcome, validatedHead);
    auditMergePr(
      config,
      args,
      { pr_url: prUrl, outcome: 'merge_failed', headRefOid: validatedHead, blocker: blocker.kind },
      task.workflowRunId
    );
    return blocked({
      ok: false,
      merged: false,
      headRefOid: validatedHead,
      blockers: [blocker],
      mergeError: outcome.error,
    });
  }

  const merged = (outcome.stateAfter ?? '').toUpperCase() === 'MERGED';
  auditMergePr(
    config,
    args,
    { pr_url: prUrl, outcome: merged ? 'merged' : 'enqueued', headRefOid: validatedHead },
    task.workflowRunId
  );
  return jsonResult({
    ok: true,
    merged,
    state: outcome.stateAfter,
    headRefOid: validatedHead,
    blockers: [],
  } satisfies MergePrToolResult);
}
