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
 * `NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING` env var and
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
} from '@neokai/shared';
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
export const POST_APPROVAL_ROUTING_FLAG_ENV = 'NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING';

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
// Dispatch delegates
// ---------------------------------------------------------------------------

/**
 * Delegate for spawning the post-approval sub-session on the
 * space-task-node-agent path. Production wires this to
 * `TaskAgentManager.spawnPostApprovalSubSession`; tests pass a stub.
 *
 * The delegate is responsible for everything that differs between a regular
 * node activation and a post-approval activation:
 *   - Creating a `NodeExecution` row (or reusing the agent's existing session).
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
  | { mode: 'skipped'; reason: string };

// ---------------------------------------------------------------------------
// Event shapes (§2.3)
// ---------------------------------------------------------------------------

const POST_APPROVAL_COMPLETION_INSTRUCTIONS =
  `When the post-approval work is finished, call mark_complete to transition the\n` +
  `task from \`approved\` to \`done\`. If you need human input mid-work, call\n` +
  `request_human_input as usual.\n\n` +
  `Do NOT call approve_task; the task has already been approved upstream.`;

export function appendPostApprovalCompletionInstructions(interpolatedInstructions: string): string {
  const trimmed = interpolatedInstructions.trim();
  return `${trimmed}\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`;
}

function resolvePostApprovalRoute(
  task: SpaceTask,
  workflow: SpaceWorkflow | null
): { route: PostApprovalRoute | undefined; sourceNodeId: string | null } {
  if (!workflow) {
    return { route: undefined, sourceNodeId: null };
  }

  const sourceNodeId = task.pendingCompletionSubmittedByNodeId || workflow.endNodeId || null;
  const sourceNode = sourceNodeId
    ? (workflow.nodes.find((node) => node.id === sourceNodeId) ?? null)
    : null;

  return {
    route: sourceNode?.postApproval ?? workflow.postApproval,
    sourceNodeId: sourceNode?.id ?? sourceNodeId,
  };
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

    const { route, sourceNodeId } = resolvePostApprovalRoute(task, workflow);

    // -------------------------------------------------------------------
    // 1. No postApproval declared → close the task directly.
    // -------------------------------------------------------------------
    if (!route || !route.targetAgent) {
      const outcomeUpdates = this.deps.resolveCompletionOutcome?.(task) ?? null;
      const updates: UpdateSpaceTaskParams = {
        ...outcomeUpdates,
        status: 'done',
        completedAt: Date.now(),
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
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
        `post-approval.route: spaceId=${task.spaceId} taskId=${task.id} sourceNodeId=${sourceNodeId ?? 'none'} targetAgent=none mode=none autonomyLevel=${context.autonomyLevel ?? 'unknown'}`
      );
      log.info(
        `task.status-transition: taskId=${task.id} from=approved to=done source=no-post-approval`
      );
      return { mode: 'no-route', taskStatus: 'done' };
    }

    const { targetAgent, instructions } = route;

    // Legacy task-agent target: the built-in task-agent session was removed.
    // Persisted workflows may still reference targetAgent: "task-agent";
    // skip gracefully rather than attempting a spawn that will fail.
    if (targetAgent === POST_APPROVAL_TASK_AGENT_TARGET) {
      const reason = `task ${task.id}: legacy task-agent post-approval target is no longer supported; skipping`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      return { mode: 'skipped', reason };
    }
    // -------------------------------------------------------------------
    // 2. Node-agent spawn route.
    // -------------------------------------------------------------------
    // Double-fire guard (§3.4): skip when an existing session is alive.
    if (task.postApprovalSessionId) {
      const alive = this.deps.livenessProbe
        ? this.deps.livenessProbe.isSessionAlive(task.postApprovalSessionId)
        : true;
      if (alive) {
        log.info(
          `PostApprovalRouter.route: task ${task.id} already has live post-approval session ${task.postApprovalSessionId}; skipping re-spawn`
        );
        return {
          mode: 'already-routed',
          postApprovalSessionId: task.postApprovalSessionId,
        };
      }
    }

    // Interpolate the workflow-specific kickoff, then append the runtime-owned
    // completion instruction shared by every post-approval route.
    const { text: interpolatedInstructions, missingKeys } = interpolatePostApprovalTemplate(
      instructions ?? '',
      context
    );
    if (!interpolatedInstructions.trim()) {
      const reason = `task ${task.id}: node-agent post-approval has empty instructions template`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      return { mode: 'skipped', reason };
    }
    if (missingKeys.length > 0) {
      log.warn(
        `PostApprovalRouter.route: task ${task.id} kickoff referenced unknown keys: ${missingKeys.join(', ')}`
      );
    }
    if (!workflow) {
      const reason = `task ${task.id}: cannot spawn post-approval sub-session without workflow`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      return { mode: 'skipped', reason };
    }
    const kickoffMessage = appendPostApprovalCompletionInstructions(interpolatedInstructions);

    const startedAt = Date.now();
    const { sessionId } = await this.deps.spawner.spawnPostApprovalSubSession({
      task,
      workflow,
      targetAgent,
      kickoffMessage,
    });

    this.deps.taskRepo.updateTask(task.id, {
      postApprovalSessionId: sessionId,
      postApprovalStartedAt: startedAt,
      postApprovalBlockedReason: null,
    });

    log.info(
      `post-approval.route: spaceId=${task.spaceId} taskId=${task.id} sourceNodeId=${sourceNodeId ?? 'none'} targetAgent=${targetAgent} mode=spawn autonomyLevel=${context.autonomyLevel ?? 'unknown'} sessionId=${sessionId}`
    );
    return {
      mode: 'spawn',
      postApprovalSessionId: sessionId,
      postApprovalStartedAt: startedAt,
      missingKeys,
    };
  }
}
