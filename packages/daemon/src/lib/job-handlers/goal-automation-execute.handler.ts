import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { EvidenceRef, GoalForgeAutomationTriggerKind, SpaceTask } from '@hyperneo/shared';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { GoalAutomationCursorRepository } from '../../storage/repositories/goal-automation-cursor-repository.ts';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { EvolutionEpisodeService } from '../space/evolution-episode-service.ts';
import {
  maxCompletedTaskTimestamp,
  maxEvidenceCursor,
  readAutomationPolicyForScope,
  readCompletedTaskThreshold,
  selectEvidenceAfterCursor,
} from '../space/goals/goal-automation-service.ts';
import { GOAL_AUTOMATION_EXECUTE } from '../job-queue-constants.ts';
import { Logger } from '../logger.ts';

const log = new Logger('goal-automation-execute');
const MAX_ACTIVE_REVIEW_REQUEUES = 60;
const EXTENDED_REQUEUE_DELAY_MS = 300_000;
const activeAutomationLocks = new Set<string>();

function automationLockKey(payload: GoalAutomationExecutePayload): string {
  return `${payload.goalId}:${payload.scopeId}:${payload.triggerKind}`;
}

export interface GoalAutomationExternalEventSnapshot {
  source: string;
  topic: string;
  summary: string;
  externalUrl?: string;
  payload: Record<string, unknown>;
  occurredAt: number;
  ingestedAt: number;
}

export interface GoalAutomationExecutePayload extends Record<string, unknown> {
  goalId: string;
  scopeId: string;
  triggerKind: GoalForgeAutomationTriggerKind;
  triggerKey: string;
  reason: 'task_completed' | 'self_nag' | 'external_event';
  taskId?: string;
  scheduleId?: string;
  externalEventId?: string;
  externalEvent?: GoalAutomationExternalEventSnapshot;
  activeReviewRequeueCount?: number;
}

export interface GoalAutomationExecuteDeps {
  db?: BunDatabase;
  goalRepo: SpaceGoalRepository;
  taskRepo: SpaceTaskRepository;
  evolutionRepo: EvolutionRepository;
  cursorRepo: GoalAutomationCursorRepository;
  episodeService: Pick<EvolutionEpisodeService, 'createFromEvidence'>;
  taskCreatedEventHub?: {
    publish: (event: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  jobQueue?: Pick<JobQueueRepository, 'enqueueUniquePending'>;
}

export interface GoalAutomationExecuteResult extends Record<string, unknown> {
  goalId: string;
  scopeId: string;
  episodeId: string | null;
  reviewTaskId: string | null;
  evidenceCount: number;
  skipped: boolean;
  skipReason?:
    | 'missing_goal'
    | 'inactive_goal'
    | 'missing_scope'
    | 'no_evidence'
    | 'below_threshold'
    | 'active_review'
    | 'disabled';
  requeued?: boolean;
}

export async function handleGoalAutomationExecute(
  job: Job,
  deps: GoalAutomationExecuteDeps
): Promise<GoalAutomationExecuteResult> {
  const payload = validatePayload(job.payload);
  const goal = deps.goalRepo.getById(payload.goalId);
  if (!goal) return skipped(payload, 'missing_goal');
  if (goal.status !== 'active') return skipped(payload, 'inactive_goal');
  const scope = deps.evolutionRepo.getScope(payload.scopeId);
  if (!scope || scope.spaceGoalId !== goal.id || scope.spaceId !== goal.spaceId) {
    return skipped(payload, 'missing_scope');
  }
  if (payload.externalEvent) {
    ensureExternalEventEvidence(deps, payload, scope.id);
  }
  const cursor =
    payload.triggerKind === 'completed_task_threshold'
      ? newestCursor(
          deps.cursorRepo.get(goal.id, scope.id, payload.triggerKind, payload.triggerKey),
          deps.cursorRepo.getLatestForTriggerKind(goal.id, scope.id, 'completed_task_threshold')
        )
      : deps.cursorRepo.get(goal.id, scope.id, payload.triggerKind, payload.triggerKey);
  const policy = readAutomationPolicyForScope(scope);
  const maxEvidence = readMaxEvidence(policy.maxEvidencePerEpisode);
  const dueEvidence = selectEvidenceAfterCursor(
    deps.evolutionRepo.listEvidence(scope.id),
    cursor?.lastEvidenceCreatedAt ?? null,
    Number.POSITIVE_INFINITY,
    cursor?.lastEvidenceId ?? null
  );
  const evidence = dueEvidence.slice(0, maxEvidence);
  const triggerEvidence = findTriggerEvidence(dueEvidence, payload);
  if (evidence.length === 0) {
    return skipped(payload, 'no_evidence');
  }
  if (payload.triggerKind === 'completed_task_threshold') {
    if (goal.type !== 'recurring' && policy.completedTaskThreshold === undefined) {
      return skipped(payload, 'disabled');
    }
    const threshold = readCompletedTaskThreshold(policy);
    const completedTaskIds = new Set(
      dueEvidence
        .filter((item) => item.kind === 'task_result' && item.sourceId !== null)
        .map((item) => item.sourceId as string)
    );
    if (!threshold || completedTaskIds.size < threshold) {
      return skipped(payload, 'below_threshold', dueEvidence.length);
    }
    if (findActiveCompletedTaskReviewTask(deps, scope.id, payload)) {
      return requeueActiveReview(deps, payload, dueEvidence.length);
    }
    const lock = automationLockKey(payload);
    if (activeAutomationLocks.has(lock)) {
      return requeueActiveReview(deps, payload, dueEvidence.length);
    }
    activeAutomationLocks.add(lock);
  }

  try {
    let episodeEvidence = evidence;
    if (triggerEvidence && payload.triggerKind === 'completed_task_threshold') {
      const triggerIndex = dueEvidence.findIndex((item) => item.id === triggerEvidence.id);
      if (triggerIndex >= maxEvidence) {
        episodeEvidence = dueEvidence.slice(0, triggerIndex + 1);
      } else {
        episodeEvidence = uniqueEvidence([...evidence, triggerEvidence]);
      }
    } else if (triggerEvidence && payload.triggerKind === 'external_event') {
      episodeEvidence = uniqueEvidence([...evidence, triggerEvidence]);
    }
    const cursorEvidence =
      triggerEvidence && payload.triggerKind === 'completed_task_threshold'
        ? episodeEvidence
        : evidence;
    const existingAutomation = findExistingAutomationReviewTask(deps, scope.id, payload);
    if (existingAutomation) {
      advanceCursor(
        deps,
        payload,
        cursorEvidence,
        existingAutomation.reviewTask,
        existingAutomation.episodeId
      );
      return {
        goalId: goal.id,
        scopeId: scope.id,
        episodeId: existingAutomation.episodeId,
        reviewTaskId: existingAutomation.reviewTask.id,
        evidenceCount: episodeEvidence.length,
        skipped: false,
      };
    }

    const episodeResult = await deps.episodeService.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: episodeEvidence.map((item) => item.id),
      confirmLowConfidence: true,
    });
    const writeResult = runWriteTransaction(deps, () => {
      const reviewTask = createReviewTask(
        deps,
        goal.id,
        scope.id,
        episodeResult.episode.id,
        episodeEvidence,
        payload
      );
      advanceCursor(deps, payload, cursorEvidence, reviewTask, episodeResult.episode.id);
      return reviewTask;
    });
    const reviewTask = writeResult;
    emitTaskCreated(deps, reviewTask);
    return {
      goalId: goal.id,
      scopeId: scope.id,
      episodeId: episodeResult.episode.id,
      reviewTaskId: reviewTask.id,
      evidenceCount: evidence.length,
      skipped: false,
    };
  } finally {
    if (payload.triggerKind === 'completed_task_threshold') {
      activeAutomationLocks.delete(automationLockKey(payload));
    }
  }
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

function findTriggerEvidence(
  dueEvidence: EvidenceRef[],
  payload: GoalAutomationExecutePayload
): EvidenceRef | null {
  if (payload.triggerKind === 'external_event' && payload.externalEventId) {
    return dueEvidence.find((item) => item.sourceId === payload.externalEventId) ?? null;
  }
  if (payload.triggerKind === 'completed_task_threshold' && payload.taskId) {
    return (
      dueEvidence.find((item) => item.kind === 'task_result' && item.sourceId === payload.taskId) ??
      null
    );
  }
  return null;
}

function uniqueEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function ensureExternalEventEvidence(
  deps: GoalAutomationExecuteDeps,
  payload: GoalAutomationExecutePayload,
  scopeId: string
): EvidenceRef | null {
  if (!payload.externalEvent || !payload.externalEventId) return null;
  const existing = deps.evolutionRepo
    .listEvidence(scopeId)
    .find(
      (item) =>
        item.kind === 'manual_note' &&
        item.sourceId === payload.externalEventId &&
        item.metadata.autoCaptured === true &&
        item.metadata.triggerKind === payload.triggerKind
    );
  if (existing) return existing;
  return runWriteTransaction(deps, () =>
    deps.evolutionRepo.createEvidence({
      scopeId,
      kind: 'manual_note',
      sourceId: payload.externalEventId as string,
      summary: `External event: ${payload.externalEvent?.summary}`,
      metadata: {
        autoCaptured: true,
        triggerKind: payload.triggerKind,
        source: payload.externalEvent?.source,
        topic: payload.externalEvent?.topic,
        externalUrl: payload.externalEvent?.externalUrl ?? null,
        payload: payload.externalEvent?.payload ?? {},
      },
      createdAt: payload.externalEvent?.ingestedAt ?? Date.now(),
    })
  );
}

function runWriteTransaction<T>(deps: GoalAutomationExecuteDeps, fn: () => T): T {
  return deps.db ? deps.db.transaction(fn)() : fn();
}

function createReviewTask(
  deps: GoalAutomationExecuteDeps,
  goalId: string,
  scopeId: string,
  episodeId: string,
  evidence: EvidenceRef[],
  payload: GoalAutomationExecutePayload
): SpaceTask {
  const scope = deps.evolutionRepo.getScope(scopeId);
  if (!scope) throw new Error(`EvolutionScope not found: ${scopeId}`);
  return deps.taskRepo.createTask({
    spaceId: scope.spaceId,
    goalId,
    evolutionScopeId: scopeId,
    title: `Review Evolution retrospective: ${scope.name}`,
    description: [
      'Evolve generated a draft retrospective episode from automation-selected evidence.',
      `Episode: ${episodeId}`,
      `Automation trigger: ${automationTriggerToken(payload)}`,
      `Evidence selected:\n${evidence.map((item) => `- ${item.id}: ${item.summary}`).join('\n')}`,
      'Review candidate lessons and task proposals before accepting or creating follow-up work.',
    ].join('\n\n'),
    priority: 'normal',
    labels: ['forge', 'review', 'automation', automationTriggerToken(payload)],
  });
}

function findActiveCompletedTaskReviewTask(
  deps: GoalAutomationExecuteDeps,
  scopeId: string,
  _payload: GoalAutomationExecutePayload
): SpaceTask | null {
  const scope = deps.evolutionRepo.getScope(scopeId);
  if (!scope) return null;
  return (
    deps.taskRepo.listBySpace(scope.spaceId, true).find((task) => {
      if (task.evolutionScopeId !== scopeId) return false;
      if (!task.labels.includes('automation')) return false;
      if (!task.labels.some((label) => label.startsWith('automation:completed_task_threshold:'))) {
        return false;
      }
      return [
        'draft',
        'open',
        'in_progress',
        'review',
        'approved',
        'blocked',
        'rate_limited',
        'usage_limited',
      ].includes(task.status);
    }) ?? null
  );
}

function findExistingAutomationReviewTask(
  deps: GoalAutomationExecuteDeps,
  scopeId: string,
  payload: GoalAutomationExecutePayload
): { reviewTask: SpaceTask; episodeId: string } | null {
  const scope = deps.evolutionRepo.getScope(scopeId);
  if (!scope) return null;
  const token = automationTriggerToken(payload);
  const cursor =
    payload.triggerKind === 'completed_task_threshold'
      ? newestCursor(
          deps.cursorRepo.get(payload.goalId, scopeId, payload.triggerKind, payload.triggerKey),
          deps.cursorRepo.getLatestForTriggerKind(
            payload.goalId,
            scopeId,
            'completed_task_threshold'
          )
        )
      : deps.cursorRepo.get(payload.goalId, scopeId, payload.triggerKind, payload.triggerKey);
  const afterTimestamp = cursor?.lastFiredAt ?? 0;
  const task = deps.taskRepo.listBySpace(scope.spaceId, true).find((item) => {
    if (item.evolutionScopeId !== scopeId) return false;
    if (!item.labels.includes('automation') || !item.labels.includes(token)) return false;
    if (
      (payload.triggerKind === 'self_nag' || payload.triggerKind === 'completed_task_threshold') &&
      item.createdAt <= afterTimestamp
    ) {
      return false;
    }
    return true;
  });
  if (!task) return null;
  const match = task.description.match(/Episode: ([^\n]+)/);
  const episodeId = match?.[1]?.trim();
  return episodeId ? { reviewTask: task, episodeId } : null;
}

function automationTriggerToken(payload: GoalAutomationExecutePayload): string {
  return `automation:${payload.triggerKind}:${payload.triggerKey}:${payload.externalEventId ?? payload.taskId ?? payload.scheduleId ?? 'run'}`;
}

function advanceCursor(
  deps: GoalAutomationExecuteDeps,
  payload: GoalAutomationExecutePayload,
  evidence: EvidenceRef[],
  reviewTask: SpaceTask,
  episodeId: string
): void {
  const taskIds = new Set(evidence.flatMap((item) => (item.sourceId ? [item.sourceId] : [])));
  const tasks = Array.from(taskIds).flatMap((taskId) => {
    const task = deps.taskRepo.getTask(taskId);
    return task ? [task] : [];
  });
  const evidenceCursor = maxEvidenceCursor(evidence);
  deps.cursorRepo.upsert({
    spaceId: reviewTask.spaceId,
    goalId: payload.goalId,
    scopeId: payload.scopeId,
    triggerKind: payload.triggerKind,
    triggerKey: payload.triggerKey,
    lastEvidenceCreatedAt: evidenceCursor?.createdAt ?? null,
    lastEvidenceId: evidenceCursor?.id ?? null,
    lastTaskCompletedAt: maxCompletedTaskTimestamp(tasks),
    lastExternalEventId: payload.externalEventId ?? null,
    lastEpisodeId: episodeId,
    lastFiredAt: Date.now(),
    metadata: {
      reason: payload.reason,
      reviewTaskId: reviewTask.id,
      evidenceIds: evidence.map((item) => item.id),
    },
  });
}

function emitTaskCreated(deps: GoalAutomationExecuteDeps, task: SpaceTask): void {
  deps.taskCreatedEventHub
    ?.publish('space.task.created', {
      sessionId: 'global',
      spaceId: task.spaceId,
      taskId: task.id,
      task,
    })
    .catch((err) => log.warn('failed to publish automation review task', err));
}

function validatePayload(payload: Record<string, unknown>): GoalAutomationExecutePayload {
  const goalId = requiredString(payload.goalId, 'goalId');
  const scopeId = requiredString(payload.scopeId, 'scopeId');
  const triggerKind = enumValue(payload.triggerKind, [
    'completed_task_threshold',
    'self_nag',
    'external_event',
  ] as const);
  const triggerKey = requiredString(payload.triggerKey, 'triggerKey');
  const reason = enumValue(payload.reason, [
    'task_completed',
    'self_nag',
    'external_event',
  ] as const);
  return {
    goalId,
    scopeId,
    triggerKind,
    triggerKey,
    reason,
    taskId: optionalString(payload.taskId),
    scheduleId: optionalString(payload.scheduleId),
    externalEventId: optionalString(payload.externalEventId),
    externalEvent: normalizeExternalEvent(payload.externalEvent),
    activeReviewRequeueCount: optionalPositiveInteger(payload.activeReviewRequeueCount),
  };
}

function normalizeExternalEvent(value: unknown): GoalAutomationExternalEventSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    source: requiredString(record.source, 'externalEvent.source'),
    topic: requiredString(record.topic, 'externalEvent.topic'),
    summary: requiredString(record.summary, 'externalEvent.summary'),
    externalUrl: optionalString(record.externalUrl),
    payload:
      record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : {},
    occurredAt: typeof record.occurredAt === 'number' ? record.occurredAt : Date.now(),
    ingestedAt: typeof record.ingestedAt === 'number' ? record.ingestedAt : Date.now(),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readMaxEvidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 12;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function requeueActiveReview(
  deps: GoalAutomationExecuteDeps,
  payload: GoalAutomationExecutePayload,
  evidenceCount: number
): GoalAutomationExecuteResult {
  const requeueCount = readActiveReviewRequeueCount(payload);
  const requeuePayload = {
    ...payload,
    activeReviewRequeueCount: requeueCount + 1,
  };
  const delay = requeueCount >= MAX_ACTIVE_REVIEW_REQUEUES ? EXTENDED_REQUEUE_DELAY_MS : 60_000;
  deps.jobQueue?.enqueueUniquePending({
    queue: GOAL_AUTOMATION_EXECUTE,
    payload: requeuePayload,
    matchPayload: uniqueJobMatchPayload(payload),
    activeStatuses: ['pending'],
    maxRetries: 2,
    runAt: Date.now() + delay,
  });
  return {
    ...skipped(payload, 'active_review', evidenceCount),
    requeued: !!deps.jobQueue,
  };
}

function readActiveReviewRequeueCount(payload: GoalAutomationExecutePayload): number {
  const value = payload.activeReviewRequeueCount;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
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

function skipped(
  payload: GoalAutomationExecutePayload,
  skipReason: NonNullable<GoalAutomationExecuteResult['skipReason']>,
  evidenceCount = 0
): GoalAutomationExecuteResult {
  return {
    goalId: payload.goalId,
    scopeId: payload.scopeId,
    episodeId: null,
    reviewTaskId: null,
    evidenceCount,
    skipped: true,
    skipReason,
  };
}
