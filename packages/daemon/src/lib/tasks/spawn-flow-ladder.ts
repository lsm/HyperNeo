import type { NodeExecution, SpaceTask } from '@hyperneo/shared';
import type { StagedRunOutcome, StagedRunUnwindEntry } from '../space/runtime/staged-run.ts';
import { validateTaskAllowsSpawn } from '../workflows/node-execution-validation.ts';
import type {
  IndexedSessionInspection,
  SpawnExecutionFlowDeps,
  SpawnExecutionFlowInput,
} from './spawn-flow-contract.ts';
import type { WorkflowNodeSlotResolution } from './spawn-slot-resolution.ts';

export function isSpawnFlowSettled(outcome: SpawnFlowOutcome): outcome is SpawnFlowSettled {
  return 'settled' in outcome;
}

export interface SpawnCompensation {
  stage: string;
  undo: () => void;
}

export interface SpawnFlowState {
  freshTask: SpaceTask;
  slotResolution: WorkflowNodeSlotResolution | null;
  workflowValid: boolean;
  isSpawning: boolean;
  indexedSession: IndexedSessionInspection;
  liveSessionId: string | null;
  spawnedSessionId: string | null;
  workspacePath: string | null;
  spawnTask: SpaceTask | null;
  boundExecution: NodeExecution | null;
  compensations: SpawnCompensation[];
  result: unknown;
}

export interface SpawnFlowSettled {
  settled: StagedRunOutcome;
}

export type SpawnFlowOutcome = SpawnFlowState | SpawnFlowSettled;

export function unwindCompensations(
  compensations: readonly SpawnCompensation[]
): StagedRunUnwindEntry[] {
  const unwind: StagedRunUnwindEntry[] = [];
  for (let index = compensations.length - 1; index >= 0; index -= 1) {
    const entry = compensations[index];
    try {
      entry.undo();
      unwind.push({ stage: entry.stage, status: 'compensated' });
    } catch (error) {
      unwind.push({ stage: entry.stage, status: 'failed', error });
    }
  }
  return unwind;
}

export function settledFailure(
  state: SpawnFlowState,
  status: 'error' | 'superseded',
  stage: string,
  error?: unknown
): SpawnFlowSettled {
  return { settled: { status, stage, error, unwind: unwindCompensations(state.compensations) } };
}

export function settledCompletion(result: unknown): SpawnFlowSettled {
  return { settled: { status: 'completed', result } };
}

export function reserveTaskSpawn(
  reserveTaskSpawnDep: SpawnExecutionFlowDeps['reserveTaskSpawn'],
  releaseTaskSpawn: SpawnExecutionFlowDeps['releaseTaskSpawn'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): { value: SpawnFlowState } | { reason: SpawnFlowSettled } {
  try {
    if (reserveTaskSpawnDep(request.task.id) === 'superseded') {
      return {
        reason: settledFailure(
          {
            ...state,
            compensations: [
              ...state.compensations,
              { stage: 'reserve-task-spawn', undo: () => {} },
            ],
          },
          'superseded',
          'reserve-task-spawn'
        ),
      };
    }
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'reserve-task-spawn', error) };
  }
  return {
    value: {
      ...state,
      compensations: [
        ...state.compensations,
        { stage: 'reserve-task-spawn', undo: () => releaseTaskSpawn(request.task.id) },
      ],
    },
  };
}

export async function reserveAndSpawnSession(
  reserveExecution: SpawnExecutionFlowDeps['reserveExecution'],
  releaseExecution: SpawnExecutionFlowDeps['releaseExecution'],
  cancelSpawnedSession: SpawnExecutionFlowDeps['cancelSpawnedSession'],
  resolveSpawnSessionId: SpawnExecutionFlowDeps['resolveSpawnSessionId'],
  resolveWorkspacePath: SpawnExecutionFlowDeps['resolveWorkspacePath'],
  getFreshTask: SpawnExecutionFlowDeps['getFreshTask'],
  createSpawnedSession: SpawnExecutionFlowDeps['createSpawnedSession'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): Promise<{ value: SpawnFlowState } | { reason: SpawnFlowSettled }> {
  let sessionId: string | null = null;
  let compensations = state.compensations;
  try {
    reserveExecution(request.execution.id);
    compensations = [
      ...compensations,
      {
        stage: 'reserve-and-spawn-session',
        undo: () => {
          if (sessionId !== null) cancelSpawnedSession(sessionId);
          releaseExecution(request.execution.id);
        },
      },
    ];
    const spawnTask = state.freshTask ?? request.task;
    if (spawnTask.workflowRunId !== request.workflowRun.id) {
      throw new Error(
        `Task ${spawnTask.id} was reassigned to workflow run ${spawnTask.workflowRunId} during spawn`
      );
    }
    const resolvedSessionId = resolveSpawnSessionId(request.space, spawnTask, request.execution);
    const workspacePath = await resolveWorkspacePath(spawnTask, request.space);
    validateTaskAllowsSpawn(getFreshTask(request.task.id) ?? spawnTask);
    sessionId = await createSpawnedSession({
      task: spawnTask,
      space: request.space,
      workflow: request.workflow,
      workflowRun: request.workflowRun,
      execution: request.execution,
      node: state.slotResolution!.node,
      slot: state.slotResolution!.slot,
      sessionId: resolvedSessionId,
      workspacePath,
      kickoff: request.kickoff,
    });
    return {
      value: { ...state, compensations, spawnedSessionId: sessionId, workspacePath, spawnTask },
    };
  } catch (error) {
    return {
      reason: settledFailure(
        { ...state, compensations },
        'error',
        'reserve-and-spawn-session',
        error
      ),
    };
  }
}

export function bindExecutionSession(
  bindExecutionToSession: SpawnExecutionFlowDeps['bindExecutionToSession'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): { value: SpawnFlowState } | { reason: SpawnFlowSettled } {
  if (state.spawnedSessionId === null) return { value: state };
  try {
    if (bindExecutionToSession(request.execution, state.spawnedSessionId) === 'superseded') {
      return { reason: settledFailure(state, 'superseded', 'bind-execution-session') };
    }
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'bind-execution-session', error) };
  }
  return { value: state };
}

export function readBoundExecution(
  getNodeExecution: SpawnExecutionFlowDeps['getNodeExecution'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): { value: SpawnFlowState } | { reason: SpawnFlowSettled } {
  if (state.spawnedSessionId === null) return { value: state };
  let bound: NodeExecution | null;
  try {
    bound = getNodeExecution(request.execution.id);
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'read-bound-execution', error) };
  }
  if (!bound) {
    return {
      reason: settledFailure(
        state,
        'error',
        'read-bound-execution',
        new Error(`Spawn flow cannot re-read execution ${request.execution.id} after binding`)
      ),
    };
  }
  return { value: { ...state, boundExecution: bound } };
}

export function releaseTaskSpawnReservation(
  releaseTaskSpawn: SpawnExecutionFlowDeps['releaseTaskSpawn'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): { value: SpawnFlowState } | { reason: SpawnFlowSettled } {
  try {
    releaseTaskSpawn(request.task.id);
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'release-task-spawn', error) };
  }
  return { value: state };
}

export async function attachNodeAgent(
  attachNodeAgentDep: SpawnExecutionFlowDeps['attachNodeAgent'],
  registerSpawnCompletionCallback: SpawnExecutionFlowDeps['registerSpawnCompletionCallback'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): Promise<{ value: SpawnFlowState } | { reason: SpawnFlowSettled }> {
  if (state.spawnedSessionId === null) return { value: state };
  const sessionId = state.spawnedSessionId;
  const execution = state.boundExecution ?? request.execution;
  try {
    await attachNodeAgentDep({
      task: state.spawnTask!,
      space: request.space,
      workflowRun: request.workflowRun,
      execution,
      sessionId,
      workspacePath: state.workspacePath!,
    });
    registerSpawnCompletionCallback(state.spawnTask!.id, execution.workflowNodeId, sessionId);
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'attach-node-agent', error) };
  }
  return { value: state };
}

export async function kickoffSession(
  buildKickoffMessage: SpawnExecutionFlowDeps['buildKickoffMessage'],
  injectKickoffMessage: SpawnExecutionFlowDeps['injectKickoffMessage'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): Promise<{ value: SpawnFlowState } | { reason: SpawnFlowSettled }> {
  if (state.spawnedSessionId === null || !request.kickoff) return { value: state };
  const sessionId = state.spawnedSessionId;
  const slotResolution = state.slotResolution!;
  try {
    const message = await buildKickoffMessage({
      task: state.spawnTask!,
      space: request.space,
      workflow: request.workflow,
      workflowRun: request.workflowRun,
      execution: state.boundExecution ?? request.execution,
      node: slotResolution.node,
      slot: slotResolution.slot,
      sessionId,
      workspacePath: state.workspacePath!,
    });
    await injectKickoffMessage(sessionId, message, request.execution.id);
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'kickoff-session', error) };
  }
  return { value: state };
}

export function activatePoolAssignment(
  activateSpawnedSessionPoolAssignment: SpawnExecutionFlowDeps['activateSpawnedSessionPoolAssignment'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): { value: SpawnFlowState } | { reason: SpawnFlowSettled } {
  if (state.spawnedSessionId === null) return { value: state };
  try {
    activateSpawnedSessionPoolAssignment(request.execution.id, state.spawnedSessionId);
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'activate-pool-assignment', error) };
  }
  return { value: state };
}

export function completeSpawn(state: SpawnFlowState): { value: SpawnFlowState } {
  return { value: { ...state, result: state.spawnedSessionId } };
}
