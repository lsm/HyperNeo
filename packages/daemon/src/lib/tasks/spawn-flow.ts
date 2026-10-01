import type { NodeExecution, Space, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { StagedRunOutcome, StagedRunUnwindEntry } from '../space/runtime/staged-run.ts';
import {
  validateExecutionAgainstWorkflow,
  validateTaskAllowsSpawn,
} from '../workflows/node-execution-validation.ts';
import { readRestartRecoveryNote } from './restart-recovery-note.ts';
import { decideSpawnExecutionAdmissionViaPipeline } from './spawn-admission-decision-pipeline.ts';
import type {
  IndexedSessionInspection,
  SpawnExecutionFlowDeps,
  SpawnExecutionFlowInput,
} from './spawn-flow-contract.ts';
import type { WorkflowNodeSlotResolution } from './spawn-slot-resolution.ts';

export type { SpawnExecutionFlowDeps } from './spawn-flow-contract.ts';

export function isSpawnFlowWaitConcurrent(result: unknown): result is {
  kind: 'wait_concurrent';
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { kind?: unknown }).kind === 'wait_concurrent'
  );
}

export function isSpawnFlowReusedSession(result: unknown): result is {
  kind: 'reused_session';
  sessionId: string;
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { kind?: unknown }).kind === 'reused_session'
  );
}

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

function settledFailure(
  state: SpawnFlowState,
  status: 'error' | 'superseded',
  stage: string,
  error?: unknown
): SpawnFlowSettled {
  return { settled: { status, stage, error, unwind: unwindCompensations(state.compensations) } };
}

function settledCompletion(result: unknown): SpawnFlowSettled {
  return { settled: { status: 'completed', result } };
}

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

function buildSpawnExecutionPipeline(
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

export async function runSpawnExecutionFlow(
  deps: SpawnExecutionFlowDeps,
  input: SpawnExecutionFlowInput
): Promise<StagedRunOutcome> {
  const outcome = await buildSpawnExecutionPipeline(deps)(input);
  if (isSpawnFlowSettled(outcome)) return outcome.settled;
  return { status: 'completed', result: outcome.result };
}
