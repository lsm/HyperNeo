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
