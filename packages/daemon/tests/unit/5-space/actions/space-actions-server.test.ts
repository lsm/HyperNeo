/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  GENERAL_HOT_ACTIONS,
  ROLE_HOT_ACTIONS,
} from '../../../../src/lib/space/actions/description-generator.ts';
import type { DispatchTelemetryEvent } from '../../../../src/lib/space/actions/dispatcher-pipeline.ts';
import {
  createSpaceActionsMcpServer,
  resolveRoleHotActionView,
  type SpaceActionsMcpServer,
  type SpaceActionsServerConfig,
} from '../../../../src/lib/space/actions/space-actions-server.ts';
import type { NodeAgentToolsConfig } from '../../../../src/lib/space/tools/node-agent-tools.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/tools/space-agent-tools.ts';
import type { CreateMcpAuditLogParams } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';

const SPACE_ID = 'space-actions-server-test';
const stubSpaceConfig = {
  spaceId: SPACE_ID,
  db: {},
  taskAgentManager: {},
} as unknown as SpaceAgentToolsConfig;
const stubNodeConfig = { spaceId: SPACE_ID } as unknown as NodeAgentToolsConfig;

function makeServer(overrides: Partial<SpaceActionsServerConfig> = {}): SpaceActionsMcpServer {
  return createSpaceActionsMcpServer({
    role: 'coordinator',
    spaceId: SPACE_ID,
    spaceConfig: stubSpaceConfig,
    ...overrides,
  });
}

async function dispatch(
  server: SpaceActionsMcpServer,
  args: { name: string; params?: Record<string, unknown> }
): Promise<unknown> {
  const callActionTool = server.tools.find((entry) => entry.name === 'call_action');
  if (!callActionTool) throw new Error('call_action tool missing');
  const result = (await callActionTool.handler(
    { name: args.name, params: args.params ?? {} },
    {}
  )) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0].text);
}

describe('resolveRoleHotActionView', () => {
  test('maps each workflow node role to its preset hot list', () => {
    for (const [key, hotActions] of Object.entries(ROLE_HOT_ACTIONS)) {
      expect(resolveRoleHotActionView('workflow_worker', key).hotActions).toBe(hotActions);
    }
  });

  test('labels node roles, normalizes input, and outranks the session role default', () => {
    expect(resolveRoleHotActionView('workflow_worker', 'qa').label).toBe('QA');
    expect(resolveRoleHotActionView('workflow_worker', 'coder').label).toBe('Coder');
    expect(resolveRoleHotActionView('workflow_worker', ' Coder ').hotActions).toBe(
      ROLE_HOT_ACTIONS.coder
    );
    expect(resolveRoleHotActionView('coordinator', 'reviewer').hotActions).toBe(
      ROLE_HOT_ACTIONS.reviewer
    );
  });

  test('falls back to the general hot list labeled by session role', () => {
    expect(resolveRoleHotActionView('coordinator', null)).toEqual({
      label: 'Coordinator',
      hotActions: GENERAL_HOT_ACTIONS,
    });
    expect(resolveRoleHotActionView('workflow_worker', 'custom-agent')).toEqual({
      label: 'Workflow Worker',
      hotActions: GENERAL_HOT_ACTIONS,
    });
    expect(resolveRoleHotActionView('long_term_agent').label).toBe('Long Term Agent');
  });
});

describe('createSpaceActionsMcpServer — tool and registry composition', () => {
  test('exposes a single call_action tool on the space-actions server', () => {
    const server = makeServer();
    expect(server.tools.map((entry) => entry.name)).toEqual(['call_action']);
  });

  test('composes space entries plus registry meta entries for the coordinator', () => {
    const server = makeServer();
    expect(server.registry.get('list_sessions')?.family).toBe('space');
    expect(server.registry.get('list_actions')).toMatchObject({
      family: 'space',
      safetyClass: 'read',
    });
    expect(server.registry.get('describe_action')).toBeDefined();
    expect(server.registry.get('send_message')).toBeUndefined();
  });

  test('composes node entries and the worker space allowlist for workflow workers', () => {
    const server = makeServer({ role: 'workflow_worker', nodeConfig: stubNodeConfig });
    expect(server.registry.get('list_peers')?.family).toBe('node');
    expect(server.registry.get('get_session_detail')?.family).toBe('space');
    expect(server.registry.get('create_standalone_task')).toBeUndefined();
    expect(server.registry.get('list_actions')).toBeDefined();
  });

  test('describes the node role hot list in the call_action description', () => {
    const server = makeServer({ nodeRole: 'coder' });
    expect(server.description.startsWith('## Coder actions')).toBe(true);
    expect(server.description).toContain('- create_standalone_task — ');
    expect(server.description).toContain('call_action(name="list_actions")');
  });
});

describe('createSpaceActionsMcpServer — call_action dispatch', () => {
  test('denies unknown actions and invalid parameters with structured reasons', async () => {
    const server = makeServer();
    expect(await dispatch(server, { name: 'definitely_missing' })).toMatchObject({
      error: 'action_denied',
      reason: 'unknown_action',
    });
    expect(await dispatch(server, { name: 'describe_action' })).toMatchObject({
      error: 'action_denied',
      reason: 'invalid_params',
    });
  });

  test('serves list_actions as a dispatchable registry entry', async () => {
    const catalog = (await dispatch(makeServer(), { name: 'list_actions' })) as Array<
      Record<string, unknown>
    >;
    const names = catalog.map((entry) => entry.name);
    expect(names).toContain('list_sessions');
    expect(names).toContain('list_actions');
    expect(names).toContain('describe_action');
    expect(catalog.find((entry) => entry.name === 'update_task')).toMatchObject({
      family: 'space',
      safetyClass: 'mutate',
    });
  });

  test('serves describe_action for registered actions and unknown names', async () => {
    const server = makeServer();
    expect(
      await dispatch(server, { name: 'describe_action', params: { name: 'list_actions' } })
    ).toMatchObject({ name: 'list_actions', safetyClass: 'read', params: 'none' });
    expect(await dispatch(server, { name: 'describe_action', params: { name: 'nope' } })).toEqual({
      error: 'Unknown action: nope',
    });
  });

  test('writes exactly one audit record for a mutating dispatch by default', async () => {
    const entries: CreateMcpAuditLogParams[] = [];
    const server = makeServer({
      spaceLevel: 4,
      spaceConfig: {
        ...stubSpaceConfig,
        auditLogRepo: {
          createEntry: (entry: CreateMcpAuditLogParams) => {
            entries.push(entry);
            return null as never;
          },
        },
      } as unknown as SpaceAgentToolsConfig,
    });
    await dispatch(server, {
      name: 'update_session_state',
      params: { session_id: 'session-1', processing_state: 'idle' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: 'update_session_state', spaceId: SPACE_ID });
  });

  test('prefers an explicit dispatchDeps audit repo over the config default', async () => {
    const configEntries: CreateMcpAuditLogParams[] = [];
    const depEntries: CreateMcpAuditLogParams[] = [];
    const server = makeServer({
      spaceLevel: 4,
      spaceConfig: {
        ...stubSpaceConfig,
        auditLogRepo: {
          createEntry: (entry: CreateMcpAuditLogParams) => void configEntries.push(entry),
        },
      } as unknown as SpaceAgentToolsConfig,
      dispatchDeps: {
        auditLogRepo: {
          createEntry: (entry: CreateMcpAuditLogParams) => {
            depEntries.push(entry);
            return null as never;
          },
        },
      },
    });
    await dispatch(server, {
      name: 'update_session_state',
      params: { session_id: 'session-1', processing_state: 'idle' },
    });
    expect(configEntries).toHaveLength(0);
    expect(depEntries).toHaveLength(1);
  });

  test('forwards the configured space autonomy resolver into dispatch', async () => {
    const queriedSpaceIds: string[] = [];
    const server = makeServer({
      spaceConfig: {
        ...stubSpaceConfig,
        getSpaceAutonomyLevel: async (spaceId: string) => {
          queriedSpaceIds.push(spaceId);
          return 4;
        },
      } as unknown as SpaceAgentToolsConfig,
    });
    const body = (await dispatch(server, {
      name: 'update_session_state',
      params: { session_id: 'session-1', processing_state: 'idle' },
    })) as Record<string, unknown>;
    expect(queriedSpaceIds).toContain(SPACE_ID);
    expect(body).not.toMatchObject({ reason: 'autonomy_denied' });
  });

  test('defaults worker dispatch context from the node config', async () => {
    const entries: CreateMcpAuditLogParams[] = [];
    const server = createSpaceActionsMcpServer({
      role: 'workflow_worker',
      spaceId: SPACE_ID,
      nodeConfig: {
        ...stubNodeConfig,
        taskId: 'task-9',
        workflowRunId: 'run-9',
        myAgentName: 'coder-9',
        mySessionId: 'session-9',
        auditLogRepo: {
          createEntry: (entry: CreateMcpAuditLogParams) => {
            entries.push(entry);
            return null as never;
          },
        },
      } as unknown as NodeAgentToolsConfig,
    });
    await dispatch(server, { name: 'send_message', params: { target: 'peer', message: 'hi' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      toolName: 'send_message',
      spaceId: SPACE_ID,
      taskId: 'task-9',
      workflowRunId: 'run-9',
      agentName: 'coder-9',
      sessionId: 'session-9',
    });
  });

  test('refuses construction for roles the dispatcher cannot dispatch', () => {
    expect(() => makeServer({ role: 'legacy_task_agent' })).toThrow(
      'does not support role "legacy_task_agent"'
    );
    expect(() => makeServer({ role: 'outside_space' })).toThrow('does not support role');
  });

  test('rejects tool configs bound to a different space', () => {
    expect(() =>
      makeServer({
        spaceConfig: {
          ...stubSpaceConfig,
          spaceId: 'other-space',
        } as unknown as SpaceAgentToolsConfig,
      })
    ).toThrow('does not match server spaceId');
    expect(() =>
      createSpaceActionsMcpServer({
        role: 'workflow_worker',
        spaceId: SPACE_ID,
        nodeConfig: {
          ...stubNodeConfig,
          spaceId: 'other-space',
        } as unknown as NodeAgentToolsConfig,
      })
    ).toThrow('does not match server spaceId');
  });

  test('derives task and run targets from the space task repository', async () => {
    const events: DispatchTelemetryEvent[] = [];
    const server = makeServer({
      spaceConfig: {
        ...stubSpaceConfig,
        taskRepo: {
          getTaskByNumber: (_spaceId: string, taskNumber: number) =>
            taskNumber === 42 ? { id: 'task-42', workflowRunId: 'run-42' } : null,
          getTask: (taskId: string) =>
            taskId === 'task-42'
              ? { id: taskId, spaceId: SPACE_ID, workflowRunId: 'run-42' }
              : null,
        },
      } as unknown as SpaceAgentToolsConfig,
      dispatchDeps: { emitTelemetry: (event) => void events.push(event) },
    });
    await dispatch(server, { name: 'get_task_detail', params: { task_number: 42 } });
    expect(events[0]).toMatchObject({
      actionName: 'get_task_detail',
      taskId: 'task-42',
      workflowRunId: 'run-42',
    });
  });

  test('reports ungated actions as having no autonomy requirement', async () => {
    const server = makeServer();
    const ungated = (await dispatch(server, {
      name: 'describe_action',
      params: { name: 'list_actions' },
    })) as Record<string, unknown>;
    expect(ungated.autonomyRequirement).toBe('none — available at every autonomy level');
    const dynamic = (await dispatch(server, {
      name: 'describe_action',
      params: { name: 'update_task' },
    })) as Record<string, unknown>;
    expect(dynamic.autonomyRequirement).toBe('depends on the provided parameters');
  });

  test('excludes coordinator-only actions from non-coordinator registries', () => {
    expect(makeServer().registry.get('approve_pending_completion')).toBeDefined();
    expect(
      makeServer({ role: 'ad_hoc_member' }).registry.get('approve_pending_completion')
    ).toBeUndefined();
    expect(
      makeServer({ role: 'long_term_agent' }).registry.get('approve_pending_completion')
    ).toBeUndefined();
  });

  test('backfills worker hot lists with always-registered node actions', () => {
    const server = makeServer({ role: 'workflow_worker', nodeConfig: stubNodeConfig });
    expect(server.description).toContain('- send_message — ');
    expect(server.description).toContain('- list_peers — ');
  });

  test('redacts node message payloads from central audit rows', async () => {
    const entries: CreateMcpAuditLogParams[] = [];
    const server = createSpaceActionsMcpServer({
      role: 'workflow_worker',
      spaceId: SPACE_ID,
      nodeConfig: {
        ...stubNodeConfig,
        myAgentName: 'coder-9',
        mySessionId: 'session-9',
        auditLogRepo: {
          createEntry: (entry: CreateMcpAuditLogParams) => {
            entries.push(entry);
            return null as never;
          },
        },
      } as unknown as NodeAgentToolsConfig,
    });
    await dispatch(server, {
      name: 'send_message',
      params: { target: 'peer', message: 'secret-payload', data: { secret: true } },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].paramsSummary).not.toContain('secret-payload');
    expect(entries[0].paramsSummary).not.toContain('message');
  });

  test('redacts free-form description payloads from central audit rows', async () => {
    const entries: CreateMcpAuditLogParams[] = [];
    const server = makeServer({
      spaceConfig: {
        ...stubSpaceConfig,
        auditLogRepo: {
          createEntry: (entry: CreateMcpAuditLogParams) => {
            entries.push(entry);
            return null as never;
          },
        },
      } as unknown as SpaceAgentToolsConfig,
    });
    await dispatch(server, {
      name: 'create_standalone_task',
      params: { title: 't', description: 'super-secret-plan' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].paramsSummary).not.toContain('super-secret-plan');
    expect(entries[0].paramsSummary).not.toContain('description');
  });

  test('derives a long-term-agent autonomy ceiling fresh on each dispatch', async () => {
    let persistedLevel = 1;
    const server = makeServer({
      role: 'long_term_agent',
      spaceLevel: 5,
      spaceConfig: {
        ...stubSpaceConfig,
        myAgentId: 'lh-agent-1',
        longHorizonAgentRepo: { getById: () => ({ autonomyLevel: persistedLevel }) },
      } as unknown as SpaceAgentToolsConfig,
    });
    const denied = (await dispatch(server, {
      name: 'update_session_state',
      params: { session_id: 'session-1', processing_state: 'idle' },
    })) as Record<string, unknown>;
    expect(denied).toMatchObject({ error: 'action_denied', reason: 'autonomy_denied' });
    persistedLevel = 4;
    const admitted = (await dispatch(server, {
      name: 'update_session_state',
      params: { session_id: 'session-1', processing_state: 'idle' },
    })) as Record<string, unknown>;
    expect(admitted).not.toMatchObject({ reason: 'autonomy_denied' });
  });

  test('excludes denied action names from the composed registry', () => {
    const server = makeServer({ deniedActionNames: new Set(['list_sessions', 'update_task']) });
    expect(server.registry.get('list_sessions')).toBeUndefined();
    expect(server.registry.get('update_task')).toBeUndefined();
    expect(server.registry.get('list_actions')).toBeDefined();
  });

  test('scopes run-id resolution to the server space', async () => {
    const events: DispatchTelemetryEvent[] = [];
    const server = makeServer({
      spaceConfig: {
        ...stubSpaceConfig,
        taskRepo: {
          getTask: (taskId: string) =>
            taskId === 'foreign-1'
              ? { id: taskId, spaceId: 'other-space', workflowRunId: 'run-foreign' }
              : { id: taskId, spaceId: SPACE_ID, workflowRunId: 'run-local' },
        },
      } as unknown as SpaceAgentToolsConfig,
      dispatchDeps: { emitTelemetry: (event) => void events.push(event) },
    });
    await dispatch(server, { name: 'get_task_detail', params: { task_id: 'foreign-1' } });
    await dispatch(server, { name: 'get_task_detail', params: { task_id: 'local-1' } });
    expect(events).toHaveLength(2);
    expect(events[0].workflowRunId).toBeUndefined();
    expect(events[1].workflowRunId).toBe('run-local');
  });

  test('denies rate-limited dispatches through the configured budget', async () => {
    const server = makeServer({ dispatchDeps: { isWithinRateBudget: () => false } });
    expect(await dispatch(server, { name: 'list_actions' })).toMatchObject({
      error: 'action_denied',
      reason: 'rate_limited',
    });
  });

  test('emits dispatch telemetry carrying the session context', async () => {
    const events: DispatchTelemetryEvent[] = [];
    const server = makeServer({
      taskId: 'task-1',
      agentName: 'coder-1',
      dispatchDeps: { emitTelemetry: (event) => void events.push(event) },
    });
    await dispatch(server, { name: 'list_actions' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actionName: 'list_actions',
      outcome: 'dispatched',
      role: 'coordinator',
      spaceId: SPACE_ID,
      taskId: 'task-1',
    });
  });
});
