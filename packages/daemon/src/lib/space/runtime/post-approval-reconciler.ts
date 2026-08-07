/**
 * PostApprovalReconciler — detects `approved` tasks whose PR is already merged
 * and resumes their deterministic completion tail (task #868).
 *
 * The PR Merger LLM agent performs the merge; this reconciler is the safety net
 * that finishes the post-merge cleanup/audit/completion exactly once if the
 * merger stalls or dies after the merge. It runs at daemon startup and on a
 * throttled cadence from the SpaceRuntime tick loop.
 *
 * ## Predicate
 *
 * An `approved` task is reconciliation-eligible when:
 *   1. it has a canonical PR URL (resolved from its workflow-run artifacts), AND
 *   2. the merger executor is "stale" — its session is not in memory (died with
 *      the daemon / crashed) OR a grace window has elapsed since dispatch — so a
 *      live, working merger is never raced, AND
 *   3. its PR is confirmed `MERGED` via GitHub.
 *
 * Unmerged/blocked PRs are NEVER completed (requirement 6) — they are skipped
 * and left for the merger. Each ineligible outcome enters a per-task cooldown
 * so the reconciler does not hammer GitHub every sweep.
 *
 * ## Concurrency
 *
 * The {@link PostApprovalCompletionService} claims a compare-and-swap lease
 * before driving the tail, so concurrent recovery (and a live merger that also
 * invokes the service) cannot duplicate completion. An in-memory single-flight
 * guard further serializes overlapping sweeps within one process.
 */

import type { SpaceTask } from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { PostApprovalCompletionOps } from './post-approval-completion-ops';
import type {
  PostApprovalCompletionService,
  PostApprovalCompletionResult,
} from './post-approval-completion-service';
import { resolveCanonicalPrUrl } from './post-approval-completion-service';
import { Logger } from '../../logger';

const log = new Logger('post-approval-reconciler');

/** Default sweep cadence: how often runRecovery actually scans when invoked. */
export const DEFAULT_RECONCILER_INTERVAL_MS = 60_000;
/** Cooldown after a not-merged check (the merger may still be working). */
export const DEFAULT_NOT_MERGED_COOLDOWN_MS = 5 * 60_000;
/** Cooldown after a transient gh lookup failure (retry sooner). */
export const DEFAULT_LOOKUP_FAILED_COOLDOWN_MS = 60_000;
/** Cooldown after a successful completion (avoid re-touching a just-done task). */
export const DEFAULT_COMPLETED_COOLDOWN_MS = 5 * 60_000;
/** Cooldown after a task with no resolvable PR URL (not a PR-completion task). */
export const DEFAULT_NO_PR_URL_COOLDOWN_MS = 10 * 60_000;
/**
 * Grace window after dispatch before an IDLE (not actively processing) merger
 * is considered stale. A merger that ended its turn without `mark_complete`
 * sits idle; the run is already `done` so the no-progress tick won't evict it,
 * so after this grace the reconciler recovers it. Actively-processing mergers
 * are never timed out by this (see isMergerStale).
 */
export const DEFAULT_MERGER_GRACE_MS = 5 * 60_000;

export interface PostApprovalReconcilerDeps {
  taskRepo: SpaceTaskRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  ops: PostApprovalCompletionOps;
  service: PostApprovalCompletionService;
  /**
   * Returns true when the merger executor for the task is stale (not driving
   * completion): session not in memory, or no session was dispatched, or the
   * grace window since dispatch has elapsed. The runtime wires this to
   * TaskAgentManager liveness + postApprovalStartedAt.
   */
  isMergerStale: (task: SpaceTask, now: number) => boolean;
  /**
   * Returns true when the task's space is active (not stopped, paused, or
   * archived) — i.e. recovery side effects are permitted. Mirrors the
   * `space.paused || space.stopped` gate every sibling recovery sweep uses.
   * Stopped spaces require an explicit start before work resumes, so an
   * approved task with a merged PR in a stopped space must NOT be force-
   * completed. Defaults to true when omitted (tests).
   */
  isSpaceRecoverable?: (spaceId: string) => boolean;
  /**
   * Fan out a `space.task.updated` event when the reconciler mutates a task
   * directly (e.g. clearing a stale `finalizing merge` status), so connected
   * clients see the change without a full reload. Wired by the runtime to
   * `safeOnTaskUpdated`.
   */
  onTaskUpdated?: (task: SpaceTask) => void;
  now?: () => number;
  intervalMs?: number;
  notMergedCooldownMs?: number;
  lookupFailedCooldownMs?: number;
  completedCooldownMs?: number;
  noPrUrlCooldownMs?: number;
  /**
   * Maximum candidates that may perform a GitHub merged-check per sweep. Each
   * candidate awaits a `gh pr view` (up to the 30s lookup timeout), so an
   * unbounded backlog would stall the sweep. Excess candidates are re-
   * evaluated on a later sweep (they get a short cooldown). Default 5.
   */
  maxCandidatesPerSweep?: number;
}

export interface ReconcilerSweepResult {
  scanned: number;
  resumed: number;
  completed: number;
  notMerged: number;
  deferred: number;
}

/**
 * Liveness probe the merger-staleness evaluator needs from the
 * TaskAgentManager. Extracted so the predicate is unit-testable without a full
 * runtime: `isSessionActivelyProcessing` (a turn in flight) is distinct from
 * `isSessionInMemory`, which also counts `idle` sessions as alive.
 */
export interface MergerLivenessProbe {
  isSessionActivelyProcessing(sessionId: string): boolean;
  isSessionInMemory(sessionId: string): boolean;
}

/**
 * Decide whether a merger executor is stale enough to recover (the reconciler
 * should drive the deterministic tail). Rules:
 *   - no merger was dispatched → stale (eligible).
 *   - a turn is in flight (or imminently queued) → NOT stale: never race it
 *     (its mark_complete does not claim this lease, so the lease can't
 *     serialize a concurrent tail).
 *   - not in memory (dead/crashed) → stale.
 *   - in memory but idle/waiting/interrupted (turn ended without
 *     mark_complete; the run is already done so the no-progress tick won't
 *     evict it) → stale once the grace window since dispatch has elapsed.
 */
export function evaluateMergerStaleness(
  task: Pick<SpaceTask, 'postApprovalSessionId' | 'postApprovalStartedAt'>,
  now: number,
  probe: MergerLivenessProbe,
  graceMs: number = DEFAULT_MERGER_GRACE_MS
): boolean {
  const sessionId = task.postApprovalSessionId;
  if (!sessionId) return true;
  if (probe.isSessionActivelyProcessing(sessionId)) return false;
  if (!probe.isSessionInMemory(sessionId)) return true;
  const startedAt = task.postApprovalStartedAt ?? 0;
  return now - startedAt > graceMs;
}

/** Default per-sweep candidate cap (bounds GitHub lookup time per sweep). */
export const DEFAULT_MAX_CANDIDATES_PER_SWEEP = 5;

export class PostApprovalReconciler {
  private readonly cooldowns = new Map<string, number>();
  private lastSweepAt = 0;
  private sweepInFlight = false;
  /**
   * Rotating start offset into the candidate list. `listApprovedTasks` always
   * returns newest-first; without rotation, a persistently-failing prefix at
   * the head (each getting a cooldown equal to the sweep interval) would be
   * retried every sweep and starve every older task. Advancing the offset by
   * the batch size each sweep gives every candidate a fair turn.
   */
  private candidateOffset = 0;

  constructor(private readonly deps: PostApprovalReconcilerDeps) {}

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }

  /**
   * Run a recovery sweep if the throttle interval has elapsed and no sweep is
   * in flight. Safe to call every tick; the throttle bounds actual work. The
   * `force` option bypasses the throttle (used for the startup sweep).
   */
  async runRecovery(options: { force?: boolean } = {}): Promise<ReconcilerSweepResult | null> {
    const now = this.now();
    const interval = this.deps.intervalMs ?? DEFAULT_RECONCILER_INTERVAL_MS;
    if (!options.force && now - this.lastSweepAt < interval) return null;
    if (this.sweepInFlight) return null;
    this.sweepInFlight = true;
    this.lastSweepAt = now;
    try {
      return await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<ReconcilerSweepResult> {
    const now = this.now();
    const notMergedCooldown = this.deps.notMergedCooldownMs ?? DEFAULT_NOT_MERGED_COOLDOWN_MS;
    const lookupFailedCooldown =
      this.deps.lookupFailedCooldownMs ?? DEFAULT_LOOKUP_FAILED_COOLDOWN_MS;
    const completedCooldown = this.deps.completedCooldownMs ?? DEFAULT_COMPLETED_COOLDOWN_MS;
    const noPrUrlCooldown = this.deps.noPrUrlCooldownMs ?? DEFAULT_NO_PR_URL_COOLDOWN_MS;

    const allTasks = this.deps.taskRepo.listApprovedTasks();
    const tally = {
      scanned: allTasks.length,
      resumed: 0,
      completed: 0,
      notMerged: 0,
      deferred: 0,
    };
    // Prune cooldown entries for tasks no longer `approved` (done / cancelled /
    // deleted). Only approved tasks are ever listed, so without this a
    // long-lived daemon would retain one map entry per task ever examined.
    if (this.cooldowns.size > 0) {
      const approvedIds = new Set(allTasks.map((t) => t.id));
      for (const id of [...this.cooldowns.keys()]) {
        if (!approvedIds.has(id)) this.cooldowns.delete(id);
      }
    }
    const maxCandidates = this.deps.maxCandidatesPerSweep ?? DEFAULT_MAX_CANDIDATES_PER_SWEEP;
    let ghLookups = 0;

    // Rotate the starting point so a persistently-failing newest-first prefix
    // cannot starve older candidates (see candidateOffset docstring).
    const len = allTasks.length;
    const offset = len > 0 ? this.candidateOffset % len : 0;
    const tasks =
      len > 0 && offset > 0 ? [...allTasks.slice(offset), ...allTasks.slice(0, offset)] : allTasks;
    this.candidateOffset = len > 0 ? (this.candidateOffset + maxCandidates) % len : 0;

    for (const task of tasks) {
      const cooldownUntil = this.cooldowns.get(task.id);
      if (cooldownUntil !== undefined && cooldownUntil > now) {
        tally.deferred++;
        continue;
      }

      // Stopped/paused/archived spaces require an explicit start before work
      // resumes — never force-complete a task in one. Mirrors the
      // `space.paused || space.stopped` gate every sibling recovery sweep uses.
      if (this.deps.isSpaceRecoverable && !this.deps.isSpaceRecoverable(task.spaceId)) {
        // Re-check next sweep in case the space is resumed.
        this.cooldowns.set(task.id, now + interval(this.deps.intervalMs));
        tally.deferred++;
        continue;
      }

      const prUrl = resolveCanonicalPrUrl(this.deps.artifactRepo, task.workflowRunId);
      if (!prUrl) {
        this.cooldowns.set(task.id, now + noPrUrlCooldown);
        tally.deferred++;
        continue;
      }

      // Only intervene when the merger is stale — never race a live, working merger.
      if (!this.deps.isMergerStale(task, now)) {
        // Short implicit cooldown: re-evaluate next sweep but don't churn.
        this.cooldowns.set(task.id, now + interval(this.deps.intervalMs));
        tally.deferred++;
        continue;
      }

      // Bound the per-sweep GitHub lookup cost: each candidate awaits a `gh pr
      // view` (up to the 30s timeout). Excess candidates are deferred to a
      // later sweep (short cooldown) so a backlog can't stall the sweep.
      if (ghLookups >= maxCandidates) {
        this.cooldowns.set(task.id, now + interval(this.deps.intervalMs));
        tally.deferred++;
        continue;
      }
      ghLookups++;

      // Pre-check merged before claiming a lease, so an unmerged PR never
      // churns the completion status / lease. The service re-checks
      // authoritatively, but this avoids touching the vast majority of tasks.
      let facts;
      try {
        facts = await this.deps.ops.fetchPrMergeFacts(prUrl);
      } catch (err) {
        log.warn(
          `reconciler: taskId=${task.id} pr=${prUrl} merged-check threw: ${err instanceof Error ? err.message : String(err)}`
        );
        facts = null;
      }
      if (!facts) {
        this.cooldowns.set(task.id, now + lookupFailedCooldown);
        tally.deferred++;
        continue;
      }
      if (!facts.merged) {
        // Unmerged/blocked PR — NEVER complete (requirement 6). Leave it.
        // The merger is stale (no active turn) yet the PR isn't merged, so the
        // router's dispatch-time `finalizing merge` status is now inaccurate —
        // clear it so the task doesn't badge "Finalizing merge" indefinitely.
        this.clearStaleFinalizingStatus(task);
        this.cooldowns.set(task.id, now + notMergedCooldown);
        tally.notMerged++;
        continue;
      }

      // Merged → drive the deterministic tail via the service (lease-guarded).
      tally.resumed++;
      let result: PostApprovalCompletionResult;
      try {
        result = await this.deps.service.resumeCompletion(task.id, {
          source: 'reconciler',
          approvalSource: task.approvalSource ?? 'agent',
        });
      } catch (err) {
        log.warn(
          `reconciler: taskId=${task.id} resumeCompletion threw: ${err instanceof Error ? err.message : String(err)}`
        );
        this.cooldowns.set(task.id, now + lookupFailedCooldown);
        continue;
      }

      if (result.outcome === 'completed') {
        tally.completed++;
        this.cooldowns.set(task.id, now + completedCooldown);
        // The service already emitted the done task (and any unblocked
        // dependents) via its onTaskUpdated callback — do NOT emit again here,
        // or production would record a duplicate `task_terminal` goal event
        // and a duplicate `space.task.updated`.
      } else if (result.outcome === 'not-merged' || result.outcome === 'identity-mismatch') {
        // State changed under us, or identity check failed — leave approved.
        tally.notMerged++;
        this.cooldowns.set(task.id, now + notMergedCooldown);
      } else {
        // lookup-failed / lease-held / not-eligible — retry next sweep.
        tally.deferred++;
        this.cooldowns.set(task.id, now + lookupFailedCooldown);
      }
    }

    if (tally.resumed > 0 || tally.notMerged > 0) {
      log.info(
        `reconciler.sweep: scanned=${tally.scanned} resumed=${tally.resumed} completed=${tally.completed} notMerged=${tally.notMerged} deferred=${tally.deferred}`
      );
    }
    return tally;
  }

  /**
   * Clear a stale `finalizing merge` status. The router stamps it at merger
   * dispatch; once the reconciler establishes the merger is stale and the PR is
   * NOT merged, no active turn is finalizing anything, so the badge would
   * linger indefinitely on an idle approved task. Only clears the dispatch-time
   * status (never clobbers a service-written `completion recovery`).
   */
  private clearStaleFinalizingStatus(task: SpaceTask): void {
    if (task.postApprovalCompletionStatus !== 'finalizing merge') return;
    try {
      this.deps.taskRepo.updateTask(task.id, { postApprovalCompletionStatus: null });
    } catch (err) {
      log.warn(
        `reconciler: taskId=${task.id} clearStaleFinalizingStatus threw: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    // Publish the refreshed task so connected clients drop the stale banner
    // without a full reload (the web store applies changes only from events).
    if (this.deps.onTaskUpdated) {
      const refreshed = this.deps.taskRepo.getTask(task.id);
      if (refreshed) {
        try {
          this.deps.onTaskUpdated(refreshed);
        } catch (err) {
          log.warn(
            `reconciler: taskId=${task.id} onTaskUpdated threw: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }
}

function interval(ms: number | undefined): number {
  return ms ?? DEFAULT_RECONCILER_INTERVAL_MS;
}
