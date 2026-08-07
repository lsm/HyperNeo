/**
 * PostApprovalCompletionService — deterministic, idempotent post-approval
 * COMPLETION tail (task #868).
 *
 * Once a task's PR is merged, the remaining completion steps (branch cleanup,
 * worktree fetch, Space checkout sync, audit artifact, task → done) are pure
 * deterministic side effects. Historically they lived entirely in the PR
 * Merger LLM agent's prompt; if the merger stalled or died after the merge,
 * the task sat in `approved` forever. This service drives those steps directly
 * from the daemon, recording durable checkpoints so recovery resumes from the
 * first incomplete checkpoint — never re-doing a finished step and never
 * depending on the merger transcript.
 *
 * ## Guarantees
 *
 *   - **Never completes an unmerged/blocked PR.** `merge_confirmed` is the
 *     first checkpoint; if the PR is not `MERGED` the service returns
 *     `not-merged` and leaves the task in `approved`.
 *   - **Idempotent.** A branch already deleted is success; a repeated fetch /
 *     `pull --ff-only` is safe; the result artifact is ensured exactly once;
 *     `approved → done` is guarded by the transition validator.
 *   - **Exactly one completion.** A compare-and-swap lease
 *     (`claimPostApprovalCompletionLease`) ensures concurrent recovery and a
 *     live merger cannot duplicate the tail.
 *   - **Resilient.** Best-effort steps (branch cleanup, sync) record a NON-result
 *     warning artifact on failure and continue — a cleanup failure never strands
 *     an already-merged PR.
 *   - **Identity-checked.** The merged PR is validated against the task's
 *     canonical PR artifact/URL and, when an expected head is recorded, against
 *     that head.
 *
 * ## Checkpoints (ordered)
 *
 *   `merge_confirmed` → `branch_cleanup` → `worktree_fetched` →
 *   `space_synced` → `audit_persisted` → `task_marked_done`
 *
 * Each is persisted to `space_tasks.post_approval_progress` immediately after
 * its side effect, so a crash mid-tail leaves durable state for the next run.
 *
 * The service is invoked by the {@link PostApprovalReconciler} (recovery) and
 * may be invoked by the merger fast-path; both go through the same code path.
 */

import type {
  SpaceTask,
  PostApprovalProgress,
  PostApprovalCheckpointName,
  SpaceApprovalSource,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { PostApprovalCompletionOps, PrMergeFacts } from './post-approval-completion-ops';
import type { MergerLivenessProbe } from './post-approval-reconciler';
import { Logger } from '../../logger';

const log = new Logger('post-approval-completion');

/** Ordered checkpoints; a step runs only once every prior step is done/skipped. */
export const POST_APPROVAL_COMPLETION_CHECKPOINTS: readonly PostApprovalCheckpointName[] = [
  'merge_confirmed',
  'branch_cleanup',
  'worktree_fetched',
  'space_synced',
  'audit_persisted',
  'task_marked_done',
];

/** Default lease TTL: long enough for the git/gh tail, short enough to recover
 *  quickly if the driver itself crashes mid-completion. */
export const DEFAULT_COMPLETION_LEASE_TTL_MS = 2 * 60 * 1000;

/** Stable nodeId/key for the service-written terminal result artifact. */
const COMPLETION_ARTIFACT_NODE_ID = 'post-approval-completion';
const COMPLETION_ARTIFACT_KEY = 'post-approval-merge-result';

export type PostApprovalCompletionOutcome =
  | 'completed'
  | 'not-merged'
  | 'identity-mismatch'
  | 'lookup-failed'
  | 'no-pr-url'
  | 'not-eligible'
  | 'lease-held';

export interface PostApprovalCompletionResult {
  outcome: PostApprovalCompletionOutcome;
  taskId: string;
  prUrl?: string;
  detail?: string;
  /** Final task state, for the caller to emit `space.task.updated`. */
  task?: SpaceTask;
}

export interface PostApprovalCompletionServiceDeps {
  taskRepo: SpaceTaskRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  ops: PostApprovalCompletionOps;
  /** Bound task manager for the task's space. */
  resolveTaskManager: (spaceId: string) => SpaceTaskManager | null;
  /** Resolve the Space checkout path (the worktree future tasks branch from). */
  resolveWorkspacePath?: (spaceId: string) => string | undefined;
  /** Resolve the task's isolated worktree path. */
  resolveWorktreePath?: (spaceId: string, taskId: string) => string | undefined;
  /**
   * Returns true when the task's space is active (not stopped/paused/archived).
   * The service re-checks this AFTER claiming the lease (right before the
   * destructive tail) so a stop that lands during the reconciler's awaited
   * GitHub lookup can never result in side effects against a stopped space.
   * Defaults to true when omitted (tests).
   */
  isSpaceRecoverable?: (spaceId: string) => boolean;
  /**
   * Resolve the targetAgent of the task's dispatched post-approval route
   * (e.g. 'merger'). The completion tail implements MERGE cleanup only — a
   * custom route (publish release, run verification) must NOT be falsely
   * completed just because the workflow's PR merged. Returns undefined when
   * the route can't be resolved (treated as eligible, for back-compat).
   */
  resolvePostApprovalTargetAgent?: (task: SpaceTask) => string | undefined;
  /**
   * Liveness probe to re-check the merger AFTER the service's own awaited gh
   * lookup. If an idle merger (past grace) is reactivated while the lookup is
   * pending, recovery must defer to the now-active turn (its mark_complete
   * doesn't claim this lease). Optional (tests omit).
   */
  mergerLivenessProbe?: MergerLivenessProbe;
  /**
   * Fan out a `space.task.updated` event whenever the service mutates the task —
   * when the in-flight completion status is set/cleared, when the task reaches
   * done, and for each dependent unblocked by the done transition. Wired by the
   * runtime to `safeOnTaskUpdated` (which also runs goal terminal handling), so
   * the service does NOT call `handleTaskTerminal` itself (avoids a double).
   */
  onTaskUpdated?: (task: SpaceTask) => void;
  /** Clock + lease-owner factory (injectable for deterministic tests). */
  now?: () => number;
  generateLeaseOwner?: () => string;
  /** Lease TTL. */
  leaseTtlMs?: number;
}

/**
 * Resolve the canonical PR URL for a task from its workflow-run artifacts.
 * Mirrors the resolution in `SpaceRuntime.dispatchPostApproval`: a `link`
 * kind:'pr' (`data.url`) or a legacy `prUrl`/`pr_url` row, preferring the most
 * recently updated candidate. Extracted here so the completion service and
 * reconciler resolve the same URL the merger was dispatched with.
 */
export function resolveCanonicalPrUrl(
  artifactRepo: WorkflowRunArtifactRepository | undefined,
  workflowRunId: string | null | undefined
): string | undefined {
  if (!artifactRepo || !workflowRunId) return undefined;
  let artifacts;
  try {
    artifacts = artifactRepo.listByRun(workflowRunId);
  } catch {
    return undefined;
  }
  const legacyPrUrl = (data: Record<string, unknown> | undefined): string =>
    (typeof data?.prUrl === 'string' && data.prUrl) ||
    (typeof data?.pr_url === 'string' && data.pr_url) ||
    '';
  let best: { url: string; updatedAt: number } | null = null;
  for (const a of artifacts) {
    const url =
      a.artifactType === 'link' && a.data.kind === 'pr'
        ? typeof a.data.url === 'string'
          ? a.data.url
          : ''
        : legacyPrUrl(a.data);
    if (!url) continue;
    if (!best || a.updatedAt > best.updatedAt) best = { url, updatedAt: a.updatedAt };
  }
  return best?.url;
}

/** Decode a persisted progress blob, or start a fresh one. */
function loadProgress(task: SpaceTask): PostApprovalProgress {
  if (task.postApprovalProgress && task.postApprovalProgress.checkpoints) {
    return {
      ...task.postApprovalProgress,
      checkpoints: { ...task.postApprovalProgress.checkpoints },
    };
  }
  return { checkpoints: {} };
}

function checkpointIsDone(
  progress: PostApprovalProgress,
  name: PostApprovalCheckpointName
): boolean {
  const s = progress.checkpoints[name];
  return !!s && (s.status === 'done' || s.status === 'skipped');
}

function firstIncompleteCheckpoint(
  progress: PostApprovalProgress
): PostApprovalCheckpointName | null {
  for (const c of POST_APPROVAL_COMPLETION_CHECKPOINTS) {
    if (!checkpointIsDone(progress, c)) return c;
  }
  return null;
}

export class PostApprovalCompletionService {
  constructor(private readonly deps: PostApprovalCompletionServiceDeps) {}

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }
  private get leaseOwner(): () => string {
    return this.deps.generateLeaseOwner ?? (() => `completion-${generateUUID()}`);
  }

  /**
   * Drive the deterministic completion tail for an `approved` task, resuming
   * from the first incomplete checkpoint. Idempotent: re-running after a partial
   * failure or a concurrent run is always safe.
   */
  async resumeCompletion(
    taskId: string,
    options: { source: 'merger' | 'reconciler'; approvalSource?: SpaceApprovalSource }
  ): Promise<PostApprovalCompletionResult> {
    const { source } = options;
    const base = { taskId, detail: `source=${source}` };

    let task = this.deps.taskRepo.getTask(taskId);
    if (!task) return { ...base, outcome: 'not-eligible', detail: 'task not found' };
    // A task that already reached `done` (e.g. the merger's mark_complete won
    // the race) is a successful no-op, not an error.
    if (task.status === 'done') return { ...base, outcome: 'completed', task };
    if (task.status !== 'approved') {
      return { ...base, outcome: 'not-eligible', detail: `task status=${task.status}` };
    }

    const prUrl = resolveCanonicalPrUrl(this.deps.artifactRepo, task.workflowRunId);
    if (!prUrl) {
      return { ...base, outcome: 'no-pr-url', detail: 'no canonical PR URL for task' };
    }

    // This completion tail implements MERGE cleanup only. A custom post-approval
    // route (publish release, run verification) must NOT be falsely completed
    // just because the workflow's PR happened to merge. Gate on the dispatched
    // route's targetAgent being the merger; undefined (route unresolvable, e.g.
    // back-compat) is allowed.
    const targetAgent = this.deps.resolvePostApprovalTargetAgent?.(task);
    if (targetAgent !== undefined && targetAgent !== 'merger') {
      return {
        ...base,
        outcome: 'not-eligible',
        detail: `non-merger post-approval route (targetAgent=${targetAgent})`,
      };
    }

    // Claim the lease. If another completion owns it, defer.
    const owner = this.leaseOwner();
    const now = this.now();
    const ttl = this.deps.leaseTtlMs ?? DEFAULT_COMPLETION_LEASE_TTL_MS;
    const claimed = this.deps.taskRepo.claimPostApprovalCompletionLease(taskId, owner, now, ttl);
    if (!claimed) {
      return { ...base, outcome: 'lease-held', prUrl };
    }

    // Recheck the space lifecycle AFTER claiming the lease (right before the
    // tail): the reconciler's pre-lookup check can race a stop/pause/archive
    // during the awaited `gh pr view`. The service owns the destructive steps,
    // so it makes the authoritative call — never run side effects against a
    // stopped/paused/archived space.
    if (this.deps.isSpaceRecoverable && !this.deps.isSpaceRecoverable(task.spaceId)) {
      this.deps.taskRepo.releasePostApprovalCompletionLease(taskId, owner, this.now());
      return {
        ...base,
        outcome: 'not-eligible',
        detail: 'space is stopped/paused/archived',
      };
    }

    const completionStatus = source === 'reconciler' ? 'completion recovery' : 'finalizing merge';
    try {
      return await this.driveTail(task, prUrl, {
        source,
        completionStatus,
        owner,
        approvalSource: options.approvalSource,
      });
    } finally {
      // Always release our lease when the drive returns (success or not). An
      // aborted drive leaves the lease to self-expire if this finally itself
      // throws, but the normal path releases immediately so the next sweep
      // can re-claim if the outcome was retryable.
      this.deps.taskRepo.releasePostApprovalCompletionLease(taskId, owner, this.now());
    }
  }

  /** Inner tail driver; runs after the lease is claimed. */
  private async driveTail(
    initialTask: SpaceTask,
    prUrl: string,
    ctx: {
      source: 'merger' | 'reconciler';
      completionStatus: 'finalizing merge' | 'completion recovery';
      owner: string;
      approvalSource?: SpaceApprovalSource;
    }
  ): Promise<PostApprovalCompletionResult> {
    const taskId = initialTask.id;
    const base = { taskId, prUrl };

    let progress = loadProgress(initialTask);
    progress.source = ctx.source;
    // If the canonical PR changed since a prior partial run (e.g. the artifact
    // was corrected from PR A to PR B), invalidate the old checkpoints — a
    // stale `merge_confirmed` for PR A must not let us skip the lookup and
    // complete PR B (which may still be OPEN). Reset to a fresh tail.
    if (progress.prUrl && progress.prUrl !== prUrl) {
      log.info(
        `post-approval.completion: taskId=${taskId} canonical PR changed (${progress.prUrl} → ${prUrl}); resetting checkpoints`
      );
      progress = { checkpoints: {} };
    }
    progress.prUrl = prUrl;
    // NOTE: completionStatus is only surfaced AFTER the PR is confirmed merged
    // (below). Setting it earlier would flap the UI badge on every not-merged
    // sweep for a task whose merger is legitimately still working.

    let facts: PrMergeFacts | undefined;

    // -- checkpoint: merge_confirmed -------------------------------------
    if (!checkpointIsDone(progress, 'merge_confirmed')) {
      const fetched = await this.deps.ops.fetchPrMergeFacts(prUrl);
      // TOCTOU: the reconciler sampled merger liveness before ITS gh lookup,
      // and this is a second awaited lookup. If an idle merger reactivated
      // during the await, defer to the now-active turn (its mark_complete
      // doesn't claim this lease, so the lease can't serialize a race).
      const sessionId = initialTask.postApprovalSessionId;
      if (sessionId && this.deps.mergerLivenessProbe?.isSessionActivelyProcessing(sessionId)) {
        log.info(
          `post-approval.completion: taskId=${taskId} merger reactivated during lookup; deferring`
        );
        this.clearCompletionStatus(taskId, progress, ctx.owner);
        return {
          ...base,
          outcome: 'not-eligible',
          detail: 'merger became active during lookup',
        };
      }
      if (!fetched) {
        log.warn(
          `post-approval.completion: taskId=${taskId} gh lookup failed for ${prUrl}; deferring`
        );
        return { ...base, outcome: 'lookup-failed', detail: 'gh pr view lookup failed' };
      }
      if (!fetched.merged) {
        // NEVER complete an unmerged/blocked PR (requirement 6). Leave the
        // task in `approved`; the merger (or a re-dispatch) still owns the merge.
        log.info(
          `post-approval.completion: taskId=${taskId} PR ${prUrl} state=${fetched.state}; not merged — leaving approved`
        );
        this.clearCompletionStatus(taskId, progress, ctx.owner);
        return { ...base, outcome: 'not-merged', detail: `PR state=${fetched.state}` };
      }
      // Merge identity is established by the canonical PR URL (we query GitHub
      // for the EXACT task PR resolved from artifacts) plus the merger's
      // `--match-head-commit` at merge time. We deliberately do NOT compare
      // against historical artifact headRefOid values: a `merge_blocked`
      // artifact records the head at the time of a PRIOR failed attempt (H1),
      // but the workflow lets the coder push a new approved head (H2) before the
      // successful merge — so a stale H1 would permanently false-positive as an
      // identity mismatch. `progress.expectedHeadOid` (set below from the live
      // merge facts on the first confirmation) is immutable for a merged PR, so
      // a resume re-query always matches itself.
      progress.mergedAt = this.now();
      progress.mergeCommit = fetched.mergeCommit;
      progress.baseBranch = fetched.baseRefName;
      progress.headRefName = fetched.headRefName;
      progress.isCrossRepository = fetched.isCrossRepository;
      if (fetched.headRefOid) progress.expectedHeadOid = fetched.headRefOid;
      progress.checkpoints.merge_confirmed = { status: 'done', at: this.now() };
      this.persistProgress(taskId, progress, ctx.completionStatus, ctx.owner);
      facts = fetched;
    }
    // After the merge_confirmed block, recover facts either from this run or
    // from the persisted progress of a prior run (resume case).
    const effectiveFacts: Partial<PrMergeFacts> | undefined =
      facts ?? this.recallFactsFromProgress(progress);
    const baseBranch = effectiveFacts?.baseRefName ?? progress.baseBranch;

    // The PR is confirmed merged (this run just confirmed it, or a prior run
    // did and we are resuming). NOW surface the finalizing/recovery status.
    progress.completionStatus = ctx.completionStatus;
    this.persistProgress(taskId, progress, ctx.completionStatus, ctx.owner);

    // -- checkpoint: branch_cleanup -------------------------------------
    if (!checkpointIsDone(progress, 'branch_cleanup')) {
      {
        const abort = this.reassertBeforeDestructive(
          taskId,
          ctx.owner,
          initialTask.spaceId,
          base,
          progress,
          'branch_cleanup'
        );
        if (abort) return abort;
      }
      if (effectiveFacts?.isCrossRepository) {
        progress.checkpoints.branch_cleanup = {
          status: 'skipped',
          at: this.now(),
          detail: 'cross-repository (fork) PR; branch kept in fork',
        };
      } else if (effectiveFacts?.headRefName) {
        const del = await this.deps.ops.deleteRemoteBranch({
          prUrl,
          headRefName: effectiveFacts.headRefName,
          workspacePath: this.deps.resolveWorkspacePath?.(initialTask.spaceId),
        });
        if (del.ok) {
          progress.checkpoints.branch_cleanup = {
            status: 'done',
            at: this.now(),
            detail: del.alreadyGone ? `${del.detail} (already absent)` : del.detail,
          };
        } else {
          // Best-effort: record a NON-result warning and continue. The PR is
          // already merged; a cleanup failure must NOT block completion.
          this.recordWarningArtifact(initialTask, {
            kind: 'cleanup_warning',
            operation: 'branch_cleanup',
            summary: `Branch cleanup failed: ${del.detail}`,
            data: { pr_url: prUrl, head_ref: effectiveFacts.headRefName },
          });
          progress.checkpoints.branch_cleanup = {
            status: 'skipped',
            at: this.now(),
            detail: `cleanup failed (warning recorded): ${del.detail}`,
          };
        }
      } else {
        progress.checkpoints.branch_cleanup = {
          status: 'skipped',
          at: this.now(),
          detail: 'no head branch name available',
        };
      }
      this.persistProgress(taskId, progress, ctx.completionStatus, ctx.owner);
    }

    // -- checkpoint: worktree_fetched -----------------------------------
    if (!checkpointIsDone(progress, 'worktree_fetched') && baseBranch) {
      {
        const abort = this.reassertBeforeDestructive(
          taskId,
          ctx.owner,
          initialTask.spaceId,
          base,
          progress,
          'worktree_fetched'
        );
        if (abort) return abort;
      }
      const res = await this.deps.ops.fetchWorktree({
        worktreePath: this.deps.resolveWorktreePath?.(initialTask.spaceId, taskId),
        baseBranch,
      });
      progress.checkpoints.worktree_fetched = {
        status: 'done',
        at: this.now(),
        detail: res.ok ? res.detail : `warning: ${res.detail}`,
      };
      if (!res.ok) {
        this.recordWarningArtifact(initialTask, {
          kind: 'cleanup_warning',
          operation: 'worktree_fetched',
          summary: `Worktree fetch warning: ${res.detail}`,
          data: { pr_url: prUrl, base_branch: baseBranch },
        });
      }
      this.persistProgress(taskId, progress, ctx.completionStatus, ctx.owner);
    }

    // -- checkpoint: space_synced ---------------------------------------
    if (!checkpointIsDone(progress, 'space_synced') && baseBranch) {
      {
        const abort = this.reassertBeforeDestructive(
          taskId,
          ctx.owner,
          initialTask.spaceId,
          base,
          progress,
          'space_synced'
        );
        if (abort) return abort;
      }
      const res = await this.deps.ops.syncSpaceCheckout({
        workspacePath: this.deps.resolveWorkspacePath?.(initialTask.spaceId),
        baseBranch,
      });
      progress.checkpoints.space_synced = {
        status: 'done',
        at: this.now(),
        detail: res.ok ? res.detail : `warning: ${res.detail}`,
      };
      if (!res.ok) {
        this.recordWarningArtifact(initialTask, {
          kind: 'cleanup_warning',
          operation: 'space_synced',
          summary: `Space checkout sync warning: ${res.detail}`,
          data: { pr_url: prUrl, base_branch: baseBranch },
        });
      }
      this.persistProgress(taskId, progress, ctx.completionStatus, ctx.owner);
    }

    // -- checkpoint: audit_persisted ------------------------------------
    if (!checkpointIsDone(progress, 'audit_persisted')) {
      // Only record the checkpoint once the artifact is confirmed written —
      // otherwise a transient DB error would be absorbed, the task would
      // transition to done (clearing progress), and the terminal result
      // artifact would be permanently lost (resumeCompletion short-circuits
      // for done tasks and the reconciler only scans approved).
      const auditOk = this.ensureResultArtifact(initialTask, prUrl, ctx.approvalSource);
      if (!auditOk) {
        log.warn(
          `post-approval.completion: taskId=${taskId} audit artifact write failed; deferring`
        );
        return { ...base, outcome: 'lookup-failed', detail: 'audit artifact write failed' };
      }
      progress.checkpoints.audit_persisted = { status: 'done', at: this.now() };
      this.persistProgress(taskId, progress, ctx.completionStatus, ctx.owner);
    }

    // -- checkpoint: task_marked_done -----------------------------------
    if (!checkpointIsDone(progress, 'task_marked_done')) {
      // P1 race guard: an explicit user action (reopen → in_progress, or
      // cancel) can land during the awaited GitHub/git steps above. Both
      // `in_progress → done` and `cancelled → done` are valid transitions, so
      // the validator would NOT reject them — revalidate that the task is
      // STILL `approved` and that THIS invocation still owns the lease right
      // before the terminal write, and abort otherwise (never overwrite an
      // explicit user action). The lease may also have self-expired (long tail)
      // and been re-claimed by another owner.
      const pre = this.deps.taskRepo.getTask(taskId);
      const leaseExpiredOrLost =
        pre?.postApprovalCompletionLeaseOwner !== ctx.owner ||
        (pre?.postApprovalCompletionLeaseExpiresAt ?? 0) < this.now();
      // Also recheck the space lifecycle: a stop/pause/archive can land during
      // the awaited syncSpaceCheckout (the last destructive step), and the
      // lease/status checks above don't cover it. Never transition to done
      // after an explicit lifecycle stop.
      const spaceStopped =
        !!this.deps.isSpaceRecoverable && !this.deps.isSpaceRecoverable(initialTask.spaceId);
      if (!pre || pre.status !== 'approved' || leaseExpiredOrLost || spaceStopped) {
        log.info(
          `post-approval.completion: taskId=${taskId} aborted before done (status=${pre?.status}, leaseOwner=${pre?.postApprovalCompletionLeaseOwner}, expired=${leaseExpiredOrLost}, spaceStopped=${spaceStopped})`
        );
        if (spaceStopped) this.clearCompletionStatus(taskId, progress, ctx.owner);
        return {
          ...base,
          outcome: 'not-eligible',
          detail: `task changed, lease lost, or space stopped before terminal (status=${pre?.status})`,
        };
      }
      const result = this.composeResultSummary(initialTask, prUrl);
      const taskManager = this.deps.resolveTaskManager(initialTask.spaceId);
      if (!taskManager) {
        log.warn(`post-approval.completion: taskId=${taskId} no task manager; deferring`);
        return { ...base, outcome: 'lookup-failed', detail: 'task manager unavailable' };
      }
      try {
        // setTaskStatus runs the transition validator + the "exit approved"
        // cleanup (nulls post-approval-* fields including our progress/lease).
        // Pass onCascadedTasks so dependents unblocked by this done transition
        // get a `space.task.updated` event (mirrors the mark_complete path).
        await taskManager.setTaskStatus(taskId, 'done', {
          approvalSource: ctx.approvalSource ?? initialTask.approvalSource ?? 'agent',
          result,
          onCascadedTasks: async (cascadedTasks) => {
            for (const cascadedTask of cascadedTasks) this.deps.onTaskUpdated?.(cascadedTask);
          },
        });
      } catch (err) {
        // A concurrent done (e.g. the merger's mark_complete won the race)
        // surfaces here as an illegal `done → done` transition — treat as success.
        const rechecked = this.deps.taskRepo.getTask(taskId);
        if (rechecked?.status === 'done') {
          log.info(`post-approval.completion: taskId=${taskId} already done (concurrent)`);
          return { ...base, outcome: 'completed', task: rechecked };
        }
        // Genuine failure: leave checkpoints intact so the next sweep retries
        // from task_marked_done. Do NOT record the checkpoint.
        log.warn(
          `post-approval.completion: taskId=${taskId} mark_done failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return {
          ...base,
          outcome: 'lookup-failed',
          detail: `mark_done failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // The "exit approved" branch in setTaskStatus nulled the progress blob
      // (and the task_marked_done checkpoint is moot once done), so we do not
      // persist a final checkpoint here. Forge evidence capture and goal
      // terminal handling are BOTH done by setTaskStatus / the onTaskUpdated
      // emit below (the runtime's safeOnTaskUpdated calls handleTaskTerminal;
      // setTaskStatus itself calls captureCompletedTaskEvidence) — NOT here, to
      // avoid duplicating either.
      const postDone = this.deps.taskRepo.getTask(taskId);
      if (postDone) {
        // Fan out the done state (and let the runtime's handler do goal
        // terminal handling + publish `space.task.updated`).
        this.emitTaskUpdated(taskId);
      }
      log.info(
        `post-approval.completion: spaceId=${initialTask.spaceId} taskId=${taskId} outcome=done source=${ctx.source} prUrl=${prUrl}`
      );
      return { ...base, outcome: 'completed', task: postDone ?? undefined };
    }

    // Every checkpoint already done — completion is finished.
    const refreshed = this.deps.taskRepo.getTask(taskId);
    if (refreshed?.status === 'done')
      return { ...base, outcome: 'completed', task: refreshed ?? undefined };
    // Checkpoints complete but task not done (e.g. cleared) — fall through to retry.
    return { ...base, outcome: 'completed', task: refreshed ?? undefined };
  }

  // ---- helpers -----------------------------------------------------------

  /**
   * Write progress + the surfaced status, but ONLY if the task is still
   * `approved` and THIS invocation still owns the lease. A cancel / reopen /
   * archive during an awaited op calls `setTaskStatus`, which clears the
   * completion fields and flips status — writing the in-memory (stale) progress
   * back afterward would resurrect `merge_confirmed` etc., letting a later
   * reapproval skip a fresh merge lookup. Returns true if written.
   */
  private persistProgress(
    taskId: string,
    progress: PostApprovalProgress,
    completionStatus: 'finalizing merge' | 'completion recovery',
    owner: string
  ): boolean {
    if (!this.ownsApprovedLease(taskId, owner)) return false;
    progress.completionStatus = completionStatus;
    this.deps.taskRepo.updateTask(taskId, {
      postApprovalProgress: progress,
      postApprovalCompletionStatus: completionStatus,
    });
    // Push the in-flight status to live clients so the task is not silently
    // idling in `approved` (the web store only learns of changes from events).
    this.emitTaskUpdated(taskId);
    return true;
  }

  /** Clear the surfaced completion status (e.g. PR not merged → leave approved
   *  without an "in progress" badge). Also guarded on lease ownership so a
   *  concurrent status change isn't clobbered. Returns true if written. */
  private clearCompletionStatus(
    taskId: string,
    progress: PostApprovalProgress,
    owner: string
  ): boolean {
    if (!this.ownsApprovedLease(taskId, owner)) return false;
    progress.completionStatus = undefined;
    this.deps.taskRepo.updateTask(taskId, {
      postApprovalProgress: progress,
      postApprovalCompletionStatus: null,
    });
    this.emitTaskUpdated(taskId);
    return true;
  }

  /** True when the task is still `approved` and this invocation still owns its
   *  completion lease (owner matches). Used to gate progress writes against a
   *  concurrent cancel/reopen/archive or a reclaimed lease. */
  private ownsApprovedLease(taskId: string, owner: string): boolean {
    const task = this.deps.taskRepo.getTask(taskId);
    return !!task && task.status === 'approved' && task.postApprovalCompletionLeaseOwner === owner;
  }

  /** Re-read the task and fan out a `space.task.updated` event if wired. */
  private emitTaskUpdated(taskId: string): void {
    if (!this.deps.onTaskUpdated) return;
    const task = this.deps.taskRepo.getTask(taskId);
    if (task) {
      try {
        this.deps.onTaskUpdated(task);
      } catch (err) {
        log.warn(
          `post-approval.completion: taskId=${taskId} onTaskUpdated threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Heartbeat: renew the lease so a legitimately long tail (each git/gh step
   * can take up to the 30s command timeout; branch delete + worktree fetch +
   * checkout sync can cumulatively exceed the lease TTL) does not expire before
   * the final done transition. Returns true when we still own the lease and the
   * task is still `approved`; returns false (caller must abort the tail) when
   * ownership was lost — the lease self-expired and was re-claimed, or an
   * explicit user action moved the task out of `approved`.
   */
  private renewLease(taskId: string, owner: string): boolean {
    const ttl = this.deps.leaseTtlMs ?? DEFAULT_COMPLETION_LEASE_TTL_MS;
    return this.deps.taskRepo.renewPostApprovalCompletionLease(taskId, owner, this.now(), ttl);
  }

  /** Build the not-eligible result for a lost/expired lease mid-tail. Preserves
   *  the persisted checkpoints (so a later sweep resumes) and clears the
   *  surfaced status. */
  private leaseLost(
    taskId: string,
    base: { taskId: string; prUrl: string },
    progress: PostApprovalProgress,
    where: string,
    owner: string
  ): PostApprovalCompletionResult {
    log.info(
      `post-approval.completion: taskId=${taskId} lease lost/expired before ${where}; aborting tail`
    );
    this.clearCompletionStatus(taskId, progress, owner);
    return {
      ...base,
      outcome: 'not-eligible',
      detail: `lease lost before ${where}`,
    };
  }

  /**
   * Pre-destructive-step guard: renew the lease (heartbeat) AND recheck the
   * space lifecycle. Returns a not-eligible result to abort the tail (caller
   * returns it) when the lease was lost/expired OR the space was
   * stopped/paused/archived during a prior await (e.g. the ~30s `gh pr view`),
   * otherwise null to continue. The space recheck is needed on EVERY awaited
   * boundary because a stop can land between checks; renewLease alone only
   * verifies owner + `approved` status, not the lifecycle.
   */
  private reassertBeforeDestructive(
    taskId: string,
    owner: string,
    spaceId: string,
    base: { taskId: string; prUrl: string },
    progress: PostApprovalProgress,
    where: string
  ): PostApprovalCompletionResult | null {
    if (!this.renewLease(taskId, owner)) {
      return this.leaseLost(taskId, base, progress, where, owner);
    }
    if (this.deps.isSpaceRecoverable && !this.deps.isSpaceRecoverable(spaceId)) {
      log.info(
        `post-approval.completion: taskId=${taskId} space ${spaceId} stopped/paused/archived before ${where}; aborting tail`
      );
      this.clearCompletionStatus(taskId, progress, owner);
      return {
        ...base,
        outcome: 'not-eligible',
        detail: `space stopped before ${where}`,
      };
    }
    return null;
  }

  /** Reconstruct merge facts from a prior run's progress (when merge_confirmed
   *  was already recorded in an earlier invocation). */
  private recallFactsFromProgress(
    progress: PostApprovalProgress
  ): Partial<PrMergeFacts> | undefined {
    const mergeConfirmed = progress.checkpoints.merge_confirmed;
    if (!mergeConfirmed) return undefined;
    return {
      mergeCommit: progress.mergeCommit,
      baseRefName: progress.baseBranch,
      headRefOid: progress.expectedHeadOid,
      headRefName: progress.headRefName,
      isCrossRepository: progress.isCrossRepository,
    };
  }

  /**
   * Upsert the terminal result artifact on a STABLE key so it is exactly one
   * row per completion AND is refreshed when a done task is reopened and later
   * merges another PR (a prior completion's stale summary must not survive).
   * Returns false when the write could not be confirmed (no repo/run, or the
   * upsert threw) so the caller leaves the `audit_persisted` checkpoint unset
   * and retries on the next sweep — never silently losing the audit.
   *
   * NB: when the merger also wrote its own `result` decision under a different
   * key, two kindless decision rows can coexist; `composeResultSummary` picks
   * the most recent, so this refreshed stable row is authoritative.
   */
  private ensureResultArtifact(
    task: SpaceTask,
    prUrl: string,
    approvalSource?: SpaceApprovalSource
  ): boolean {
    if (!this.deps.artifactRepo || !task.workflowRunId) return true;
    const mergedAt = this.now();
    const summary = `Merged PR ${prUrl}`;
    try {
      this.deps.artifactRepo.upsert({
        id: generateUUID(),
        runId: task.workflowRunId,
        nodeId: COMPLETION_ARTIFACT_NODE_ID,
        artifactType: 'decision',
        artifactKey: COMPLETION_ARTIFACT_KEY,
        data: {
          summary,
          merged_pr_url: prUrl,
          merged_at: mergedAt,
          approval_source: approvalSource ?? task.approvalSource ?? 'agent',
        },
      });
      return true;
    } catch (err) {
      log.warn(
        `post-approval.completion: taskId=${task.id} result artifact upsert failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /** Compose the task `result` summary: prefer an existing terminal result
   *  artifact, else a generated one. Mirrors mark_complete's resolution. */
  private composeResultSummary(task: SpaceTask, prUrl: string): string {
    if (this.deps.artifactRepo && task.workflowRunId) {
      try {
        const decisions = this.deps.artifactRepo.listByRun(task.workflowRunId, {
          artifactType: 'decision',
        });
        const artifact = decisions
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => {
            const s = item.data?.summary;
            return !item.data?.kind && typeof s === 'string' && s.trim().length > 0;
          })
          .toSorted(
            (a, b) =>
              b.item.updatedAt - a.item.updatedAt ||
              b.item.createdAt - a.item.createdAt ||
              b.index - a.index
          )[0]?.item;
        const summary = artifact ? (artifact.data.summary as string) : '';
        if (summary.trim().length > 0) return summary;
      } catch {
        // fall through to generated summary
      }
    }
    return task.reportedSummary?.trim() || task.result?.trim() || `Merged PR ${prUrl}`;
  }

  /** Record a NON-result warning artifact (cleanup warnings). NEVER a terminal
   *  `decision` without kind — that would be picked up as the task result.
   *  `operation` is folded into the artifact key so warnings from different
   *  cleanup steps (branch / worktree / sync) persist independently instead of
   *  overwriting each other. */
  private recordWarningArtifact(
    task: SpaceTask,
    payload: {
      kind: string;
      operation: string;
      summary: string;
      data: Record<string, unknown>;
    }
  ): void {
    if (!this.deps.artifactRepo || !task.workflowRunId) return;
    try {
      this.deps.artifactRepo.upsert({
        id: generateUUID(),
        runId: task.workflowRunId,
        nodeId: COMPLETION_ARTIFACT_NODE_ID,
        artifactType: 'note',
        artifactKey: `post-approval-warning-${payload.operation}`,
        data: {
          kind: payload.kind,
          operation: payload.operation,
          summary: payload.summary,
          ...payload.data,
        },
      });
    } catch (err) {
      log.warn(
        `post-approval.completion: taskId=${task.id} warning artifact failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Test/diagnostic helper: the first checkpoint not yet done/skipped. */
  firstIncomplete(task: SpaceTask): PostApprovalCheckpointName | null {
    return firstIncompleteCheckpoint(loadProgress(task));
  }
}
