import { describe, expect, test } from 'bun:test';
import type {
  NodeExecution,
  Space,
  SpaceTask,
  SpaceTaskStatus,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import {
  admitSpawnExecution,
  blockRunForSpawnFailure,
  casCanonicalTaskOpenToInProgress,
  drainPendingNodeHandoffs,
  finalizeTick,
  haltIfBlockedExecutions,
  haltIfNoExecutions,
  haltIfNoRunContext,
  haltIfRateLimited,
  haltIfRunFinished,
  haltIfRunMissing,
  haltIfStrandedRecoveryHalted,
  haltIfTaskStopped,
  haltIfWorkflowInvalid,
  loadExecutionsAndSpace,
  loadRunContext,
  promotePendingExecutionsWithLiveSessions,
  pruneStaleNotifyDedupKeys,
  recoverStrandedExecutions,
  routeWaitingRun,
  runSpaceWorkflowRunTick,
  settleIfComplete,
  spawnPendingExecutions,
} from '../../../../src/lib/space/runtime/run-tick-pipeline.ts';
import type {
  SpaceWorkflowRunTickDeps,
  SpaceWorkflowRunTickOutcome,
} from '../../../../src/lib/space/runtime/run-tick-contract.ts';
import type {
  AdmitSpawnExecutionOutcome,
  RunTickContext,
} from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const RUN_ID = 'run-1';
const SPACE_ID = 'space-1';
const TASK_ID = 'task-1';

function makeRun(status: SpaceWorkflowRun['status']): SpaceWorkflowRun {
  return { id: RUN_ID, status } as SpaceWorkflowRun;
}

function makeTask(status: SpaceTaskStatus): SpaceTask {
  return { id: TASK_ID, status, workflowRunId: RUN_ID } as SpaceTask;
}

function makeExecution(
  status: NodeExecution['status'],
  result: string | null = null
): NodeExecution {
  return { id: `exec-${status}`, status, result } as NodeExecution;
}

function makeContext(
  overrides: {
    canonicalTaskStatus?: SpaceTaskStatus;
    executions?: NodeExecution[];
    hasEndNodeId?: boolean;
  } = {}
): RunTickContext {
  const canonicalTask = makeTask(overrides.canonicalTaskStatus ?? 'in_progress');
  const executions = overrides.executions ?? [makeExecution('pending')];
  return {
    meta: {
      workflow: { endNodeId: overrides.hasEndNodeId === false ? undefined : 'node-end' },
      spaceId: SPACE_ID,
      workspacePath: '/tmp/ws',
    },
    runTaskCount: 1,
    canonicalTask,
    loadNodeExecutions: () => executions,
    resolveRunIsComplete: () => false,
  } as RunTickContext;
}

interface DepsState {
  run: SpaceWorkflowRun | null;
  context: RunTickContext | null;
  space: Space | null;
  recoveryHalted: boolean;
  settled: boolean;
  drainHalted: boolean;
  spawnAdmissionAction: 'spawn' | 'skipSpawn';
  spawnFailureBlocks: boolean;
}

interface RecordedDeps extends SpaceWorkflowRunTickDeps {
  calls: string[];
  run: SpaceWorkflowRun | null;
  context: RunTickContext | null;
  space: Space | null;
  blockedReasons: string[];
  spawnedArgs: {
    canonicalTaskId: string;
    pendingExecutionIds: string[];
    blockedByCrash: boolean;
  }[];
}

function makeDeps(state: Partial<DepsState> = {}): RecordedDeps {
  const full: DepsState = {
    run: makeRun('in_progress'),
    context: makeContext(),
    space: { id: SPACE_ID } as Space,
    recoveryHalted: false,
    settled: false,
    drainHalted: false,
    spawnAdmissionAction: 'spawn',
    spawnFailureBlocks: false,
    ...state,
  };
  const calls: string[] = [];
  const blockedReasons: string[] = [];
  const spawnedArgs: RecordedDeps['spawnedArgs'] = [];
  const tam = { id: 'tam' } as TaskAgentManager;
  const deps: SpaceWorkflowRunTickDeps = {
    getRun: () => {
      calls.push('getRun');
      return full.run;
    },
    clearAgentStuckStateForRun: () => calls.push('clearAgentStuckStateForRun'),
    recoverBlockedRun: async () => calls.push('recoverBlockedRun'),
    loadRunContext: () => {
      calls.push('loadRunContext');
      return Promise.resolve(full.context);
    },
    blockInvalidWorkflowRun: async () => calls.push('blockInvalidWorkflowRun'),
    pruneStaleNotifyDedupKeys: () => calls.push('pruneStaleNotifyDedupKeys'),
    blockRunOnBlockedExecutions: async (_runId, _meta, _task, blockedReason) => {
      calls.push('blockRunOnBlockedExecutions');
      blockedReasons.push(blockedReason);
    },
    getSpace: () => {
      calls.push('getSpace');
      return Promise.resolve(full.space);
    },
    recoverStrandedExecutions: async () => {
      calls.push('recoverStrandedExecutions');
      return full.recoveryHalted
        ? { action: 'halted' }
        : {
            action: 'continue',
            tam,
            blockedByCrash: false,
            preTickPendingIds: new Set(['exec-pending']),
          };
    },
    settleIfComplete: async () => {
      calls.push('settleIfComplete');
      return full.settled;
    },
    drainPendingNodeHandoffs: async () => {
      calls.push('drainPendingNodeHandoffs');
      return full.drainHalted ? 'halted' : 'continue';
    },
    promotePendingExecutionsWithLiveSessions: () => {
      calls.push('promotePendingExecutionsWithLiveSessions');
      return full.context?.loadNodeExecutions() ?? [];
    },
    admitSpawnExecution: () => {
      calls.push('admitSpawnExecution');
      const outcome: AdmitSpawnExecutionOutcome = {
        canonicalTask: full.context!.canonicalTask,
        pendingExecutions: full.context!.loadNodeExecutions().filter((e) => e.status === 'pending'),
        spawnAdmission:
          full.spawnAdmissionAction === 'spawn'
            ? { action: 'spawn' }
            : { action: 'skipSpawn', reason: 'canonical_task_terminal' },
      } as AdmitSpawnExecutionOutcome;
      return outcome;
    },
    spawnPendingExecutions: async (
      _runId,
      canonicalTask,
      _space,
      _meta,
      _run,
      pending,
      _tam,
      blockedByCrash
    ) => {
      calls.push('spawnPendingExecutions');
      spawnedArgs.push({
        canonicalTaskId: canonicalTask.id,
        pendingExecutionIds: pending.map((e) => e.id),
        blockedByCrash,
      });
      return { blockedByCrash, permanentSpawnFailureReason: null };
    },
    blockRunForSpawnFailure: async () => {
      calls.push('blockRunForSpawnFailure');
      return full.spawnFailureBlocks;
    },
    casCanonicalTaskOpenToInProgress: async () => calls.push('casCanonicalTaskOpenToInProgress'),
  };
  return {
    ...deps,
    calls,
    run: full.run,
    context: full.context,
    space: full.space,
    blockedReasons,
    spawnedArgs,
  };
}

describe('spaceWorkflowRunTick stages', () => {
  test('loadRunContext fetches the run and loads the context for an active run', async () => {
    const deps = makeDeps();
    const ctx = await loadRunContext({ runId: RUN_ID, deps });
    expect(ctx.run).toEqual(makeRun('in_progress'));
    expect(ctx.context).toEqual(deps.context);
    expect(deps.calls).toEqual(['getRun', 'loadRunContext']);
  });

  test('loadRunContext skips the context load for missing, finished, and waiting runs', async () => {
    for (const status of [null, 'cancelled', 'done', 'blocked'] as const) {
      const deps = makeDeps({ run: status === null ? null : makeRun(status) });
      const ctx = await loadRunContext({ runId: RUN_ID, deps });
      expect(ctx.context).toBeNull();
      expect(deps.calls).toEqual(['getRun']);
    }
  });

  test('haltIfRunMissing skips only when the run is absent', () => {
    const deps = makeDeps();
    expect(haltIfRunMissing({ runId: RUN_ID, deps })).toEqual({
      reason: { action: 'skip', reason: 'missing_run' },
    });
    expect(haltIfRunMissing({ runId: RUN_ID, deps, run: makeRun('in_progress') })).toEqual({
      value: { runId: RUN_ID, deps, run: makeRun('in_progress') },
    });
  });

  test('haltIfRunFinished clears stuck state and halts for cancelled and done runs', () => {
    for (const status of ['cancelled', 'done'] as const) {
      const deps = makeDeps();
      const outcome = haltIfRunFinished({ runId: RUN_ID, deps, run: makeRun(status) });
      expect(outcome).toEqual({ reason: { action: 'cleared_finished_run' } });
      expect(deps.calls).toEqual(['clearAgentStuckStateForRun']);
    }
  });

  test('haltIfRunFinished continues for active and waiting runs without effects', () => {
    for (const status of ['in_progress', 'blocked', 'pending'] as const) {
      const deps = makeDeps();
      const ctx = { runId: RUN_ID, deps, run: makeRun(status) };
      expect(haltIfRunFinished(ctx)).toEqual({ value: ctx });
      expect(deps.calls).toEqual([]);
    }
  });

  test('routeWaitingRun routes a waiting run through blocked-run recovery and halts', async () => {
    const deps = makeDeps();
    const outcome = await routeWaitingRun({ runId: RUN_ID, deps, run: makeRun('blocked') });
    expect(outcome).toEqual({ reason: { action: 'recovered_waiting_run' } });
    expect(deps.calls).toEqual(['recoverBlockedRun']);
  });

  test('routeWaitingRun continues past an active run', async () => {
    const deps = makeDeps();
    const ctx = { runId: RUN_ID, deps, run: makeRun('in_progress') };
    expect(await routeWaitingRun(ctx)).toEqual({ value: ctx });
    expect(deps.calls).toEqual([]);
  });

  test('haltIfNoRunContext skips when the context failed to load', () => {
    const deps = makeDeps();
    expect(haltIfNoRunContext({ runId: RUN_ID, deps, context: null })).toEqual({
      reason: { action: 'skip', reason: 'no_run_context' },
    });
    const ctx = { runId: RUN_ID, deps, context: deps.context };
    expect(haltIfNoRunContext(ctx)).toEqual({ value: ctx });
  });

  test('skip gates fire only on their own predicate', () => {
    const rateLimited = makeDeps({
      context: makeContext({ canonicalTaskStatus: 'rate_limited' }),
    });
    const rateCtx = { runId: RUN_ID, deps: rateLimited, context: rateLimited.context };
    expect(haltIfRateLimited(rateCtx)).toEqual({
      reason: { action: 'skip', reason: 'rate_or_usage_limited' },
    });
    expect(haltIfTaskStopped(rateCtx)).toEqual({ value: rateCtx });

    const stopped = makeDeps({ context: makeContext({ canonicalTaskStatus: 'stopped' }) });
    const stoppedCtx = { runId: RUN_ID, deps: stopped, context: stopped.context };
    expect(haltIfTaskStopped(stoppedCtx)).toEqual({
      reason: { action: 'skip', reason: 'task_stopped' },
    });

    const empty = makeDeps({ context: makeContext({ executions: [] }) });
    const emptyCtx = { runId: RUN_ID, deps: empty, context: empty.context };
    expect(haltIfNoExecutions(emptyCtx)).toEqual({
      reason: { action: 'skip', reason: 'no_executions' },
    });
    expect(haltIfRateLimited(emptyCtx)).toEqual({ value: emptyCtx });

    const healthy = makeDeps();
    const healthyCtx = { runId: RUN_ID, deps: healthy, context: healthy.context };
    expect(haltIfRateLimited(healthyCtx)).toEqual({ value: healthyCtx });
    expect(haltIfTaskStopped(healthyCtx)).toEqual({ value: healthyCtx });
    expect(haltIfNoExecutions(healthyCtx)).toEqual({ value: healthyCtx });
  });

  test('haltIfWorkflowInvalid runs the blocking effect and halts', async () => {
    const deps = makeDeps({ context: makeContext({ hasEndNodeId: false }) });
    const outcome = await haltIfWorkflowInvalid({
      runId: RUN_ID,
      deps,
      context: deps.context,
    });
    expect(outcome).toEqual({ reason: { action: 'blocked_invalid_workflow' } });
    expect(deps.calls).toEqual(['blockInvalidWorkflowRun']);
  });

  test('haltIfWorkflowInvalid continues for a workflow with an end node', async () => {
    const deps = makeDeps();
    const ctx = { runId: RUN_ID, deps, context: deps.context };
    expect(await haltIfWorkflowInvalid(ctx)).toEqual({ value: ctx });
    expect(deps.calls).toEqual([]);
  });

  test('pruneStaleNotifyDedupKeys delegates to the runtime seam', () => {
    const deps = makeDeps();
    const ctx = pruneStaleNotifyDedupKeys({ runId: RUN_ID, deps, context: deps.context });
    expect(deps.calls).toEqual(['pruneStaleNotifyDedupKeys']);
    expect(ctx.context).toBe(deps.context);
  });

  test('haltIfBlockedExecutions runs the blocking effect with the first blocked result', async () => {
    const deps = makeDeps({
      context: makeContext({
        executions: [makeExecution('in_progress'), makeExecution('blocked', 'needs review')],
      }),
    });
    const outcome = await haltIfBlockedExecutions({
      runId: RUN_ID,
      deps,
      context: deps.context,
    });
    expect(outcome).toEqual({ reason: { action: 'blocked_on_blocked_executions' } });
    expect(deps.calls).toEqual(['blockRunOnBlockedExecutions']);
    expect(deps.blockedReasons).toEqual(['needs review']);
  });

  test('haltIfBlockedExecutions falls back to the default blocked reason', async () => {
    const deps = makeDeps({
      context: makeContext({ executions: [makeExecution('blocked')] }),
    });
    await haltIfBlockedExecutions({ runId: RUN_ID, deps, context: deps.context });
    expect(deps.blockedReasons).toEqual(['One or more workflow agents are blocked']);
  });

  test('haltIfBlockedExecutions continues without blocked executions', async () => {
    const deps = makeDeps();
    const ctx = { runId: RUN_ID, deps, context: deps.context };
    expect(await haltIfBlockedExecutions(ctx)).toEqual({ value: ctx });
    expect(deps.calls).toEqual([]);
  });

  test('loadExecutionsAndSpace gathers executions, completion, and the space', async () => {
    const deps = makeDeps();
    const ctx = await loadExecutionsAndSpace({
      runId: RUN_ID,
      deps,
      context: deps.context,
    });
    expect(ctx.nodeExecutions).toEqual(deps.context!.loadNodeExecutions());
    expect(ctx.runIsComplete).toBe(false);
    expect(ctx.space).toEqual({ id: SPACE_ID });
    expect(deps.calls).toEqual(['getSpace']);
  });

  test('recoverStrandedExecutions threads the recovery state for continuation', async () => {
    const deps = makeDeps();
    const ctx = await recoverStrandedExecutions({
      runId: RUN_ID,
      deps,
      run: deps.run,
      context: deps.context,
      nodeExecutions: deps.context!.loadNodeExecutions(),
      runIsComplete: false,
      space: deps.space,
    });
    expect(ctx.recovery).toEqual({
      tam: expect.any(Object),
      blockedByCrash: false,
      preTickPendingIds: new Set(['exec-pending']),
    });
    expect(haltIfStrandedRecoveryHalted(ctx)).toEqual({ value: ctx });
  });

  test('recoverStrandedExecutions clears the recovery state on a halt', async () => {
    const deps = makeDeps({ recoveryHalted: true });
    const ctx = await recoverStrandedExecutions({
      runId: RUN_ID,
      deps,
      run: deps.run,
      context: deps.context,
      nodeExecutions: deps.context!.loadNodeExecutions(),
      runIsComplete: false,
      space: deps.space,
    });
    expect(ctx.recovery).toBeUndefined();
    expect(haltIfStrandedRecoveryHalted(ctx)).toEqual({
      reason: { action: 'halted_stranded_recovery' },
    });
  });

  test('settleIfComplete halts when the run settles', async () => {
    const deps = makeDeps({ settled: true });
    const ctx = { runId: RUN_ID, deps, context: deps.context, runIsComplete: true };
    expect(await settleIfComplete(ctx)).toEqual({ reason: { action: 'settled_run' } });
    const passing = makeDeps();
    const activeCtx = {
      runId: RUN_ID,
      deps: passing,
      context: passing.context,
      runIsComplete: false,
    };
    expect(await settleIfComplete(activeCtx)).toEqual({ value: activeCtx });
  });

  test('drainPendingNodeHandoffs halts only when the drain reports a halt', async () => {
    const halted = makeDeps({ drainHalted: true });
    const ctx = { runId: RUN_ID, deps: halted, run: halted.run, context: halted.context };
    expect(await drainPendingNodeHandoffs(ctx)).toEqual({
      reason: { action: 'halted_node_handoff_drain' },
    });
    const passing = makeDeps();
    const passCtx = { runId: RUN_ID, deps: passing, run: passing.run, context: passing.context };
    expect(await drainPendingNodeHandoffs(passCtx)).toEqual({ value: passCtx });
  });

  test('promotePendingExecutionsWithLiveSessions uses the recovery thread', () => {
    const deps = makeDeps();
    const recovery = {
      tam: {} as never,
      blockedByCrash: false,
      preTickPendingIds: new Set(['exec-pending']),
    };
    const ctx = promotePendingExecutionsWithLiveSessions({
      runId: RUN_ID,
      deps,
      context: deps.context,
      recovery,
    });
    expect(deps.calls).toEqual(['promotePendingExecutionsWithLiveSessions']);
    expect(ctx.nodeExecutions).toEqual(deps.context!.loadNodeExecutions());
  });

  test('admitSpawnExecution records the admission outcome', () => {
    const deps = makeDeps();
    const ctx = admitSpawnExecution({
      runId: RUN_ID,
      deps,
      context: deps.context,
      nodeExecutions: deps.context!.loadNodeExecutions(),
      space: deps.space,
    });
    expect(deps.calls).toEqual(['admitSpawnExecution']);
    expect(ctx.spawn?.spawnAdmission).toEqual({ action: 'spawn' });
    expect(ctx.spawn?.canonicalTask.id).toBe(TASK_ID);
  });

  test('spawnPendingExecutions spawns only when admitted with a live space', async () => {
    const deps = makeDeps();
    const admitted = {
      runId: RUN_ID,
      deps,
      context: deps.context,
      run: deps.run,
      space: deps.space,
      recovery: {
        tam: {} as never,
        blockedByCrash: true,
        preTickPendingIds: new Set<string>(),
      },
      spawn: deps.admitSpawnExecution(
        RUN_ID,
        deps.context!.meta,
        deps.context!.canonicalTask,
        deps.context!.loadNodeExecutions(),
        deps.space
      ),
    };
    await spawnPendingExecutions(admitted);
    expect(deps.calls.filter((c) => c === 'spawnPendingExecutions')).toHaveLength(1);
    expect(deps.spawnedArgs).toEqual([
      { canonicalTaskId: TASK_ID, pendingExecutionIds: ['exec-pending'], blockedByCrash: true },
    ]);

    const skipped = makeDeps({ spawnAdmissionAction: 'skipSpawn' });
    const skipSpawn = skipped.admitSpawnExecution(
      RUN_ID,
      skipped.context!.meta,
      skipped.context!.canonicalTask,
      skipped.context!.loadNodeExecutions(),
      skipped.space
    );
    await spawnPendingExecutions({
      runId: RUN_ID,
      deps: skipped,
      context: skipped.context,
      run: skipped.run,
      space: skipped.space,
      recovery: admitted.recovery,
      spawn: skipSpawn,
    });
    expect(skipped.calls).toEqual(['admitSpawnExecution']);

    const spaceless = makeDeps();
    await spawnPendingExecutions({
      runId: RUN_ID,
      deps: spaceless,
      context: spaceless.context,
      run: spaceless.run,
      recovery: admitted.recovery,
      spawn: admitted.spawn,
    });
    expect(spaceless.calls).toEqual([]);
  });

  test('blockRunForSpawnFailure and casCanonicalTaskOpenToInProgress stay inside the spawn branch', async () => {
    const deps = makeDeps();
    const spawned = { blockedByCrash: false, permanentSpawnFailureReason: null };
    const spawn = deps.admitSpawnExecution(
      RUN_ID,
      deps.context!.meta,
      deps.context!.canonicalTask,
      deps.context!.loadNodeExecutions(),
      deps.space
    );
    const ctx = await blockRunForSpawnFailure({
      runId: RUN_ID,
      deps,
      context: deps.context,
      spawn,
      spawned,
    });
    expect(ctx.spawnFailureBlocked).toBe(false);
    await casCanonicalTaskOpenToInProgress({
      runId: RUN_ID,
      deps,
      context: deps.context,
      spawn,
      spawned,
    });
    expect(deps.calls).toEqual([
      'admitSpawnExecution',
      'blockRunForSpawnFailure',
      'casCanonicalTaskOpenToInProgress',
    ]);

    const unspawned = makeDeps();
    await blockRunForSpawnFailure({ runId: RUN_ID, deps: unspawned, context: unspawned.context });
    await casCanonicalTaskOpenToInProgress({
      runId: RUN_ID,
      deps: unspawned,
      context: unspawned.context,
    });
    expect(unspawned.calls).toEqual([]);
  });

  test('finalizeTick resolves the tick as complete', () => {
    const deps = makeDeps();
    expect(finalizeTick({ runId: RUN_ID, deps })).toEqual({
      reason: { action: 'ran_to_completion' },
    });
  });
});

describe('spaceWorkflowRunTick pipeline', () => {
  test('a healthy run flows through every stage in order', async () => {
    const deps = makeDeps();
    const outcome = await runSpaceWorkflowRunTick(deps, RUN_ID);
    expect(outcome).toEqual({ action: 'ran_to_completion' });
    expect(deps.calls).toEqual([
      'getRun',
      'loadRunContext',
      'pruneStaleNotifyDedupKeys',
      'getSpace',
      'recoverStrandedExecutions',
      'settleIfComplete',
      'drainPendingNodeHandoffs',
      'promotePendingExecutionsWithLiveSessions',
      'admitSpawnExecution',
      'spawnPendingExecutions',
      'blockRunForSpawnFailure',
      'casCanonicalTaskOpenToInProgress',
    ]);
  });

  const haltCases: Array<{
    name: string;
    state: Partial<DepsState>;
    expected: SpaceWorkflowRunTickOutcome;
    expectedCalls: string[];
  }> = [
    {
      name: 'skips a missing run',
      state: { run: null },
      expected: { action: 'skip', reason: 'missing_run' },
      expectedCalls: ['getRun'],
    },
    {
      name: 'clears a finished run',
      state: { run: makeRun('cancelled') },
      expected: { action: 'cleared_finished_run' },
      expectedCalls: ['getRun', 'clearAgentStuckStateForRun'],
    },
    {
      name: 'recovers a waiting run through blocked-run recovery',
      state: { run: makeRun('blocked') },
      expected: { action: 'recovered_waiting_run' },
      expectedCalls: ['getRun', 'recoverBlockedRun'],
    },
    {
      name: 'skips a run without a tick context',
      state: { context: null },
      expected: { action: 'skip', reason: 'no_run_context' },
      expectedCalls: ['getRun', 'loadRunContext'],
    },
    {
      name: 'skips a rate-limited task',
      state: { context: makeContext({ canonicalTaskStatus: 'rate_limited' }) },
      expected: { action: 'skip', reason: 'rate_or_usage_limited' },
      expectedCalls: ['getRun', 'loadRunContext'],
    },
    {
      name: 'skips a stopped task',
      state: { context: makeContext({ canonicalTaskStatus: 'stopped' }) },
      expected: { action: 'skip', reason: 'task_stopped' },
      expectedCalls: ['getRun', 'loadRunContext'],
    },
    {
      name: 'skips a run without executions',
      state: { context: makeContext({ executions: [] }) },
      expected: { action: 'skip', reason: 'no_executions' },
      expectedCalls: ['getRun', 'loadRunContext'],
    },
    {
      name: 'blocks a workflow missing its end node',
      state: { context: makeContext({ hasEndNodeId: false }) },
      expected: { action: 'blocked_invalid_workflow' },
      expectedCalls: ['getRun', 'loadRunContext', 'blockInvalidWorkflowRun'],
    },
    {
      name: 'workflow validity beats a rate-limited task',
      state: { context: makeContext({ hasEndNodeId: false, canonicalTaskStatus: 'rate_limited' }) },
      expected: { action: 'blocked_invalid_workflow' },
      expectedCalls: ['getRun', 'loadRunContext', 'blockInvalidWorkflowRun'],
    },
    {
      name: 'workflow validity beats a stopped task and an empty run',
      state: {
        context: makeContext({
          hasEndNodeId: false,
          canonicalTaskStatus: 'stopped',
          executions: [],
        }),
      },
      expected: { action: 'blocked_invalid_workflow' },
      expectedCalls: ['getRun', 'loadRunContext', 'blockInvalidWorkflowRun'],
    },
    {
      name: 'blocks on blocked executions',
      state: {
        context: makeContext({
          executions: [makeExecution('blocked', 'needs review')],
        }),
      },
      expected: { action: 'blocked_on_blocked_executions' },
      expectedCalls: [
        'getRun',
        'loadRunContext',
        'pruneStaleNotifyDedupKeys',
        'blockRunOnBlockedExecutions',
      ],
    },
    {
      name: 'halts when stranded-execution recovery halts',
      state: { recoveryHalted: true },
      expected: { action: 'halted_stranded_recovery' },
      expectedCalls: [
        'getRun',
        'loadRunContext',
        'pruneStaleNotifyDedupKeys',
        'getSpace',
        'recoverStrandedExecutions',
      ],
    },
    {
      name: 'halts after settling a complete run',
      state: { settled: true },
      expected: { action: 'settled_run' },
      expectedCalls: [
        'getRun',
        'loadRunContext',
        'pruneStaleNotifyDedupKeys',
        'getSpace',
        'recoverStrandedExecutions',
        'settleIfComplete',
      ],
    },
    {
      name: 'halts when the queued node-handoff drain halts',
      state: { drainHalted: true },
      expected: { action: 'halted_node_handoff_drain' },
      expectedCalls: [
        'getRun',
        'loadRunContext',
        'pruneStaleNotifyDedupKeys',
        'getSpace',
        'recoverStrandedExecutions',
        'settleIfComplete',
        'drainPendingNodeHandoffs',
      ],
    },
  ];

  for (const { name, state, expected, expectedCalls } of haltCases) {
    test(name, async () => {
      const deps = makeDeps(state);
      expect(await runSpaceWorkflowRunTick(deps, RUN_ID)).toEqual(expected);
      expect(deps.calls).toEqual(expectedCalls);
    });
  }

  test('blocks the run via the !dep halt when the spawn pass fails permanently', async () => {
    const deps = makeDeps({ spawnFailureBlocks: true });
    const outcome = await runSpaceWorkflowRunTick(deps, RUN_ID);
    expect(outcome).toEqual({ action: 'blocked_for_spawn_failure' });
    expect(deps.calls.slice(-2)).toEqual(['spawnPendingExecutions', 'blockRunForSpawnFailure']);
    expect(deps.calls).not.toContain('casCanonicalTaskOpenToInProgress');
  });

  test('skips the spawn branch when admission declines to spawn', async () => {
    const deps = makeDeps({ spawnAdmissionAction: 'skipSpawn' });
    const outcome = await runSpaceWorkflowRunTick(deps, RUN_ID);
    expect(outcome).toEqual({ action: 'ran_to_completion' });
    expect(deps.calls.slice(-2)).toEqual([
      'promotePendingExecutionsWithLiveSessions',
      'admitSpawnExecution',
    ]);
    expect(deps.calls).not.toContain('spawnPendingExecutions');
    expect(deps.calls).not.toContain('blockRunForSpawnFailure');
    expect(deps.calls).not.toContain('casCanonicalTaskOpenToInProgress');
  });
});
