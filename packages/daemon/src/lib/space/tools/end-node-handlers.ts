/**
 * End-node tool handlers.
 *
 * Factory for the two "terminal" MCP tool handlers exposed to end-node agents:
 *   - approve_task        — Agent self-close. Gated by space.autonomyLevel >=
 *                           workflow.completionAutonomyLevel.
 *   - submit_for_approval — Request human sign-off. Always available.
 *
 * These were previously inline closures inside
 * `SpaceTaskAgentManager.buildNodeAgentMcpServer`. Extracting them here lets
 * them be unit-tested directly (see `end-node-handlers.test.ts`) and keeps the
 * manager focused on orchestration.
 *
 * Contract notes:
 *   - Both handlers return a `ToolResult` (never throw).
 *   - `onApproveTask` re-checks autonomy at call time as defense-in-depth;
 *     tool registration already gates the surface, but a racing autonomy-level
 *     downgrade between registration and invocation would otherwise slip
 *     through.
 *   - `onSubmitForApproval` sets `status='review'` plus pending-completion
 *     fields so the UI banner can route a human to approve/reject.
 */

import type { SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import { Logger } from '../../logger';
import { pickCanonicalRunTask } from '../runtime/space-runtime';
import { collectDispatchablePostApprovalRoutes } from '../runtime/post-approval-router';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceGoalService } from '../goals/goal-service';
import type {
  ApproveTaskInput,
  CompleteValidationTaskInput,
  MarkCompleteInput,
  SubmitForApprovalInput,
} from './task-agent-tool-schemas';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';
import { normalizeMeaningfulTaskResult } from '../task-result-utils';

const log = new Logger('end-node-handlers');

/**
 * Dependencies for building end-node handlers. All fields are required EXCEPT
 * `internalEventBus` — when absent the handlers still succeed, they just do not emit
 * lifecycle events (used in unit tests).
 */
export interface EndNodeHandlerDeps {
  /** Task being finalized. */
  taskId: string;
  /** Space the task belongs to. Needed for autonomy lookup + event payloads. */
  spaceId: string;
  /** Workflow the task was executed under. Needed for completionAutonomyLevel. */
  workflow: SpaceWorkflow | null;
  /** Workflow node ID of the calling agent — stored for pending fields. */
  workflowNodeId: string;
  /** Agent name calling the tool — for logging. */
  agentName: string;
  /** Task repository. */
  taskRepo: SpaceTaskRepository;
  /**
   * Task manager bound to `spaceId`. Used by `submit_for_approval` so the
   * agent path and the UI "Submit for Review" RPC share `submitTaskForReview`,
   * which runs the centralised transition validator before stamping the
   * pending-completion fields.
   */
  taskManager: Pick<SpaceTaskManager, 'submitTaskForReview'>;
  /** Space manager — used to look up current autonomy level for approve_task. */
  spaceManager: Pick<SpaceManager, 'getSpace'>;
  /** Optional hub for emitting `space.task.updated` events after state changes. */
  internalEventBus?: Pick<InternalEventBus<DaemonInternalEventMap>, 'publish'>;
}

export interface EndNodeHandlers {
  onApproveTask: (args: ApproveTaskInput) => Promise<ToolResult>;
  onSubmitForApproval: (args: SubmitForApprovalInput) => Promise<ToolResult>;
}

/**
 * Standalone factory for the `mark_complete` handler (PR 2/5). Separate from
 * `createEndNodeHandlers` because `mark_complete` is mirrored onto
 * post-approval sub-sessions — which are NOT necessarily end-node sessions —
 * and also onto the orchestration Task Agent's MCP surface directly.
 *
 * Transitions the task `approved → done` via `SpaceTaskManager.setTaskStatus`
 * (so the centralised transition validator runs), clears the post-approval
 * tracking fields, and emits a `space.task.updated` InternalEventBus<DaemonInternalEventMap> event.
 */
export interface MarkCompleteHandlerDeps {
  taskId: string;
  spaceId: string;
  /** Task repository — used to read the current status before transitioning. */
  taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
  /** Optional summary captured from the latest result artifact for this task's workflow run. */
  resolveResultArtifactSummary?: (task: SpaceTask) => string | null;
  /** Session invoking mark_complete; must match the routed post-approval session. */
  callerSessionId?: string;
  /** Whether this workflow declares a dispatchable post-approval route. */
  requiresPostApprovalOwner?: boolean;
  /** Task manager — used to transition and update the task atomically. */
  taskManager: Pick<SpaceTaskManager, 'setTaskStatus' | 'updateTask'>;
  /** Optional hub for emitting `space.task.updated` events. */
  internalEventBus?: Pick<InternalEventBus<DaemonInternalEventMap>, 'publish'>;
  /** Optional goal service for processing terminal goal-task side effects. */
  goalService?: Pick<SpaceGoalService, 'getGoal' | 'updateGoal' | 'handleTaskTerminal'>;
  /**
   * Optional merge-completion gate. When provided, `mark_complete` fails closed
   * until GitHub reports the task's PR merged (the coder owns the merge — there
   * is no `merge_pr` gate anymore). The gate decides whether a missing `pr_url`
   * passes for non-PR workflows or blocks for workflows that require a PR. The
   * task stays `approved` on a block and the caller may retry after the merge.
   */
  assertPrMerged?: (task: SpaceTask) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Dependencies for the merge-completion gate factory.
 */
export interface PrMergedGateDeps {
  /** Resolve the task's PR URL (e.g. via the workflow run's primary link). */
  resolvePrUrl: (task: SpaceTask) => string;
  /** Block when no PR URL resolves. Use for workflows whose completion requires a PR. */
  requirePrUrl?: boolean;
  /** Query GitHub for the PR's state. Throws on lookup failure (fail closed). */
  getPrState: (prUrl: string) => Promise<string>;
}

/**
 * Merge-completion gate factory. Returns a `mark_complete` gate that fails
 * closed until GitHub reports the task's PR MERGED. Mirrors the `pr_merged`
 * validator's semantics (`state == MERGED` passes; `OPEN` is a retryable
 * "not yet merged" block; anything else — CLOSED-without-merge or lookup
 * failure — is a terminal block). The task stays `approved` on a block so the
 * implementer can merge and retry.
 */
export function createPrMergedGate(
  deps: PrMergedGateDeps
): (task: SpaceTask) => Promise<{ ok: true } | { ok: false; error: string }> {
  const { resolvePrUrl, requirePrUrl = false, getPrState } = deps;
  return async (task) => {
    const prUrl = resolvePrUrl(task);
    if (!prUrl) {
      return requirePrUrl
        ? {
            ok: false,
            error:
              "mark_complete merge gate: could not resolve the run's PR URL. " +
              'The task stays approved until a PR link is available and its merge is confirmed.',
          }
        : { ok: true };
    }

    let state: string;
    try {
      state = await getPrState(prUrl);
    } catch (err) {
      return {
        ok: false,
        error:
          `mark_complete merge gate: could not verify the run's PR state for ${prUrl} ` +
          `(${err instanceof Error ? err.message : String(err)}). The task stays approved until the PR is confirmed merged.`,
      };
    }

    if (state === 'MERGED') return { ok: true };
    if (state === 'OPEN') {
      return {
        ok: false,
        error:
          `mark_complete merge gate: the run's PR is still OPEN (${prUrl}). ` +
          `Merge it before calling mark_complete (gh pr merge), then retry.`,
      };
    }
    return {
      ok: false,
      error:
        `mark_complete merge gate: the run's PR is ${state} (${prUrl}), not merged. ` +
        `The task stays approved; resolve the PR before calling mark_complete.`,
    };
  };
}

/**
 * Create a bound `mark_complete` handler. See the type-level doc on the
 * `mark_complete` tool registration in `task-agent-tools.ts` /
 * `node-agent-tools.ts` for the wider contract.
 */
export function createMarkCompleteHandler(
  deps: MarkCompleteHandlerDeps
): (args: MarkCompleteInput) => Promise<ToolResult> {
  const {
    taskId,
    spaceId,
    taskRepo,
    taskManager,
    internalEventBus,
    goalService,
    resolveResultArtifactSummary,
    callerSessionId,
    requiresPostApprovalOwner = false,
    assertPrMerged,
  } = deps;

  const handleGoalTerminal = (task: SpaceTask): void => {
    if (!goalService) return;
    try {
      goalService.handleTaskTerminal(task.id);
    } catch (err) {
      log.warn(
        `Goal terminal handling threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const emitTaskUpdated = (task: SpaceTask): void => {
    if (!internalEventBus) return;
    void internalEventBus
      .publish('space.task.updated', { sessionId: 'global', spaceId, taskId: task.id, task })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  };

  return async (args: MarkCompleteInput): Promise<ToolResult> => {
    const task = taskRepo.getTask(taskId);
    if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

    if (task.status !== 'approved') {
      return jsonResult({
        success: false,
        error:
          `task is not in \`approved\` status (current: \`${task.status}\`); did you mean \`approve_task\`? ` +
          `mark_complete only transitions an already-approved task from 'approved' to 'done'.`,
      });
    }

    if (requiresPostApprovalOwner && !task.postApprovalSessionId) {
      return jsonResult({
        success: false,
        error:
          'mark_complete is blocked until the routed post-approval session is recorded on the task.',
      });
    }
    if (
      task.postApprovalSessionId &&
      (!callerSessionId || task.postApprovalSessionId !== callerSessionId)
    ) {
      return jsonResult({
        success: false,
        error: `mark_complete is restricted to the routed post-approval session ${task.postApprovalSessionId}.`,
      });
    }

    // Merge-completion gate: the coder owns the merge in the stable coding /
    // research workflows, so the task must NOT flip to `done` while the run's
    // PR is still open — otherwise a coder that abandons a conflicted merge or
    // mistakes a merge-queue enqueue for completion would close the task with
    // the PR unmerged. Fails closed until GitHub reports the PR MERGED. The
    // closure resolves the pr_url itself and skips non-PR runs, so a bare
    // `approved → done` (no PR) is unaffected.
    if (assertPrMerged) {
      const gate = await assertPrMerged(task);
      if (!gate.ok) {
        return jsonResult({ success: false, error: gate.error });
      }
    }

    let goalUpdate: {
      goalId: string;
      updates: NonNullable<MarkCompleteInput['goal_update']>;
    } | null = null;
    if (args.goal_update) {
      if (!goalService) {
        return jsonResult({
          success: false,
          error: 'Goal update is not available in this context.',
        });
      }
      if (!task.goalId) {
        return jsonResult({
          success: false,
          error: 'Cannot apply goal_update: this task is not linked to a goal.',
        });
      }
      const goal = goalService.getGoal(task.goalId);
      if (!goal || goal.spaceId !== task.spaceId) {
        return jsonResult({ success: false, error: `Goal not found: ${task.goalId}` });
      }
      goalUpdate = { goalId: goal.id, updates: args.goal_update };
    }

    try {
      // Single atomic write: status flip + post-approval-* cleanup. The
      // "exit approved" branch in `SpaceTaskManager.setTaskStatus` nulls
      // `postApprovalSessionId`, `postApprovalStartedAt`, and
      // `postApprovalBlockedReason` in the same UPDATE.
      const artifactSummary = normalizeMeaningfulTaskResult(resolveResultArtifactSummary?.(task));
      const reportedSummary = normalizeMeaningfulTaskResult(task.reportedSummary);
      const existingResult = normalizeMeaningfulTaskResult(task.result);
      const result = artifactSummary ?? existingResult ?? reportedSummary ?? 'Task completed.';
      const updated = await taskManager.setTaskStatus(taskId, 'done', {
        approvalSource: task.approvalSource ?? 'agent',
        result,
        reportedSummary: artifactSummary ?? reportedSummary ?? undefined,
        onCascadedTasks: async (cascadedTasks) => {
          for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
        },
      });
      if (goalUpdate) {
        goalService?.updateGoal(
          goalUpdate.goalId,
          {
            summary: goalUpdate.updates.summary,
            progress: goalUpdate.updates.progress,
            metrics: goalUpdate.updates.metrics,
            nextSteps: goalUpdate.updates.nextSteps,
          },
          { source: 'workflow_node_agent', sourceTaskId: taskId }
        );
      }
      handleGoalTerminal(updated);
      emitTaskUpdated(updated);
      log.info(
        `post-approval.complete: spaceId=${spaceId} taskId=${taskId} outcome=done mode=${task.postApprovalSessionId ? 'spawn' : 'inline'}`
      );
      return jsonResult({
        success: true,
        taskId,
        message: 'Post-approval work finished. Task transitioned to done.',
      });
    } catch (err) {
      return jsonResult({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Dependencies for the `complete_validation_task` handler (task #918).
 *
 * Node-agent-exclusive by design: like `mark_complete`, the handler is mirrored
 * onto every spawned node-agent server (workflow workers are its callers), and
 * `createNodeAgentMcpServer` wraps it with the WorkflowHookEngine so
 * workflow-declared completion hooks run around it. `space-agent-tools` does
 * NOT ship the tool — coordinators and members have no validation-only close
 * path.
 */
export interface CompleteValidationTaskHandlerDeps {
  /** Space the handler is scoped to. */
  spaceId: string;
  /**
   * Calling sub-session id. Drives the worker caller-binding guard (via its
   * `session_context.taskId`) and resolves the completing worker's node
   * execution. Callers with no session id (unit tests) skip both.
   */
  callerSessionId?: string;
  /**
   * Raw db handle for the two synchronous terminal-write revalidations: the
   * `spaces.autonomy_level` reread and the caller-binding session-context read.
   * Optional — absent, the autonomy reread falls back to the entry-gate
   * snapshot and the caller-binding guard is skipped.
   */
  db?: BunDatabase;
  /** Task repository — task reads, run-task listing for canonical selection. */
  taskRepo: Pick<SpaceTaskRepository, 'getTask' | 'listByWorkflowRun'>;
  /** Task manager bound to `spaceId` — runs the centralised transition validator. */
  taskManager: Pick<SpaceTaskManager, 'setTaskStatus'>;
  /** Workflow run repository — run ownership + status guards. */
  workflowRunRepo: Pick<SpaceWorkflowRunRepository, 'getRun'>;
  /** Resolves a run's workflow definition; null when unresolvable (imported/legacy). */
  getWorkflowForRun: (run: SpaceWorkflowRun) => SpaceWorkflow | null;
  /** Node execution repository — run-liveliness, caller source resolution, sweep. */
  nodeExecutionRepo: Pick<
    NodeExecutionRepository,
    'listByWorkflowRun' | 'listByAgentSessionId' | 'updateStatus'
  >;
  /**
   * Resolves a run's primary-link (PR) URL; '' when none. Wired from the
   * domain artifact profile exactly as `SpaceRuntime.resolvePrUrlForRun` does.
   */
  resolvePrimaryLinkUrl: (workflowRunId: string) => string;
  /** Space manager — autonomy level source for the entry gate. */
  spaceManager?: Pick<SpaceManager, 'getSpace'>;
  /** Async space-autonomy fallback when the space manager has no level. */
  getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
  /**
   * Calling long-horizon agent's autonomy ceiling (null/absent = uncapped —
   * node agents are workers and carry no ceiling of their own).
   */
  getCallingAgentAutonomyLevel?: () => number | null;
  /** Interrupts a live worker sub-session (post-completion worker sweep). */
  interruptBySessionId?: (sessionId: string) => Promise<void>;
  /** Audit callback — autonomy rejections and completions are attributable. */
  audit?: (params: Record<string, unknown>, taskId?: string) => void;
  /** Optional hub for emitting `space.task.updated` events after completion. */
  internalEventBus?: Pick<InternalEventBus<DaemonInternalEventMap>, 'publish'>;
  /** Optional goal service for terminal goal-task side effects. */
  goalService?: Pick<SpaceGoalService, 'handleTaskTerminal'>;
}

/**
 * Synchronous `spaces.autonomy_level` read for terminal-write revalidation
 * (the entry gate resolves the level through async managers, which cannot run
 * inside setTaskStatus' synchronous precondition). Returns null when no
 * synchronous source is available or the column is unset — callers fall back
 * to the entry-gate snapshot in that case.
 */
function readSpaceAutonomyLevelSync(db: BunDatabase | undefined, spaceId: string): number | null {
  if (!db) return null;
  const row = db.prepare('SELECT autonomy_level FROM spaces WHERE id = ? LIMIT 1').get(spaceId) as
    | { autonomy_level: number | null }
    | undefined;
  const level = row?.autonomy_level;
  return typeof level === 'number' && level >= 1 && level <= 5 ? level : null;
}

/**
 * The caller's `session_context.taskId` binding, read from the persisted
 * session row (space-scoped). Returns undefined when the session is unknown,
 * in another space, or carries no task binding — callers treat that as broad
 * access, mirroring the coordinator/ad-hoc semantics this guard originated
 * from.
 */
function readCallerSessionTaskId(
  db: BunDatabase | undefined,
  spaceId: string,
  sessionId: string
): unknown {
  if (!db) return undefined;
  let row: { session_context: string | null } | undefined;
  try {
    row = db
      .prepare(
        `SELECT session_context
           FROM sessions
          WHERE id = ?
            AND json_extract(session_context, '$.spaceId') = ?
          LIMIT 1`
      )
      .get(sessionId, spaceId) as { session_context: string | null } | undefined;
  } catch {
    // Malformed context JSON makes json_extract itself throw — unresolvable,
    // which the caller-binding guard treats as fail-closed, never privileged.
    return undefined;
  }
  if (!row?.session_context) return undefined;
  try {
    const parsed = JSON.parse(row.session_context) as { taskId?: unknown } | null;
    return parsed?.taskId;
  } catch {
    return undefined;
  }
}

/**
 * Create a bound `complete_validation_task` handler — the validation-only
 * (no-PR) completion path (task #918). Captures the validation outcome as
 * `task.result` and transitions `review`/`in_progress → done` without
 * requiring a pr_url, for tasks that complete via validation rather than a
 * reviewed PR (Forge review/automation, diagnostics, already-complete work).
 *
 * It complements, rather than duplicates, the other completion tools:
 *   - `approve_task` closes a task already in `review` — any review task,
 *     PR or not. This tool's genuine deltas: `in_progress` eligibility,
 *     explicit outcome capture, and a STRICTER review-path boundary (it
 *     rejects runs whose PR was already recorded, forcing those through
 *     the normal approve/merge path).
 *   - `submit_for_approval` / `approve_pending_completion` are the
 *     human-approval pair; a `review` task parked at a `task_completion`
 *     checkpoint is theirs to resolve, never this tool's.
 *
 * Result precedence: the validation outcome is written as `task.result` at
 * completion. For STANDALONE tasks it is durable. For workflow-backed
 * tasks, the tick loop's run reconciliation may replace it with the run's
 * structured outcome summary when one exists (terminal `decision` artifact
 * or end-node execution summary) — the same precedence every completion
 * path accepts (`approve_task`, post-approval no-route). In the typical
 * no-PR case there IS no such artifact, so the outcome survives via the
 * existing-result fallback.
 *
 * Guards (order is load-bearing — autonomy runs before any task-state
 * reveal, mirroring `approve_task`):
 *   - Task must belong to this space.
 *   - Caller binding, fail closed: every caller on this node-agent-exclusive
 *     surface is a WORKER session, so its `session_context.taskId` binding
 *     MUST resolve (a missing/foreign/malformed/unset binding is rejected,
 *     not treated as an unbound privileged caller) and must equal the target
 *     task.
 *   - Autonomy-gated to the workflow's `completionAutonomyLevel` (default 5)
 *     — the same capability-vs-autonomy framing as `approve_task`. The gate
 *     runs BEFORE the status/no-PR checks so a task's status or PR URL is
 *     never surfaced to a caller below the threshold.
 *   - Task must be `review` or `in_progress`. `in_progress` is intentionally
 *     eligible (Forge review tasks complete while still in_progress); the
 *     autonomy gate is the control.
 *   - A `review` task parked at a `task_completion` checkpoint is
 *     rejected — `submit_for_approval` put it there under an explicit
 *     human-approval promise, and the human approve/reject flow
 *     (approve_pending_completion) owns its resolution.
 *   - No-PR: a workflow-backed task whose run has a primary link (PR) is
 *     PR-bound and must use the normal approve/merge path. A task with no
 *     workflow run (standalone — the common Forge self_nag/review shape) is
 *     no-PR by definition and eligible.
 *   - Workflow-backed tasks whose workflow declares a dispatchable
 *     `postApproval` route are rejected — a direct done would silently skip
 *     the route (the tick loop treats an already-done task as resolved).
 *     They must close through submit_for_approval so the router fires.
 *   - The workflow run must belong to THIS space, be `in_progress`
 *     (pending/cancelled/done/blocked all refuse), carry node executions,
 *     and resolve its workflow definition — an unresolvable or foreign
 *     run refuses rather than being treated as unconstrained.
 *   - Workflow-backed completions apply the tick loop's canonical-task
 *     selection (`pickCanonicalRunTask`) and reject non-canonical
 *     duplicates — the tick archives duplicates, which would discard the
 *     completion while keeping its side effects.
 *   - Workflow-declared hooks on this method are NOT refused here: the
 *     node-agent registration wraps this handler with the WorkflowHookEngine
 *     (`wrapHandlerWithHooks`), so `complete_validation_task` validators run
 *     before the guard chain is ever entered.
 *   - The no-PR, run-status, and run-IDENTITY conditions are re-asserted
 *     synchronously inside the terminal write's precondition against the
 *     reread state — the write is bound to the run whose guards were
 *     checked, so a mid-flight re-attachment to a different run refuses
 *     rather than bypassing that run's guards.
 *
 * The validation outcome is captured as `task.result`; `approvalSource` is
 * stamped `'agent'` atomically with the done commit on every path
 * (`setTaskStatus` stamps it on review→done natively, and on in_progress→done
 * when an explicit approvalSource is supplied). When the caller's session
 * resolves to a node execution in the task's run, its node is committed in
 * the SAME UPDATE as the durable `postApprovalSourceNodeId` so the tick
 * loop's sibling-quiesce exempts the worker that submitted the verdict
 * instead of falling back to the workflow end node.
 */
export function createCompleteValidationTaskHandler(
  deps: CompleteValidationTaskHandlerDeps
): (args: CompleteValidationTaskInput) => Promise<ToolResult> {
  const {
    spaceId,
    callerSessionId,
    db,
    taskRepo,
    taskManager,
    workflowRunRepo,
    getWorkflowForRun,
    nodeExecutionRepo,
    resolvePrimaryLinkUrl,
    spaceManager,
    getSpaceAutonomyLevel,
    getCallingAgentAutonomyLevel,
    interruptBySessionId,
    audit,
    internalEventBus,
    goalService,
  } = deps;

  const emitTaskUpdated = (task: SpaceTask): void => {
    if (!internalEventBus) return;
    void internalEventBus
      .publish('space.task.updated', { sessionId: 'global', spaceId, taskId: task.id, task })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  };

  return async (args: CompleteValidationTaskInput): Promise<ToolResult> => {
    const outcome = args.validation_outcome?.trim();
    if (!outcome) {
      return jsonResult({
        success: false,
        error: 'validation_outcome is required — describe what was checked and the verdict.',
      });
    }

    const task = taskRepo.getTask(args.task_id);
    if (!task) {
      return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
    }
    if (task.spaceId !== spaceId) {
      return jsonResult({
        success: false,
        error: `Task ${args.task_id} does not belong to this space.`,
      });
    }

    // Caller-binding guard, fail closed. This surface is node-agent-exclusive:
    // every legitimate caller is a WORKER sub-session spawned for one task
    // (its session_context carries that taskId). Two refusals:
    //   - The binding must RESOLVE. A missing/foreign-space session row,
    //     malformed context JSON, or an absent taskId is anomalous on this
    //     surface, not privileged — treating it as an unbound "external"
    //     caller would grant broad same-space completion plus the
    //     quiesce-ALL sweep over any run's workers.
    //   - The resolved binding must equal the target: a worker for task A
    //     must not close an unrelated in_progress task B (the next tick
    //     would finalize B's run and quiesce its workers).
    if (callerSessionId) {
      const callerTaskId = readCallerSessionTaskId(db, spaceId, callerSessionId);
      if (callerTaskId === undefined || callerTaskId === null) {
        return jsonResult({
          success: false,
          error: `This worker session's task binding cannot be resolved (no session_context.taskId for this space); complete_validation_task requires a task-bound worker session. Retry after the session context is restored (restore_node_agent) or escalate to the coordinator.`,
        });
      }
      if (callerTaskId !== args.task_id) {
        return jsonResult({
          success: false,
          error: `Worker sessions may only complete their own task; task ${args.task_id} belongs to another task's workers. Escalate to the coordinator if it needs closing.`,
        });
      }
    }

    // Autonomy gate FIRST — mirrors `approve_task`'s ordering. Resolve the
    // workflow's completionAutonomyLevel (default 5) and reject when effective
    // autonomy (min(space, agent-ceiling)) is below it. Running this before the
    // status/no-PR checks avoids leaking a task's status or PR URL to a caller
    // below the threshold. Both the agent-ceiling and space-level blocks log
    // an audit entry so every rejection is attributable.
    const space = spaceManager ? await spaceManager.getSpace(spaceId) : null;
    const spaceLevel =
      space?.autonomyLevel ?? (getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 1);
    const agentLevel = getCallingAgentAutonomyLevel?.() ?? null;
    const currentLevel = agentLevel == null ? spaceLevel : Math.min(spaceLevel, agentLevel);
    let completionAutonomyLevel = 5;
    if (task.workflowRunId) {
      const run = workflowRunRepo.getRun(task.workflowRunId);
      if (run?.workflowId) {
        const workflow = getWorkflowForRun(run);
        if (workflow?.completionAutonomyLevel !== undefined) {
          completionAutonomyLevel = workflow.completionAutonomyLevel;
        }
      }
    }

    if (currentLevel < completionAutonomyLevel) {
      const ceilingBinding = agentLevel != null && agentLevel < spaceLevel;
      audit?.(
        {
          blocked: true,
          reason: ceilingBinding ? 'agent_autonomy_ceiling' : 'space_autonomy',
          agentLevel,
          spaceLevel,
          required: completionAutonomyLevel,
        },
        args.task_id
      );
      return jsonResult({
        success: false,
        error: ceilingBinding
          ? `complete_validation_task not permitted: agent autonomy ceiling ${agentLevel} (space ${spaceLevel}) < workflow completionAutonomyLevel ${completionAutonomyLevel}. Use submit_for_approval to request human review.`
          : `complete_validation_task not permitted: space autonomy level ${spaceLevel} < workflow completionAutonomyLevel ${completionAutonomyLevel}. Use submit_for_approval to request human review.`,
      });
    }

    // Eligibility: only `review` and `in_progress` may close via the
    // validation-only path. `open` has produced no work to validate; terminal
    // statuses are already closed.
    if (task.status !== 'review' && task.status !== 'in_progress') {
      return jsonResult({
        success: false,
        error: `Task is in '${task.status}' status. complete_validation_task only applies to tasks in 'review' or 'in_progress' that complete without a PR.`,
      });
    }

    // Pending-human-approval guard: a `review` task carrying a
    // `task_completion` checkpoint is parked there by `submit_for_approval`
    // under an explicit promise that a HUMAN approves or rejects it. Letting
    // this tool (or any agent) close it directly to `done` would clear the
    // checkpoint and bypass that human gate — the exact bypass the review
    // path exists to prevent. The human review flow (approve_pending_completion
    // / reject) owns those tasks; a `review` task with no pending checkpoint
    // remains eligible.
    if (task.status === 'review' && task.pendingCheckpointType === 'task_completion') {
      return jsonResult({
        success: false,
        error: `Task ${args.task_id} is awaiting human completion approval (pending 'task_completion' checkpoint). complete_validation_task cannot bypass that review — it is resolved through the human approve/reject flow (approve_pending_completion), not by an agent.`,
      });
    }

    // No-PR guard: a workflow-backed task whose run has a primary link (PR) is
    // PR-bound and must close through the normal approve/merge path. A task
    // with no workflow run (standalone) is no-PR by definition and eligible —
    // this is the common Forge self_nag/review shape.
    if (task.workflowRunId) {
      const prUrl = resolvePrimaryLinkUrl(task.workflowRunId);
      if (prUrl) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} has a PR (${prUrl}); validation-only completion is for no-PR tasks. Use approve_task (if in review) or the normal PR merge path instead.`,
        });
      }
      const run = workflowRunRepo.getRun(task.workflowRunId);
      // Run-space ownership (before any lifecycle consultation): imported/
      // malformed rows carry no constraint tying a task's workflowRunId to
      // a run in the SAME space. A foreign run's task must not be completed
      // (or its executions swept) from this space — that lifecycle belongs
      // to the run's own space.
      if (run && run.spaceId !== spaceId) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} references a workflow run belonging to a different space; validation-only completion is not applicable here. Reconcile the task's run association.`,
        });
      }
      // Run-lifecycle guard: the tick loop's completion detection only runs
      // when the run has node executions (`space-runtime.ts` early-returns on
      // an empty list), so completing a run's task while zero executions
      // exist would leave the run active forever — the same stranding shape
      // the `archive_task` active-run guard rejects (task #849, G1). An
      // execution-less run is degenerate (never initialized, or an import
      // edge case): direct the caller to cancel it rather than strand it.
      const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
      if (executions.length === 0) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} belongs to a workflow run with no node executions (${task.workflowRunId}); completing it would strand the run. Cancel the run instead so its lifecycle is torn down.`,
        });
      }
      // Run-status guard: a task can linger in review/in_progress while its
      // run is already terminal or waiting — cancelled (cancellation/
      // recovery edge — e.g. shutdown leaves the task unreconciled), done,
      // or BLOCKED (the runtime's blocking paths transition the run first
      // and update the task behind awaits, so a window exists where the run
      // is blocked but the task row still reads review/in_progress). A
      // blocked run never reaches completion detection in the tick loop
      // (`processRunTick` routes it through blocked-run recovery first), so
      // completing the task would strand the run in blocked limbo or be
      // overwritten by the pending task-block step. PENDING is equally
      // ineligible: it is a transient pre-initialization state (the start
      // path promotes a run to in_progress before attaching its task, and
      // rehydration excludes pending runs), so a completion landing on a
      // still-pending run would strand it outside every lifecycle loop.
      // Only `in_progress` runs are eligible.
      if (run && run.status !== 'in_progress') {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} belongs to a ${run.status} workflow run; validation-only completion is not applicable. Reconcile or retry the task instead.`,
        });
      }
      // Canonical-task guard: a run should have exactly one task, but
      // imported/legacy runs can temporarily carry duplicates. The tick loop
      // picks the canonical task (pickCanonicalRunTask) and archives every
      // duplicate, so completing a non-canonical duplicate here would be
      // discarded by that archive while its side effects (evidence capture,
      // dependent unblocking) persisted. Apply the tick's exact selection
      // rule and reject duplicates up front.
      const runTasks = taskRepo.listByWorkflowRun(task.workflowRunId);
      const canonicalTask = run ? pickCanonicalRunTask(run, runTasks) : null;
      if (canonicalTask && canonicalTask.id !== task.id) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} is not the canonical task of its workflow run (a duplicate the runtime will archive); completing it would be discarded. Complete or reconcile the canonical task (${canonicalTask.taskNumber}) instead.`,
        });
      }
      const routeWorkflow = run?.workflowId ? getWorkflowForRun(run) : null;
      // Workflow-definition guard: an imported/legacy run whose referenced
      // definition is missing resolves no workflow — treating that as "no
      // hooks, no routes" would let the task complete while the run
      // strands `in_progress` forever (rehydration cannot register
      // executorMeta for it, and processRunTick returns before completion
      // handling when that metadata is absent). Refuse so the run's
      // lifecycle is reconciled instead.
      if (run && run.workflowId && !routeWorkflow) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} belongs to a workflow run whose workflow definition cannot be resolved (${run.workflowId}); completing it would strand the run. Reconcile or cancel the run instead.`,
        });
      }
      if (collectDispatchablePostApprovalRoutes(routeWorkflow).length > 0) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} belongs to a workflow with a post-approval route; validation-only completion would skip it. Use submit_for_approval (then approval) so the route fires.`,
        });
      }
    }

    try {
      // Snapshots the terminal precondition revalidates against (autonomy
      // can be revoked between the entry gate and the write).
      const requiredAutonomyLevel = completionAutonomyLevel;
      const entrySpaceLevel = spaceLevel;
      // Resolve the completing worker's node BEFORE the transition so the
      // source can be committed atomically with `done` (no follow-up write,
      // no observable terminal-without-source window). The tick loop's
      // sibling-quiesce resolves its exclusion as `postApprovalSourceNodeId
      // ?? pendingCompletionSubmittedByNodeId ?? endNodeId`; without the
      // stamp a non-end-node worker completing its own in_progress task
      // would leave all three unset, and reconciliation would fall back to
      // endNodeId — interrupting the actual caller and sparing the
      // unrelated end-node worker. Callers with no node execution in the
      // task's run (no session id, or a worker from another run)
      // resolve to none and pass no option.
      let completionSourceNodeId: string | undefined;
      let completionSourceExecutionId: string | undefined;
      if (callerSessionId && task.workflowRunId) {
        const callerExecution = nodeExecutionRepo
          .listByAgentSessionId(callerSessionId)
          .find((e) => e.workflowRunId === task.workflowRunId);
        completionSourceNodeId = callerExecution?.workflowNodeId;
        completionSourceExecutionId = callerExecution?.id;
        // Stale-worker guard: the caller is task-BOUND (the binding guard
        // above fail-closed on unresolvable bindings) but has NO execution in
        // the task's CURRENT run — a worker from a previous run attachment:
        // `startWorkflowRun({parentTaskId})` re-attaches the task to a new
        // run while the old worker keeps its session_context.taskId binding
        // and its executions stay on the old run. Its completion authority
        // ended with that run: this handler is wrapped in the SPAWN-TIME
        // run's hook engine, and resolving to "no source" would grant it the
        // external-caller quiesce-ALL sweep over the new run's workers.
        // Reject so the current run's own workers drive the completion.
        if (!callerExecution) {
          return jsonResult({
            success: false,
            error: `Task ${args.task_id} was re-attached to a different workflow run after this worker spawned; this session has no node execution in the current run. Validation completion belongs to the current run's workers — escalate to the coordinator if it still needs closing.`,
          });
        }
      }
      // The run every guard above evaluated against — the terminal write is
      // bound to this association remaining unchanged (see the precondition).
      const checkedWorkflowRunId = task.workflowRunId;

      // `approvalSource: 'agent'` is passed unconditionally: setTaskStatus
      // stamps it atomically with the done commit on BOTH paths — review→done
      // natively, and in_progress→done when an explicit approvalSource is
      // supplied (validation-only completions only; other callers of that
      // transition are unaffected).
      //
      // `allowedSourceStatuses` closes the TOCTOU window between the
      // eligibility check above and this write: `cancelled → done` and
      // `approved → done` are both VALID edges, so without the condition a
      // concurrent user cancellation or human approval landing in between
      // would let this completion overwrite the cancellation or prematurely
      // close a task whose post-approval work is still running. setTaskStatus
      // rereads the task right before the UPDATE, so the condition binds to
      // the persisted state the write lands on.
      const updated = await taskManager.setTaskStatus(args.task_id, 'done', {
        result: outcome,
        approvalSource: 'agent',
        approvalReason: args.reason,
        allowedSourceStatuses: ['review', 'in_progress'],
        ...(completionSourceNodeId !== undefined ? { completionSourceNodeId } : {}),
        // Re-assert the run-dependent conditions against the reread state
        // right before the UPDATE. Runs synchronously (no event-loop yield)
        // between the reread and the write. HONEST BOUNDS: this bounds the
        // artifact-table race to the same narrow window every other
        // completion path accepts — the PR lives in a different table (run
        // artifacts), so a save_artifact committing between this check and
        // the task UPDATE can still slip through, exactly as it can under
        // `approve_task`. It does NOT claim full closure; the STATUS half of
        // the race is closed atomically by the `WHERE status IN (…)`
        // predicate on the UPDATE (allowedSourceStatuses above).
        precondition: (current) => {
          // Checkpoint recheck on the reread state (BEFORE the run-identity
          // work — this applies to standalone tasks too): a concurrent
          // `submit_for_approval` can flip an initially-in_progress task to
          // `review` (stamping the human-approval checkpoint) between the
          // handler's early check and this reread — `review` is in the
          // allowed set and the exact-status predicate keys on the reread
          // status, so only this recheck can catch it. Refuse so the
          // requested human approval is not bypassed.
          if (current.status === 'review' && current.pendingCheckpointType === 'task_completion') {
            throw new Error(
              `Task ${args.task_id} was submitted for human approval during completion (pending 'task_completion' checkpoint); refusing so the requested review is not bypassed. The human approve/reject flow owns it now.`
            );
          }
          // Run-identity binding: every run-dependent guard (autonomy's
          // workflow, PR, runnable status, canonical ownership, hooks,
          // post-approval routes) evaluated against the run the task
          // referenced at entry. `startWorkflowRun({parentTaskId})` can
          // re-attach a task to a different run WITHOUT changing its status,
          // which the exact-status SQL predicate cannot see — refuse if the
          // association moved so the newly attached run's guards are
          // evaluated instead of bypassed.
          // Autonomy revalidation: an operator can lower the space level or
          // the calling agent's ceiling after the entry gate but before this
          // write — authority revoked mid-flight must not complete work
          // under the old policy. The agent-ceiling closure is synchronous;
          // the space level is reread synchronously from the spaces row,
          // falling back to the entry-gate snapshot when no synchronous
          // source exists (handlers built without a db handle).
          const agentLevelNow = getCallingAgentAutonomyLevel?.() ?? null;
          const spaceLevelNow = readSpaceAutonomyLevelSync(db, spaceId) ?? entrySpaceLevel;
          const effectiveNow =
            agentLevelNow == null ? spaceLevelNow : Math.min(spaceLevelNow, agentLevelNow);
          if (effectiveNow < requiredAutonomyLevel) {
            throw new Error(
              `Task ${args.task_id} cannot be completed: effective autonomy was lowered to ${effectiveNow} (required ${requiredAutonomyLevel}) before the write. The completion authority was revoked — use submit_for_approval to request human review.`
            );
          }
          const expectedRunId = checkedWorkflowRunId ?? null;
          const actualRunId = current.workflowRunId ?? null;
          if (actualRunId !== expectedRunId) {
            throw new Error(
              `Task ${args.task_id}'s workflow run association changed during completion (expected ${expectedRunId ?? 'none'}, found ${actualRunId ?? 'none'}); refusing so the attached run's guards are evaluated. Re-check and retry if still appropriate.`
            );
          }
          if (!actualRunId) return;
          const prUrl = resolvePrimaryLinkUrl(actualRunId);
          if (prUrl) {
            throw new Error(
              `Task ${args.task_id} acquired a PR (${prUrl}) during completion; validation-only completion is for no-PR tasks. Use the normal approve/merge path instead.`
            );
          }
          // Run-active recheck: `stopActiveWork` cancels a `review` task's RUN
          // while deliberately excluding the task row itself from its
          // task-cancellation pass (only in_progress/open/paused tasks are
          // cancelled), and the blocking paths flip the run to `blocked`
          // before their task update — so a run status change can land
          // between the handler's early run read and this write with the
          // task row still reading `review`/`in_progress`, invisible to the
          // exact-status predicate. Reread the run inside the same
          // synchronous reread→UPDATE window and require an `in_progress`
          // run (pending/cancelled/done/blocked all refuse).
          const runNow = workflowRunRepo.getRun(actualRunId);
          if (runNow && runNow.status !== 'in_progress') {
            throw new Error(
              `Task ${args.task_id} belongs to a ${runNow.status} workflow run (rechecked at the terminal write); validation-only completion is not applicable. Reconcile or retry the task instead.`
            );
          }
        },
        onCascadedTasks: async (cascadedTasks) => {
          for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
        },
      });

      // Quiesce the run's workers so none survives the completion
      // `in_progress` (the reconciliation sweep spares whole NODES — the
      // recorded source node, or endNodeId as its fallback — so workers on
      // those nodes would otherwise keep issuing tools/messages for
      // finished work). Two shapes:
      //   - WORKER caller: quiesce same-node peers, sparing only the
      //     caller's own execution (mid-tool-call; it cannot be interrupted
      //     from within itself).
      //   - EXTERNAL caller (no node execution in the run): nobody in the
      //     run submitted this verdict, and the sweep's endNodeId fallback
      //     would spare the entire end node; quiesce every active run worker
      //     (the caller's session is not among them).
      // Best-effort: a failure never rolls back the committed done
      // transition. Revalidate first: setTaskStatus commits `done` BEFORE
      // awaiting its post-commit cascade (unblockDependentTasks), so a
      // concurrent reopen (recoverWorkflowBackedTask or a message-driven
      // revival) can restore the task and restart executions while the
      // returned `updated` snapshot still says done — sweeping then would
      // idle/interrupt the newly recovered workers. Require the CURRENT
      // task row to still be `done` and run-attached before sweeping.
      const currentTaskRow = taskRepo.getTask(updated.id);
      if (currentTaskRow?.status === 'done' && currentTaskRow.workflowRunId) {
        try {
          const quiesce = (execution: { id: string; agentSessionId: string | null }) => {
            nodeExecutionRepo.updateStatus(execution.id, 'idle');
            if (execution.agentSessionId && interruptBySessionId) {
              void interruptBySessionId(execution.agentSessionId).catch((err) => {
                log.warn(
                  `complete_validation_task: failed to interrupt run worker session ${execution.agentSessionId}: ${err instanceof Error ? err.message : String(err)}`
                );
              });
            }
          };
          const activeExecutions = nodeExecutionRepo
            .listByWorkflowRun(currentTaskRow.workflowRunId)
            .filter((execution) => execution.status === 'in_progress');
          if (completionSourceNodeId) {
            for (const peer of activeExecutions.filter(
              (execution) =>
                execution.workflowNodeId === completionSourceNodeId &&
                execution.id !== completionSourceExecutionId
            )) {
              quiesce(peer);
            }
          } else {
            for (const worker of activeExecutions) {
              quiesce(worker);
            }
          }
        } catch (err) {
          log.warn(
            `complete_validation_task: run-worker quiesce failed for task "${updated.id}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Best-effort goal terminal handling — must not block completion.
      try {
        goalService?.handleTaskTerminal(updated.id);
      } catch (err) {
        log.warn(
          `Goal terminal handling threw for task "${updated.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }

      audit?.(
        {
          completionMode: 'validation_only',
          reason: args.reason,
          previousStatus: task.status,
        },
        args.task_id
      );

      emitTaskUpdated(updated);

      return jsonResult({ success: true, task: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ success: false, error: message });
    }
  };
}

/**
 * Create the two end-node tool handlers bound to a specific task/workflow/
 * agent context. The returned handlers are pure closures — repeated calls
 * with the same `deps` return independent instances.
 */
export function createEndNodeHandlers(deps: EndNodeHandlerDeps): EndNodeHandlers {
  const {
    taskId,
    spaceId,
    workflow,
    workflowNodeId,
    taskRepo,
    taskManager,
    spaceManager,
    internalEventBus,
  } = deps;

  const emitTaskUpdated = (task: SpaceTask): void => {
    if (!internalEventBus) return;
    void internalEventBus
      .publish('space.task.updated', { sessionId: 'global', spaceId, taskId: task.id, task })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  };

  return {
    // -------------------------------------------------------------------
    // approve_task — self-close. Re-checks autonomy at call time.
    // -------------------------------------------------------------------
    onApproveTask: async (_args: ApproveTaskInput) => {
      const space = await spaceManager.getSpace(spaceId);
      const currentLevel = space?.autonomyLevel ?? 1;
      const required = workflow?.completionAutonomyLevel ?? 5;
      if (currentLevel < required) {
        return jsonResult({
          success: false,
          error: `approve_task not permitted: space autonomy level ${currentLevel} < workflow completionAutonomyLevel ${required}. If work is approved/QA-passed and all findings are resolved, use submit_for_approval as the terminal human sign-off path. Do not use either terminal tool while findings, QA failures, or dispatch work remain open.`,
        });
      }

      const task = taskRepo.getTask(taskId);
      if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

      try {
        const updated = taskRepo.updateTask(taskId, {
          reportedStatus: 'done',
          // Preserve the approving node as the DURABLE completion source so
          // post-approval routing resolves against this terminal node instead
          // of falling back to the workflow end node. The router/dispatch read
          // this field (not the pending-completion fields, which are atomically
          // cleared on entering `approved` — task #851) for sourceNodeId +
          // approval_authority + sibling-quiesce source.
          pendingCheckpointType: null,
          pendingCompletionSubmittedByNodeId: workflowNodeId,
          pendingCompletionSubmittedAt: null,
          pendingCompletionReason: null,
          postApprovalSourceNodeId: workflowNodeId,
        });
        if (updated) emitTaskUpdated(updated);
        return jsonResult({
          success: true,
          taskId,
          message:
            'Task approved for completion. The completion-action pipeline will now resolve terminal status.',
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // -------------------------------------------------------------------
    // submit_for_approval — human sign-off. Always available to end nodes.
    //
    // Delegates to `SpaceTaskManager.submitTaskForReview` — the same helper
    // used by the UI "Submit for Review" RPC and the Task Agent's
    // `submit_for_approval` tool — so all three callers write identical
    // fields and the resulting `review` task is always banner-eligible.
    // -------------------------------------------------------------------
    onSubmitForApproval: async (args: SubmitForApprovalInput) => {
      const task = taskRepo.getTask(taskId);
      if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

      try {
        const updated = await taskManager.submitTaskForReview(taskId, {
          submittedByNodeId: workflowNodeId,
          reason: args.reason ?? null,
        });
        emitTaskUpdated(updated);
        return jsonResult({
          success: true,
          taskId,
          message: `Task submitted for human review${args.reason ? ` (reason: ${args.reason})` : ''}. A human must approve or reject via the UI before the workflow continues.`,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
