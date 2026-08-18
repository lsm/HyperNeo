/**
 * PostApprovalRouter — deterministic dispatch for workflow post-approval routes.
 *
 * PR 2/5 of the task-agent-as-post-approval-executor refactor. See
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §1.4 for the runtime-driven routing mechanics and §2.3 for the event shapes.
 *
 * ## What it does
 *
 * When a task transitions into `approved` (from the end-node `approve_task`
 * path in `space-runtime.ts`, or from the human `approvePendingCompletion`
 * RPC handler in `space-task-handlers.ts`), this router consults the approving
 * workflow node's `postApproval` route (falling back to legacy
 * `workflow.postApproval`) and performs one of three deterministic actions:
 *
 *   1. **No route declared** → runtime transitions `approved → done` directly
 *      and emits `task.status-transition: approved → done source=no-post-approval`.
 *   2. **Any `targetAgent`** (a *space task node agent* — see terminology
 *      below) → spawn a fresh sub-session for that agent with the interpolated
 *      kickoff message, and stamp `post_approval_session_id` +
 *      `post_approval_started_at` on the task.
 *
 * ## Terminology — "space task node agent"
 *
 * Throughout this plan, "space task node agent" refers to an agent session
 * spawned for a node in a space workflow run — distinct from the Task Agent
 * (the orchestrator) and from ad-hoc chat sessions. In the current codebase
 * this is the `'node_agent'` kind in
 * `packages/shared/src/types/space.ts` (`SpaceMemberSession.kind`). See
 * `PostApprovalRoute.targetAgent` in the same file: the validator in
 * `post-approval-validator.ts` restricts valid targets to the `name` of a declared `WorkflowNodeAgent`.
 *
 * ## Double-fire guard (§3.4)
 *
 * The router is idempotent against double-invocation for the node-agent-spawn
 * case: if a task already has `postApprovalSessionId` set AND the referenced
 * session is alive (not terminal), the router returns a no-op result with
 * `mode: 'already-routed'`.
 *
 *  * ## Feature flag (kill switch only)
 *
 * As of PR 4/5 the completion-action pipeline has been deleted — the
 * PostApprovalRouter is the only approval path. The
 * `HYPERNEO_TASK_AGENT_POST_APPROVAL_ROUTING` env var and
 * `isPostApprovalRoutingEnabled()` helper are retained as an emergency kill
 * switch: production call sites no longer consult it (PR 4/5 removed the
 * branch), but operators can still inspect the flag state in diagnostics.
 * There is no longer a fallback path to switch to.
 */

import type {
  SpaceTask,
  SpaceWorkflow,
  SpaceApprovalSource,
  UpdateSpaceTaskParams,
  PostApprovalRoute,
} from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import {
  interpolatePostApprovalTemplate,
  type PostApprovalTemplateContext,
} from '../workflows/post-approval-template';
import { Logger } from '../../logger';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';

const log = new Logger('post-approval-router');

/**
 * Feature-flag env var. Call-sites read this and only invoke the router when
 * it is truthy (`'1'` or `'true'`). Exported so tests can assert on it and
 * so the RPC handler + space-runtime share a single key.
 */
export const POST_APPROVAL_ROUTING_FLAG_ENV = 'HYPERNEO_TASK_AGENT_POST_APPROVAL_ROUTING';

/**
 * Returns true when the feature flag indicates post-approval routing should
 * remain enabled. Retained as an emergency kill switch only — as of PR 4/5
 * the production call sites have been collapsed (no legacy path to fall back
 * to), so the helper is consulted only in diagnostics and tests.
 *
 * Default-ON as of PR 3/5. Set the env var to any of `0` / `false` / `no` /
 * `off` to read as disabled. An absent value (`undefined`) or any unrecognised
 * string keeps routing enabled.
 */
export function isPostApprovalRoutingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const raw = env[POST_APPROVAL_ROUTING_FLAG_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Deferral signal
// ---------------------------------------------------------------------------

/**
 * Thrown by `SpaceRuntime.dispatchPostApproval` when the review → approved
 * commit has already happened but the post-approval dispatch must not run
 * because the space is stopped/paused (the supervision hold), or a stop
 * landed mid-dispatch (the merge spawner's pre-kickoff check surfaces as a
 * transient spawn error that the runtime converts).
 *
 * Contract with callers:
 *   - The approval itself is durable — the task is `approved`.
 *   - `postApprovalBlockedReason` is stamped on the task by the runtime
 *     BEFORE throwing, so the UI banner exists regardless of caller. Human
 *     callers (RPC handler / coordinator tool) should NOT re-stamp it — their
 *     `mapPostApprovalDispatchWarning` copy would both duplicate the
 *     "approval recorded" phrasing and give deferral-inappropriate advice.
 *   - `onSpaceResumed` re-drives the deferred dispatch when the space
 *     starts/resumes (`resumeDeferredPostApprovals`), so this is a deferral,
 *     not a dead end.
 */
export class PostApprovalDeferredError extends Error {
  /** Why the dispatch deferred — drives the resumed-race compensation. */
  readonly cause: 'stopped' | 'paused' | 'unreadable';
  constructor(message: string, cause: 'stopped' | 'paused' | 'unreadable' = 'stopped') {
    super(message);
    this.name = 'PostApprovalDeferredError';
    this.cause = cause;
  }
}

/** Type guard for {@link PostApprovalDeferredError}. */
export function isPostApprovalDeferredError(err: unknown): err is PostApprovalDeferredError {
  return err instanceof PostApprovalDeferredError;
}

// ---------------------------------------------------------------------------
// Dispatch delegates
// ---------------------------------------------------------------------------

/**
 * Delegate for spawning the post-approval sub-session on the
 * space-task-node-agent path. Production wires this to
 * `TaskAgentManager.spawnPostApprovalSubSession`; tests pass a stub.
 *
 * The delegate is responsible for everything that differs between a regular
 * node activation and a post-approval activation:
 *   - Reusing the agent's existing session when one is live; a FRESH
 *     post-approval target (e.g. the built-in merger) carries no
 *     `NodeExecution` row at all (#852) — `createSubSession` stamps a row
 *     only when one already exists with a blank session binding.
 *   - Attaching the same MCP server set that the target node would have.
 *   - Injecting the `kickoffMessage` as the first user turn.
 *   - Returning the spawned session ID so the router can stamp it on the task.
 */
export interface PostApprovalSubSessionSpawner {
  spawnPostApprovalSubSession(args: {
    task: SpaceTask;
    workflow: SpaceWorkflow;
    targetAgent: string;
    kickoffMessage: string;
  }): Promise<{ sessionId: string }>;
}

/**
 * Optional delegate used to confirm that a previously-recorded
 * `postApprovalSessionId` still points at a live session. When omitted the
 * router treats any non-null `postApprovalSessionId` as live (conservative:
 * it skips the second spawn). Production wires this to
 * `TaskAgentManager.isSessionAlive`.
 */
export interface SessionLivenessProbe {
  isSessionAlive(sessionId: string): boolean;
}

export interface PostApprovalRouterDeps {
  taskRepo: Pick<SpaceTaskRepository, 'updateTask' | 'getTask'>;
  spawner: PostApprovalSubSessionSpawner;
  livenessProbe?: SessionLivenessProbe;
  /** Optional hook that fills task outcome fields before terminal side effects run. */
  resolveCompletionOutcome?: (task: SpaceTask) => UpdateSpaceTaskParams | null;
  /** Optional goal service for processing terminal goal-task side effects. */
  goalService?: Pick<import('../goals/goal-service').SpaceGoalService, 'handleTaskTerminal'>;
  /** Optional Forge scope service for automatic terminal task evidence capture. */
  evolutionScopeService?: Pick<
    import('../evolution-scope-service').EvolutionScopeService,
    'captureCompletedTaskEvidence'
  >;
}

// ---------------------------------------------------------------------------
// Route inputs + outputs
// ---------------------------------------------------------------------------

/**
 * Runtime context assembled by the caller. Includes every key that the
 * template interpolator recognises (see
 * `post-approval-template.ts:POST_APPROVAL_TEMPLATE_KEYS`) plus arbitrary
 * extra keys signalled by the end-node agent (e.g. `pr_url`).
 */
export interface PostApprovalRouteContext extends PostApprovalTemplateContext {
  /** How the task reached `approved`. Included in post-approval routing context. */
  approvalSource: SpaceApprovalSource;
  /** Slot/name of the agent that approved the task. */
  reviewerName?: string;
  /** Owning space ID. */
  spaceId?: string;
  /** Workspace path for the space's worktree. */
  workspacePath?: string;
  /** Space's autonomy level at routing time. */
  autonomyLevel?: number;
}

/**
 * Discriminated union describing which branch the router took.
 *
 *   - `mode: 'no-route'`        — no `postApproval` declared; task transitioned
 *                                 directly `approved → done`.
 *   - `mode: 'spawn'`           — a node-agent sub-session was spawned; its
 *                                 ID was stamped on the task.
 *   - `mode: 'already-routed'`  — idempotency guard: a prior spawn's session
 *                                 is still alive, so this call is a no-op.
 *   - `mode: 'skipped'`         — router precondition failed (e.g. missing
 *                                 workflow, empty instructions for inline path).
 *                                 Not a failure — caller may choose to surface.
 */
export type PostApprovalRouteResult =
  | { mode: 'no-route'; taskStatus: 'done' }
  | {
      mode: 'spawn';
      postApprovalSessionId: string;
      postApprovalStartedAt: number;
      missingKeys: string[];
    }
  | { mode: 'already-routed'; postApprovalSessionId: string }
  | {
      mode: 'skipped';
      reason: string;
      /**
       * `true` marks the MUTEX variant of skipped — another dispatch for the
       * same task owns the work and will clear or re-stamp the reason on
       * completion — as opposed to the router's permanent skipped (broken
       * route, manual recovery). Consumers branch on it.
       */
      inFlight?: boolean;
    };

// ---------------------------------------------------------------------------
// Event shapes (§2.3)
// ---------------------------------------------------------------------------

const POST_APPROVAL_COMPLETION_INSTRUCTIONS =
  `When the post-approval work is finished, call mark_complete to transition the\n` +
  `task from \`approved\` to \`done\`. If you are blocked and cannot complete the\n` +
  `work, do NOT call mark_complete — the post-approval node-agent surface has no\n` +
  `request-human tool, so surface the blocker via send_message(target="space-agent")\n` +
  `and save a NON-result artifact describing the block (e.g. shape:"note", kind:"blocked"). A\n` +
  `kindless \`decision\` would be picked up as the task result on a later mark_complete,\n` +
  `poisoning completion. Then stop.\n\n` +
  `Do NOT call approve_task; the task has already been approved upstream.`;

export function appendPostApprovalCompletionInstructions(interpolatedInstructions: string): string {
  const trimmed = interpolatedInstructions.trim();
  return `${trimmed}\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`;
}

/**
 * Collect every declared post-approval route in a workflow. Approval is a
 * task-level event, so collection scans EVERY node (plus the legacy workflow-
 * level route as a fallback) regardless of which node submitted or approved —
 * this is what lets the merger route fire no matter who submitted. The router
 * then dispatches AT MOST ONE route (the first); see `route()` for why
 * multi-route fan-out is not supported.
 */
export function collectPostApprovalRoutes(workflow: SpaceWorkflow | null): PostApprovalRoute[] {
  if (!workflow) return [];
  // Approval is a task-level event: collect post-approval routes from EVERY
  // node, independent of which node submitted or approved.
  const nodeRoutes = workflow.nodes
    .map((node) => node.postApproval)
    .filter((route): route is PostApprovalRoute => !!route);
  if (nodeRoutes.length > 0) return nodeRoutes;
  // Legacy workflow-level fallback (pre-node-level): only when no node declares
  // its own route, so a workflow with both never double-dispatches.
  return workflow.postApproval ? [workflow.postApproval] : [];
}

export function collectDispatchablePostApprovalRoutes(
  workflow: SpaceWorkflow | null
): PostApprovalRoute[] {
  return collectPostApprovalRoutes(workflow).filter(
    (route) => route.targetAgent && route.targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET
  );
}

/**
 * Null out the four pending-completion fields on a task. Exported so the
 * dispatch layer (`SpaceRuntime.dispatchPostApproval`) can guarantee the
 * cleanup in a single location regardless of which router branch ran (or
 * whether the router threw) — see the Layer B invariant documented on
 * `dispatchPostApproval`.
 */
export function clearPendingCompletionState(
  taskRepo: Pick<SpaceTaskRepository, 'updateTask'>,
  taskId: string
): void {
  taskRepo.updateTask(taskId, {
    pendingCheckpointType: null,
    pendingCompletionSubmittedByNodeId: null,
    pendingCompletionSubmittedAt: null,
    pendingCompletionReason: null,
  });
}

/**
 * Re-frame a post-approval dispatch error (e.g. an SDK `"user interrupted"`
 * abort during sub-session spawn) as a user-facing message. The raw SDK
 * string gives the operator no context — they cannot tell what was
 * "interrupted" or that the approval itself actually succeeded. This maps
 * known abort/interrupt/cancel signatures to a clearer phrasing and always
 * makes explicit that the approval was recorded and only the post-approval
 * dispatch failed.
 *
 * Used by the `approvePendingCompletion` RPC handler (Layer C) when
 * `dispatchPostApproval` throws after the `review → approved` status commit.
 */
export function mapPostApprovalDispatchWarning(detail: string): string {
  // The raw detail is used ONLY to classify the cause — it must NOT be
  // embedded in the returned banner copy, which the web PendingPostApprovalBanner
  // renders verbatim (daemon paths, SQL text, and ids would otherwise leak to
  // web clients). The raw cause stays in the caller's log line.
  const lower = (detail ?? '').trim().toLowerCase();
  const interrupted =
    lower.includes('interrupted') || lower.includes('abort') || lower.includes('cancel');
  const cause = interrupted
    ? 'the post-approval dispatch was interrupted'
    : 'the post-approval dispatch hit an error';
  return `Approval recorded, but ${cause}. The task is approved; you may need to manually trigger post-approval work.`;
}

/**
 * Shared Layer-C recovery for a post-approval dispatch that threw AFTER the
 * status commit (the task is `approved`). Used by the `approvePendingCompletion`
 * RPC handler and the coordinator tool, which must encode the same policy:
 *  - a typed deferral already stamped by the runtime is preserved verbatim
 *    (do NOT overwrite with the generic warning);
 *  - a typed deferral that reached the caller UNSTAMPED (a runtime stamping
 *    gap) gets the generic recovery banner — the resume sweep filters on the
 *    reason, so an unstamped deferral would wedge the task `approved` with no
 *    banner and no recovery;
 *  - any other failure is captured as the generic warning.
 * The raw error cause stays in the caller's log; the banner carries generic
 * copy (rendered verbatim to web clients).
 */
export async function handlePostApprovalDispatchError(opts: {
  taskId: string;
  dispatchErr: unknown;
  /** `postApprovalBlockedReason` read AFTER the commit (may be null when the
   *  runtime had a stamping gap). */
  afterCommitReason: string | null | undefined;
  updateTask: (taskId: string, updates: { postApprovalBlockedReason: string }) => Promise<unknown>;
  logPrefix: string;
}): Promise<void> {
  const { taskId, dispatchErr, afterCommitReason, updateTask, logPrefix } = opts;
  if (isPostApprovalDeferredError(dispatchErr)) {
    if (!afterCommitReason) {
      log.warn(
        `${logPrefix}: post-approval dispatch of task ${taskId} deferred without a blocked-reason ` +
          `stamp (${dispatchErr.message}); stamping the generic recovery banner`
      );
      await updateTask(taskId, {
        postApprovalBlockedReason: mapPostApprovalDispatchWarning(dispatchErr.message),
      });
    } else {
      log.info(
        `${logPrefix}: post-approval dispatch of task ${taskId} deferred (${dispatchErr.message}); ` +
          `approval recorded, dispatch re-runs when the space resumes`
      );
    }
    return;
  }
  const detail = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
  log.warn(
    `${logPrefix}: post-approval dispatch failed for task ${taskId} after status commit ` +
      `(${detail}); capturing as post-approval-blocked`
  );
  await updateTask(taskId, {
    postApprovalBlockedReason: mapPostApprovalDispatchWarning(detail),
  });
}

// ---------------------------------------------------------------------------
// PostApprovalRouter
// ---------------------------------------------------------------------------

/**
 * Deterministic dispatcher for the post-approval step. Instantiated once by
 * the runtime layer (see `space-runtime.ts`), reused for every approval.
 */
export class PostApprovalRouter {
  constructor(private readonly deps: PostApprovalRouterDeps) {}

  /**
   * Route a just-`approved` task. Must be called AFTER the caller has
   * transitioned the task into `approved` — the router inspects the
   * current task state but never performs the `in_progress → approved`
   * or `review → approved` hop itself (those live at the call sites so
   * their emit + liveness semantics stay local).
   */
  async route(
    task: SpaceTask,
    workflow: SpaceWorkflow | null,
    context: PostApprovalRouteContext
  ): Promise<PostApprovalRouteResult> {
    // -------------------------------------------------------------------
    // 0. Sanity: task MUST currently be in `approved`. If it isn't, the
    //    caller misordered things — log loudly and skip.
    // -------------------------------------------------------------------
    if (task.status !== 'approved') {
      const reason = `task ${task.id} is not in 'approved' (status=${task.status}); router will not dispatch`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      return { mode: 'skipped', reason };
    }

    // Source node is informational only (logging + the no-route audit write):
    // route RESOLUTION is task-level via `collectPostApprovalRoutes` above, so
    // it does not depend on this value. Read it from the DURABLE
    // `postApprovalSourceNodeId` field — NOT `pendingCompletionSubmittedByNodeId`,
    // which is cleared atomically in the same UPDATE that commits `approved`
    // (task #851) and is therefore null by the time the router runs. The
    // durable field also survives a crashed dispatch, so a reconciliation retry
    // still logs/audits the correct submitting node. Falls back to the workflow
    // end node when no node submitted (Task Agent / UI self-submit).
    const sourceNodeId = task.postApprovalSourceNodeId || workflow?.endNodeId || null;

    // Approval is a task-level event: collect post-approval routes from EVERY
    // node (plus the legacy workflow-level route), independent of which node
    // submitted or approved. Filter to dispatchable routes — each must name a
    // targetAgent, and the legacy 'task-agent' target is no longer supported.
    const allRoutes = collectPostApprovalRoutes(workflow);
    const dispatchable: PostApprovalRoute[] = [];
    for (const candidate of allRoutes) {
      if (!candidate.targetAgent) continue;
      if (candidate.targetAgent === POST_APPROVAL_TASK_AGENT_TARGET) {
        log.warn(
          `PostApprovalRouter.route: task ${task.id} has a legacy task-agent post-approval target; skipping that route`
        );
        continue;
      }
      dispatchable.push(candidate);
    }

    // -------------------------------------------------------------------
    // 1. No postApproval declared anywhere → close the task directly.
    // -------------------------------------------------------------------
    if (dispatchable.length === 0) {
      const outcomeUpdates = this.deps.resolveCompletionOutcome?.(task) ?? null;
      const updates: UpdateSpaceTaskParams = {
        ...outcomeUpdates,
        status: 'done',
        completedAt: Date.now(),
        pendingCheckpointType: null,
        pendingCompletionSubmittedByNodeId: sourceNodeId,
        pendingCompletionSubmittedAt: null,
        pendingCompletionReason: null,
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
        // The task is leaving `approved` → done: drop the durable source field
        // alongside the other post-approval tracking fields. (This branch writes
        // status directly via taskRepo, bypassing setTaskStatus' centralised
        // approved-exit clear, so it must null the field itself.)
        postApprovalSourceNodeId: null,
      };
      this.deps.taskRepo.updateTask(task.id, updates);
      // Best-effort Forge evidence capture — must not block approval routing.
      try {
        this.deps.evolutionScopeService?.captureCompletedTaskEvidence({ taskId: task.id });
      } catch (err) {
        log.warn(
          `Forge evidence capture threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
      // Best-effort goal terminal handling — must not block approval routing.
      try {
        this.deps.goalService?.handleTaskTerminal(task.id);
      } catch (err) {
        log.warn(
          `Goal terminal handling threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
      log.info(
        `post-approval.route: spaceId=${task.spaceId} taskId=${task.id} sourceNodeId=${sourceNodeId ?? 'none'} routes=0 mode=none autonomyLevel=${context.autonomyLevel ?? 'unknown'}`
      );
      log.info(
        `task.status-transition: taskId=${task.id} from=approved to=done source=no-post-approval`
      );
      return { mode: 'no-route', taskStatus: 'done' };
    }

    // -------------------------------------------------------------------
    // 2. Node-agent dispatch: deliver the (single) post-approval route.
    // -------------------------------------------------------------------
    // Approval is a task-level event, so the router scans EVERY node to find
    // the declared route — the merger fires regardless of which node submitted
    // or approved. But multi-route fan-out is NOT supported: completion is
    // uncoordinated (`mark_complete` closes the shared task), the singular
    // `postApprovalSessionId` can track only one session, and the sibling-
    // quiesce sweep excludes only that one session. Rather than ship half-
    // coordinated parallel post-approval workers, dispatch AT MOST ONE route
    // (the first declared). Every built-in workflow declares exactly one route
    // (the merger), so this is exact in practice; a custom or migrated workflow
    // that happens to declare more degrades to the first with a warning instead
    // of running broken parallel workers (e.g. two merge kickoffs into the same
    // PR). When Commit 2 moves the route to the agent slot, this collapses
    // further.
    if (dispatchable.length > 1) {
      log.warn(
        `PostApprovalRouter.route: task ${task.id} declares ${dispatchable.length} post-approval routes; multi-route fan-out is not supported. Only the first (targetAgent=${dispatchable[0]?.targetAgent}) will dispatch — extras ignored.`
      );
    }

    // Double-fire guard (§3.4): if a post-approval session is already live,
    // skip re-dispatch.
    if (task.postApprovalSessionId) {
      const alive = this.deps.livenessProbe
        ? this.deps.livenessProbe.isSessionAlive(task.postApprovalSessionId)
        : true;
      if (alive) {
        log.info(
          `PostApprovalRouter.route: task ${task.id} already has live post-approval session ${task.postApprovalSessionId}; skipping re-dispatch`
        );
        return {
          mode: 'already-routed',
          postApprovalSessionId: task.postApprovalSessionId,
        };
      }
    }

    // `workflow` is non-null whenever `dispatchable` is non-empty (routes come
    // from it), but narrow for the spawn call below.
    if (!workflow) {
      const reason = `task ${task.id}: cannot spawn post-approval sub-session without workflow`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      clearPendingCompletionState(this.deps.taskRepo, task.id);
      return { mode: 'skipped', reason };
    }

    const route = dispatchable[0]!;
    const { text: interpolatedInstructions, missingKeys } = interpolatePostApprovalTemplate(
      route.instructions ?? '',
      context
    );
    if (missingKeys.length > 0) {
      log.warn(
        `PostApprovalRouter.route: task ${task.id} kickoff referenced unknown keys: ${missingKeys.join(', ')}`
      );
    }
    if (!interpolatedInstructions.trim()) {
      const reason = `task ${task.id}: post-approval route (targetAgent=${route.targetAgent}) has an empty instructions template`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      clearPendingCompletionState(this.deps.taskRepo, task.id);
      return { mode: 'skipped', reason };
    }

    const startedAt = Date.now();
    const kickoffMessage = appendPostApprovalCompletionInstructions(interpolatedInstructions);
    const { sessionId } = await this.deps.spawner.spawnPostApprovalSubSession({
      task,
      workflow,
      targetAgent: route.targetAgent!,
      kickoffMessage,
    });

    this.deps.taskRepo.updateTask(task.id, {
      pendingCheckpointType: null,
      pendingCompletionSubmittedByNodeId: null,
      pendingCompletionSubmittedAt: null,
      pendingCompletionReason: null,
      postApprovalSessionId: sessionId,
      postApprovalStartedAt: startedAt,
      postApprovalBlockedReason: null,
    });

    log.info(
      `post-approval.route: spaceId=${task.spaceId} taskId=${task.id} sourceNodeId=${sourceNodeId ?? 'none'} routes=${dispatchable.length} dispatched=1 mode=spawn autonomyLevel=${context.autonomyLevel ?? 'unknown'} sessionId=${sessionId}`
    );
    return {
      mode: 'spawn',
      postApprovalSessionId: sessionId,
      postApprovalStartedAt: startedAt,
      missingKeys,
    };
  }
}
