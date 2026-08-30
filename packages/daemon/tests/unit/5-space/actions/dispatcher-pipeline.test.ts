/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  applyAutonomyGate,
  applyRateAndAudit,
  applyRoleAdmission,
  applySafetyClass,
  buildDispatchTelemetryEvent,
  type DispatchActionCtx,
  type DispatchActionDeps,
  type DispatchActionInput,
  type DispatchActionOutcome,
  type DispatchTelemetryEvent,
  emitDispatchTelemetry,
  executeAction,
  formatResult,
  resolveAction,
  resolveTargets,
  runDispatchAction,
} from '../../../../src/lib/space/actions/dispatcher-pipeline.ts';
import { createActionRegistry, defineAction } from '../../../../src/lib/space/actions/registry.ts';
import type { CreateMcpAuditLogParams } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';

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

  test('attributes the parsed target task to dispatcher audits and telemetry', () => {
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      handler: async () => ({}),
    });
    const registry = createActionRegistry([archiveTask]);
    const ctx = resolveAction(
      buildCtx({ actionName: 'archive_task', params: { task_id: 'task-42' } }, { registry })
    );
    expect(ctx.taskId).toBe('task-42');
  });

  test('prefers the action target task over the session contextual task', () => {
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      handler: async () => ({}),
    });
    const registry = createActionRegistry([archiveTask]);
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'archive_task',
          params: { task_id: 'target-task' },
          taskId: 'session-task',
        },
        { registry }
      )
    );
    expect(ctx.taskId).toBe('target-task');
  });

  test('keeps task_id for a task_number-preference action when no number is present', () => {
    const getTaskDetail = defineAction({
      name: 'get_task_detail',
      family: 'tasks',
      safetyClass: 'read',
      description: 'Get task detail',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      taskIdPreference: 'task_number',
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'get_task_detail',
          params: { task_id: 'task-a' },
        },
        { registry: createActionRegistry([getTaskDetail]) }
      )
    );
    expect(ctx.taskId).toBe('task-a');
  });

  test('attributes workflow actions to the parsed run id over the session context', () => {
    const changePlan = defineAction({
      name: 'change_plan',
      family: 'workflows',
      safetyClass: 'destructive',
      description: 'Change plan',
      paramsDoc: '{ run_id: string }',
      paramsSchema: z.object({ run_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'change_plan',
          params: { run_id: 'run-b' },
          workflowRunId: 'run-a',
        },
        { registry: createActionRegistry([changePlan]) }
      )
    );
    expect(ctx.workflowRunId).toBe('run-b');
  });

  test('clears the contextual task when the parsed run target differs', () => {
    const changePlan = defineAction({
      name: 'change_plan',
      family: 'workflows',
      safetyClass: 'destructive',
      description: 'Change plan',
      paramsDoc: '{ run_id: string }',
      paramsSchema: z.object({ run_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'change_plan',
          params: { run_id: 'run-b' },
          taskId: 'session-task-a',
          workflowRunId: 'run-a',
        },
        { registry: createActionRegistry([changePlan]) }
      )
    );
    expect(ctx.taskId).toBeUndefined();
    expect(ctx.workflowRunId).toBe('run-b');
  });

  test('clears the contextual task when an explicit run target has no contextual run to correlate', () => {
    const changePlan = defineAction({
      name: 'change_plan',
      family: 'workflows',
      safetyClass: 'destructive',
      description: 'Change plan',
      paramsDoc: '{ run_id: string }',
      paramsSchema: z.object({ run_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'change_plan',
          params: { run_id: 'run-b' },
          taskId: 'standalone-task-a',
        },
        { registry: createActionRegistry([changePlan]) }
      )
    );
    expect(ctx.taskId).toBeUndefined();
    expect(ctx.workflowRunId).toBe('run-b');
  });

  test('attributes camel-case workflowRunId params to the requested run', () => {
    const listDeliveries = defineAction({
      name: 'list_deliveries',
      family: 'node',
      safetyClass: 'read',
      description: 'List deliveries',
      paramsDoc: '{ workflowRunId?: string }',
      paramsSchema: z.object({ workflowRunId: z.string().optional() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'list_deliveries',
          params: { workflowRunId: 'run-b' },
          workflowRunId: 'run-a',
        },
        { registry: createActionRegistry([listDeliveries]) }
      )
    );
    expect(ctx.workflowRunId).toBe('run-b');
  });

  test('attributes workflow_run_id-filtered listings to the requested run', () => {
    const listTasks = defineAction({
      name: 'list_tasks',
      family: 'tasks',
      safetyClass: 'read',
      description: 'List tasks',
      paramsDoc: '{ workflow_run_id: string }',
      paramsSchema: z.object({ workflow_run_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'list_tasks',
          params: { workflow_run_id: 'run-b' },
        },
        { registry: createActionRegistry([listTasks]) }
      )
    );
    expect(ctx.workflowRunId).toBe('run-b');
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

describe('resolveTargets', () => {
  test('clears an unverifiable contextual run when the params target a task', async () => {
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'archive_task',
          params: { task_id: 'task-b' },
          workflowRunId: 'run-a',
        },
        { registry: createActionRegistry([archiveTask]) }
      )
    );
    const next = await resolveTargets(withDeps(ctx, {}));
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBe('task-b');
    expect(next.workflowRunId).toBeUndefined();
  });

  test('clears numeric attribution when no task resolver is wired', async () => {
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'send_message_to_task',
          params: { task_number: 7, message: 'ping' },
          taskId: 'session-task-a',
          workflowRunId: 'run-a',
        },
        { registry: createActionRegistry([sendToTask]) }
      )
    );
    const next = await resolveTargets(withDeps(ctx, {}));
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBeUndefined();
    expect(next.workflowRunId).toBeUndefined();
  });

  test('keeps the contextual run when the parsed task target is the same contextual task', async () => {
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'archive_task',
          params: { task_id: 'session-task-a' },
          taskId: 'session-task-a',
          workflowRunId: 'run-a',
        },
        { registry: createActionRegistry([archiveTask]) }
      )
    );
    const next = await resolveTargets(withDeps(ctx, {}));
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBe('session-task-a');
    expect(next.workflowRunId).toBe('run-a');
  });

  test('prefers the derived run over the same-task contextual run when the resolver is wired', async () => {
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = resolveAction(
      buildCtx(
        {
          actionName: 'archive_task',
          params: { task_id: 'session-task-a' },
          taskId: 'session-task-a',
          workflowRunId: 'run-a',
        },
        { registry: createActionRegistry([archiveTask]) }
      )
    );
    const next = await resolveTargets(
      withDeps(ctx, {
        resolveRunId: () => 'run-repo-truth',
      })
    );
    expect(next.outcome).toBeUndefined();
    expect(next.workflowRunId).toBe('run-repo-truth');
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

  test('admits the registry-space families for the space roles', () => {
    const families = [
      'sessions',
      'workflows',
      'tasks',
      'forge',
      'scheduled',
      'external_events',
      'inactivity',
    ] as const;
    const registry = createActionRegistry(
      families.map((family) =>
        defineAction({
          name: `probe_${family}`,
          family,
          safetyClass: 'read',
          description: 'Registry family probe',
          paramsDoc: '{}',
          paramsSchema: z.object({}),
          handler: async () => ({}),
        })
      )
    );
    for (const role of ['coordinator', 'ad_hoc_member', 'long_term_agent'] as const) {
      for (const family of families) {
        const ctx = applyRoleAdmission(
          applySafetyClass(
            resolveAction(buildCtx({ actionName: `probe_${family}`, role }, { registry }))
          )
        );
        expect(ctx.outcome).toBeUndefined();
      }
    }
  });

  test('keeps coordinator-wide registry families out of worker admission', () => {
    const families = [
      'sessions',
      'workflows',
      'tasks',
      'forge',
      'scheduled',
      'external_events',
      'inactivity',
    ] as const;
    const registry = createActionRegistry(
      families.map((family) =>
        defineAction({
          name: `probe_${family}`,
          family,
          safetyClass: 'read',
          description: 'Registry family probe',
          paramsDoc: '{}',
          paramsSchema: z.object({}),
          handler: async () => ({}),
        })
      )
    );
    for (const family of families) {
      const ctx = applyRoleAdmission(
        applySafetyClass(
          resolveAction(
            buildCtx({ actionName: `probe_${family}`, role: 'workflow_worker' }, { registry })
          )
        )
      );
      assertDenied(ctx.outcome!);
      expect(ctx.outcome.reason).toBe('role_denied');
    }
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

  test('skips the space autonomy lookup for actions without a requirement', async () => {
    let lookups = 0;
    const ctx = applyRoleAdmission(
      applySafetyClass(resolveAction(buildCtx({ actionName: 'list_tasks' })))
    );
    const next = await applyAutonomyGate(
      withDeps(ctx, {
        getSpaceAutonomyLevel: async () => {
          lookups += 1;
          return 3;
        },
      })
    );
    expect(next.outcome).toBeUndefined();
    expect(lookups).toBe(0);
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

  test('resolves task_number through the resolver before writing the audit entry', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_number: 42, message: 'ping' },
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          auditLogRepo: {
            createEntry: (params) => {
              auditEntries.push(params);
              return null as never;
            },
          },
          resolveTaskId: (params) =>
            typeof params.task_number === 'number' ? `task-from-${params.task_number}` : undefined,
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBe('task-from-42');
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].taskId).toBe('task-from-42');
  });

  test('prefers the resolved task_number target over the session contextual task', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_number: 7, message: 'ping' },
              taskId: 'session-task',
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          auditLogRepo: {
            createEntry: (params) => {
              auditEntries.push(params);
              return null as never;
            },
          },
          resolveTaskId: (params) =>
            typeof params.task_number === 'number' ? `task-from-${params.task_number}` : undefined,
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBe('task-from-7');
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].taskId).toBe('task-from-7');
  });

  test('keeps task_id precedence over task_number in attribution', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    let resolverCalls = 0;
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_id: string, task_number: number, message: string }',
      paramsSchema: z.object({ task_id: z.string(), task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_id: 'task-a', task_number: 7, message: 'ping' },
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          auditLogRepo: {
            createEntry: (params) => {
              auditEntries.push(params);
              return null as never;
            },
          },
          resolveTaskId: (params) => {
            resolverCalls += 1;
            return `task-from-${params.task_number}`;
          },
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(resolverCalls).toBe(0);
    expect(next.taskId).toBe('task-a');
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].taskId).toBe('task-a');
  });

  test('resolves task_number for reads whose handler prefers the numeric identifier', async () => {
    const getTaskDetail = defineAction({
      name: 'get_task_detail',
      family: 'tasks',
      safetyClass: 'read',
      description: 'Get task detail',
      paramsDoc: '{ task_number: number, task_id: string }',
      paramsSchema: z.object({ task_number: z.number(), task_id: z.string() }),
      taskIdPreference: 'task_number',
      handler: async () => ({}),
    });
    const ctx = applySafetyClass(
      resolveAction(
        buildCtx(
          {
            actionName: 'get_task_detail',
            params: { task_number: 9, task_id: 'task-a' },
          },
          { registry: createActionRegistry([getTaskDetail]) }
        )
      )
    );
    expect(ctx.taskId).toBeUndefined();
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveTaskId: (params) =>
            typeof params.task_number === 'number' ? `task-from-${params.task_number}` : undefined,
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBe('task-from-9');
  });

  test('clears the contextual task when the numeric resolver throws', async () => {
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_number: 7, message: 'ping' },
              taskId: 'session-task',
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          auditLogRepo: {
            createEntry: () => null as never,
          },
          resolveTaskId: () => {
            throw new Error('repo unavailable');
          },
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBeUndefined();
    expect(next.workflowRunId).toBeUndefined();
  });

  test('resolves task_number when task_id is an empty string', async () => {
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_id: string, task_number: number, message: string }',
      paramsSchema: z.object({ task_id: z.string(), task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_id: '', task_number: 7, message: 'ping' },
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveTaskId: (params) =>
            typeof params.task_number === 'number' ? `task-from-${params.task_number}` : undefined,
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBe('task-from-7');
  });

  test('redacts listed keys from the audit params summary', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_id: string, message: string }',
      paramsSchema: z.object({ task_id: z.string(), message: z.string() }),
      auditRedactKeys: ['message'],
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_id: 'task-a', message: 'top secret' },
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
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
    expect(auditEntries.length).toBe(1);
    const summary = JSON.parse(auditEntries[0].paramsSummary ?? '{}');
    expect(summary.task_id).toBe('task-a');
    expect('message' in summary).toBe(false);
  });

  test('derives the run from the resolved target task for task-triggered mutations', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const cancelTask = defineAction({
      name: 'cancel_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Cancel task',
      paramsDoc: '{ task_id: string, cancel_workflow_run: boolean }',
      paramsSchema: z.object({ task_id: z.string(), cancel_workflow_run: z.boolean() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'cancel_task',
              params: { task_id: 'task-b', cancel_workflow_run: true },
            },
            { registry: createActionRegistry([cancelTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(
          { ...ctx, workflowRunId: 'run-a' },
          {
            auditLogRepo: {
              createEntry: (params) => {
                auditEntries.push(params);
                return null as never;
              },
            },
            resolveRunId: (taskId) => (taskId === 'task-b' ? 'run-b' : undefined),
          }
        )
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.workflowRunId).toBe('run-b');
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].workflowRunId).toBe('run-b');
  });

  test('clears a stale session run when the resolved target task is standalone', async () => {
    const cancelTask = defineAction({
      name: 'cancel_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Cancel task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'cancel_task',
              params: { task_id: 'standalone-task' },
              workflowRunId: 'run-a',
            },
            { registry: createActionRegistry([cancelTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveRunId: () => undefined,
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.workflowRunId).toBeUndefined();
  });

  test('preserves an explicit parsed run target over session-task run derivation', async () => {
    let resolverCalls = 0;
    const changePlan = defineAction({
      name: 'change_plan',
      family: 'workflows',
      safetyClass: 'destructive',
      description: 'Change plan',
      paramsDoc: '{ run_id: string }',
      paramsSchema: z.object({ run_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'change_plan',
              params: { run_id: 'run-b' },
              taskId: 'session-task-a',
            },
            { registry: createActionRegistry([changePlan]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveRunId: (taskId) => {
            resolverCalls += 1;
            return `run-of-${taskId}`;
          },
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(resolverCalls).toBe(0);
    expect(next.workflowRunId).toBe('run-b');
  });

  test('keeps an explicit parsed run target when the params also target a task', async () => {
    let resolverCalls = 0;
    const moveTask = defineAction({
      name: 'move_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Move task',
      paramsDoc: '{ task_id: string, run_id: string }',
      paramsSchema: z.object({ task_id: z.string(), run_id: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'move_task',
              params: { task_id: 'task-b', run_id: 'run-explicit' },
              taskId: 'session-task-a',
              workflowRunId: 'run-a',
            },
            { registry: createActionRegistry([moveTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveRunId: (taskId) => {
            resolverCalls += 1;
            return `run-of-${taskId}`;
          },
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(resolverCalls).toBe(0);
    expect(next.taskId).toBe('task-b');
    expect(next.workflowRunId).toBe('run-explicit');
  });

  test('clears the contextual run when a completed numeric lookup misses', async () => {
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_number: 999, message: 'ping' },
              taskId: 'session-task-a',
              workflowRunId: 'run-a',
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveTaskId: () => undefined,
          auditLogRepo: {
            createEntry: (params) => {
              auditEntries.push(params);
              return null as never;
            },
          },
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBeUndefined();
    expect(next.workflowRunId).toBeUndefined();
    expect(auditEntries[0].taskId).toBeNull();
    expect(auditEntries[0].workflowRunId).toBeNull();
  });

  test('clears the stale session run when a numeric lookup resolves a different task without a run resolver', async () => {
    const updateTask = defineAction({
      name: 'update_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Update task',
      paramsDoc: '{ task_number: number }',
      paramsSchema: z.object({ task_number: z.number() }),
      taskIdPreference: 'task_number',
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'update_task',
              params: { task_number: 7 },
              taskId: 'session-task-a',
              workflowRunId: 'run-a',
            },
            { registry: createActionRegistry([updateTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveTaskId: () => 'task-b',
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBe('task-b');
    expect(next.workflowRunId).toBeUndefined();
  });

  test('re-denies with standard diagnostics and an audit entry when a state-dependent requirement rises', async () => {
    let required = 1;
    const stateful = defineAction({
      name: 'update_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Update task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      autonomyRequirement: async () => required,
      handler: async () => ({}),
    });
    const auditEntries: CreateMcpAuditLogParams[] = [];
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            { actionName: 'update_task', params: { task_id: 't-1' } },
            { registry: createActionRegistry([stateful]) }
          )
        )
      )
    );
    const autonomied = await applyAutonomyGate({ ...ctx, spaceLevel: 1 });
    expect(autonomied.outcome).toBeUndefined();
    required = 5;
    const next = await applyRateAndAudit(
      withDeps(autonomied, {
        auditLogRepo: {
          createEntry: (params) => {
            auditEntries.push(params);
            return null as never;
          },
        },
      })
    );
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('autonomy_denied');
    expect(next.outcome.message).toBe(
      'update_task not permitted: space autonomy level 1 < required level 5. Request human approval.'
    );
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].toolName).toBe('update_task');
  });

  test('skips rate admission when the checkpoint recheck denies', async () => {
    let required = 1;
    let budgetCalls = 0;
    const stateful = defineAction({
      name: 'update_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Update task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      autonomyRequirement: async () => required,
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            { actionName: 'update_task', params: { task_id: 't-1' } },
            { registry: createActionRegistry([stateful]) }
          )
        )
      )
    );
    const autonomied = await applyAutonomyGate({ ...ctx, spaceLevel: 1 });
    expect(autonomied.outcome).toBeUndefined();
    required = 5;
    const next = await applyRateAndAudit(
      withDeps(autonomied, {
        isWithinRateBudget: () => {
          budgetCalls += 1;
          return true;
        },
      })
    );
    assertDenied(next.outcome!);
    expect(next.outcome.reason).toBe('autonomy_denied');
    expect(budgetCalls).toBe(0);
  });

  test('clears the contextual task when a completed numeric lookup misses', async () => {
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx(
            {
              actionName: 'send_message_to_task',
              params: { task_number: 999, message: 'ping' },
              taskId: 'session-task-a',
            },
            { registry: createActionRegistry([sendToTask]) }
          )
        )
      )
    );
    const next = await applyRateAndAudit(
      await resolveTargets(
        withDeps(ctx, {
          resolveTaskId: () => undefined,
        })
      )
    );
    expect(next.outcome).toBeUndefined();
    expect(next.taskId).toBeUndefined();
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

  test('does not emit telemetry (emission moved to the post-outcome step)', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(buildCtx({ actionName: 'update_task', params: { taskId: 't-1' } }))
      )
    );
    await applyRateAndAudit(
      withDeps(ctx, {
        emitTelemetry: (event) => {
          telemetry.push(event);
        },
      })
    );
    expect(telemetry.length).toBe(0);
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

  test('passes an existing ToolResult through without re-wrapping', () => {
    const result = { content: [{ type: 'text' as const, text: '{"wrapped":true}' }] };
    const ctx: DispatchActionCtx = {
      ...buildCtx({ actionName: 'update_task' }),
      rawResult: result,
    };
    const next = formatResult(ctx);
    assertDispatched(next.outcome!);
    expect(next.outcome.result).toBe(result);
  });

  test('jsonResult-wraps payloads whose content array is not a ToolResult envelope', () => {
    const stringEntries = { content: ['message'] };
    const next = formatResult({
      ...buildCtx({ actionName: 'update_task' }),
      rawResult: stringEntries,
    });
    assertDispatched(next.outcome!);
    expect(JSON.parse(extractText(next.outcome.result))).toEqual(stringEntries);

    const emptyEntries = { content: [] };
    const empty = formatResult({
      ...buildCtx({ actionName: 'update_task' }),
      rawResult: emptyEntries,
    });
    assertDispatched(empty.outcome!);
    expect(JSON.parse(extractText(empty.outcome.result))).toEqual(emptyEntries);
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

describe('buildDispatchTelemetryEvent', () => {
  test('carries action metadata for a dispatched outcome', () => {
    const ctx = applyRoleAdmission(
      applySafetyClass(
        resolveAction(
          buildCtx({ actionName: 'update_task', params: { taskId: 't-1' }, taskId: TASK_ID })
        )
      )
    );
    const event = buildDispatchTelemetryEvent(
      baseInput({ actionName: 'update_task', taskId: TASK_ID }),
      ctx.action,
      { action: 'dispatched', result: { content: [] } }
    );
    expect(event.actionName).toBe('update_task');
    expect(event.family).toBe('space');
    expect(event.safetyClass).toBe('mutate');
    expect(event.role).toBe('coordinator');
    expect(event.spaceId).toBe(SPACE_ID);
    expect(event.taskId).toBe(TASK_ID);
    expect(event.outcome).toBe('dispatched');
    expect(event.reason).toBeUndefined();
    expect(typeof event.timestamp).toBe('number');
  });

  test('carries the deny reason for a denied outcome', () => {
    const denied = resolveAction(buildCtx({ actionName: 'missing_action' }));
    const event = buildDispatchTelemetryEvent(
      baseInput({ actionName: 'missing_action' }),
      denied.action,
      denied.outcome!
    );
    expect(event.outcome).toBe('denied');
    expect(event.reason).toBe('unknown_action');
    expect(event.family).toBeUndefined();
    expect(event.safetyClass).toBeUndefined();
  });

  test('carries no reason for a failed outcome', () => {
    const event = buildDispatchTelemetryEvent(baseInput(), undefined, {
      action: 'failed',
      error: 'level lookup failed',
    });
    expect(event.outcome).toBe('failed');
    expect(event.reason).toBeUndefined();
    expect(event.family).toBeUndefined();
    expect(event.actionName).toBe('list_tasks');
  });
});

describe('emitDispatchTelemetry', () => {
  test('emits the built event through the sink', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    await emitDispatchTelemetry(
      baseDeps({
        emitTelemetry: (event) => {
          telemetry.push(event);
        },
      }),
      baseInput({ actionName: 'list_tasks' }),
      undefined,
      { action: 'failed', error: 'boom' }
    );
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].outcome).toBe('failed');
  });

  test('swallows synchronous sink throws', async () => {
    await emitDispatchTelemetry(
      baseDeps({
        emitTelemetry: () => {
          throw new Error('sync sink failure');
        },
      }),
      baseInput(),
      undefined,
      { action: 'failed', error: 'boom' }
    );
  });

  test('swallows asynchronous sink rejections', async () => {
    await emitDispatchTelemetry(
      baseDeps({
        emitTelemetry: async () => {
          throw new Error('async sink failure');
        },
      }),
      baseInput(),
      undefined,
      { action: 'failed', error: 'boom' }
    );
  });

  test('is a no-op without a sink', async () => {
    await emitDispatchTelemetry(baseDeps(), baseInput(), undefined, {
      action: 'failed',
      error: 'boom',
    });
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
    expect(telemetry[0].outcome).toBe('dispatched');
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
    expect(telemetry[0].outcome).toBe('dispatched');
  });

  test('emits telemetry with the resolved target task id', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      autonomyRequirement: 4,
      handler: async () => ({}),
    });
    const deps = baseDeps({
      registry: createActionRegistry([archiveTask]),
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({ actionName: 'archive_task', params: { task_id: 'task-42' } }),
      spaceLevel: 5,
    });
    assertDispatched(outcome);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].taskId).toBe('task-42');
  });

  test('emits telemetry with the resolved workflow run id', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const changePlan = defineAction({
      name: 'change_plan',
      family: 'workflows',
      safetyClass: 'destructive',
      description: 'Change plan',
      paramsDoc: '{ run_id: string }',
      paramsSchema: z.object({ run_id: z.string() }),
      autonomyRequirement: 4,
      handler: async () => ({}),
    });
    const deps = baseDeps({
      registry: createActionRegistry([changePlan]),
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({ actionName: 'change_plan', params: { run_id: 'run-b' } }),
      spaceLevel: 5,
    });
    assertDispatched(outcome);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].workflowRunId).toBe('run-b');
  });

  test('telemetry agrees with the audit when the target task clears the session run', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const cancelTask = defineAction({
      name: 'cancel_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Cancel task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      handler: async () => ({}),
    });
    const deps = baseDeps({
      registry: createActionRegistry([cancelTask]),
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
      resolveRunId: () => undefined,
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({
        actionName: 'cancel_task',
        params: { task_id: 'standalone-task' },
        workflowRunId: 'run-a',
      }),
    });
    assertDispatched(outcome);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].workflowRunId).toBeUndefined();
  });

  test('drops the stale session run from gate-denied telemetry when the parsed task target differs', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      autonomyRequirement: 4,
      handler: async () => ({}),
    });
    const deps = baseDeps({
      registry: createActionRegistry([archiveTask]),
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({
        actionName: 'archive_task',
        params: { task_id: 'task-b' },
        taskId: 'session-task-a',
        workflowRunId: 'run-a',
      }),
      spaceLevel: 2,
    });
    assertDenied(outcome);
    expect(outcome.reason).toBe('autonomy_denied');
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].taskId).toBe('task-b');
    expect(telemetry[0].workflowRunId).toBeUndefined();
  });

  test('attributes rate-denied numeric targets through the resolvers', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      handler: async () => ({}),
    });
    const deps = baseDeps({
      registry: createActionRegistry([sendToTask]),
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
      isWithinRateBudget: () => false,
      resolveTaskId: () => 'task-b',
      resolveRunId: () => 'run-of-task-b',
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({
        actionName: 'send_message_to_task',
        params: { task_number: 7, message: 'ping' },
        taskId: 'session-task-a',
        workflowRunId: 'run-a',
      }),
    });
    assertDenied(outcome);
    expect(outcome.reason).toBe('rate_limited');
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].taskId).toBe('task-b');
    expect(telemetry[0].workflowRunId).toBe('run-of-task-b');
  });

  test('carries the resolved target into failed telemetry when a stage throws', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const archiveTask = defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description: 'Archive task',
      paramsDoc: '{ task_id: string }',
      paramsSchema: z.object({ task_id: z.string() }),
      autonomyRequirement: 4,
      handler: async () => ({}),
    });
    const deps = baseDeps({
      registry: createActionRegistry([archiveTask]),
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
      getSpaceAutonomyLevel: async () => {
        throw new Error('level lookup failed');
      },
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({
        actionName: 'archive_task',
        params: { task_id: 'task-b' },
        taskId: 'session-task-a',
        workflowRunId: 'run-a',
      }),
    });
    assertFailed(outcome);
    expect(outcome.error).toContain('level lookup failed');
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].outcome).toBe('failed');
    expect(telemetry[0].taskId).toBe('task-b');
    expect(telemetry[0].workflowRunId).toBeUndefined();
  });

  test('retains first-pass numeric attribution without replaying resolvers when a stage throws', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    let taskResolutions = 0;
    let runResolutions = 0;
    const sendToTask = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Send message',
      paramsDoc: '{ task_number: number, message: string }',
      paramsSchema: z.object({ task_number: z.number(), message: z.string() }),
      autonomyRequirement: 2,
      handler: async () => ({}),
    });
    const deps = baseDeps({
      registry: createActionRegistry([sendToTask]),
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
      getSpaceAutonomyLevel: async () => {
        throw new Error('level lookup failed');
      },
      resolveTaskId: () => {
        taskResolutions += 1;
        return 'task-from-7';
      },
      resolveRunId: () => {
        runResolutions += 1;
        return 'run-of-task';
      },
    });
    const outcome = await runDispatchAction(deps, {
      ...baseInput({
        actionName: 'send_message_to_task',
        params: { task_number: 7, message: 'ping' },
        taskId: 'session-task-a',
        workflowRunId: 'run-a',
      }),
    });
    assertFailed(outcome);
    expect(outcome.error).toContain('level lookup failed');
    expect(taskResolutions).toBe(1);
    expect(runResolutions).toBe(1);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].outcome).toBe('failed');
    expect(telemetry[0].taskId).toBe('task-from-7');
    expect(telemetry[0].workflowRunId).toBe('run-of-task');
  });

  test('denies actions at the role gate', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const outcome = await runDispatchAction(
      baseDeps({
        emitTelemetry: (event) => {
          telemetry.push(event);
        },
      }),
      baseInput({ actionName: 'send_message', role: 'coordinator' })
    );
    assertDenied(outcome);
    expect(outcome.reason).toBe('role_denied');
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].outcome).toBe('denied');
    expect(telemetry[0].reason).toBe('role_denied');
    expect(telemetry[0].family).toBe('node');
  });

  test('dispatches human_only actions when the declared autonomy requirement is met', async () => {
    const outcome = await runDispatchAction(
      baseDeps(),
      baseInput({
        actionName: 'approve_task',
        params: { taskId: 'review-gated' },
        role: 'workflow_worker',
        spaceLevel: 5,
      })
    );
    assertDispatched(outcome);
    expect(JSON.parse(extractText(outcome.result))).toEqual({ approved: 'review-gated' });
  });

  test('emits failed telemetry when the handler throws', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const outcome = await runDispatchAction(
      baseDeps({
        emitTelemetry: (event) => {
          telemetry.push(event);
        },
      }),
      baseInput({ actionName: 'broken_action' })
    );
    assertFailed(outcome);
    expect(outcome.error).toContain('handler failure');
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].outcome).toBe('failed');
    expect(telemetry[0].actionName).toBe('broken_action');
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
    const telemetry: DispatchTelemetryEvent[] = [];
    const deps = baseDeps({
      getSpaceAutonomyLevel: async () => {
        throw new Error('level lookup failed');
      },
      emitTelemetry: (event) => {
        telemetry.push(event);
      },
    });
    const outcome = await runDispatchAction(
      deps,
      baseInput({ actionName: 'update_task', params: { taskId: 't-1' } })
    );
    assertFailed(outcome);
    expect(outcome.error).toContain('level lookup failed');
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].outcome).toBe('failed');
    expect(telemetry[0].actionName).toBe('update_task');
    expect(telemetry[0].family).toBe('space');
    expect(telemetry[0].safetyClass).toBe('mutate');
  });

  test('dispatches ungated reads without consulting the autonomy lookup', async () => {
    const deps = baseDeps({
      getSpaceAutonomyLevel: async () => {
        throw new Error('level lookup failed');
      },
    });
    const outcome = await runDispatchAction(deps, baseInput({ actionName: 'list_tasks' }));
    assertDispatched(outcome);
    expect(JSON.parse(extractText(outcome.result))).toEqual({ tasks: [] });
  });
});
