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
/** Grace window after dispatch before a still-alive merger is considered stale. */
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
  /** Fan out a `space.task.updated` event after a completion (so the UI refreshes). */
  onTaskCompleted?: (task: SpaceTask) => void;
  now?: () => number;
  intervalMs?: number;
  notMergedCooldownMs?: number;
  lookupFailedCooldownMs?: number;
  completedCooldownMs?: number;
  noPrUrlCooldownMs?: number;
}

export interface ReconcilerSweepResult {
  scanned: number;
  resumed: number;
  completed: number;
  notMerged: number;
  deferred: number;
}

export class PostApprovalReconciler {
  private readonly cooldowns = new Map<string, number>();
  private lastSweepAt = 0;
  private sweepInFlight = false;

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

    const tasks = this.deps.taskRepo.listApprovedTasks();
    const tally = { scanned: tasks.length, resumed: 0, completed: 0, notMerged: 0, deferred: 0 };

    for (const task of tasks) {
      const cooldownUntil = this.cooldowns.get(task.id);
      if (cooldownUntil !== undefined && cooldownUntil > now) {
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
        if (result.task) {
          try {
            this.deps.onTaskCompleted?.(result.task);
          } catch (err) {
            log.warn(
              `reconciler: taskId=${task.id} onTaskCompleted threw: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
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
}

function interval(ms: number | undefined): number {
  return ms ?? DEFAULT_RECONCILER_INTERVAL_MS;
}
