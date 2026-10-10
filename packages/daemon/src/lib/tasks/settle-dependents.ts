import { isRateOrUsageLimited, type SpaceTask, type SpaceTaskStatus } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DirectTaskAttempt } from '../../storage/repositories/direct-task-execution-repository.ts';
import { Logger } from '../logger.ts';
import type { DirectOutcomeAcknowledgement } from './direct-outcome-jobs.ts';
import type { DirectFinalizationInput } from './finalize-direct-attempt.ts';
import { StaleTaskGuardError, type SpaceTaskManager } from './task-manager.ts';

const log = new Logger('settle-task-dependents');

export interface DependentEvidence {
  task: SpaceTask;
  dependenciesDone: boolean;
  activeAttempt: DirectTaskAttempt | null;
}

export type DependentSettlement =
  | { kind: 'unblock'; task: SpaceTask }
  | { kind: 'block'; task: SpaceTask }
  | { kind: 'stop_workflow'; task: SpaceTask }
  | { kind: 'stop_direct'; task: SpaceTask; attempt: DirectTaskAttempt };

const DEPENDENCY_BLOCKS = new Set(['dependency_failed', 'dependency_added']);

function isRunning(status: SpaceTaskStatus): boolean {
  return status === 'in_progress' || isRateOrUsageLimited(status);
}

function settleCancelledDependent({
  task,
  activeAttempt,
}: DependentEvidence): DependentSettlement | null {
  if (task.status === 'open') return { kind: 'block', task };
  if (!isRunning(task.status)) return null;
  if (task.workflowRunId) return { kind: 'stop_workflow', task };
  return activeAttempt?.phase === 'running' && activeAttempt.sessionId === task.taskAgentSessionId
    ? { kind: 'stop_direct', task, attempt: activeAttempt }
    : { kind: 'block', task };
}

export function planDependentSettlement(
  endedStatus: SpaceTaskStatus,
  dependents: readonly DependentEvidence[]
): DependentSettlement[] {
  if (endedStatus === 'done')
    return dependents.flatMap(({ task, dependenciesDone }) =>
      task.status === 'blocked' && DEPENDENCY_BLOCKS.has(task.blockReason ?? '') && dependenciesDone
        ? [{ kind: 'unblock' as const, task }]
        : []
    );
  if (endedStatus === 'cancelled')
    return dependents.flatMap((dependent) => settleCancelledDependent(dependent) ?? []);
  return [];
}

export interface DependentSettlementDeps {
  getTaskManager: (
    spaceId: string
  ) => Pick<SpaceTaskManager, 'listTasks' | 'getTask' | 'setTaskStatus'>;
  getActiveAttempt: (taskId: string) => DirectTaskAttempt | null;
  stopForStatus?: (
    spaceId: string,
    taskId: string,
    params: { status: 'blocked'; blockReason: 'dependency_failed'; result: string },
    expected: { expectedStatus: SpaceTaskStatus }
  ) => Promise<SpaceTask | null>;
  requestDirectOutcome?: (input: DirectFinalizationInput) => DirectOutcomeAcknowledgement;
}

async function readDependents(
  ended: SpaceTask,
  deps: DependentSettlementDeps
): Promise<DependentEvidence[]> {
  const tasks = await deps.getTaskManager(ended.spaceId).listTasks(false);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks
    .filter((task) => task.dependsOn?.includes(ended.id))
    .map((task) => ({
      task,
      dependenciesDone: (task.dependsOn ?? []).every((id) => byId.get(id)?.status === 'done'),
      activeAttempt: deps.getActiveAttempt(task.id),
    }));
}

function planForEnded(ended: SpaceTask, dependents: DependentEvidence[]): DependentSettlement[] {
  return planDependentSettlement(ended.status, dependents);
}

async function applySettlement(
  settlement: DependentSettlement,
  ended: SpaceTask,
  deps: DependentSettlementDeps
): Promise<SpaceTask | null> {
  const { task } = settlement;
  const manager = deps.getTaskManager(task.spaceId);
  const result = `Dependency task ${ended.id} was cancelled`;
  const expectedStatus = task.status;
  try {
    switch (settlement.kind) {
      case 'unblock':
        return await manager.setTaskStatus(task.id, 'open', { expectedStatus });
      case 'block':
        return await manager.setTaskStatus(task.id, 'blocked', {
          blockReason: 'dependency_failed',
          result,
          expectedStatus,
        });
      case 'stop_workflow':
        return deps.stopForStatus
          ? await deps.stopForStatus(
              task.spaceId,
              task.id,
              { status: 'blocked', blockReason: 'dependency_failed', result },
              { expectedStatus }
            )
          : null;
      case 'stop_direct': {
        const { attempt } = settlement;
        deps.requestDirectOutcome?.({
          attemptId: attempt.id,
          sessionId: attempt.sessionId,
          generation: attempt.generation,
          status: 'blocked',
          options: { blockReason: 'dependency_failed', result },
        });
        return null;
      }
    }
  } catch (error) {
    if (error instanceof StaleTaskGuardError) return null;
    log.warn(
      `Could not settle dependent "${task.id}" of "${ended.id}": ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function applySettlements(
  settlements: readonly DependentSettlement[],
  ended: SpaceTask,
  deps: DependentSettlementDeps
): Promise<SpaceTask[]> {
  const settled: SpaceTask[] = [];
  for (const settlement of settlements) {
    const updated = await applySettlement(settlement, ended, deps);
    if (updated) settled.push(updated);
  }
  return settled;
}

export const settleTaskDependents = (superpipe({})('settle-task-dependents') as PipelineAPI)
  .input(['ended', 'deps'])
  .pipe(readDependents, ['ended', 'deps'], 'dependents')
  .pipe(planForEnded, ['ended', 'dependents'], 'settlements')
  .pipe(applySettlements, ['settlements', 'ended', 'deps'], 'settled')
  .endAsync('settled') as (ended: SpaceTask, deps: DependentSettlementDeps) => Promise<SpaceTask[]>;
