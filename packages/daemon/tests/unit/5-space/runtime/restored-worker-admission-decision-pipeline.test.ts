import { describe, expect, test } from 'bun:test';
import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import {
  applyDaemonCleanupGate,
  applyManualQueryModeGate,
  applyTaskTerminalGate,
  applyTaskWorkflowGate,
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
    space: makeSpace(),
    sessionId: EXECUTION_SESSION_ID,
    sessionStatus: 'active',
    execution: makeExecution(),
    hasQueuedRetryableHookAction: false,
    ...input,
    decision: null,
  };
}

describe('restored worker admission decisionRun gates', () => {
  test('non-deciding gates pass the ctx through by reference', () => {
    const ctx = undecided();
    expect(applyManualQueryModeGate(ctx)).toBe(ctx);
    expect(applyDaemonCleanupGate(ctx)).toBe(ctx);
    expect(applyTaskWorkflowGate(ctx)).toBe(ctx);
    expect(applyTaskTerminalGate(ctx)).toBe(ctx);
  });

  test('manual query mode denies unless replay provisioning is settling', () => {
    expect(undecided({ queryMode: 'manual' }).queryMode).toBe('manual');
    expect(decideRestoredWorkerAdmission(undecided({ queryMode: 'manual' }))).toBe(false);
    expect(
      decideRestoredWorkerAdmission(
        undecided({ queryMode: 'manual', settleReplayProvisioning: true })
      )
    ).toBe(true);
  });

  test('daemon cleanup denies', () => {
    expect(decideRestoredWorkerAdmission(undecided({ daemonCleaningUp: true }))).toBe(false);
  });

  test('missing task or workflow run binding denies', () => {
    expect(decideRestoredWorkerAdmission(undecided({ task: null }))).toBe(false);
    expect(
      decideRestoredWorkerAdmission(undecided({ task: makeTask({ workflowRunId: null }) }))
    ).toBe(false);
  });

  test('cancelled or archived task denies', () => {
    expect(
      decideRestoredWorkerAdmission(undecided({ task: makeTask({ status: 'cancelled' }) }))
    ).toBe(false);
    expect(
      decideRestoredWorkerAdmission(undecided({ task: makeTask({ status: 'archived' }) }))
    ).toBe(false);
  });

  test('missing or cancelled workflow run denies', () => {
    expect(decideRestoredWorkerAdmission(undecided({ workflowRun: null }))).toBe(false);
    expect(
      decideRestoredWorkerAdmission(undecided({ workflowRun: makeRun({ status: 'cancelled' }) }))
    ).toBe(false);
  });

  test('archived or ended session status denies', () => {
    expect(decideRestoredWorkerAdmission(undecided({ sessionStatus: 'archived' }))).toBe(false);
    expect(decideRestoredWorkerAdmission(undecided({ sessionStatus: 'ended' }))).toBe(false);
  });

  test('stopped, paused, archived, or missing space denies', () => {
    expect(decideRestoredWorkerAdmission(undecided({ space: makeSpace({ stopped: true }) }))).toBe(
      false
    );
    expect(decideRestoredWorkerAdmission(undecided({ space: makeSpace({ paused: true }) }))).toBe(
      false
    );
    expect(
      decideRestoredWorkerAdmission(undecided({ space: makeSpace({ status: 'archived' }) }))
    ).toBe(false);
    expect(decideRestoredWorkerAdmission(undecided({ space: null }))).toBe(false);
  });

  test('post-approval sessions admit exactly when the task is approved', () => {
    const approved = undecided({
      sessionId: POST_APPROVAL_SESSION_ID,
      task: makeTask({ status: 'approved' }),
      workflowRun: makeRun({ status: 'done' }),
    });
    expect(decideRestoredWorkerAdmission(approved)).toBe(true);
    expect(
      decideRestoredWorkerAdmission(
        undecided({ sessionId: POST_APPROVAL_SESSION_ID, task: makeTask({ status: 'done' }) })
      )
    ).toBe(false);
  });

  test('terminal task or finished run denies ordinary workers', () => {
    expect(decideRestoredWorkerAdmission(undecided({ task: makeTask({ status: 'done' }) }))).toBe(
      false
    );
    expect(
      decideRestoredWorkerAdmission(undecided({ workflowRun: makeRun({ status: 'done' }) }))
    ).toBe(false);
  });

  test('missing or non-resumable execution denies ordinary workers', () => {
    expect(decideRestoredWorkerAdmission(undecided({ execution: null }))).toBe(false);
    expect(
      decideRestoredWorkerAdmission(undecided({ execution: makeExecution({ status: 'idle' }) }))
    ).toBe(false);
    expect(
      decideRestoredWorkerAdmission(
        undecided({ execution: makeExecution({ status: 'cancelled' }) })
      )
    ).toBe(false);
    expect(
      decideRestoredWorkerAdmission(undecided({ execution: makeExecution({ status: 'blocked' }) }))
    ).toBe(true);
    expect(
      decideRestoredWorkerAdmission({
        ...undecided({ execution: makeExecution({ status: 'idle' }) }),
        hasQueuedRetryableHookAction: true,
      })
    ).toBe(true);
  });

  test('later gates never read lazy inputs once an earlier gate denies', () => {
    let sessionStatusReads = 0;
    let executionReads = 0;
    let hookReads = 0;
    const input: RestoredWorkerAdmissionInput = {
      ...undecided({ daemonCleaningUp: true }),
      sessionStatus: () => {
        sessionStatusReads += 1;
        return 'active';
      },
      execution: () => {
        executionReads += 1;
        return makeExecution();
      },
      hasQueuedRetryableHookAction: () => {
        hookReads += 1;
        return true;
      },
    };
    expect(decideRestoredWorkerAdmission(input)).toBe(false);
    expect(sessionStatusReads).toBe(0);
    expect(executionReads).toBe(0);
    expect(hookReads).toBe(0);
  });

  test('the queued retryable hook action fact is only read after the execution status gate', () => {
    let hookReads = 0;
    const input: RestoredWorkerAdmissionInput = {
      ...undecided({ execution: makeExecution({ status: 'in_progress' }) }),
      hasQueuedRetryableHookAction: () => {
        hookReads += 1;
        return false;
      },
    };
    expect(decideRestoredWorkerAdmission(input)).toBe(true);
    expect(hookReads).toBe(0);
  });
});
