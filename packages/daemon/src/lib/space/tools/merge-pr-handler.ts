/**
 * `merge_pr` Space MCP tool handler.
 *
 * The deterministic post-approval merge gate (task #866). This is the ONLY path
 * by which a post-approval Merger may merge a PR — raw `gh pr merge` is blocked
 * on the Merger slot by a declarative Bash guard, so the agent cannot bypass
 * this validation by reasoning around prompt text (the #857 failure).
 *
 * Flow:
 *   1. Fetch a GitHub snapshot of the PR (state, head, checks, reviews, threads).
 *   2. {@link evaluateMergeReadiness} computes structured blockers (pure).
 *   3. If blocked → return the blockers (the Merger relays them to the approval
 *      authority). No merge is attempted.
 *   4. If ready → `gh pr merge --squash --match-head-commit <validatedHead>`.
 *      `--match-head-commit` makes a concurrent push fail safely; a failure is
 *      classified by {@link classifyMergeFailure} (head_changed / permissions /
 *      branch_protection / merge_failed).
 *
 * The handler NEVER consults Space task-approval provenance (`approvalSource`).
 * Only a real GitHub approval covering the current head authorizes the merge.
 */

import { buildMergePrDeps, type MergePrDeps } from '../runtime/merge-pr-gh';
import {
  classifyMergeFailure,
  evaluateMergeReadiness,
  type MergeBlocker,
} from '../runtime/merge-pr-validator';
import type { SpaceAgentToolsConfig } from './space-agent-tools';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';

export interface MergePrArgs {
  pr_url: string;
  /** Optional: the Space task being merged for (audit only — not a gate). */
  task_id?: string;
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

/**
 * Run the merge gate. `config.mergePrDeps` lets tests inject a fully-mocked
 * dependency (no real `gh` / network); production builds it from `Bun.spawn`.
 */
export async function runMergePr(
  args: MergePrArgs,
  config: SpaceAgentToolsConfig
): Promise<ToolResult> {
  const prUrl = (args?.pr_url ?? '').trim();
  if (!prUrl) {
    return jsonResult({
      ok: false,
      merged: false,
      blockers: [{ kind: 'fetch_failed', detail: 'merge_pr requires a pr_url.' }],
    } satisfies MergePrToolResult);
  }

  let deps: MergePrDeps;
  try {
    deps =
      config.mergePrDeps ?? buildMergePrDeps({ spawn: Bun.spawn, cwd: await resolveGhCwd(config) });
  } catch (err) {
    return jsonResult({
      ok: false,
      merged: false,
      blockers: [
        {
          kind: 'fetch_failed',
          detail: `Could not initialise gh deps: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    } satisfies MergePrToolResult);
  }

  let snapshot;
  try {
    snapshot = await deps.fetchSnapshot(prUrl);
  } catch (err) {
    return jsonResult({
      ok: false,
      merged: false,
      blockers: [
        {
          kind: 'fetch_failed',
          detail: `GitHub state fetch threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    } satisfies MergePrToolResult);
  }

  const readiness = evaluateMergeReadiness(snapshot);
  if (!readiness.ok) {
    return jsonResult({
      ok: false,
      merged: false,
      headRefOid: snapshot.headRefOid ?? undefined,
      blockers: readiness.blockers,
    } satisfies MergePrToolResult);
  }

  const validatedHead = readiness.validatedHeadOid!;
  let outcome;
  try {
    outcome = await deps.performMerge(prUrl, validatedHead);
  } catch (err) {
    return jsonResult({
      ok: false,
      merged: false,
      headRefOid: validatedHead,
      blockers: [
        {
          kind: 'merge_failed',
          detail: `merge attempt threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    } satisfies MergePrToolResult);
  }

  if (!outcome.ok) {
    const blocker = classifyMergeFailure(outcome, validatedHead);
    return jsonResult({
      ok: false,
      merged: false,
      headRefOid: validatedHead,
      blockers: [blocker],
      mergeError: outcome.error,
    } satisfies MergePrToolResult);
  }

  const merged = (outcome.stateAfter ?? '').toUpperCase() === 'MERGED';
  return jsonResult({
    ok: true,
    merged,
    state: outcome.stateAfter,
    headRefOid: validatedHead,
    blockers: [],
  } satisfies MergePrToolResult);
}
