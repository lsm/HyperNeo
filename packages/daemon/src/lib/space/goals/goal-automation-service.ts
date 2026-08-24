import type {
  EvidenceRef,
  EvolutionScope,
  GoalForgeAutomationEventSubscription,
  GoalForgeAutomationPolicy,
  SpaceGoal,
  SpaceTask,
} from '@hyperneo/shared';
import { GOAL_AUTOMATION_EXECUTE } from '../../job-queue-constants.ts';
import type { ExternalEventPublishedPayload } from '../../external-events/external-event-service.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { EvolutionRepository } from '../../../storage/repositories/evolution-repository.ts';
import type { GoalAutomationCursorRepository } from '../../../storage/repositories/goal-automation-cursor-repository.ts';
import type { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { EvolutionScopeService } from '../evolution-scope-service.ts';
import type { GoalAutomationExecutePayload } from '../../job-handlers/goal-automation-execute.handler.ts';
import { Logger } from '../../logger.ts';

export const DEFAULT_COMPLETED_TASK_THRESHOLD = 10;
const DEFAULT_MAX_EVIDENCE_PER_EPISODE = 12;
const log = new Logger('goal-automation-service');

export interface GoalAutomationServiceDeps {
  goalRepo: SpaceGoalRepository;
  taskRepo: SpaceTaskRepository;
  evolutionRepo: EvolutionRepository;
  cursorRepo: GoalAutomationCursorRepository;
  jobQueue: Pick<JobQueueRepository, 'enqueueUniquePending'>;
  evolutionScopeService: Pick<EvolutionScopeService, 'resolveScopeForTask'>;
}

export interface GoalAutomationEnqueueResult {
  enqueued: boolean;
  reason:
    | 'below_threshold'
    | 'missing_scope'
    | 'ambiguous_scope'
    | 'disabled'
    | 'queued'
    | 'not_applicable';
  count?: number;
}

export class GoalAutomationService {
  constructor(private readonly deps: GoalAutomationServiceDeps) {}

  onTaskCompleted(taskId: string): GoalAutomationEnqueueResult {
    const task = this.deps.taskRepo.getTask(taskId);
    if (!task || task.status !== 'done' || !task.goalId) {
      return { enqueued: false, reason: 'not_applicable' };
    }
    const goal = this.deps.goalRepo.getById(task.goalId);
    if (!isActiveGoal(goal) || goal.spaceId !== task.spaceId) {
      return { enqueued: false, reason: 'disabled' };
    }
    if (!task.evolutionScopeId) {
      const scopes = this.deps.evolutionRepo.listScopes({
        spaceId: task.spaceId,
        spaceGoalId: goal.id,
      });
      if (scopes.length > 1) return { enqueued: false, reason: 'ambiguous_scope' };
    }
    const scope = this.deps.evolutionScopeService.resolveScopeForTask({ taskId });
    if (!scope) return { enqueued: false, reason: 'missing_scope' };
    const policy = readAutomationPolicyForScope(scope);
    const threshold = readCompletedTaskThreshold(policy);
    if (threshold === null) return { enqueued: false, reason: 'disabled' };
    if (goal.type !== 'recurring' && policy.completedTaskThreshold === undefined) {
      return { enqueued: false, reason: 'disabled' };
    }
    const triggerKey = completedTaskTriggerKey(threshold);
    const cursor = latestCompletedTaskCursor(this.deps.cursorRepo, goal.id, scope.id, triggerKey);
    const dueEvidence = selectEvidenceAfterCursor(
      this.deps.evolutionRepo.listEvidence(scope.id),
      cursor?.lastEvidenceCreatedAt ?? null,
      Number.POSITIVE_INFINITY,
      cursor?.lastEvidenceId ?? null
    ).filter((item) => item.kind === 'task_result' && item.sourceId !== null);
    const completedTaskIds = new Set(dueEvidence.map((item) => item.sourceId as string));
    if (completedTaskIds.size < threshold) {
      return { enqueued: false, reason: 'below_threshold', count: completedTaskIds.size };
    }
    this.enqueue({
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey,
      reason: 'task_completed',
      taskId,
    });
    return { enqueued: true, reason: 'queued', count: completedTaskIds.size };
  }

  onSelfNag(goalId: string, scheduleId: string, scopeId?: string): GoalAutomationEnqueueResult {
    const goal = this.deps.goalRepo.getById(goalId);
    if (!isActiveGoal(goal)) return { enqueued: false, reason: 'disabled' };
    const scope = scopeId
      ? this.deps.evolutionRepo.getScope(scopeId)
      : resolveScopeForGoal(this.deps.evolutionRepo, goal);
    if (!scope || scope.spaceGoalId !== goal.id || scope.spaceId !== goal.spaceId) {
      return { enqueued: false, reason: 'missing_scope' };
    }
    const policy = readAutomationPolicyForScope(scope);
    if (!policy.selfNagCronExpression) return { enqueued: false, reason: 'disabled' };
    const cursor = this.deps.cursorRepo.get(goal.id, scope.id, 'self_nag', scheduleId);
    const evidence = selectEvidenceAfterCursor(
      this.deps.evolutionRepo.listEvidence(scope.id),
      cursor?.lastEvidenceCreatedAt ?? null,
      Number.POSITIVE_INFINITY,
      cursor?.lastEvidenceId ?? null
    );
    if (evidence.length === 0) return { enqueued: false, reason: 'not_applicable', count: 0 };
    this.enqueue({
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'self_nag',
      triggerKey: scheduleId,
      reason: 'self_nag',
      scheduleId,
    });
    return { enqueued: true, reason: 'queued' };
  }

  onExternalEventPublished(event: ExternalEventPublishedPayload): GoalAutomationEnqueueResult[] {
    const goals = this.deps.goalRepo.list({ spaceId: event.spaceId, status: 'active' });
    const results: GoalAutomationEnqueueResult[] = [];
    for (const goal of goals) {
      const scopes = this.deps.evolutionRepo.listScopes({
        spaceId: goal.spaceId,
        spaceGoalId: goal.id,
      });
      if (scopes.length === 0) {
        results.push({ enqueued: false, reason: 'missing_scope' });
        continue;
      }
      for (const scope of scopes) {
        const policy = readAutomationPolicyForScope(scope);
        const subscription = findMatchingSubscription(policy.eventSubscriptions, event);
        if (!subscription) continue;
        const triggerKey = externalEventTriggerKey(subscription);
        const cursor = this.deps.cursorRepo.get(goal.id, scope.id, 'external_event', triggerKey);
        if (cursor?.lastExternalEventId === event.eventId) {
          results.push({ enqueued: false, reason: 'not_applicable' });
          continue;
        }
        this.enqueue({
          goalId: goal.id,
          scopeId: scope.id,
          triggerKind: 'external_event',
          triggerKey,
          reason: 'external_event',
          externalEventId: event.eventId,
          externalEvent: {
            source: event.source,
            topic: event.topic,
            summary: event.summary,
            externalUrl: event.externalUrl,
            payload: event.payload,
            occurredAt: event.occurredAt,
            ingestedAt: event.ingestedAt,
          },
        });
        results.push({ enqueued: true, reason: 'queued' });
      }
    }
    return results;
  }

  private enqueue(payload: GoalAutomationExecutePayload): void {
    const job = this.deps.jobQueue.enqueueUniquePending({
      queue: GOAL_AUTOMATION_EXECUTE,
      payload,
      matchPayload: uniqueJobMatchPayload(payload),
      activeStatuses: payload.triggerKind === 'completed_task_threshold' ? ['pending'] : undefined,
      maxRetries: 2,
    });
    if (!job) log.debug('goal automation job already pending', payload);
  }
}

export function readAutomationPolicyForScope(
  scope: EvolutionScope | null | undefined
): GoalForgeAutomationPolicy {
  return normalizePolicy(scope?.policy.automation);
}

export function resolveScopeForGoal(
  evolutionRepo: Pick<EvolutionRepository, 'listScopes'>,
  goal: SpaceGoal
): EvolutionScope | null {
  return evolutionRepo.listScopes({ spaceId: goal.spaceId, spaceGoalId: goal.id })[0] ?? null;
}

export function selectEvidenceAfterCursor(
  evidence: EvidenceRef[],
  lastEvidenceCreatedAt: number | null,
  limit = DEFAULT_MAX_EVIDENCE_PER_EPISODE,
  lastEvidenceId: string | null = null
): EvidenceRef[] {
  return evidence
    .filter(
      (item) =>
        lastEvidenceCreatedAt === null ||
        item.createdAt > lastEvidenceCreatedAt ||
        (item.createdAt === lastEvidenceCreatedAt &&
          (lastEvidenceId === null || item.id > lastEvidenceId))
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function completedTaskTriggerKey(threshold: number): string {
  return `threshold:${threshold}`;
}

export function externalEventTriggerKey(
  subscription: GoalForgeAutomationEventSubscription
): string {
  return `event:${subscription.source ?? '*'}:${subscription.topic}`;
}

function latestCompletedTaskCursor(
  cursorRepo: GoalAutomationCursorRepository,
  goalId: string,
  scopeId: string,
  triggerKey: string
) {
  return newestCursor(
    cursorRepo.get(goalId, scopeId, 'completed_task_threshold', triggerKey),
    cursorRepo.getLatestForTriggerKind(goalId, scopeId, 'completed_task_threshold')
  );
}

function newestCursor<
  T extends {
    lastEvidenceCreatedAt: number | null;
    lastEvidenceId: string | null;
    updatedAt: number;
  },
>(first: T | null, second: T | null): T | null {
  if (!first) return second;
  if (!second) return first;
  const firstEvidence = first.lastEvidenceCreatedAt ?? 0;
  const secondEvidence = second.lastEvidenceCreatedAt ?? 0;
  if (firstEvidence !== secondEvidence) return firstEvidence > secondEvidence ? first : second;
  const firstEvidenceId = first.lastEvidenceId ?? '';
  const secondEvidenceId = second.lastEvidenceId ?? '';
  if (firstEvidenceId !== secondEvidenceId) {
    return firstEvidenceId.localeCompare(secondEvidenceId) >= 0 ? first : second;
  }
  return first.updatedAt >= second.updatedAt ? first : second;
}

export function readCompletedTaskThreshold(policy: GoalForgeAutomationPolicy): number | null {
  if (policy.completedTaskAutomationEnabled === false) return null;
  const threshold = policy.completedTaskThreshold;
  if (threshold === undefined) return DEFAULT_COMPLETED_TASK_THRESHOLD;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null;
  const normalized = Math.floor(threshold);
  return normalized > 0 ? normalized : null;
}

function normalizePolicy(value: unknown): GoalForgeAutomationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    completedTaskThreshold:
      typeof record.completedTaskThreshold === 'number' ? record.completedTaskThreshold : undefined,
    completedTaskAutomationEnabled:
      typeof record.completedTaskAutomationEnabled === 'boolean'
        ? record.completedTaskAutomationEnabled
        : undefined,
    selfNagCronExpression:
      typeof record.selfNagCronExpression === 'string'
        ? record.selfNagCronExpression.trim()
        : undefined,
    selfNagTimezone:
      typeof record.selfNagTimezone === 'string' ? record.selfNagTimezone.trim() : undefined,
    eventSubscriptions: Array.isArray(record.eventSubscriptions)
      ? record.eventSubscriptions.flatMap((item) => normalizeSubscription(item))
      : undefined,
    maxEvidencePerEpisode:
      typeof record.maxEvidencePerEpisode === 'number' ? record.maxEvidencePerEpisode : undefined,
  };
}

function normalizeSubscription(value: unknown): GoalForgeAutomationEventSubscription[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.topic !== 'string' || !record.topic.trim()) return [];
  const filter =
    record.filter && typeof record.filter === 'object' && !Array.isArray(record.filter)
      ? (record.filter as Record<string, string | number | boolean | null>)
      : undefined;
  return [
    {
      topic: record.topic.trim(),
      source:
        typeof record.source === 'string' && record.source.trim()
          ? record.source.trim()
          : undefined,
      filter,
    },
  ];
}

function findMatchingSubscription(
  subscriptions: GoalForgeAutomationEventSubscription[] | undefined,
  event: ExternalEventPublishedPayload
): GoalForgeAutomationEventSubscription | null {
  for (const subscription of subscriptions ?? []) {
    if (subscription.source && subscription.source !== event.source) continue;
    if (!topicMatches(subscription.topic, event.topic)) continue;
    if (!filterMatches(subscription.filter, event.payload)) continue;
    return subscription;
  }
  return null;
}

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic || pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(topic);
}

function filterMatches(
  filter: Record<string, string | number | boolean | null> | undefined,
  payload: Record<string, unknown>
): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (payload[key] !== expected) return false;
  }
  return true;
}

function uniqueJobMatchPayload(payload: GoalAutomationExecutePayload): Record<string, unknown> {
  const matchPayload: Record<string, unknown> = {
    goalId: payload.goalId,
    scopeId: payload.scopeId,
    triggerKind: payload.triggerKind,
    triggerKey: payload.triggerKey,
  };
  if (payload.externalEventId !== undefined) {
    matchPayload.externalEventId = payload.externalEventId;
  }
  return matchPayload;
}

function isActiveGoal(goal: SpaceGoal | null): goal is SpaceGoal {
  return !!goal && goal.status === 'active';
}

export function maxCompletedTaskTimestamp(tasks: SpaceTask[]): number | null {
  const timestamps = tasks.flatMap((task) =>
    task.completedAt === null || task.completedAt === undefined ? [] : [task.completedAt]
  );
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

export function maxEvidenceCursor(
  evidence: EvidenceRef[]
): { createdAt: number; id: string } | null {
  if (evidence.length === 0) return null;
  return evidence.reduce(
    (max, item) =>
      item.createdAt > max.createdAt || (item.createdAt === max.createdAt && item.id > max.id)
        ? { createdAt: item.createdAt, id: item.id }
        : max,
    { createdAt: evidence[0].createdAt, id: evidence[0].id }
  );
}
