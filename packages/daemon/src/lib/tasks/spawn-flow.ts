import type { SpaceTask } from '@hyperneo/shared';
import type { NodeExecution } from '@hyperneo/shared';
import { readRestartRecoveryNote } from './restart-recovery-note.ts';
import type { SpawnExecutionAdmissionDecision } from './spawn-admission-gates.ts';
import { decideSpawnExecutionAdmissionViaPipeline } from './spawn-admission-decision-pipeline.ts';
import type {
  IndexedSessionInspection,
  SpawnExecutionFlowDeps,
  SpawnExecutionFlowInput,
} from './spawn-flow-contract.ts';
import type { WorkflowNodeSlotResolution } from './spawn-slot-resolution.ts';
import { type StagedRunOutcome, type StagedRunUnwindEntry } from '../space/runtime/staged-run.ts';
import {
  validateExecutionAgainstWorkflow,
  validateTaskAllowsSpawn,
} from '../workflows/node-execution-validation.ts';
import superpipe, { type PipelineAPI } from 'superpipe';

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

interface SpawnCompensation {
  stage: string;
  undo: () => void;
}

type SpawnTerminal =
  | { status: 'error'; stage: string; error: unknown }
  | { status: 'superseded'; stage: string };

interface SpawnExecutionFlowCtx extends SpawnExecutionFlowInput {
  deps: SpawnExecutionFlowDeps;
  freshTask: SpaceTask | null;
  slotResolution: WorkflowNodeSlotResolution | null;
  workflowValid: boolean;
  isSpawning: boolean;
  indexedSession: IndexedSessionInspection;
  admission: SpawnExecutionAdmissionDecision | null;
  liveSessionId: string | null;
  spawnedSessionId: string | null;
  workspacePath: string | null;
  spawnTask: SpaceTask | null;
  boundExecution: NodeExecution | null;
  compensations: SpawnCompensation[];
  terminal: SpawnTerminal | null;
  result: unknown;
}

function gatherSpawnAdmission(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  try {
    const freshTask = ctx.deps.getFreshTask(ctx.task.id) ?? ctx.task;
    return {
      ...ctx,
      freshTask,
      slotResolution: ctx.deps.resolveSlot(ctx.space, ctx.workflow, ctx.execution, freshTask),
      workflowValid: validateExecutionAgainstWorkflow(ctx.execution, ctx.workflow).valid,
      isSpawning: ctx.deps.isSpawningExecution(ctx.execution.id),
      indexedSession: ctx.deps.inspectIndexedSession(ctx.execution.agentSessionId),
    };
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'gather-spawn-admission', error } };
  }
}

function decideAdmission(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null) return ctx;
  const liveSessionId = ctx.indexedSession.alive ? ctx.indexedSession.sessionId : null;
  const admission = decideSpawnExecutionAdmissionViaPipeline({
    hasLiveIndexedSession: liveSessionId !== null,
    isSpawningExecution: ctx.isSpawning,
    taskStatus: ctx.freshTask!.status,
    executionWorkflowValid: ctx.workflowValid,
    slotResolvable: ctx.slotResolution !== null,
  });
  return { ...ctx, admission, liveSessionId };
}

function rebindLiveSession(
  ctx: SpawnExecutionFlowCtx
): SpawnExecutionFlowCtx | Promise<SpawnExecutionFlowCtx> {
  if (ctx.terminal !== null || ctx.admission!.action !== 'reuse_live') return ctx;
  return rebindLiveSessionNow(ctx);
}

async function rebindLiveSessionNow(ctx: SpawnExecutionFlowCtx): Promise<SpawnExecutionFlowCtx> {
  const sessionId = ctx.liveSessionId!;
  try {
    if (ctx.freshTask!.workflowRunId !== ctx.execution.workflowRunId) {
      throw new Error(
        `Task ${ctx.freshTask!.id} is no longer attached to workflow run ${ctx.execution.workflowRunId}; refusing to reuse its live session`
      );
    }
    const rebind = ctx.deps.rebindLiveExecution(ctx.execution, sessionId);
    if (rebind === 'superseded') {
      return { ...ctx, terminal: { status: 'superseded', stage: 'rebind-live-session' } };
    }
    try {
      await ctx.deps.syncReuseLiveWorkspace?.(ctx.freshTask!, ctx.space, ctx.execution, sessionId);
      const recoveryNote = readRestartRecoveryNote(ctx.execution);
      if (recoveryNote) {
        await ctx.deps.injectKickoffMessage(sessionId, recoveryNote, ctx.execution.id);
      }
    } catch (err) {
      ctx.deps.revertLiveExecutionRebind?.(ctx.execution, sessionId);
      throw err;
    }
    return { ...ctx, result: { kind: 'reused_session', sessionId } };
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'rebind-live-session', error } };
  }
}

function haltWaitConcurrent(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null || ctx.admission!.action !== 'wait_concurrent') return ctx;
  return { ...ctx, result: { kind: 'wait_concurrent' } };
}

function raiseSpawnRejection(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  const action = ctx.admission!.action;
  if (ctx.terminal !== null || (action !== 'reject_permanent' && action !== 'reject_transient')) {
    return ctx;
  }
  try {
    ctx.deps.raiseSpawnRejection(ctx.freshTask!, ctx.execution, ctx.workflow);
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'raise-spawn-rejection', error } };
  }
  return ctx;
}

function reserveTaskSpawn(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null || ctx.admission!.action !== 'proceed_fresh') return ctx;
  const result = ctx.deps.reserveTaskSpawn(ctx.task.id);
  if (result === 'superseded') {
    return {
      ...ctx,
      terminal: { status: 'superseded', stage: 'reserve-task-spawn' },
      compensations: [...ctx.compensations, { stage: 'reserve-task-spawn', undo: () => {} }],
    };
  }
  return {
    ...ctx,
    compensations: [
      ...ctx.compensations,
      {
        stage: 'reserve-task-spawn',
        undo: () => ctx.deps.releaseTaskSpawn(ctx.task.id),
      },
    ],
  };
}

function reserveAndSpawnSession(
  ctx: SpawnExecutionFlowCtx
): SpawnExecutionFlowCtx | Promise<SpawnExecutionFlowCtx> {
  if (ctx.terminal !== null || ctx.admission!.action !== 'proceed_fresh') return ctx;
  return reserveAndSpawnSessionNow(ctx);
}

async function reserveAndSpawnSessionNow(
  ctx: SpawnExecutionFlowCtx
): Promise<SpawnExecutionFlowCtx> {
  let sessionId: string | null = null;
  ctx.deps.reserveExecution(ctx.execution.id);
  const compensations = [
    ...ctx.compensations,
    {
      stage: 'reserve-and-spawn-session',
      undo: () => {
        if (sessionId !== null) ctx.deps.cancelSpawnedSession(sessionId);
        ctx.deps.releaseExecution(ctx.execution.id);
      },
    },
  ];
  try {
    const spawnTask = ctx.freshTask ?? ctx.task;
    if (spawnTask.workflowRunId !== ctx.workflowRun.id) {
      throw new Error(
        `Task ${spawnTask.id} was reassigned to workflow run ${spawnTask.workflowRunId} during spawn`
      );
    }
    const resolvedSessionId = ctx.deps.resolveSpawnSessionId(ctx.space, spawnTask, ctx.execution);
    const workspacePath = await ctx.deps.resolveWorkspacePath(spawnTask, ctx.space);
    validateTaskAllowsSpawn(ctx.deps.getFreshTask(ctx.task.id) ?? spawnTask);
    sessionId = await ctx.deps.createSpawnedSession({
      task: spawnTask,
      space: ctx.space,
      workflow: ctx.workflow,
      workflowRun: ctx.workflowRun,
      execution: ctx.execution,
      node: ctx.slotResolution!.node,
      slot: ctx.slotResolution!.slot,
      sessionId: resolvedSessionId,
      workspacePath,
      kickoff: ctx.kickoff,
    });
    return { ...ctx, compensations, spawnedSessionId: sessionId, workspacePath, spawnTask };
  } catch (error) {
    return {
      ...ctx,
      compensations,
      terminal: { status: 'error', stage: 'reserve-and-spawn-session', error },
    };
  }
}

function bindExecutionSession(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null || ctx.spawnedSessionId === null) return ctx;
  try {
    const result = ctx.deps.bindExecutionToSession(ctx.execution, ctx.spawnedSessionId);
    if (result === 'superseded') {
      return { ...ctx, terminal: { status: 'superseded', stage: 'bind-execution-session' } };
    }
    return ctx;
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'bind-execution-session', error } };
  }
}

function readBoundExecution(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null || ctx.spawnedSessionId === null) return ctx;
  const bound = ctx.deps.getNodeExecution(ctx.execution.id);
  if (!bound) {
    return {
      ...ctx,
      terminal: {
        status: 'error',
        stage: 'read-bound-execution',
        error: new Error(`Spawn flow cannot re-read execution ${ctx.execution.id} after binding`),
      },
    };
  }
  return { ...ctx, boundExecution: bound };
}

function releaseTaskSpawnReservation(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null || ctx.admission!.action !== 'proceed_fresh') return ctx;
  try {
    ctx.deps.releaseTaskSpawn(ctx.task.id);
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'release-task-spawn', error } };
  }
  return ctx;
}

function attachNodeAgent(
  ctx: SpawnExecutionFlowCtx
): SpawnExecutionFlowCtx | Promise<SpawnExecutionFlowCtx> {
  if (ctx.terminal !== null || ctx.spawnedSessionId === null) return ctx;
  return attachNodeAgentNow(ctx);
}

async function attachNodeAgentNow(ctx: SpawnExecutionFlowCtx): Promise<SpawnExecutionFlowCtx> {
  const sessionId = ctx.spawnedSessionId!;
  const execution = ctx.boundExecution ?? ctx.execution;
  try {
    await ctx.deps.attachNodeAgent({
      task: ctx.spawnTask!,
      space: ctx.space,
      workflowRun: ctx.workflowRun,
      execution,
      sessionId,
      workspacePath: ctx.workspacePath!,
    });
    ctx.deps.registerSpawnCompletionCallback(
      ctx.spawnTask!.id,
      execution.workflowNodeId,
      sessionId
    );
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'attach-node-agent', error } };
  }
  return ctx;
}

function kickoffSession(
  ctx: SpawnExecutionFlowCtx
): SpawnExecutionFlowCtx | Promise<SpawnExecutionFlowCtx> {
  if (ctx.terminal !== null || ctx.spawnedSessionId === null || !ctx.kickoff) return ctx;
  return kickoffSessionNow(ctx);
}

async function kickoffSessionNow(ctx: SpawnExecutionFlowCtx): Promise<SpawnExecutionFlowCtx> {
  const sessionId = ctx.spawnedSessionId!;
  const slotResolution = ctx.slotResolution!;
  try {
    const message = await ctx.deps.buildKickoffMessage({
      task: ctx.spawnTask!,
      space: ctx.space,
      workflow: ctx.workflow,
      workflowRun: ctx.workflowRun,
      execution: ctx.boundExecution ?? ctx.execution,
      node: slotResolution.node,
      slot: slotResolution.slot,
      sessionId,
      workspacePath: ctx.workspacePath!,
    });
    await ctx.deps.injectKickoffMessage(sessionId, message, ctx.execution.id);
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'kickoff-session', error } };
  }
  return ctx;
}

function activatePoolAssignment(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null || ctx.spawnedSessionId === null) return ctx;
  try {
    ctx.deps.activateSpawnedSessionPoolAssignment(ctx.execution.id, ctx.spawnedSessionId);
  } catch (error) {
    return { ...ctx, terminal: { status: 'error', stage: 'activate-pool-assignment', error } };
  }
  return ctx;
}

function completeSpawn(ctx: SpawnExecutionFlowCtx): SpawnExecutionFlowCtx {
  if (ctx.terminal !== null || ctx.spawnedSessionId === null) return ctx;
  return { ...ctx, result: ctx.spawnedSessionId };
}

const run = (
  superpipe<{
    proceedingFresh: (ctx: SpawnExecutionFlowCtx) => boolean;
    hasTerminal: (ctx: SpawnExecutionFlowCtx) => boolean;
  }>({
    proceedingFresh: (ctx: SpawnExecutionFlowCtx): boolean =>
      ctx.terminal === null && ctx.admission?.action === 'proceed_fresh',
    hasTerminal: (ctx: SpawnExecutionFlowCtx): boolean => ctx.terminal !== null,
  })('spawn-execution') as PipelineAPI
)
  .input(['ctx'])
  .pipe(gatherSpawnAdmission, 'ctx', 'ctx')
  .pipe(decideAdmission, 'ctx', 'ctx')
  .pipe(rebindLiveSession, 'ctx', 'ctx')
  .pipe(haltWaitConcurrent, 'ctx', 'ctx')
  .pipe(raiseSpawnRejection, 'ctx', 'ctx')
  .pipe('proceedingFresh', 'ctx')
  .pipe(reserveTaskSpawn, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(reserveAndSpawnSession, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(bindExecutionSession, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(readBoundExecution, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(releaseTaskSpawnReservation, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(attachNodeAgent, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(kickoffSession, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(activatePoolAssignment, 'ctx', 'ctx')
  .pipe('!hasTerminal', 'ctx')
  .pipe(completeSpawn, 'ctx', 'ctx')
  .endAsync('ctx') as (input: SpawnExecutionFlowCtx) => Promise<SpawnExecutionFlowCtx>;

function unwindCompensations(compensations: readonly SpawnCompensation[]): StagedRunUnwindEntry[] {
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

export function runSpawnExecutionFlow(
  deps: SpawnExecutionFlowDeps,
  input: SpawnExecutionFlowInput
): Promise<StagedRunOutcome> {
  const ctx: SpawnExecutionFlowCtx = {
    deps,
    ...input,
    freshTask: null,
    slotResolution: null,
    workflowValid: false,
    isSpawning: false,
    indexedSession: { sessionId: null, alive: false },
    admission: null,
    liveSessionId: null,
    spawnedSessionId: null,
    workspacePath: null,
    spawnTask: null,
    boundExecution: null,
    compensations: [],
    terminal: null,
    result: undefined,
  };
  return run(ctx).then((final) => {
    if (final.terminal === null) {
      return { status: 'completed', result: final.result };
    }
    return { ...final.terminal, unwind: unwindCompensations(final.compensations) };
  });
}
