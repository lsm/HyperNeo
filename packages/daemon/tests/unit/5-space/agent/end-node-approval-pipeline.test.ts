import { describe, expect, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import {
  applyDispatch,
  applyLoadTask,
  applyReportStamp,
  applyStatusAdmission,
  mapApprovalRouteResponse,
  runEndNodeApproval,
  type EndNodeApprovalCtx,
  type EndNodeApprovalDeps,
} from '../../../../src/lib/space/tools/end-node-approval-pipeline.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { PostApprovalRouteResult } from '../../../../src/lib/space/runtime/post-approval-router.ts';

function makeTask(status: SpaceTask['status']): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    status,
  } as SpaceTask;
}

function makeCtx(
  overrides: Partial<EndNodeApprovalCtx> = {},
  deps: Partial<EndNodeApprovalDeps> = {}
): EndNodeApprovalCtx {
  return {
    taskId: 'task-1',
    taskRepo: { getTask: () => null, updateTask: () => null } as unknown as Pick<
      SpaceTaskRepository,
      'getTask' | 'updateTask'
    >,
    dispatchApproval: async () => ({ mode: 'no-route', taskStatus: 'done' }),
    emitTaskUpdated: () => {},
    task: null,
    routeResult: null,
    dispatchError: null,
    response: null,
    halt: null,
    ...deps,
    ...overrides,
  };
}

describe('end-node-approval pipeline — applyStatusAdmission decision table', () => {
  test.each(['review', 'approved'] as const)('admits a %s task', (status) => {
    const ctx = applyStatusAdmission(makeCtx({ task: makeTask(status) }));
    expect(ctx.halt).toBeNull();
    expect(ctx.response).toBeNull();
  });

  test.each([
    'done',
    'cancelled',
    'archived',
  ] as const)('rejects a terminal %s task with a not-applicable response', (status) => {
    const ctx = applyStatusAdmission(makeCtx({ task: makeTask(status) }));
    expect(ctx.halt).toBe('resolved');
    const parsed = JSON.parse(ctx.response!.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain(`already '${status}'`);
  });

  test.each([
    'in_progress',
    'open',
    'blocked',
    'stopped',
    'rate_limited',
    'usage_limited',
  ] as const)('diverts a %s task to the legacy completion-pipeline path', (status) => {
    const ctx = applyStatusAdmission(makeCtx({ task: makeTask(status) }));
    expect(ctx.halt).toBe('completion_pipeline');
  });

  test('halts resolved with a not-found response when the task does not exist', () => {
    const ctx = applyLoadTask(
      makeCtx(
        {},
        {
          taskRepo: { getTask: () => null } as unknown as Pick<
            SpaceTaskRepository,
            'getTask' | 'updateTask'
          >,
        }
      )
    );
    expect(ctx.halt).toBe('resolved');
    const parsed = JSON.parse(ctx.response!.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Task not found');
  });

  test('applyReportStamp stamps reportedStatus=done and emits the update', () => {
    const emitted: string[] = [];
    const stampedTask = makeTask('review');
    const ctx = applyReportStamp(
      makeCtx(
        { task: makeTask('review') },
        {
          taskRepo: {
            getTask: () => stampedTask,
            updateTask: (_id, params) =>
              params.reportedStatus === 'done' ? { ...stampedTask, reportedStatus: 'done' } : null,
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
          emitTaskUpdated: (task) => emitted.push(task.id),
        }
      )
    );
    expect(ctx.halt).toBeNull();
    expect(emitted).toEqual(['task-1']);
  });

  test('applyReportStamp skips a task rejected while the dispatch was in flight', () => {
    const updates: Array<Record<string, unknown>> = [];
    const admitted = { ...makeTask('review'), pendingCompletionSubmittedAt: 500 } as SpaceTask;
    const rejected = {
      ...makeTask('in_progress'),
      pendingCompletionSubmittedAt: null,
    } as SpaceTask;
    const ctx = applyReportStamp(
      makeCtx(
        { task: admitted },
        {
          taskRepo: {
            getTask: () => rejected,
            updateTask: (_id, params) => {
              updates.push(params as Record<string, unknown>);
              return rejected;
            },
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
        }
      )
    );
    expect(updates).toHaveLength(0);
    expect(rejected.reportedStatus).toBeFalsy();
  });

  test('applyReportStamp skips a review generation re-submitted while the dispatch was in flight', () => {
    const updates: Array<Record<string, unknown>> = [];
    const admitted = { ...makeTask('review'), pendingCompletionSubmittedAt: 500 } as SpaceTask;
    const resubmitted = {
      ...makeTask('review'),
      pendingCompletionSubmittedAt: 900,
    } as SpaceTask;
    const ctx = applyReportStamp(
      makeCtx(
        { task: admitted },
        {
          taskRepo: {
            getTask: () => resubmitted,
            updateTask: (_id, params) => {
              updates.push(params as Record<string, unknown>);
              return resubmitted;
            },
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
        }
      )
    );
    expect(updates).toHaveLength(0);
  });
});

describe('end-node-approval pipeline — mapApprovalRouteResponse', () => {
  test('maps a skipped dispatch to a failure with the reason', () => {
    const out = mapApprovalRouteResponse({ mode: 'skipped', reason: 'router not wired' }, 'task-1');
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('router not wired');
  });

  test('maps a no-route dispatch to a done response', () => {
    const out = mapApprovalRouteResponse({ mode: 'no-route', taskStatus: 'done' }, 'task-1');
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('no post-approval route');
  });

  test('maps a spawn dispatch to a post-approval work response', () => {
    const out = mapApprovalRouteResponse(
      {
        mode: 'spawn',
        postApprovalSessionId: 'session-1',
        postApprovalStartedAt: 1,
        missingKeys: [],
      },
      'task-1'
    );
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('mark_complete');
  });

  test('maps an already-routed dispatch to an in-flight response', () => {
    const out = mapApprovalRouteResponse(
      { mode: 'already-routed', postApprovalSessionId: 'session-1' },
      'task-1'
    );
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('already running');
  });
});

describe('end-node-approval pipeline — applyDispatch failure recording', () => {
  test('records postApprovalBlockedReason when the dispatch throws after the approval commit', async () => {
    const task = makeTask('review');
    let stored: SpaceTask = { ...task, status: 'approved' };
    const updates: Array<Record<string, unknown>> = [];
    const ctx = await applyDispatch(
      makeCtx(
        { task },
        {
          taskRepo: {
            getTask: () => stored,
            updateTask: (_id, params) => {
              updates.push(params as Record<string, unknown>);
              stored = { ...stored, ...(params as object) } as SpaceTask;
              return stored;
            },
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
          dispatchApproval: async () => {
            throw new Error('spawn failed permanently');
          },
        }
      )
    );
    expect(ctx.halt).toBeNull();
    expect(ctx.dispatchError).toContain('spawn failed permanently');
    expect(updates[0].postApprovalBlockedReason).toContain('Approval recorded');
  });

  test('does not record a blocked reason when the throw predates the approval commit', async () => {
    const task = makeTask('review');
    const updates: Array<Record<string, unknown>> = [];
    const ctx = await applyDispatch(
      makeCtx(
        { task },
        {
          taskRepo: {
            getTask: () => task,
            updateTask: (_id, params) => {
              updates.push(params as Record<string, unknown>);
              return task;
            },
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
          dispatchApproval: async () => {
            throw new Error('router not wired');
          },
        }
      )
    );
    expect(updates).toHaveLength(0);
    expect(ctx.dispatchError).toContain('router not wired');
  });

  test('never marks an already-routed approval blocked when a repeat dispatch throws', async () => {
    const task: SpaceTask = {
      ...makeTask('approved'),
      approvedAt: 111,
      workflowRunId: 'run-1',
      postApprovalSessionId: 'live-worker-1',
    };
    const fresh: SpaceTask = { ...task };
    const updates: Array<Record<string, unknown>> = [];
    const ctx = await applyDispatch(
      makeCtx(
        { task },
        {
          taskRepo: {
            getTask: () => fresh,
            updateTask: (_id, params) => {
              updates.push(params as Record<string, unknown>);
              return fresh;
            },
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
          dispatchApproval: async () => {
            throw new Error('space lookup failed');
          },
        }
      )
    );
    expect(updates).toHaveLength(0);
    expect(ctx.dispatchError).toContain('space lookup failed');
  });

  test('records a blocked reason when a skipped dispatch landed after the approval commit', async () => {
    const task = makeTask('review');
    let stored: SpaceTask = { ...task, status: 'approved' };
    const updates: Array<Record<string, unknown>> = [];
    const ctx = await applyDispatch(
      makeCtx(
        { task },
        {
          taskRepo: {
            getTask: () => stored,
            updateTask: (_id, params) => {
              updates.push(params as Record<string, unknown>);
              stored = { ...stored, ...(params as object) } as SpaceTask;
              return stored;
            },
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
          dispatchApproval: async () => ({
            mode: 'skipped' as const,
            reason: 'post-approval route has an empty instructions template',
          }),
        }
      )
    );
    expect(ctx.dispatchError).toBeNull();
    expect(ctx.routeResult?.mode).toBe('skipped');
    expect(updates[0].postApprovalBlockedReason).toContain('Approval recorded');
    expect(updates[0].postApprovalBlockedReason).toContain('empty instructions template');
  });

  test('does not double-record when the router already captured the skip as blocked', async () => {
    const task = makeTask('review');
    const stored: SpaceTask = {
      ...task,
      status: 'approved',
      postApprovalBlockedReason: 'Approval recorded, but post-approval dispatch was interrupted',
    };
    const updates: Array<Record<string, unknown>> = [];
    const ctx = await applyDispatch(
      makeCtx(
        { task },
        {
          taskRepo: {
            getTask: () => stored,
            updateTask: (_id, params) => {
              updates.push(params as Record<string, unknown>);
              return stored;
            },
          } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
          dispatchApproval: async () => ({
            mode: 'skipped' as const,
            reason: 'post-approval spawn deferred: database is locked',
          }),
        }
      )
    );
    expect(updates).toHaveLength(0);
    expect(ctx.routeResult?.mode).toBe('skipped');
  });

  test('does not expose the completion stamp to the tick before the dispatch returns', async () => {
    let reportedStatusAtDispatch: string | null = 'unset';
    let stored: SpaceTask = makeTask('review');
    const outcome = await runEndNodeApproval({
      taskId: 'task-1',
      taskRepo: {
        getTask: () => stored,
        updateTask: (_id, params) => {
          stored = { ...stored, ...(params as object) } as SpaceTask;
          return stored;
        },
      } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
      dispatchApproval: async () => {
        reportedStatusAtDispatch = stored.reportedStatus ?? null;
        stored = { ...stored, status: 'approved' } as SpaceTask;
        return { mode: 'no-route', taskStatus: 'done' };
      },
      emitTaskUpdated: () => {},
    });
    expect(reportedStatusAtDispatch).toBeNull();
    expect(outcome.action).toBe('respond');
    expect(stored.reportedStatus).toBe('done');
  });
});

describe('end-node-approval pipeline — runEndNodeApproval composition', () => {
  test('routes a non-review task to the completion pipeline without stamping or dispatching', async () => {
    const dispatches: PostApprovalRouteResult[] = [];
    const outcome = await runEndNodeApproval({
      taskId: 'task-1',
      taskRepo: {
        getTask: () => makeTask('in_progress'),
        updateTask: () => null,
      } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
      dispatchApproval: async () => {
        dispatches.push({ mode: 'no-route', taskStatus: 'done' });
        return { mode: 'no-route', taskStatus: 'done' };
      },
      emitTaskUpdated: () => {},
    });
    expect(outcome).toEqual({ action: 'completion_pipeline' });
    expect(dispatches).toHaveLength(0);
  });

  test('passes the admitted generation fence to the dispatch', async () => {
    const admitted = {
      ...makeTask('review'),
      pendingCompletionSubmittedAt: 777,
    } as SpaceTask;
    let received: { expectedStatus: string; expectedCheckpointAt: number | null } | null = null;
    const outcome = await runEndNodeApproval({
      taskId: 'task-1',
      taskRepo: {
        getTask: () => admitted,
        updateTask: () => admitted,
      } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
      dispatchApproval: async (fence) => {
        received = fence;
        return { mode: 'no-route', taskStatus: 'done' };
      },
      emitTaskUpdated: () => {},
    });
    expect(outcome.action).toBe('respond');
    expect(received).toEqual({ expectedStatus: 'review', expectedCheckpointAt: 777 });
  });

  test('dispatches a review task and returns the mapped response', async () => {
    const outcome = await runEndNodeApproval({
      taskId: 'task-1',
      taskRepo: {
        getTask: () => makeTask('review'),
        updateTask: () => makeTask('review'),
      } as unknown as Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
      dispatchApproval: async () => ({ mode: 'no-route', taskStatus: 'done' }),
      emitTaskUpdated: () => {},
    });
    expect(outcome.action).toBe('respond');
    if (outcome.action === 'respond') {
      const parsed = JSON.parse(outcome.response.content[0].text);
      expect(parsed.success).toBe(true);
    }
  });
});
