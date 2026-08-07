/**
 * SpaceLifecycleEventEmitter — publishes `space`-source external events for
 * meaningful task / goal lifecycle transitions so subscribed long-horizon agents
 * wake and can react (e.g. a coordinator subscribed to `space/task.*` reacts to
 * a task it routed reaching `blocked` or `done`).
 *
 * This is the producer counterpart to the subscription trie in
 * `space-runtime.ts`: until this emitter existed, `KNOWN_SOURCES` listed
 * `'space'` but no daemon code ever published a space-source event, so
 * subscribed owner agents never woke.
 *
 * Topic shape — **two segments**, `space/<resource>.<action>`:
 *   - `space/task.<action>`   (action: created | in_progress | blocked | review | done | cancelled)
 *   - `space/goal.<action>`   (action: task_triggered | progress | status | check_in)
 *
 * This matches the existing long-horizon subscription patterns
 * (`task.*` / `task.done` / `goal.*` → composed to `space/task.*` etc.), which
 * are depth-2 globs. An entity id is intentionally NOT a topic segment: doing so
 * would make the topic depth-3 and break both the depth-2 wildcards (`task.*`)
 * and the exact-action subscriptions (`task.done`). The entity id and full
 * details travel in the `payload` + `summary`, where subscribers read them.
 *
 * Dedupe / feedback-loop safety — each `dedupeKey` is anchored on a monotonic
 * per-transition value (the entity's `updatedAt`/`createdAt`, or the spawned
 * task id for goal triggers):
 *   - Re-emitting the *same* transition (e.g. a retry, or an agent reacting to
 *     an event it triggered by re-applying the identical state) produces the
 *     same key → `ExternalEventStore` short-circuits it once terminal. No loop.
 *   - A genuinely *new* transition (blocked → open → blocked) lands at a fresh
 *     timestamp → a distinct key → a new event. Correct: it IS a new transition.
 *
 * All emits are best-effort (fire-and-forget with a logged catch): a publish
 * failure must never roll back or block the lifecycle write that triggered it.
 */

import type {
  SpaceBlockReason,
  SpaceGoal,
  SpaceGoalStatus,
  SpaceTask,
  SpaceTaskStatus,
} from '@hyperneo/shared';
import type { ExternalEventPublisher, PublishResult } from '../../external-events';
import { Logger } from '../../logger';

const log = new Logger('space-lifecycle-event-emitter');

/**
 * Task statuses surfaced as their own `space/task.<status>` event. `open`,
 * `approved`, and `archived` are intentionally excluded — they are not in the
 * lifecycle contract and would only add noise (a task becoming `open` is the
 * default post-create state, `approved` is an internal post-approval step, and
 * `archived` is a tombstone the coordinator does not act on).
 */
const TASK_STATUS_ACTIONS: ReadonlySet<SpaceTaskStatus> = new Set<SpaceTaskStatus>([
  'in_progress',
  'blocked',
  'review',
  'done',
  'cancelled',
]);

/** A task *status* that has its own `space/task.<status>` event (excludes `created`). */
type SpaceTaskStatusAction = 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled';

/** Any task action surfaced as a `space/task.<action>` topic. */
type SpaceTaskAction = 'created' | SpaceTaskStatusAction;

/** Type guard narrowing a status to the surfaced {@link SpaceTaskStatusAction} set. */
function isTaskStatusAction(status: SpaceTaskStatus): status is SpaceTaskStatusAction {
  return TASK_STATUS_ACTIONS.has(status);
}

type SpaceGoalAction = 'task_triggered' | 'progress' | 'status' | 'check_in' | 'done';

export class SpaceLifecycleEventEmitter {
  constructor(private readonly publisher: ExternalEventPublisher) {}

  // ---------------------------------------------------------------------------
  // Task lifecycle
  // ---------------------------------------------------------------------------

  /** Emit `space/task.created`. Safe to call for any newly created task. */
  emitTaskCreated(task: SpaceTask): Promise<PublishResult> {
    return this.publish({
      spaceId: task.spaceId,
      topic: 'space/task.created',
      dedupeKey: `task:${task.id}:created:${task.createdAt}`,
      summary: `Task #${task.taskNumber} created: ${task.title}`,
      payload: taskPayload(task, 'created'),
    });
  }

  /**
   * Emit `space/task.<newStatus>` for a meaningful status transition.
   *
   * Returns `null` (and emits nothing) when the transition is not in
   * {@link TASK_STATUS_ACTIONS} or when `from === task.status` (no actual
   * change). Callers may therefore invoke it unconditionally after a status
   * write and let this method decide whether the transition is worth publishing.
   */
  emitTaskStatusChanged(task: SpaceTask, from: SpaceTaskStatus): Promise<PublishResult> | null {
    const to = task.status;
    if (from === to || !isTaskStatusAction(to)) return null;
    const anchor = task.updatedAt ?? task.completedAt ?? task.createdAt;
    return this.publish({
      spaceId: task.spaceId,
      topic: `space/task.${to}`,
      // Include `from` so two distinct transitions into the same status from
      // different sources (e.g. open→blocked vs in_progress→blocked) never
      // collide even when they land in the same millisecond. The anchor
      // (updatedAt) distinguishes repeated transitions through the same edge.
      dedupeKey: `task:${task.id}:${from}:${to}:${anchor}`,
      summary: `Task #${task.taskNumber} (${task.title}) transitioned ${from} → ${to}`,
      payload: { ...taskPayload(task, to), from, to },
    });
  }

  // ---------------------------------------------------------------------------
  // Goal lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Emit `space/goal.task_triggered` when a goal run is dispatched (immediate
   * trigger or scheduled check-in producing a task). `taskId` is the spawned
   * task — a unique anchor so each distinct trigger publishes once.
   */
  emitGoalTaskTriggered(goal: SpaceGoal, taskId: string): Promise<PublishResult> {
    return this.publish({
      spaceId: goal.spaceId,
      topic: 'space/goal.task_triggered',
      dedupeKey: `goal:${goal.id}:task_triggered:${taskId}`,
      summary: `Goal "${goal.title}" triggered task ${taskId}`,
      payload: { ...goalPayload(goal, 'task_triggered'), taskId },
    });
  }

  /**
   * Emit `space/goal.status` when a goal's status changes. When the goal reaches
   * `completed`, also emits `space/goal.done` so subscribers keyed on the
   * `goal.done` topic (e.g. the marketing template) wake on completion — goal
   * statuses are `active|paused|completed|archived` (no literal `done`), so the
   * completion is mapped to the `done` action those subscriptions expect.
   */
  emitGoalStatusChanged(goal: SpaceGoal, from: SpaceGoalStatus): Promise<PublishResult> | null {
    const to = goal.status;
    if (from === to) return null;
    if (to === 'completed') {
      // Fire-and-forget the completion topic alongside the generic status event.
      this.publish({
        spaceId: goal.spaceId,
        topic: 'space/goal.done',
        dedupeKey: `goal:${goal.id}:done:${goal.updatedAt}`,
        summary: `Goal "${goal.title}" completed`,
        payload: { ...goalPayload(goal, 'done'), from, to },
      });
    }
    return this.publish({
      spaceId: goal.spaceId,
      topic: 'space/goal.status',
      dedupeKey: `goal:${goal.id}:status:${from}:${to}:${goal.updatedAt}`,
      summary: `Goal "${goal.title}" status ${from} → ${to}`,
      payload: { ...goalPayload(goal, 'status'), from, to },
    });
  }

  /**
   * Emit `space/goal.progress` when a goal's progress value changes.
   *
   * Returns `null` (and emits nothing) when the value did not change, so callers
   * can invoke it on every goal update without producing an event storm — only
   * an actual progress delta publishes.
   */
  emitGoalProgress(goal: SpaceGoal, previous: number | null): Promise<PublishResult> | null {
    if (previous === goal.progress) return null;
    return this.publish({
      spaceId: goal.spaceId,
      topic: 'space/goal.progress',
      dedupeKey: `goal:${goal.id}:progress:${previous}:${goal.progress}:${goal.updatedAt}`,
      summary: `Goal "${goal.title}" progress ${previous ?? 0} → ${goal.progress}`,
      payload: { ...goalPayload(goal, 'progress'), from: previous, to: goal.progress },
    });
  }

  /** Emit `space/goal.check_in` when a scheduled goal check-in fires. */
  emitGoalCheckIn(goal: SpaceGoal, taskId: string): Promise<PublishResult> {
    return this.publish({
      spaceId: goal.spaceId,
      topic: 'space/goal.check_in',
      dedupeKey: `goal:${goal.id}:check_in:${taskId}`,
      summary: `Goal "${goal.title}" scheduled check-in fired (task ${taskId})`,
      payload: { ...goalPayload(goal, 'check_in'), taskId },
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Publish a space-source external event, swallowing errors so a publish
   * failure can never break the lifecycle write that triggered it.
   *
   * The returned promise resolves with the {@link PublishResult} (so tests and
   * callers that care can inspect dedupe outcomes); production callers fire it
   * and forget.
   */
  private publish(params: {
    spaceId: string;
    topic: string;
    dedupeKey: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<PublishResult> {
    const now = Date.now();
    const result = this.publisher.publish({
      id: crypto.randomUUID(),
      spaceId: params.spaceId,
      source: 'space',
      topic: params.topic,
      dedupeKey: params.dedupeKey,
      occurredAt: now,
      ingestedAt: now,
      summary: params.summary,
      payload: params.payload,
    });
    // Ensure a rejected publish never surfaces as an unhandled rejection to the
    // caller that fire-and-forget'd it. Callers that `await` still see the
    // rejection via the returned promise; this only attaches a safety net for
    // the floating-promise case.
    result.catch((err) => {
      log.warn(
        `Failed to publish space lifecycle event "${params.topic}" for ` +
          `${params.spaceId}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    return result;
  }
}

/** Shared structured payload for a task lifecycle event. */
function taskPayload(task: SpaceTask, action: SpaceTaskAction): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    eventType: 'task',
    action,
    taskId: task.id,
    taskNumber: task.taskNumber,
    title: task.title,
    status: task.status,
    spaceId: task.spaceId,
  };
  if (task.goalId) payload.goalId = task.goalId;
  if (task.workflowRunId) payload.workflowRunId = task.workflowRunId;
  if (task.priority) payload.priority = task.priority;
  // Labels are required for subscribers that self-filter on label predicates
  // (research / marketing templates) under the pure-pub/sub decide-at-consumption
  // model.
  payload.labels = task.labels ?? [];
  if (task.blockReason) payload.blockReason = task.blockReason as SpaceBlockReason;
  if (task.result) payload.result = task.result;
  return payload;
}

/** Shared structured payload for a goal lifecycle event. */
function goalPayload(goal: SpaceGoal, action: SpaceGoalAction): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    eventType: 'goal',
    action,
    goalId: goal.id,
    title: goal.title,
    status: goal.status,
    type: goal.type,
    progress: goal.progress,
    spaceId: goal.spaceId,
  };
  // Parity with taskPayload: labels support the same consumption-time filtering
  // (e.g. the marketing template's goal.done label filter).
  payload.labels = goal.labels ?? [];
  if (goal.activeTaskId) payload.activeTaskId = goal.activeTaskId;
  if (goal.summary) payload.summary = goal.summary;
  return payload;
}
