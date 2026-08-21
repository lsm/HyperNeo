import { describe, expect, test } from 'bun:test';
import { isWorkflowRecoveryTransition } from '@hyperneo/shared';
import {
  routeTaskUpdate,
  type TaskUpdateRoutingInput,
} from '../../../../src/lib/space/tools/task-transition-routing.ts';

function baseInput(overrides: Partial<TaskUpdateRoutingInput> = {}): TaskUpdateRoutingInput {
  return {
    hasChanges: true,
    taskExists: true,
    taskInSpace: true,
    currentStatus: 'in_progress',
    requestedStatus: 'open',
    statusDiffers: true,
    hasWorkflowRun: false,
    runActive: false,
    isRecoveryTransition: false,
    hasFieldUpdates: false,
    taskId: 'task-1',
    workflowRunId: 'run-1',
    ...overrides,
  };
}

describe('routeTaskUpdate reject reasons', () => {
  test('no_updatable_fields wins before existence checks and keeps its message', () => {
    expect(routeTaskUpdate(baseInput({ hasChanges: false, taskExists: false }))).toEqual({
      action: 'reject',
      reason: 'no_updatable_fields',
      message:
        'No fields to update. Provide at least one of: title, description, priority, depends_on, status.',
    });
  });

  test('task_not_found wins before space and status checks and interpolates the task id', () => {
    expect(
      routeTaskUpdate(
        baseInput({ taskExists: false, taskInSpace: false, requestedStatus: 'review' })
      )
    ).toEqual({
      action: 'reject',
      reason: 'task_not_found',
      message: 'Task not found: task-1',
    });
  });

  test('task_not_in_space wins before status checks and interpolates the task id', () => {
    expect(routeTaskUpdate(baseInput({ taskInSpace: false, requestedStatus: 'review' }))).toEqual({
      action: 'reject',
      reason: 'task_not_in_space',
      message: 'Task task-1 does not belong to this space.',
    });
  });

  test('review_direct rejects even for workflow-backed recovery-shaped requests', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'open',
          requestedStatus: 'review',
          hasWorkflowRun: true,
          isRecoveryTransition: true,
        })
      )
    ).toEqual({
      action: 'reject',
      reason: 'review_direct',
      message:
        `update_task cannot transition a task into 'review' directly. ` +
        `Use submit_for_approval so the pending-completion fields get stamped ` +
        `and the approval banner renders.`,
    });
  });

  test('approved_direct rejects even for workflow-backed recovery-shaped requests', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'open',
          requestedStatus: 'approved',
          hasWorkflowRun: true,
          isRecoveryTransition: true,
        })
      )
    ).toEqual({
      action: 'reject',
      reason: 'approved_direct',
      message:
        `update_task cannot transition a task into 'approved' directly. ` +
        `Use approve_pending_completion after submit_for_approval, or let the ` +
        `runtime's post-approval router handle the transition — both stamp ` +
        `the approval metadata and dispatch the configured post-approval step.`,
    });
  });

  test('review_to_done rejects even for workflow-backed tasks', () => {
    expect(
      routeTaskUpdate(
        baseInput({ currentStatus: 'review', requestedStatus: 'done', hasWorkflowRun: true })
      )
    ).toEqual({
      action: 'reject',
      reason: 'review_to_done',
      message:
        `update_task cannot transition a task from 'review' to 'done' directly. ` +
        `Use approve_task (subject to the workflow's completion autonomy level) ` +
        `or submit_for_approval so a human can approve via the UI — both stamp ` +
        `the approval metadata and dispatch the configured post-approval step.`,
    });
  });

  test('archive_active_run interpolates the task id and workflow run id', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'in_progress',
          requestedStatus: 'archived',
          hasWorkflowRun: true,
          runActive: true,
          workflowRunId: 'run-9',
        })
      )
    ).toEqual({
      action: 'reject',
      reason: 'archive_active_run',
      message:
        `Cannot archive task task-1: it belongs to an active workflow run ` +
        `(run-9). Cancel the task instead (cancel_task) so its ` +
        `agents and lifecycle are torn down — archiving would leave the run stranded.`,
    });
  });

  test('archiving a workflow-backed task is allowed when the run is not active', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'in_progress',
          requestedStatus: 'archived',
          hasWorkflowRun: true,
          runActive: false,
        })
      )
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });
});

describe('routeTaskUpdate action branches', () => {
  test('a requested stop on a workflow-backed task parks', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'in_progress',
          requestedStatus: 'stopped',
          hasWorkflowRun: true,
        })
      )
    ).toEqual({
      action: 'park_stopped',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'only_with_field_updates',
    });
  });

  test('a requested stop without a workflow run is a plain status set', () => {
    expect(
      routeTaskUpdate(baseInput({ currentStatus: 'in_progress', requestedStatus: 'stopped' }))
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });

  test('a workflow-backed recovery transition recovers', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'blocked',
          requestedStatus: 'open',
          hasWorkflowRun: true,
          isRecoveryTransition: isWorkflowRecoveryTransition('blocked', 'open'),
        })
      )
    ).toEqual({
      action: 'recover_transition',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'only_with_field_updates',
    });
  });

  test('a recovery-shaped transition without a workflow run is a plain status set', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'blocked',
          requestedStatus: 'open',
          isRecoveryTransition: isWorkflowRecoveryTransition('blocked', 'open'),
        })
      )
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });

  test('workflow-backed active tasks moving to open or cancelled stop for status', () => {
    for (const requestedStatus of ['open', 'cancelled'] as const) {
      expect(
        routeTaskUpdate(
          baseInput({ currentStatus: 'in_progress', requestedStatus, hasWorkflowRun: true })
        )
      ).toEqual({
        action: 'stop_for_status',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'never',
      });
    }
  });

  test('an active-to-cancelled transition without a workflow run is a plain status set', () => {
    expect(
      routeTaskUpdate(baseInput({ currentStatus: 'in_progress', requestedStatus: 'cancelled' }))
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });

  test('any other status change is a plain status set', () => {
    expect(
      routeTaskUpdate(baseInput({ currentStatus: 'open', requestedStatus: 'in_progress' }))
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });

  test('an update without a requested status is fields-only', () => {
    expect(
      routeTaskUpdate(baseInput({ requestedStatus: undefined, statusDiffers: false }))
    ).toEqual({
      action: 'fields_only',
      auditParamsShape: 'fields_only',
      emitTaskUpdated: 'always',
    });
  });

  test('a requested status equal to the current one is fields-only', () => {
    expect(
      routeTaskUpdate(baseInput({ requestedStatus: 'in_progress', statusDiffers: false }))
    ).toEqual({
      action: 'fields_only',
      auditParamsShape: 'fields_only',
      emitTaskUpdated: 'always',
    });
  });

  test('an undefined requested status stays fields-only even with an inconsistent diff flag', () => {
    expect(routeTaskUpdate(baseInput({ requestedStatus: undefined }))).toEqual({
      action: 'fields_only',
      auditParamsShape: 'fields_only',
      emitTaskUpdated: 'always',
    });
  });

  test('routing ignores whether field updates accompany the request', () => {
    for (const hasFieldUpdates of [false, true]) {
      expect(
        routeTaskUpdate(
          baseInput({ hasFieldUpdates, currentStatus: 'review', requestedStatus: 'done' })
        ).action
      ).toBe('reject');
      expect(
        routeTaskUpdate(baseInput({ hasFieldUpdates, currentStatus: 'in_progress' })).action
      ).toBe('set_status');
    }
  });
});

describe('routeTaskUpdate precedence', () => {
  test('a requested stop parks before recovery routing', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'blocked',
          requestedStatus: 'stopped',
          hasWorkflowRun: true,
          isRecoveryTransition: true,
        })
      )
    ).toEqual({
      action: 'park_stopped',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'only_with_field_updates',
    });
  });

  test('recovery routing wins over stop-for-status for the same transition', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'blocked',
          requestedStatus: 'open',
          hasWorkflowRun: true,
          isRecoveryTransition: true,
        })
      )
    ).toEqual({
      action: 'recover_transition',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'only_with_field_updates',
    });
  });

  test('stop-for-status wins over the plain status set only with a workflow run', () => {
    const shared = {
      currentStatus: 'in_progress',
      requestedStatus: 'cancelled',
    };
    expect(routeTaskUpdate(baseInput({ ...shared, hasWorkflowRun: true }))).toEqual({
      action: 'stop_for_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'never',
    });
    expect(routeTaskUpdate(baseInput({ ...shared, hasWorkflowRun: false }))).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });
});

describe('routeTaskUpdate fromActivePaused boundaries', () => {
  test('every active-or-paused status stops for status when cancelled', () => {
    for (const currentStatus of [
      'in_progress',
      'blocked',
      'stopped',
      'rate_limited',
      'usage_limited',
    ] as const) {
      expect(
        routeTaskUpdate(
          baseInput({ currentStatus, requestedStatus: 'cancelled', hasWorkflowRun: true })
        )
      ).toEqual({
        action: 'stop_for_status',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'never',
      });
    }
  });

  test('open targets stop non-recovery paused statuses but recover blocked and cancelled ones', () => {
    for (const currentStatus of [
      'in_progress',
      'stopped',
      'rate_limited',
      'usage_limited',
    ] as const) {
      expect(
        routeTaskUpdate(
          baseInput({
            currentStatus,
            requestedStatus: 'open',
            hasWorkflowRun: true,
            isRecoveryTransition: isWorkflowRecoveryTransition(currentStatus, 'open'),
          })
        )
      ).toEqual({
        action: 'stop_for_status',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'never',
      });
    }
    for (const currentStatus of ['blocked', 'cancelled'] as const) {
      expect(
        routeTaskUpdate(
          baseInput({
            currentStatus,
            requestedStatus: 'open',
            hasWorkflowRun: true,
            isRecoveryTransition: isWorkflowRecoveryTransition(currentStatus, 'open'),
          })
        )
      ).toEqual({
        action: 'recover_transition',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'only_with_field_updates',
      });
    }
  });

  test('statuses outside the active-or-paused set are plain status sets', () => {
    for (const currentStatus of [
      'draft',
      'open',
      'review',
      'approved',
      'done',
      'archived',
    ] as const) {
      expect(
        routeTaskUpdate(
          baseInput({
            currentStatus,
            requestedStatus: 'cancelled',
            hasWorkflowRun: true,
            isRecoveryTransition: isWorkflowRecoveryTransition(currentStatus, 'cancelled'),
          })
        )
      ).toEqual({
        action: 'set_status',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'always',
      });
    }
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'cancelled',
          requestedStatus: 'archived',
          hasWorkflowRun: true,
          isRecoveryTransition: isWorkflowRecoveryTransition('cancelled', 'archived'),
        })
      )
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });
});

describe('routeTaskUpdate rate-limit-limited boundaries', () => {
  test('limited statuses stop for status when moving to blocked', () => {
    for (const currentStatus of ['rate_limited', 'usage_limited'] as const) {
      expect(
        routeTaskUpdate(
          baseInput({
            currentStatus,
            requestedStatus: 'blocked',
            hasWorkflowRun: true,
            isRecoveryTransition: isWorkflowRecoveryTransition(currentStatus, 'blocked'),
          })
        )
      ).toEqual({
        action: 'stop_for_status',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'never',
      });
    }
  });

  test('blocked from a non-limited paused status is a plain status set', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'in_progress',
          requestedStatus: 'blocked',
          hasWorkflowRun: true,
        })
      )
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });

  test('blocked equal to the current status is fields-only', () => {
    expect(
      routeTaskUpdate(
        baseInput({ currentStatus: 'blocked', requestedStatus: 'blocked', statusDiffers: false })
      )
    ).toEqual({
      action: 'fields_only',
      auditParamsShape: 'fields_only',
      emitTaskUpdated: 'always',
    });
  });

  test('limited statuses moving to blocked without a workflow run are plain status sets', () => {
    expect(
      routeTaskUpdate(baseInput({ currentStatus: 'rate_limited', requestedStatus: 'blocked' }))
    ).toEqual({
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    });
  });

  test('limited statuses recover to in_progress before the stop path', () => {
    expect(
      routeTaskUpdate(
        baseInput({
          currentStatus: 'usage_limited',
          requestedStatus: 'in_progress',
          hasWorkflowRun: true,
          isRecoveryTransition: isWorkflowRecoveryTransition('usage_limited', 'in_progress'),
        })
      )
    ).toEqual({
      action: 'recover_transition',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'only_with_field_updates',
    });
  });
});
