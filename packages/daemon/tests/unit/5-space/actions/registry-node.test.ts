import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { AgentMessageRouter } from '../../../../src/lib/messaging/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/messaging/channel-resolver.ts';
import type { WorkflowHookEngine } from '../../../../src/lib/workflows/hook-engine.ts';
import type { SpaceMcpSessionRole } from '../../../../src/lib/space/runtime/space-mcp-session-policy.ts';
import type { NodeAgentToolsConfig } from '../../../../src/lib/space/actions/node-handlers.ts';
import {
  createActionRegistry,
  defineAction,
  type ActionDefinition,
} from '../../../../src/lib/space/actions/registry.ts';
import {
  composeRoleActionEntries,
  createNodeRegistryEntries,
} from '../../../../src/lib/space/actions/registry-node.ts';
import { z } from 'zod';

const SPACE_ID = 'space-registry-node-test';

interface TestCtx {
  db: BunDatabase;
}

function makeCtx(): TestCtx {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return { db };
}

function makeConfig(
  ctx: TestCtx,
  overrides: Partial<NodeAgentToolsConfig> = {}
): NodeAgentToolsConfig {
  const nodeExecutionRepo = new NodeExecutionRepository(ctx.db);
  const channelResolver = new ChannelResolver([]);
  const workflowRunId = 'run-registry-node-test';
  return {
    mySessionId: 'session-coder',
    myAgentName: 'coder',
    taskId: 'task-1',
    spaceId: SPACE_ID,
    channelResolver,
    workflowRunId,
    workflowNodeId: 'node-coder',
    nodeExecutionRepo,
    agentMessageRouter: new AgentMessageRouter({
      nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [],
      messageInjector: async () => {},
    }),
    workflow: null,
    artifactRepo: new WorkflowRunArtifactRepository(ctx.db),
    taskRepo: new SpaceTaskRepository(ctx.db),
    auditLogRepo: new McpAuditLogRepository(ctx.db),
    ...overrides,
  };
}

function makeBareConfig(
  ctx: TestCtx,
  overrides: Partial<NodeAgentToolsConfig> = {}
): NodeAgentToolsConfig {
  const config = makeConfig(ctx);
  return {
    ...config,
    artifactRepo: undefined,
    auditLogRepo: undefined,
    ...overrides,
  };
}

function keepCallbacks(ctx: TestCtx, keys: string[]): Partial<NodeAgentToolsConfig> {
  const all = makeConfig(ctx) as unknown as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, all[key]])) as Partial<NodeAgentToolsConfig>;
}

function makeStubEngine(executeCalls: string[]): WorkflowHookEngine {
  return {
    executeAction: async (methodName: string, args?: Record<string, unknown>) => {
      executeCalls.push(methodName);
      return {
        decision: 'allow',
        stateUpdates: [],
        executionLog: [],
        userState: {},
        followUpRequests: [],
        finalParams: args ?? {},
      };
    },
    persistStateUpdate: () => true,
    clearQueuedRetryableActionsForOwner: () => [],
    clearQueuedRetryableActionsForKey: () => {},
    scheduleQueuedRetryableActions: () => {},
  } as unknown as WorkflowHookEngine;
}

function makeSpaceEntries(spaceApproveCalls: string[]): ActionDefinition[] {
  const taskActionSchema = z.object({ task_id: z.string() });
  return [
    defineAction({
      name: 'approve_task',
      family: 'space',
      safetyClass: 'mutate',
      description: 'Approves an arbitrary task by id from the space surface',
      paramsDoc: 'task_id',
      paramsSchema: taskActionSchema,
      handler: async () => {
        spaceApproveCalls.push('space');
        return { approved: 'space' };
      },
    }),
    defineAction({
      name: 'list_workflows',
      family: 'space',
      safetyClass: 'read',
      description: 'Lists workflows in the space',
      paramsDoc: 'none',
      paramsSchema: z.object({}),
      handler: async () => [],
    }),
  ];
}

function makeNodeEntry(): ActionDefinition {
  return defineAction({
    name: 'sample_node_action',
    family: 'node',
    safetyClass: 'mutate',
    description: 'node entry',
    paramsDoc: 'none',
    paramsSchema: z.object({}),
    handler: async () => null,
  });
}

describe('createNodeRegistryEntries — empty node family', () => {
  test('a fully-populated config advertises no node entries', () => {
    const ctx = makeCtx();
    try {
      expect(createNodeRegistryEntries(makeConfig(ctx))).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('a bare config advertises no entries', () => {
    const ctx = makeCtx();
    try {
      expect(createNodeRegistryEntries(makeBareConfig(ctx))).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });
});

describe('composeRoleActionEntries — composition', () => {
  test('space entries are normalized to the dispatcher family before dispatch', () => {
    const spaceEntry = defineAction({
      name: 'list_workflows',
      family: 'workflows',
      safetyClass: 'read',
      description: 'Lists workflows in the space',
      paramsDoc: 'none',
      paramsSchema: z.object({}),
      handler: async () => [],
    });
    const composed = composeRoleActionEntries('coordinator', [spaceEntry], []);
    expect(composed[0].family).toBe('space');
    const registry = createActionRegistry(composed);
    expect(registry.get('list_workflows')?.family).toBe('space');
  });

  test('coordinator, member, long-term, and non-space registries never include node family', () => {
    const nodeEntry = makeNodeEntry();
    const spaceEntries = makeSpaceEntries([]);
    for (const role of [
      'coordinator',
      'ad_hoc_member',
      'long_term_agent',
      'legacy_task_agent',
      'outside_space',
    ] as SpaceMcpSessionRole[]) {
      const composed = composeRoleActionEntries(role, spaceEntries, [nodeEntry]);
      expect(composed.every((entry) => entry.family !== 'node')).toBe(true);
      expect(composed.map((entry) => entry.name)).toEqual(['approve_task', 'list_workflows']);
    }
  });

  test('composed worker registry keeps allowlisted space reads alongside node entries', () => {
    const ctx = makeCtx();
    try {
      const nodeEntries = createNodeRegistryEntries(makeConfig(ctx));
      const composed = composeRoleActionEntries('workflow_worker', makeSpaceEntries([]), [
        ...nodeEntries,
        makeNodeEntry(),
      ]);
      const registry = createActionRegistry(composed);
      expect(registry.get('list_workflows')?.family).toBe('space');
      expect(registry.get('sample_node_action')?.family).toBe('node');
      expect(registry.get('approve_task')).toBeUndefined();
      expect(registry.entries).toHaveLength(2);
    } finally {
      ctx.db.close();
    }
  });

  test('composed worker registry excludes non-allowlisted space actions', () => {
    const nodeEntry = makeNodeEntry();
    const spaceEntries = [
      defineAction({
        name: 'list_workflows',
        family: 'space',
        safetyClass: 'read',
        description: 'space list',
        paramsDoc: 'none',
        paramsSchema: z.object({}),
        handler: async () => null,
      }),
      defineAction({
        name: 'change_plan',
        family: 'space',
        safetyClass: 'destructive',
        description: 'space change plan',
        paramsDoc: 'none',
        paramsSchema: z.object({}),
        handler: async () => null,
      }),
      defineAction({
        name: 'delete_agent_template',
        family: 'space',
        safetyClass: 'destructive',
        description: 'space delete template',
        paramsDoc: 'none',
        paramsSchema: z.object({}),
        handler: async () => null,
      }),
    ];
    const composed = composeRoleActionEntries('workflow_worker', spaceEntries, [nodeEntry]);
    const registry = createActionRegistry(composed);
    expect(registry.get('sample_node_action')).toBeDefined();
    expect(registry.get('list_workflows')).toBeDefined();
    expect(registry.get('change_plan')).toBeUndefined();
    expect(registry.get('delete_agent_template')).toBeUndefined();
  });
});
