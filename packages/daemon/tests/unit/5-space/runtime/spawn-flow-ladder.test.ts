import { describe, expect, test } from 'bun:test';
import type { NodeExecution, SpaceTask } from '@hyperneo/shared';
import type { SpawnExecutionFlowInput } from '../../../../src/lib/tasks/spawn-flow-contract';
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
  unwindCompensations,
  type SpawnFlowState,
} from '../../../../src/lib/tasks/spawn-flow-ladder';

const TASK_ID = 'task-1240';
const RUN_ID = 'run-1240';
const SPACE_ID = 'space-1240';
const EXECUTION_ID = 'exec-1240';
const SPAWNED_SESSION_ID = 'spawned-session-1';
const WORKSPACE_PATH = '/tmp/ws';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: TASK_ID,
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    status: 'in_progress',
    ...overrides,
  } as unknown as SpaceTask;
}

function makeRequest(overrides: Partial<SpawnExecutionFlowInput> = {}): SpawnExecutionFlowInput {
  return {
    task: makeTask(),
    space: { id: SPACE_ID, workspacePath: '/tmp/space' },
    workflow: { id: 'workflow-1' },
    workflowRun: { id: RUN_ID, workflowId: 'workflow-1', status: 'in_progress' },
    execution: {
      id: EXECUTION_ID,
      workflowRunId: RUN_ID,
      workflowNodeId: 'node-1',
      agentName: 'coder',
      agentSessionId: null,
      status: 'pending',
    },
    kickoff: true,
    ...overrides,
  } as unknown as SpawnExecutionFlowInput;
}

function makeState(overrides: Partial<SpawnFlowState> = {}): SpawnFlowState {
  return {
    freshTask: makeTask(),
    slotResolution: {
      node: { id: 'node-1' },
      slot: { agentName: 'coder' },
    } as unknown as SpawnFlowState['slotResolution'],
    workflowValid: true,
    isSpawning: false,
    indexedSession: { sessionId: null, alive: false },
    liveSessionId: null,
    spawnedSessionId: null,
    workspacePath: null,
    spawnTask: null,
    boundExecution: null,
    compensations: [],
    result: undefined,
    ...overrides,
  };
}

describe('unwindCompensations', () => {
  test('runs compensations last-to-first and reports each one', () => {
    const order: string[] = [];
    const report = unwindCompensations([
      { stage: 'first', undo: () => order.push('first') },
      { stage: 'second', undo: () => order.push('second') },
    ]);
    expect(order).toEqual(['second', 'first']);
    expect(report).toEqual([
      { stage: 'second', status: 'compensated' },
      { stage: 'first', status: 'compensated' },
    ]);
  });

  test('records a failing compensation without stopping the rest', () => {
    const order: string[] = [];
    const report = unwindCompensations([
      { stage: 'first', undo: () => order.push('first') },
      {
        stage: 'second',
        undo: () => {
          throw new Error('undo boom');
        },
      },
    ]);
    expect(order).toEqual(['first']);
    expect(report[0]).toMatchObject({ stage: 'second', status: 'failed' });
    expect(report[1]).toEqual({ stage: 'first', status: 'compensated' });
  });
});

describe('reserveTaskSpawn gate', () => {
  test('records the reservation compensation when the task reservation is won', () => {
    const released: string[] = [];
    const outcome = reserveTaskSpawn(
      () => 'won',
      (taskId) => released.push(taskId),
      makeRequest(),
      makeState()
    );
    expect(outcome).toMatchObject({ value: { compensations: [{ stage: 'reserve-task-spawn' }] } });
    if (!('value' in outcome)) throw new Error('expected the value arm');
    outcome.value.compensations[0].undo();
    expect(released).toEqual([TASK_ID]);
  });

  test('resolves the run as superseded when another spawn holds the reservation', () => {
    const outcome = reserveTaskSpawn(
      () => 'superseded',
      () => undefined,
      makeRequest(),
      makeState()
    );
    expect(outcome).toEqual({
      reason: {
        settled: {
          status: 'superseded',
          stage: 'reserve-task-spawn',
          unwind: [{ stage: 'reserve-task-spawn', status: 'compensated' }],
        },
      },
    });
  });

  test('resolves the run as an error when the reservation throws', () => {
    const outcome = reserveTaskSpawn(
      () => {
        throw new Error('db locked');
      },
      () => undefined,
      makeRequest(),
      makeState()
    );
    expect(outcome).toEqual({
      reason: {
        settled: {
          status: 'error',
          stage: 'reserve-task-spawn',
          error: expect.any(Error),
          unwind: [],
        },
      },
    });
  });
});

describe('reserveAndSpawnSession rung', () => {
  interface RungDeps {
    reserveExecution: () => void;
    releaseExecution: (id: string) => void;
    cancelSpawnedSession: (id: string) => void;
    resolveSpawnSessionId: () => string;
    resolveWorkspacePath: () => Promise<string>;
    getFreshTask: () => SpaceTask;
    createSpawnedSession: () => Promise<string>;
  }

  function makeDeps(overrides: Partial<RungDeps> = {}): RungDeps {
    return {
      reserveExecution: () => undefined,
      releaseExecution: () => undefined,
      cancelSpawnedSession: () => undefined,
      resolveSpawnSessionId: () => 'base-session-1',
      resolveWorkspacePath: async () => WORKSPACE_PATH,
      getFreshTask: () => makeTask(),
      createSpawnedSession: async () => SPAWNED_SESSION_ID,
      ...overrides,
    };
  }

  function runRung(deps: RungDeps, request = makeRequest(), state = makeState()) {
    return reserveAndSpawnSession(
      deps.reserveExecution,
      deps.releaseExecution,
      deps.cancelSpawnedSession,
      deps.resolveSpawnSessionId,
      deps.resolveWorkspacePath,
      deps.getFreshTask,
      deps.createSpawnedSession,
      request,
      state
    );
  }

  test('records the spawn and its compensation on success', async () => {
    const cancels: string[] = [];
    const releases: string[] = [];
    const outcome = await runRung(
      makeDeps({
        cancelSpawnedSession: (id) => cancels.push(id),
        releaseExecution: (id) => releases.push(id),
      })
    );
    expect(outcome).toMatchObject({
      value: { spawnedSessionId: SPAWNED_SESSION_ID, workspacePath: WORKSPACE_PATH },
    });
    if (!('value' in outcome)) throw new Error('expected the value arm');
    outcome.value.compensations.at(-1)?.undo();
    expect(cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(releases).toEqual([EXECUTION_ID]);
  });

  test('releases the execution reservation when the session creation throws', async () => {
    const releases: string[] = [];
    const outcome = await runRung(
      makeDeps({
        releaseExecution: (id) => releases.push(id),
        createSpawnedSession: async () => {
          throw new Error('create boom');
        },
      })
    );
    expect(outcome).toMatchObject({
      reason: {
        settled: {
          status: 'error',
          stage: 'reserve-and-spawn-session',
          unwind: [{ stage: 'reserve-and-spawn-session', status: 'compensated' }],
        },
      },
    });
    expect(releases).toEqual([EXECUTION_ID]);
  });

  test('cancels the spawned session when a later failure unwinds this rung', async () => {
    const cancels: string[] = [];
    const outcome = await runRung(makeDeps({ cancelSpawnedSession: (id) => cancels.push(id) }));
    if (!('value' in outcome)) throw new Error('expected the value arm');
    unwindCompensations(outcome.value.compensations);
    expect(cancels).toEqual([SPAWNED_SESSION_ID]);
  });

  test('fails the rung without reserving when the task was reassigned to another workflow run', async () => {
    let reserved = 0;
    const outcome = await runRung(
      makeDeps({ reserveExecution: () => (reserved += 1) }),
      makeRequest(),
      makeState({ freshTask: makeTask({ workflowRunId: 'run-other' }) })
    );
    expect(outcome).toMatchObject({
      reason: { settled: { status: 'error', stage: 'reserve-and-spawn-session' } },
    });
    expect(reserved).toBe(1);
  });
});

describe('bound-execution rungs', () => {
  test('bind is a no-op without a spawned session and supersedes on a lost CAS', () => {
    expect(bindExecutionSession(() => 'won', makeRequest(), makeState())).toEqual({
      value: makeState(),
    });
    const superseded = bindExecutionSession(
      () => 'superseded',
      makeRequest(),
      makeState({ spawnedSessionId: SPAWNED_SESSION_ID })
    );
    expect(superseded).toMatchObject({
      reason: { settled: { status: 'superseded', stage: 'bind-execution-session' } },
    });
  });

  test('the re-read resolves the run as an error when the read throws or returns null', () => {
    const state = makeState({ spawnedSessionId: SPAWNED_SESSION_ID });
    expect(
      readBoundExecution(
        () => {
          throw new Error('read boom');
        },
        makeRequest(),
        state
      )
    ).toMatchObject({ reason: { settled: { status: 'error', stage: 'read-bound-execution' } } });
    expect(readBoundExecution(() => null, makeRequest(), state)).toMatchObject({
      reason: { settled: { status: 'error', stage: 'read-bound-execution' } },
    });
  });

  test('the re-read hands the bound execution to the later rungs', () => {
    const bound = { id: EXECUTION_ID, status: 'in_progress' } as unknown as NodeExecution;
    expect(
      readBoundExecution(
        () => bound,
        makeRequest(),
        makeState({ spawnedSessionId: SPAWNED_SESSION_ID })
      )
    ).toEqual({
      value: makeState({ spawnedSessionId: SPAWNED_SESSION_ID, boundExecution: bound }),
    });
  });

  test('the task reservation release resolves the run as an error when it throws', () => {
    expect(
      releaseTaskSpawnReservation(
        () => {
          throw new Error('release boom');
        },
        makeRequest(),
        makeState()
      )
    ).toMatchObject({ reason: { settled: { status: 'error', stage: 'release-task-spawn' } } });
    expect(releaseTaskSpawnReservation(() => undefined, makeRequest(), makeState())).toMatchObject({
      value: {},
    });
  });
});

describe('attach, kickoff and activation rungs', () => {
  test('attach registers the completion callback and resolves the run when it throws', async () => {
    const registered: string[] = [];
    const state = makeState({
      spawnedSessionId: SPAWNED_SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      spawnTask: makeTask(),
    });
    const ok = await attachNodeAgent(
      async () => undefined,
      (taskId) => registered.push(taskId),
      makeRequest(),
      state
    );
    expect(ok).toEqual({ value: state });
    expect(registered).toEqual([TASK_ID]);
    const failed = await attachNodeAgent(
      async () => {
        throw new Error('attach boom');
      },
      () => undefined,
      makeRequest(),
      state
    );
    expect(failed).toMatchObject({
      reason: { settled: { status: 'error', stage: 'attach-node-agent' } },
    });
  });

  test('kickoff is skipped without the kickoff flag', async () => {
    const state = makeState({
      spawnedSessionId: SPAWNED_SESSION_ID,
      workspacePath: WORKSPACE_PATH,
    });
    expect(
      await kickoffSession(
        async () => 'msg',
        async () => undefined,
        makeRequest({ kickoff: false }),
        state
      )
    ).toEqual({ value: state });
  });

  test('kickoff resolves the run when the message cannot be built', async () => {
    const state = makeState({
      spawnedSessionId: SPAWNED_SESSION_ID,
      workspacePath: WORKSPACE_PATH,
    });
    const outcome = await kickoffSession(
      async () => {
        throw new Error('build boom');
      },
      async () => undefined,
      makeRequest(),
      state
    );
    expect(outcome).toMatchObject({
      reason: { settled: { status: 'error', stage: 'kickoff-session' } },
    });
  });

  test('pool activation resolves the run when it throws', () => {
    const state = makeState({ spawnedSessionId: SPAWNED_SESSION_ID });
    expect(
      activatePoolAssignment(
        () => {
          throw new Error('activate boom');
        },
        makeRequest(),
        state
      )
    ).toMatchObject({
      reason: { settled: { status: 'error', stage: 'activate-pool-assignment' } },
    });
    expect(activatePoolAssignment(() => undefined, makeRequest(), makeState())).toEqual({
      value: makeState(),
    });
  });

  test('completion hands back the spawned session id', () => {
    expect(completeSpawn(makeState({ spawnedSessionId: SPAWNED_SESSION_ID }))).toEqual({
      value: makeState({ spawnedSessionId: SPAWNED_SESSION_ID, result: SPAWNED_SESSION_ID }),
    });
  });
});
