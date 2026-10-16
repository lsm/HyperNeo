import type {
  EvidenceRef,
  GoalEvolutionAutomationTriggerKind,
  GoalEvolutionAutomationPolicy,
  SpaceTask,
} from '@hyperneo/shared';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import { readCompletedTaskThreshold } from '../goals/automation-policy.ts';

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
  triggerKind: GoalEvolutionAutomationTriggerKind;
  triggerKey: string;
  reason: 'task_completed' | 'self_nag' | 'external_event';
  taskId?: string;
  scheduleId?: string;
  externalEventId?: string;
  externalEvent?: GoalAutomationExternalEventSnapshot;
  activeReviewRequeueCount?: number;
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

export type AutomationGoal = NonNullable<ReturnType<SpaceGoalRepository['getById']>>;

export type AutomationScope = NonNullable<ReturnType<EvolutionRepository['getScope']>>;

export type AutomationSkip = {
  skipReason: NonNullable<GoalAutomationExecuteResult['skipReason']>;
  evidenceCount?: number;
};

export interface AutomationFacts {
  goal: AutomationGoal;
  scope: AutomationScope;
  policy: GoalEvolutionAutomationPolicy;
  maxEvidence: number;
  dueEvidence: EvidenceRef[];
  evidence: EvidenceRef[];
  triggerEvidence: EvidenceRef | null;
}

type AutomationGate<T> = { value: T } | { reason: AutomationSkip };

export function requireAutomationGoal(goal: AutomationGoal | null): AutomationGate<AutomationGoal> {
  return goal ? { value: goal } : { reason: { skipReason: 'missing_goal' } };
}

export function requireActiveAutomationGoal(goal: AutomationGoal): AutomationGate<AutomationGoal> {
  return goal.status === 'active' ? { value: goal } : { reason: { skipReason: 'inactive_goal' } };
}

export function requireAutomationScope(
  scope: AutomationScope | null,
  goal: AutomationGoal
): AutomationGate<AutomationScope> {
  return scope && scope.spaceGoalId === goal.id && scope.spaceId === goal.spaceId
    ? { value: scope }
    : { reason: { skipReason: 'missing_scope' } };
}

export function requireAutomationEvidence(facts: AutomationFacts): AutomationGate<AutomationFacts> {
  return facts.evidence.length ? { value: facts } : { reason: { skipReason: 'no_evidence' } };
}

export function requireEnabledAutomation(
  facts: AutomationFacts,
  payload: GoalAutomationExecutePayload
): AutomationGate<AutomationFacts> {
  return payload.triggerKind === 'completed_task_threshold' &&
    facts.goal.type !== 'recurring' &&
    facts.policy.completedTaskThreshold === undefined
    ? { reason: { skipReason: 'disabled' } }
    : { value: facts };
}

export function requireAutomationThreshold(
  facts: AutomationFacts,
  payload: GoalAutomationExecutePayload
): AutomationGate<AutomationFacts> {
  if (payload.triggerKind !== 'completed_task_threshold') return { value: facts };
  const threshold = readCompletedTaskThreshold(facts.policy);
  const completedTaskIds = new Set(
    facts.dueEvidence
      .filter((item) => item.kind === 'task_result' && item.sourceId !== null)
      .map((item) => item.sourceId as string)
  );
  return !threshold || completedTaskIds.size < threshold
    ? { reason: { skipReason: 'below_threshold', evidenceCount: facts.dueEvidence.length } }
    : { value: facts };
}

export function requireNoActiveAutomationReview(
  facts: AutomationFacts,
  payload: GoalAutomationExecutePayload,
  activeReview: SpaceTask | null
): AutomationGate<AutomationFacts> {
  return payload.triggerKind === 'completed_task_threshold' && activeReview
    ? { reason: { skipReason: 'active_review', evidenceCount: facts.dueEvidence.length } }
    : { value: facts };
}

export function requireUnlockedAutomation(
  facts: AutomationFacts,
  payload: GoalAutomationExecutePayload,
  locked: boolean
): AutomationGate<AutomationFacts> {
  return payload.triggerKind === 'completed_task_threshold' && locked
    ? { reason: { skipReason: 'active_review', evidenceCount: facts.dueEvidence.length } }
    : { value: facts };
}
