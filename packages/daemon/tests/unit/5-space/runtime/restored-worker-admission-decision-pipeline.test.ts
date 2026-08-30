import { describe, expect, test } from 'bun:test';
import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import {
  applyDaemonCleanupGate,
  applyManualQueryModeGate,
  applyTaskGate,
  decideRestoredWorkerAdmission,
  type RestoredWorkerAdmissionCtx,
  type RestoredWorkerAdmissionInput,
} from '../../../../src/lib/space/runtime/restored-worker-admission-decision-pipeline';

const POST_APPROVAL_SESSION_ID = 'space:space-1:task:task-1:post-approval:worker';
const EXECUTION_SESSION_ID = 'space:space-1:task:task-1:exec:e1';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    workflowRunId: 'run-1',
    status: 'in_progress',
    ...overrides,
  } as SpaceTask;
}

function makeRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
  return { id: 'run-1', status: 'in_progress', ...overrides } as SpaceWorkflowRun;
}

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 'space-1',
    stopped: false,
    paused: false,
    status: 'active',
    ...overrides,
  } as Space;
}

function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    workflowRunId: 'run-1',
    agentSessionId: EXECUTION_SESSION_ID,
    agentName: 'coder',
    status: 'in_progress',
    ...overrides,
  } as NodeExecution;
}

function undecided(input: Partial<RestoredWorkerAdmissionInput> = {}): RestoredWorkerAdmissionCtx {
  return {
    settleReplayProvisioning: false,
    queryMode: undefined,
    daemonCleaningUp: false,
    task: makeTask(),
    workflowRun: makeRun(),
    fetchSpace: async () => makeSpace(),
    sessionId: EXECUTION_SESSION_ID,
    sessionStatus: 'active',
    execution: makeExecution(),
    hasQueuedRetryableHookAction: false,
    ...input,
    decision: null,
  };
}

describe('restored worker admission decisionRun gates', () => {
  test('non-deciding sync gates pass the ctx through by reference', () => {
    const ctx = undecided();
    expect(applyManualQueryModeGate(ctx)).toBe(ctx);
    expect(applyDaemonCleanupGate(ctx)).toBe(ctx);
    expect(applyTaskGate(ctx)).toBe(ctx);
  });

  test('manual query mode denies unless replay provisioning is settling', async () => {
    await expect(decideRestoredWorkerAdmission(undecided({ queryMode: 'manual' }))).resolves.toBe(
      false
    );
    await expect(
      decideRestoredWorkerAdmission(
        undecided({ queryMode: 'manual', settleReplayProvisioning: true })
      )
    ).resolves.toBe(true);
  });

  test('daemon cleanup denies', async () => {
    await expect(
      decideRestoredWorkerAdmission(undecided({ daemonCleaningUp: true }))
    ).resolves.toBe(false);
  });

  test('missing task, missing run binding, or terminal task denies', async () => {
    await expect(decideRestoredWorkerAdmission(undecided({ task: null }))).resolves.toBe(false);
    await expect(
      decideRestoredWorkerAdmission(undecided({ task: makeTask({ workflowRunId: null }) }))
    ).resolves.toBe(false);
    await expect(
      decideRestoredWorkerAdmission(undecided({ task: makeTask({ status: 'cancelled' }) }))
    ).resolves.toBe(false);
    await expect(
      decideRestoredWorkerAdmission(undecided({ task: makeTask({ status: 'archived' }) }))
    ).resolves.toBe(false);
  });

  test('missing or cancelled workflow run denies', async () => {
    await expect(decideRestoredWorkerAdmission(undecided({ workflowRun: null }))).resolves.toBe(
      false
    );
    await expect(
      decideRestoredWorkerAdmission(undecided({ workflowRun: makeRun({ status: 'cancelled' }) }))
    ).resolves.toBe(false);
  });

  test('stopped, paused, archived, or missing space denies', async () => {
    for (const space of [
      makeSpace({ stopped: true }),
      makeSpace({ paused: true }),
      makeSpace({ status: 'archived' }),
      null,
    ]) {
      await expect(
        decideRestoredWorkerAdmission(undecided({ fetchSpace: async () => space }))
      ).resolves.toBe(false);
    }
  });

  test('archived or ended session status denies', async () => {
    await expect(
      decideRestoredWorkerAdmission(undecided({ sessionStatus: 'archived' }))
    ).resolves.toBe(false);
    await expect(
      decideRestoredWorkerAdmission(undecided({ sessionStatus: 'ended' }))
    ).resolves.toBe(false);
  });

  test('post-approval sessions admit exactly when the task is approved', async () => {
    const approved = undecided({
      sessionId: POST_APPROVAL_SESSION_ID,
      task: makeTask({ status: 'approved' }),
      workflowRun: makeRun({ status: 'done' }),
    });
    await expect(decideRestoredWorkerAdmission(approved)).resolves.toBe(true);
    await expect(
      decideRestoredWorkerAdmission(
        undecided({ sessionId: POST_APPROVAL_SESSION_ID, task: makeTask({ status: 'done' }) })
      )
    ).resolves.toBe(false);
  });

  test('terminal task or finished run denies ordinary workers', async () => {
    await expect(
      decideRestoredWorkerAdmission(undecided({ task: makeTask({ status: 'done' }) }))
    ).resolves.toBe(false);
    await expect(
      decideRestoredWorkerAdmission(undecided({ workflowRun: makeRun({ status: 'done' }) }))
    ).resolves.toBe(false);
  });

  test('missing or non-resumable execution denies ordinary workers', async () => {
    await expect(decideRestoredWorkerAdmission(undecided({ execution: null }))).resolves.toBe(
      false
    );
    await expect(
      decideRestoredWorkerAdmission(undecided({ execution: makeExecution({ status: 'idle' }) }))
    ).resolves.toBe(false);
    await expect(
      decideRestoredWorkerAdmission(
        undecided({ execution: makeExecution({ status: 'cancelled' }) })
      )
    ).resolves.toBe(false);
    await expect(
      decideRestoredWorkerAdmission(undecided({ execution: makeExecution({ status: 'blocked' }) }))
    ).resolves.toBe(true);
    await expect(
      decideRestoredWorkerAdmission({
        ...undecided({ execution: makeExecution({ status: 'idle' }) }),
        hasQueuedRetryableHookAction: true,
      })
    ).resolves.toBe(true);
  });
});

describe('restored worker admission fact-read ordering', () => {
  function countingInput(input: Partial<RestoredWorkerAdmissionInput> = {}): {
    input: RestoredWorkerAdmissionInput;
    reads: Record<string, number>;
  } {
    const reads: Record<string, number> = {
      daemonCleaningUp: 0,
      task: 0,
      workflowRun: 0,
      fetchSpace: 0,
      sessionStatus: 0,
      execution: 0,
      hasQueuedRetryableHookAction: 0,
    };
    const wrap =
      <T>(key: string, fn: () => T): (() => T) =>
      () => {
        reads[key] += 1;
        return fn();
      };
    return {
      reads,
      input: undecided({
        daemonCleaningUp: wrap('daemonCleaningUp', () => false),
        task: wrap('task', () => makeTask()),
        workflowRun: wrap('workflowRun', () => makeRun()),
        fetchSpace: wrap('fetchSpace', async () => makeSpace()),
        sessionStatus: wrap('sessionStatus', () => 'active'),
        execution: wrap('execution', () => makeExecution()),
        hasQueuedRetryableHookAction: wrap('hasQueuedRetryableHookAction', () => false),
        ...input,
      }),
    };
  }

  test('a manual-mode deny reads no other facts', async () => {
    const { input, reads } = countingInput({ queryMode: 'manual' });
    await expect(decideRestoredWorkerAdmission(input)).resolves.toBe(false);
    expect(reads).toEqual({
      daemonCleaningUp: 0,
      task: 0,
      workflowRun: 0,
      fetchSpace: 0,
      sessionStatus: 0,
      execution: 0,
      hasQueuedRetryableHookAction: 0,
    });
  });

  test('a terminal-task deny reads no run, space, session, or execution facts', async () => {
    const { input, reads } = countingInput({ task: () => makeTask({ status: 'cancelled' }) });
    await expect(decideRestoredWorkerAdmission(input)).resolves.toBe(false);
    expect(reads.workflowRun).toBe(0);
    expect(reads.fetchSpace).toBe(0);
    expect(reads.sessionStatus).toBe(0);
    expect(reads.execution).toBe(0);
  });

  test('a cancelled-run deny never awaits the space lookup', async () => {
    const { input, reads } = countingInput({
      workflowRun: () => makeRun({ status: 'cancelled' }),
    });
    await expect(decideRestoredWorkerAdmission(input)).resolves.toBe(false);
    expect(reads.fetchSpace).toBe(0);
    expect(reads.sessionStatus).toBe(0);
  });

  test('the session status is read only after the space lookup resolves', async () => {
    const order: string[] = [];
    const input: RestoredWorkerAdmissionInput = undecided({
      fetchSpace: async () => {
        order.push('fetchSpace');
        return makeSpace();
      },
      sessionStatus: () => {
        order.push('sessionStatus');
        return 'active';
      },
    });
    await expect(decideRestoredWorkerAdmission(input)).resolves.toBe(true);
    expect(order).toEqual(['fetchSpace', 'sessionStatus']);
  });

  test('a session archiving while the space lookup is in flight denies admission', async () => {
    let sessionStatus = 'active';
    const input: RestoredWorkerAdmissionInput = undecided({
      fetchSpace: async () => {
        sessionStatus = 'archived';
        return makeSpace();
      },
      sessionStatus: () => sessionStatus,
    });
    await expect(decideRestoredWorkerAdmission(input)).resolves.toBe(false);
  });

  test('a space-gate deny skips the session, execution, and hook facts', async () => {
    const { input, reads } = countingInput({
      fetchSpace: async () => makeSpace({ paused: true }),
    });
    await expect(decideRestoredWorkerAdmission(input)).resolves.toBe(false);
    expect(reads.sessionStatus).toBe(0);
    expect(reads.execution).toBe(0);
    expect(reads.hasQueuedRetryableHookAction).toBe(0);
  });

  test('the queued retryable hook action fact is only read after the execution status gate', async () => {
    const { input, reads } = countingInput({
      execution: () => makeExecution({ status: 'in_progress' }),
    });
    await expect(decideRestoredWorkerAdmission(input)).resolves.toBe(true);
    expect(reads.hasQueuedRetryableHookAction).toBe(0);
  });
});
