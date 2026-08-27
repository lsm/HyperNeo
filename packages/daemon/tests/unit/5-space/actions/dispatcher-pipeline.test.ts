/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { CreateMcpAuditLogParams } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import {
  applyAutonomyGate,
  applyRateAndAudit,
  applyRoleAdmission,
  applySafetyClass,
  executeAction,
  formatResult,
  resolveAction,
  runDispatchAction,
  type DispatchActionCtx,
  type DispatchActionDeps,
  type DispatchActionInput,
  type DispatchActionOutcome,
  type DispatchTelemetryEvent,
} from '../../../../src/lib/space/actions/dispatcher-pipeline.ts';
import { createActionRegistry, defineAction } from '../../../../src/lib/space/actions/registry.ts';

const SPACE_ID = 'space-1';
const TASK_ID = 'task-1';
const WORKFLOW_RUN_ID = 'run-1';
const SESSION_ID = 'session-1';
const AGENT_NAME = 'agent-1';

type DispatchedOutcome = Extract<DispatchActionOutcome, { action: 'dispatched' }>;
type DeniedOutcome = Extract<DispatchActionOutcome, { action: 'denied' }>;
type FailedOutcome = Extract<DispatchActionOutcome, { action: 'failed' }>;

const listTasks = defineAction({
  name: 'list_tasks',
  family: 'space',
  safetyClass: 'read',
  description: 'List tasks',
  paramsDoc: '{}',
  paramsSchema: z.object({}),
  handler: async () => ({ tasks: [] }),
});

const updateTask = defineAction({
  name: 'update_task',
  family: 'space',
  safetyClass: 'mutate',
  description: 'Update task',
  paramsDoc: '{ taskId: string }',
  paramsSchema: z.object({ taskId: z.string() }),
  autonomyRequirement: 4,
  handler: async (params) => ({ updated: params.taskId }),
});

const approveTask = defineAction({
  name: 'approve_task',
  family: 'node',
  safetyClass: 'human_only',
  description: 'Approve task',
  paramsDoc: '{ taskId: string }',
  paramsSchema: z.object({ taskId: z.string() }),
  autonomyRequirement: async (params) => (params.taskId === 'review-gated' ? 5 : 4),
  handler: async (params) => ({ approved: params.taskId }),
});

const sendMessage = defineAction({
  name: 'send_message',
  family: 'node',
  safetyClass: 'mutate',
  description: 'Send message',
  paramsDoc: '{}',
  paramsSchema: z.object({}),
  handler: async () => ({ sent: true }),
});

const brokenAction = defineAction({
  name: 'broken_action',
  family: 'space',
  safetyClass: 'read',
  description: 'Broken action',
  paramsDoc: '{}',
  paramsSchema: z.object({}),
  handler: async () => {
    throw new Error('handler failure');
  },
});

function makeRegistry(actions = [listTasks, updateTask, approveTask, sendMessage, brokenAction]) {
  return createActionRegistry(actions);
}

function baseInput(overrides: Partial<DispatchActionInput> = {}): DispatchActionInput {
  return {
    actionName: 'list_tasks',
    params: {},
    role: 'coordinator',
    spaceId: SPACE_ID,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<DispatchActionDeps> = {}): DispatchActionDeps {
  return {
    registry: makeRegistry(),
    ...overrides,
  };
}

function buildCtx(
  inputOverrides: Partial<DispatchActionInput> = {},
  depsOverrides: Partial<DispatchActionDeps> = {}
): DispatchActionCtx {
  const input = baseInput(inputOverrides);
  return { ...input, deps: baseDeps(depsOverrides) };
}

function withDeps(
  ctx: DispatchActionCtx,
  depsOverrides: Partial<DispatchActionDeps>
): DispatchActionCtx {
  return { ...ctx, deps: { ...ctx.deps, ...depsOverrides } };
}

function extractText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

function assertDenied(outcome: DispatchActionOutcome): asserts outcome is DeniedOutcome {
  expect(outcome.action).toBe('denied');
  if (outcome.action !== 'denied') {
    throw new Error('Expected denied outcome');
  }
}

function assertFailed(outcome: DispatchActionOutcome): asserts outcome is FailedOutcome {
  expect(outcome.action).toBe('failed');
  if (outcome.action !== 'failed') {
    throw new Error('Expected failed outcome');
  }
}

function assertDispatched(outcome: DispatchActionOutcome): asserts outcome is DispatchedOutcome {
  expect(outcome.action).toBe('dispatched');
  if (outcome.action !== 'dispatched') {
    throw new Error('Expected dispatched outcome');
  }
}

describe('resolveAction', () => {
  test('resolves a registered action and parses parameters', () => {
    const ctx = buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } });
    const next = resolveAction(ctx);
    expect(next.outcome).toBeUndefined();
    expect(next.action?.name).toBe('update_task');
    expect(next.parsedParams).toEqual({ taskId: 't-1' });
  });

  test('denies unknown actions', () => {
    const ctx = buildCtx({ actionName: 'missing_action' });
    const next = resolveAction(ctx);
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('unknown_action');
    expect(next.outcome.message).toContain('missing_action');
  });

  test('denies actions with invalid parameters', () => {
    const ctx = buildCtx({ actionName: 'update_task', params: { taskId: 123 } });
    const next = resolveAction(ctx);
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('invalid_params');
    expect(next.outcome.message).toContain('Invalid parameters for update_task');
  });
});

describe('applySafetyClass', () => {
  test('marks read actions as non-mutating', () => {
    const ctx = resolveAction(buildCtx({ actionName: 'list_tasks' }));
    const next = applySafetyClass(ctx);
    expect(next.outcome).toBeUndefined();
    expect(next.isMutating).toBe(false);
  });

  test('marks mutate actions as mutating', () => {
    const ctx = resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }));
    const next = applySafetyClass(ctx);
    expect(next.outcome).toBeUndefined();
    expect(next.isMutating).toBe(true);
  });
});

describe('applyRoleAdmission', () => {
  test('allows coordinator to access space-family actions', () => {
    const ctx = applySafetyClass(resolveAction(buildCtx({ actionName: 'list_tasks' })));
    const next = applyRoleAdmission(ctx);
    expect(next.outcome).toBeUndefined();
  });

  test('denies coordinator access to node-family actions', () => {
    const ctx = applySafetyClass(resolveAction(buildCtx({ actionName: 'send_message' })));
    const next = applyRoleAdmission(ctx);
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('role_denied');
    expect(next.outcome.message).toContain('not available for role coordinator');
  });

  test('allows workflow_worker to access both node and space families', () => {
    const space = applySafetyClass(
      resolveAction(buildCtx({ actionName: 'list_tasks', role: 'workflow_worker' }))
    );
    expect(applyRoleAdmission(space).outcome).toBeUndefined();
    const node = applySafetyClass(
      resolveAction(buildCtx({ actionName: 'send_message', role: 'workflow_worker' }))
    );
    expect(applyRoleAdmission(node).outcome).toBeUndefined();
  });

  test('denies outside_space all actions', () => {
    const ctx = applySafetyClass(
      resolveAction(buildCtx({ actionName: 'list_tasks', role: 'outside_space' }))
    );
    const next = applyRoleAdmission(ctx);
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('role_denied');
  });
});

describe('applyAutonomyGate', () => {
  test('allows read actions with default level 1', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(resolveAction(buildCtx({ actionName: 'list_tasks' })))
    );
    const next = await applyAutonomyGate(ctx);
    expect(next.outcome).toBeUndefined();
    expect(next.spaceLevel).toBe(1);
  });

  test('allows mutating actions when effective autonomy meets requirement', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    const next = await applyAutonomyGate({ ...ctx, spaceLevel: 5 });
    expect(next.outcome).toBeUndefined();
  });

  test('denies mutating actions below the required autonomy level', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    const next = await applyAutonomyGate({ ...ctx, spaceLevel: 2 });
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('autonomy_denied');
    expect(next.outcome.message).toBe(
      'update_task not permitted: space autonomy level 2 < required level 4. Request human approval.'
    );
  });

  test('applies agent autonomy ceiling below space level', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    const next = await applyAutonomyGate({ ...ctx, spaceLevel: 5, agentLevel: 2 });
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('autonomy_denied');
    expect(next.outcome.message).toBe(
      'update_task not permitted: agent autonomy ceiling 2 (space 5) < required level 4. Request human approval.'
    );
  });

  test('uses async per-entry autonomy resolver', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx({
            actionName: 'approve_task',
            params: { taskId: 'review-gated' },
            role: 'workflow_worker',
          })
        )
      )
    );
    const allowed = await applyAutonomyGate({ ...ctx, spaceLevel: 5 });
    expect(allowed.outcome).toBeUndefined();

    const denied = await applyAutonomyGate({ ...ctx, spaceLevel: 4 });
    assertDenied(denied.outcome!);
    expect(denied.outcome.message).toBe(
      'approve_task not permitted: space autonomy level 4 < required level 5. Request human approval.'
    );
  });

  test('defaults space autonomy level to 1 when no resolver is provided', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(resolveAction(buildCtx({ actionName: 'list_tasks' })))
    );
    const deps: DispatchActionDeps = { ...ctx.deps, getSpaceAutonomyLevel: undefined };
    const next = await applyAutonomyGate({ ...ctx, deps, spaceLevel: undefined });
    expect(next.outcome).toBeUndefined();
    expect(next.spaceLevel).toBe(1);
  });
});

describe('applyRateAndAudit', () => {
  test('denies actions when rate budget is exhausted', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    const next = await applyRateAndAudit(withDeps(ctx, { isWithinRateBudget: async () => false }));
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('rate_limited');
  });

  test('writes audit log for non-read actions', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    const next = await applyRateAndAudit(
      withDeps(
        {
          ...ctx,
          spaceLevel: 5,
          agentName: AGENT_NAME,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          workflowRunId: WORKFLOW_RUN_ID,
        },
        {
          auditLogRepo: {
            createEntry: (params) => {
              auditEntries.push(params);
              return null as never;
            },
          },
        }
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].toolName).toBe('update_task');
    expect(auditEntries[0].spaceId).toBe(SPACE_ID);
    expect(auditEntries[0].taskId).toBe(TASK_ID);
    expect(auditEntries[0].workflowRunId).toBe(WORKFLOW_RUN_ID);
    expect(auditEntries[0].agentName).toBe(AGENT_NAME);
    expect(auditEntries[0].sessionId).toBe(SESSION_ID);
    expect(JSON.parse(auditEntries[0].paramsSummary ?? '{}')).toEqual({ taskId: 't-1' });
  });

  test('skips audit for read actions', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const ctx = applyRoleAdmission(
      applySafetyClass(resolveAction(buildCtx({ actionName: 'list_tasks' })))
    );
    const next = await applyRateAndAudit(
      withDeps(ctx, {
        auditLogRepo: {
          createEntry: (params) => {
            auditEntries.push(params);
            return null as never;
          },
        },
      })
    );
    expect(next.outcome).toBeUndefined();
    expect(auditEntries.length).toBe(0);
  });

  test('emits telemetry at the dispatch choke point', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    await applyRateAndAudit(
      withDeps(
        {
          ...ctx,
          spaceLevel: 5,
          taskId: TASK_ID,
          workflowRunId: WORKFLOW_RUN_ID,
        },
        {
          emitTelemetry: (event) => {
            telemetry.push(event);
          },
        }
      )
    );
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].actionName).toBe('update_task');
    expect(telemetry[0].family).toBe('space');
    expect(telemetry[0].safetyClass).toBe('mutate');
    expect(telemetry[0].role).toBe('coordinator');
    expect(telemetry[0].spaceId).toBe(SPACE_ID);
    expect(telemetry[0].taskId).toBe(TASK_ID);
    expect(telemetry[0].workflowRunId).toBe(WORKFLOW_RUN_ID);
    expect(telemetry[0].outcome).toBe('dispatched');
    expect(typeof telemetry[0].timestamp).toBe('number');
  });
});

describe('executeAction', () => {
  test('captures the handler result', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    const autonomied = await applyAutonomyGate({ ...ctx, spaceLevel: 5 });
    const audited = await applyRateAndAudit(withDeps(autonomied, {}));
    const next = await executeAction(audited);
    expect(next.outcome).toBeUndefined();
    expect(next.rawResult).toEqual({ updated: 't-1' });
  });

  test('returns failed outcome when the handler throws', async () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(resolveAction(buildCtx({ actionName: 'broken_action' })))
    );
    const autonomied = await applyAutonomyGate({ ...ctx, spaceLevel: 5 });
    const audited = await applyRateAndAudit(withDeps(autonomied, {}));
    const next = await executeAction(audited);
    assertFailed(next.outcome!);
    expect(next.outcome.error).toContain('handler failure');
  });
});

describe('formatResult', () => {
  test('formats raw result as jsonResult dispatched outcome', () => {
    const ctx: DispatchActionCtx = {
      ...buildCtx({ actionName: 'update_task' }),
      rawResult: { ok: true },
    };
    const next = formatResult(ctx);
    assertDispatched(next.outcome!);
    expect(JSON.parse(extractText(next.outcome.result))).toEqual({ ok: true });
  });

  test('preserves an existing denied outcome', () => {
    const denied = resolveAction(buildCtx({ actionName: 'missing_action' }));
    const next = formatResult(denied);
    expect(next.outcome?.action).toBe('denied');
  });

  test('fails when no raw result or prior outcome exists', () => {
    const ctx = buildCtx({ actionName: 'list_tasks' });
    const next = formatResult(ctx);
    assertFailed(next.outcome!);
    expect(next.outcome.error).toContain('Missing action result');
  });
});

describe('runDispatchAction', () => {
  test('dispatches a read action end-to-end', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const deps = baseDeps({
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
      auditLogRepo: {
        createEntry: (params) => {
          auditEntries.push(params);
          return null as never;
        },
      },
    });
    const outcome = await runDispatchAction(deps, baseInput({ actionName: 'list_tasks' }));
    assertDispatched(outcome);
    expect(JSON.parse(extractText(outcome.result))).toEqual({ tasks: [] });
    expect(auditEntries.length).toBe(0);
    expect(telemetry.length).toBe(1);
  });

  test('dispatches a mutating action with audit and telemetry', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const deps = baseDeps({
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
      auditLogRepo: {
        createEntry: (params) => {
          auditEntries.push(params);
          return null as never;
        },
      },
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({ actionName: 'update_task', params: { taskId: 't-1' } }),
      spaceLevel: 5,
    });
    assertDispatched(outcome);
    expect(JSON.parse(extractText(outcome.result))).toEqual({ updated: 't-1' });
    expect(auditEntries.length).toBe(1);
    expect(telemetry.length).toBe(1);
  });

  test('denies actions at the role gate', async () => {
    const outcome = await runDispatchAction(
      baseDeps(),
      baseInput({ actionName: 'send_message', role: 'coordinator' })
    );
    assertDenied(outcome);
    expect(outcome.reason).toBe('role_denied');
  });

  test('denies actions at the autonomy gate with byte-identical messages', async () => {
    const outcome = await runDispatchAction(
      baseDeps(),
      baseInput({ actionName: 'update_task', params: { taskId: 't-1' }, spaceLevel: 2 })
    );
    assertDenied(outcome);
    expect(outcome.reason).toBe('autonomy_denied');
    expect(outcome.message).toBe(
      'update_task not permitted: space autonomy level 2 < required level 4. Request human approval.'
    );
  });

  test('denies actions at the rate gate', async () => {
    const outcome = await runDispatchAction(baseDeps({ isWithinRateBudget: async () => false }), {
      ...baseInput({ actionName: 'update_task', params: { taskId: 't-1' } }),
      spaceLevel: 5,
    });
    assertDenied(outcome);
    expect(outcome.reason).toBe('rate_limited');
  });

  test('returns failed outcome for unexpected errors', async () => {
    const deps = baseDeps({
      getSpaceAutonomyLevel: async () => {
        throw new Error('level lookup failed');
      },
    });
    const outcome = await runDispatchAction(
      deps,
      baseInput({ actionName: 'update_task', params: { taskId: 't-1' } })
    );
    assertFailed(outcome);
    expect(outcome.error).toContain('level lookup failed');
  });
});
