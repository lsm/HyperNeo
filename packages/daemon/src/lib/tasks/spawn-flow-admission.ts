import type { NodeExecution, Space, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { validateExecutionAgainstWorkflow } from '../workflows/node-execution-validation.ts';
import { readRestartRecoveryNote } from './restart-recovery-note.ts';
import { decideSpawnExecutionAdmissionViaPipeline } from './spawn-admission-decision-pipeline.ts';
import type { SpawnExecutionFlowDeps, SpawnExecutionFlowInput } from './spawn-flow-contract.ts';
import {
  activatePoolAssignment,
  attachNodeAgent,
  bindExecutionSession,
  completeSpawn,
  kickoffSession,
  readBoundExecution,
  releaseTaskSpawnReservation,
  reserveAndSpawnSession,
  reserveTaskSpawn,
  settledCompletion,
  settledFailure,
  type SpawnFlowOutcome,
  type SpawnFlowSettled,
  type SpawnFlowState,
} from './spawn-flow-ladder.ts';

export function gatherSpawnFlowFacts(
  getFreshTask: SpawnExecutionFlowDeps['getFreshTask'],
  resolveSlot: SpawnExecutionFlowDeps['resolveSlot'],
  isSpawningExecution: SpawnExecutionFlowDeps['isSpawningExecution'],
  inspectIndexedSession: SpawnExecutionFlowDeps['inspectIndexedSession'],
  request: SpawnExecutionFlowInput
): { value: SpawnFlowState } | { reason: SpawnFlowSettled } {
  try {
    const freshTask = getFreshTask(request.task.id) ?? request.task;
    const workflowCheck = validateExecutionAgainstWorkflow(request.execution, request.workflow);
    return {
      value: {
        freshTask,
        slotResolution: resolveSlot(request.space, request.workflow, request.execution, freshTask),
        workflowValid: workflowCheck.valid,
        isSpawning: isSpawningExecution(request.execution.id),
        indexedSession: inspectIndexedSession(request.execution.agentSessionId),
        liveSessionId: null,
        spawnedSessionId: null,
        workspacePath: null,
        spawnTask: null,
        boundExecution: null,
        compensations: [],
        result: undefined,
      },
    };
  } catch (error) {
    return {
      reason: {
        settled: { status: 'error', stage: 'gather-spawn-admission', error, unwind: [] },
      },
    };
  }
}

export function selectSpawnFlowArm(state: SpawnFlowState): {
  spawn: SpawnFlowState;
  reuseLiveArm: typeof reuseLiveSessionStage | undefined;
  waitConcurrentArm: typeof waitConcurrentStage | undefined;
  rejectArm: typeof raiseSpawnRejectionStage | undefined;
} {
  const liveSessionId = state.indexedSession.alive ? state.indexedSession.sessionId : null;
  const admission = decideSpawnExecutionAdmissionViaPipeline({
    hasLiveIndexedSession: liveSessionId !== null,
    isSpawningExecution: state.isSpawning,
    taskStatus: state.freshTask.status,
    executionWorkflowValid: state.workflowValid,
    slotResolvable: state.slotResolution !== null,
  });
  const spawn = { ...state, liveSessionId };
  if (admission.action === 'reuse_live') {
    return {
      spawn,
      reuseLiveArm: reuseLiveSessionStage,
      waitConcurrentArm: undefined,
      rejectArm: undefined,
    };
  }
  if (admission.action === 'wait_concurrent') {
    return {
      spawn,
      reuseLiveArm: undefined,
      waitConcurrentArm: waitConcurrentStage,
      rejectArm: undefined,
    };
  }
  if (admission.action === 'reject_permanent' || admission.action === 'reject_transient') {
    return {
      spawn,
      reuseLiveArm: undefined,
      waitConcurrentArm: undefined,
      rejectArm: raiseSpawnRejectionStage,
    };
  }
  return { spawn, reuseLiveArm: undefined, waitConcurrentArm: undefined, rejectArm: undefined };
}

export interface ReuseLiveSessionDeps {
  rebindLiveExecution: SpawnExecutionFlowDeps['rebindLiveExecution'];
  syncReuseLiveWorkspace(
    task: SpaceTask,
    space: Space,
    execution: NodeExecution,
    sessionId: string
  ): void | Promise<void>;
  revertLiveExecutionRebind(execution: NodeExecution, sessionId: string): void;
  injectKickoffMessage: SpawnExecutionFlowDeps['injectKickoffMessage'];
}

export async function reuseLiveSessionStage(
  rebindLiveExecution: ReuseLiveSessionDeps['rebindLiveExecution'],
  syncReuseLiveWorkspace: ReuseLiveSessionDeps['syncReuseLiveWorkspace'],
  revertLiveExecutionRebind: ReuseLiveSessionDeps['revertLiveExecutionRebind'],
  injectKickoffMessage: ReuseLiveSessionDeps['injectKickoffMessage'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): Promise<{ reason: SpawnFlowSettled }> {
  const sessionId = state.liveSessionId!;
  try {
    if (state.freshTask.workflowRunId !== request.execution.workflowRunId) {
      throw new Error(
        `Task ${state.freshTask.id} is no longer attached to workflow run ${request.execution.workflowRunId}; refusing to reuse its live session`
      );
    }
    if (rebindLiveExecution(request.execution, sessionId) === 'superseded') {
      return { reason: settledFailure(state, 'superseded', 'rebind-live-session') };
    }
    try {
      await syncReuseLiveWorkspace(state.freshTask, request.space, request.execution, sessionId);
      const recoveryNote = readRestartRecoveryNote(request.execution);
      if (recoveryNote) {
        await injectKickoffMessage(sessionId, recoveryNote, request.execution.id);
      }
    } catch (error) {
      revertLiveExecutionRebind(request.execution, sessionId);
      throw error;
    }
    return { reason: settledCompletion({ kind: 'reused_session', sessionId }) };
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'rebind-live-session', error) };
  }
}

export function waitConcurrentStage(_state: SpawnFlowState): { reason: SpawnFlowSettled } {
  return { reason: settledCompletion({ kind: 'wait_concurrent' }) };
}

export function raiseSpawnRejectionStage(
  raiseSpawnRejection: SpawnExecutionFlowDeps['raiseSpawnRejection'],
  request: SpawnExecutionFlowInput,
  state: SpawnFlowState
): { reason: SpawnFlowSettled } {
  try {
    raiseSpawnRejection(state.freshTask, request.execution, request.workflow);
  } catch (error) {
    return { reason: settledFailure(state, 'error', 'raise-spawn-rejection', error) };
  }
  return { reason: settledCompletion(undefined) };
}

export function buildSpawnExecutionPipeline(
  deps: SpawnExecutionFlowDeps
): (request: SpawnExecutionFlowInput) => Promise<SpawnFlowOutcome> {
  return (
    superpipe({
      getFreshTask: deps.getFreshTask,
      getNodeExecution: deps.getNodeExecution,
      isSpawningExecution: deps.isSpawningExecution,
      inspectIndexedSession: deps.inspectIndexedSession,
      resolveSlot: deps.resolveSlot,
      reserveExecution: deps.reserveExecution,
      releaseExecution: deps.releaseExecution,
      reserveTaskSpawn: deps.reserveTaskSpawn,
      releaseTaskSpawn: deps.releaseTaskSpawn,
      cancelSpawnedSession: deps.cancelSpawnedSession,
      rebindLiveExecution: deps.rebindLiveExecution,
      syncReuseLiveWorkspace: (
        task: SpaceTask,
        space: Space,
        execution: NodeExecution,
        sessionId: string
      ) => deps.syncReuseLiveWorkspace?.(task, space, execution, sessionId),
      revertLiveExecutionRebind: (execution: NodeExecution, sessionId: string) =>
        deps.revertLiveExecutionRebind?.(execution, sessionId),
      raiseSpawnRejection: deps.raiseSpawnRejection,
      resolveSpawnSessionId: deps.resolveSpawnSessionId,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      createSpawnedSession: deps.createSpawnedSession,
      bindExecutionToSession: deps.bindExecutionToSession,
      attachNodeAgent: deps.attachNodeAgent,
      registerSpawnCompletionCallback: deps.registerSpawnCompletionCallback,
      buildKickoffMessage: deps.buildKickoffMessage,
      injectKickoffMessage: deps.injectKickoffMessage,
      activateSpawnedSessionPoolAssignment: deps.activateSpawnedSessionPoolAssignment,
    })('spawn-execution') as PipelineAPI
  )
    .input('request')
    .pipe(
      gatherSpawnFlowFacts,
      ['getFreshTask', 'resolveSlot', 'isSpawningExecution', 'inspectIndexedSession', 'request'],
      'result:spawn'
    )
    .pipe(selectSpawnFlowArm, 'spawn', ['spawn', 'reuseLiveArm', 'waitConcurrentArm', 'rejectArm'])
    .pipe(
      '?reuseLiveArm',
      [
        'rebindLiveExecution',
        'syncReuseLiveWorkspace',
        'revertLiveExecutionRebind',
        'injectKickoffMessage',
        'request',
        'spawn',
      ],
      'result:spawn'
    )
    .pipe('?waitConcurrentArm', 'spawn', 'result:spawn')
    .pipe('?rejectArm', ['raiseSpawnRejection', 'request', 'spawn'], 'result:spawn')
    .pipe(
      reserveTaskSpawn,
      ['reserveTaskSpawn', 'releaseTaskSpawn', 'request', 'spawn'],
      'result:spawn'
    )
    .pipe(
      reserveAndSpawnSession,
      [
        'reserveExecution',
        'releaseExecution',
        'cancelSpawnedSession',
        'resolveSpawnSessionId',
        'resolveWorkspacePath',
        'getFreshTask',
        'createSpawnedSession',
        'request',
        'spawn',
      ],
      'result:spawn'
    )
    .pipe(bindExecutionSession, ['bindExecutionToSession', 'request', 'spawn'], 'result:spawn')
    .pipe(readBoundExecution, ['getNodeExecution', 'request', 'spawn'], 'result:spawn')
    .pipe(releaseTaskSpawnReservation, ['releaseTaskSpawn', 'request', 'spawn'], 'result:spawn')
    .pipe(
      attachNodeAgent,
      ['attachNodeAgent', 'registerSpawnCompletionCallback', 'request', 'spawn'],
      'result:spawn'
    )
    .pipe(
      kickoffSession,
      ['buildKickoffMessage', 'injectKickoffMessage', 'request', 'spawn'],
      'result:spawn'
    )
    .pipe(
      activatePoolAssignment,
      ['activateSpawnedSessionPoolAssignment', 'request', 'spawn'],
      'result:spawn'
    )
    .pipe(completeSpawn, 'spawn', 'result:spawn')
    .endAsync('spawn') as (request: SpawnExecutionFlowInput) => Promise<SpawnFlowOutcome>;
}
