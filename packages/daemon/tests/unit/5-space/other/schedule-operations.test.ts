import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session, TaskSchedule } from '@hyperneo/shared';
import {
  createScheduleOperations,
  type ScheduleAuditEntry,
  type ScheduleOperationDependencies,
} from '../../../../src/lib/schedule/operations';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

const SPACE_ID = 'space-1';
const READ_ROLES = ['ad_hoc_member', 'long_term_agent', 'workflow_worker'];
const WRITE_ROLES = ['ad_hoc_member', 'long_term_agent'];
const OTHER_SPACE_ID = 'space-2';

function schedule(overrides: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    id: 'sched-1',
    spaceId: SPACE_ID,
    title: 'Nightly sweep',
    description: 'Sweep the board',
    priority: 'normal',
    preferredWorkflowId: null,
    labels: [],
    metadata: {},
    triggerType: 'cron',
    cronExpression: '0 9 * * 1',
    runAt: null,
    timezone: 'UTC',
    nextRunAt: 1000,
    lastRunAt: null,
    lastCreatedTaskId: null,
    pendingJobId: 'job-1',
    status: 'active',
    createdByAgent: null,
    createdBySession: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function session(status: string, spaceId: string): Session {
  return {
    id: 'member-1',
    type: 'space_chat',
    status,
    context: { spaceId },
    metadata: {},
  } as unknown as Session;
}

interface Harness {
  deps: ScheduleOperationDependencies;
  operations: Map<string, OperationDefinition>;
  calls: string[];
  audits: ScheduleAuditEntry[];
  stored: TaskSchedule[];
  sessions: Map<string, Session>;
  deleteSucceeds: boolean;
  createThrows: string | null;
  transitionThrows: string | null;
  auditThrows: boolean;
}

function harness(): Harness {
  const state: Harness = {
    deps: undefined as unknown as ScheduleOperationDependencies,
    operations: new Map(),
    calls: [],
    audits: [],
    stored: [schedule()],
    sessions: new Map([['member-1', session('active', SPACE_ID)]]),
    deleteSucceeds: true,
    createThrows: null,
    transitionThrows: null,
    auditThrows: false,
  };
  state.deps = {
    schedules: {
      createSchedule: (input) => {
        state.calls.push('createSchedule');
        if (state.createThrows) throw new Error(state.createThrows);
        const created = schedule({
          id: 'sched-new',
          spaceId: input.spaceId,
          title: input.title,
          createdByAgent: input.createdByAgent ?? null,
          createdBySession: input.createdBySession ?? null,
        });
        state.stored.push(created);
        return created;
      },
      listSchedules: (spaceId, status) => {
        state.calls.push('listSchedules');
        return state.stored.filter(
          (entry) => entry.spaceId === spaceId && (!status || entry.status === status)
        );
      },
      getSchedule: (scheduleId) => state.stored.find((entry) => entry.id === scheduleId) ?? null,
      pauseSchedule: (scheduleId) => {
        state.calls.push('pauseSchedule');
        if (state.transitionThrows) throw new Error(state.transitionThrows);
        return schedule({ id: scheduleId, status: 'paused' });
      },
      resumeSchedule: (scheduleId) => {
        state.calls.push('resumeSchedule');
        if (state.transitionThrows) throw new Error(state.transitionThrows);
        return schedule({ id: scheduleId, status: 'active' });
      },
      deleteSchedule: (scheduleId) => {
        state.calls.push('deleteSchedule');
        if (!state.deleteSucceeds) return false;
        state.stored = state.stored.filter((entry) => entry.id !== scheduleId);
        return true;
      },
    },
    getSession: (sessionId) => state.sessions.get(sessionId) ?? null,
    sessionSpaceId: (value) =>
      (value.context as { spaceId?: string } | undefined)?.spaceId ?? undefined,
    audit: (entry) => {
      if (state.auditThrows) throw new Error('audit down');
      state.audits.push(entry);
    },
  };
  for (const operation of createScheduleOperations(state.deps)) {
    state.operations.set(operation.name, operation);
  }
  return state;
}

function mcpCaller(role: OperationCallerRole, overrides: Partial<OperationCaller> = {}) {
  return {
    source: 'mcp',
    sessionId: 'member-1',
    spaceId: SPACE_ID,
    role,
    agentName: 'planner',
    ...overrides,
  } satisfies OperationCaller;
}

const RPC_CALLER: OperationCaller = { source: 'rpc' };

let h: Harness;

beforeEach(() => {
  h = harness();
});

function run(name: string, input: unknown, caller: OperationCaller) {
  const operation = h.operations.get(name);
  if (!operation) throw new Error(`missing operation: ${name}`);
  return operation.execute(input, caller);
}

describe('schedule operation catalog', () => {
  test('registers the five schedule operations', () => {
    expect([...h.operations.keys()].sort()).toEqual([
      'schedule.create',
      'schedule.delete',
      'schedule.get',
      'schedule.list',
      'schedule.update',
    ]);
  });

  test('every schedule operation declares a policy for the door', () => {
    const policies = [...h.operations.values()].map((operation) => [
      operation.name,
      operation.policy?.safetyClass,
      operation.policy?.roles,
    ]);
    expect(policies).toEqual([
      ['schedule.create', 'mutate', WRITE_ROLES],
      ['schedule.list', 'read', READ_ROLES],
      ['schedule.get', 'read', READ_ROLES],
      ['schedule.update', 'mutate', WRITE_ROLES],
      ['schedule.delete', 'destructive', WRITE_ROLES],
    ]);
  });

  test('the family scope gate admits a workflow worker inside a schedule mutation', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'schedule.delete',
      { scheduleId: 'sched-1' },
      mcpCaller('workflow_worker')
    );
    expect(outcome).toEqual({ kind: 'completed', value: { ok: true } });
    expect(h.stored.map((entry) => entry.id)).not.toContain('sched-1');
  });

  test('the family scope gate still refuses a caller that carries no Space', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'schedule.delete',
      { scheduleId: 'sched-1' },
      mcpCaller('ad_hoc_member', { spaceId: undefined })
    );
    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        ok: false,
        reason: 'space_scope_required',
        message: 'A Space is required: pass spaceId, or call from a session inside a Space.',
      },
    });
    expect(h.calls).toEqual([]);
  });

  test('an RPC caller must name the space it is acting in', async () => {
    expect(await run('schedule.list', {}, RPC_CALLER)).toEqual({
      ok: false,
      reason: 'space_scope_required',
      message: 'A Space is required: pass spaceId, or call from a session inside a Space.',
    });
    expect(h.calls).toEqual([]);
  });

  test('an RPC caller reads the space it names', async () => {
    expect(await run('schedule.list', { spaceId: SPACE_ID }, RPC_CALLER)).toEqual({
      ok: true,
      schedules: [schedule()],
    });
  });

  test('an MCP caller inherits its own space and may not override it', async () => {
    expect(
      await run('schedule.list', { spaceId: OTHER_SPACE_ID }, mcpCaller('ad_hoc_member'))
    ).toEqual({
      ok: false,
      reason: 'space_mismatch',
      message: 'The requested spaceId does not match the calling session Space.',
    });
    expect(h.calls).toEqual([]);
  });

  test('create stamps the schedule with the caller identity, never with input', async () => {
    const result = await run(
      'schedule.create',
      { title: 'Weekly', description: 'd', triggerType: 'cron', cronExpression: '@daily' },
      mcpCaller('ad_hoc_member', { sessionId: 'member-1', agentName: 'planner' })
    );
    expect(result).toMatchObject({
      ok: true,
      schedule: { spaceId: SPACE_ID, createdByAgent: 'planner', createdBySession: 'member-1' },
    });
    expect(h.audits.map((entry) => entry.toolName)).toEqual(['schedule.create']);
    expect(h.audits[0]?.paramsSummary).toEqual({
      title: 'Weekly',
      trigger_type: 'cron',
      cron_expression: '@daily',
      run_at: undefined,
      timezone: undefined,
    });
  });

  test('a schedule service failure becomes a rejected result, not a throw', async () => {
    h.createThrows = 'Cannot create schedule in a non-active space (current: archived)';
    expect(
      await run(
        'schedule.create',
        { title: 'Weekly', description: 'd', triggerType: 'cron', cronExpression: '@daily' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'rejected',
      message: 'Cannot create schedule in a non-active space (current: archived)',
    });
  });

  test('a schedule owned by another space is not found', async () => {
    h.stored = [schedule({ id: 'sched-1', spaceId: OTHER_SPACE_ID })];
    expect(
      await run('schedule.get', { scheduleId: 'sched-1' }, mcpCaller('ad_hoc_member'))
    ).toEqual({
      ok: false,
      reason: 'schedule_not_found',
      message: 'Schedule not found: sched-1',
    });
  });

  test('update pauses an active schedule and audits the door that was called', async () => {
    expect(
      await run(
        'schedule.update',
        { scheduleId: 'sched-1', status: 'paused' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({ ok: true, schedule: schedule({ status: 'paused' }) });
    expect(h.calls).toEqual(['pauseSchedule']);
    expect(h.audits.map((entry) => entry.toolName)).toEqual(['schedule.update']);
    expect(h.audits[0]?.paramsSummary).toEqual({ schedule_id: 'sched-1', transition: 'pause' });
  });

  test('update returns a paused schedule to active through the resume path', async () => {
    h.stored = [schedule({ status: 'paused', nextRunAt: null, pendingJobId: null })];
    expect(
      await run(
        'schedule.update',
        { scheduleId: 'sched-1', status: 'active' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({ ok: true, schedule: schedule({ status: 'active' }) });
    expect(h.calls).toEqual(['resumeSchedule']);
    expect(h.audits[0]?.paramsSummary).toEqual({ schedule_id: 'sched-1', transition: 'resume' });
  });

  test('update to the status a schedule already holds touches nothing', async () => {
    expect(
      await run(
        'schedule.update',
        { scheduleId: 'sched-1', status: 'active' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({ ok: true, schedule: schedule() });
    expect(h.calls).toEqual([]);
    expect(h.audits[0]?.paramsSummary).toEqual({ schedule_id: 'sched-1', transition: 'none' });
  });

  test('update reports the service status guard instead of swallowing it', async () => {
    h.stored = [schedule({ status: 'completed' })];
    h.transitionThrows = 'Schedule is not active (current: completed)';
    expect(
      await run(
        'schedule.update',
        { scheduleId: 'sched-1', status: 'paused' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'rejected',
      message: 'Schedule is not active (current: completed)',
    });
    expect(h.audits).toEqual([]);
  });

  test('update cannot reach a schedule owned by another space', async () => {
    h.stored = [schedule({ spaceId: OTHER_SPACE_ID })];
    expect(
      await run(
        'schedule.update',
        { scheduleId: 'sched-1', status: 'paused' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'schedule_not_found',
      message: 'Schedule not found: sched-1',
    });
    expect(h.calls).toEqual([]);
  });

  test('a concurrently advanced schedule reports modified_concurrently', async () => {
    h.deleteSucceeds = false;
    expect(
      await run('schedule.delete', { scheduleId: 'sched-1' }, mcpCaller('ad_hoc_member'))
    ).toEqual({
      ok: false,
      reason: 'modified_concurrently',
      message: 'Schedule was modified concurrently (e.g. a fire job advanced it). Please retry.',
    });
    expect(h.stored).toHaveLength(1);
    expect(h.audits).toEqual([]);
  });

  test('delete removes the schedule and records an audit entry', async () => {
    expect(
      await run('schedule.delete', { scheduleId: 'sched-1' }, mcpCaller('ad_hoc_member'))
    ).toEqual({ ok: true });
    expect(h.stored).toEqual([]);
    expect(h.audits.map((entry) => entry.toolName)).toEqual(['schedule.delete']);
  });

  test('an audit writer failure never turns a committed mutation into a rejection', async () => {
    h.auditThrows = true;
    expect(
      await run(
        'schedule.create',
        { title: 'Weekly', description: 'd', triggerType: 'cron', cronExpression: '@daily' },
        mcpCaller('ad_hoc_member')
      )
    ).toMatchObject({ ok: true });
    expect(h.stored).toHaveLength(2);
    expect(
      await run('schedule.delete', { scheduleId: 'sched-1' }, mcpCaller('ad_hoc_member'))
    ).toEqual({ ok: true });
    expect(h.stored.map((entry) => entry.id)).not.toContain('sched-1');
  });
});

describe('schedule operation role admission', () => {
  test('workflow workers may read schedules', async () => {
    expect(await run('schedule.list', {}, mcpCaller('workflow_worker'))).toEqual({
      ok: true,
      schedules: [schedule()],
    });
    expect(
      await run('schedule.get', { scheduleId: 'sched-1' }, mcpCaller('workflow_worker'))
    ).toEqual({ ok: true, schedule: schedule() });
  });

  test('workflow workers may mutate schedules', async () => {
    expect(
      await run(
        'schedule.update',
        { scheduleId: 'sched-1', status: 'paused' },
        mcpCaller('workflow_worker')
      )
    ).toMatchObject({ ok: true });
    expect(
      await run('schedule.delete', { scheduleId: 'sched-1' }, mcpCaller('workflow_worker'))
    ).toMatchObject({ ok: true });
    expect(h.calls).toEqual(['pauseSchedule', 'deleteSchedule']);
  });

  test('roles outside the space family may read as well', async () => {
    for (const role of ['outside_space', 'legacy_task_agent', 'direct_task_worker'] as const) {
      expect(await run('schedule.list', {}, mcpCaller(role))).toEqual({
        ok: true,
        schedules: [schedule()],
      });
    }
  });

  test('an archived caller session may not mutate, and nothing changes', async () => {
    h.sessions.set('member-1', session('archived', SPACE_ID));
    expect(
      await run('schedule.delete', { scheduleId: 'sched-1' }, mcpCaller('ad_hoc_member'))
    ).toEqual({
      ok: false,
      reason: 'denied',
      message: 'This caller may not use Space schedules.',
    });
    expect(h.calls).toEqual([]);
    expect(h.stored).toEqual([schedule()]);
    expect(h.audits).toEqual([]);
  });

  test('a caller session that left the owning space may not mutate', async () => {
    h.sessions.set('member-1', session('active', OTHER_SPACE_ID));
    expect(
      await run(
        'schedule.update',
        { scheduleId: 'sched-1', status: 'paused' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'denied',
      message: 'This caller may not use Space schedules.',
    });
    expect(h.calls).toEqual([]);
  });
});

describe('invokeOperation', () => {
  test('schedule results satisfy their declared result schemas', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    expect(
      await invokeOperation(registry, 'schedule.list', { spaceId: SPACE_ID }, RPC_CALLER)
    ).toEqual({ kind: 'completed', value: { ok: true, schedules: [schedule()] } });
    expect(
      await invokeOperation(
        registry,
        'schedule.get',
        { scheduleId: 'sched-1' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({ kind: 'completed', value: { ok: true, schedule: schedule() } });
    expect(
      await invokeOperation(
        registry,
        'schedule.delete',
        { scheduleId: 'sched-1' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({ kind: 'completed', value: { ok: true } });
  });

  test('update accepts only a status the door can reach', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    expect(
      await invokeOperation(
        registry,
        'schedule.update',
        { scheduleId: 'sched-1', status: 'paused' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({ kind: 'completed', value: { ok: true, schedule: schedule({ status: 'paused' }) } });
    const completed = await invokeOperation(
      registry,
      'schedule.update',
      { scheduleId: 'sched-1', status: 'completed' },
      mcpCaller('ad_hoc_member')
    );
    expect(completed.kind).toBe('failed');
  });

  test('caller identity fields are rejected as unknown input', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'schedule.list',
      { spaceId: SPACE_ID, role: 'long_term_agent', sessionId: 'someone-else' },
      RPC_CALLER
    );
    expect(outcome.kind).toBe('failed');
  });
});
