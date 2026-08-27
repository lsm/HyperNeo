import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import type { WorkflowHookEngine } from '../../../../src/lib/space/runtime/workflow-hook-engine.ts';
import type { SpaceMcpSessionRole } from '../../../../src/lib/space/runtime/space-mcp-session-policy.ts';
import type { NodeAgentToolsConfig } from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { NODE_AGENT_TOOL_SCHEMAS } from '../../../../src/lib/space/tools/node-agent-tool-schemas.ts';
import {
  ApproveTaskSchema,
  MarkCompleteSchema,
  SubmitForApprovalSchema,
  TASK_AGENT_TOOL_SCHEMAS,
} from '../../../../src/lib/space/tools/task-agent-tool-schemas.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { jsonResult } from '../../../../src/lib/space/tools/tool-result.ts';
import {
  createActionRegistry,
  defineAction,
  type ActionDefinition,
} from '../../../../src/lib/space/actions/registry.ts';
import { runDispatchAction } from '../../../../src/lib/space/actions/dispatcher-pipeline.ts';
import {
  composeRoleActionEntries,
  createNodeRegistryEntries,
} from '../../../../src/lib/space/actions/registry-node.ts';
import { z } from 'zod';

const SPACE_ID = 'space-registry-node-test';

const FULL_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['list_peers', 'read'],
  ['list_reachable_agents', 'read'],
  ['list_channels', 'read'],
  ['send_message', 'mutate'],
  ['subscribe_external_event', 'mutate'],
  ['unsubscribe_external_event', 'mutate'],
  ['subscribe_pr_events', 'mutate'],
  ['list_subscriptions', 'read'],
  ['get_external_event', 'read'],
  ['list_deliveries', 'read'],
  ['restore_node_agent', 'mutate'],
  ['save_artifact', 'mutate'],
  ['list_artifacts', 'read'],
  ['create_standalone_task', 'mutate'],
  ['publish_task', 'mutate'],
  ['archive_task', 'destructive'],
  ['approve_task', 'mutate'],
  ['submit_for_approval', 'mutate'],
  ['mark_complete', 'mutate'],
  ['list_tasks', 'read'],
  ['get_task', 'read'],
  ['list_audit_entries', 'read'],
];

const ALWAYS_ON_NAMES = [
  'list_peers',
  'list_reachable_agents',
  'list_channels',
  'send_message',
  'restore_node_agent',
];

const NODE_SCHEMA_BY_NAME: Record<string, z.ZodType<unknown>> = {
  ...Object.fromEntries(
    Object.entries(NODE_AGENT_TOOL_SCHEMAS).map(([name, schema]) => [
      name,
      schema as z.ZodType<unknown>,
    ])
  ),
  approve_task: ApproveTaskSchema,
  submit_for_approval: SubmitForApprovalSchema,
  mark_complete: MarkCompleteSchema,
};

interface TestCtx {
  db: BunDatabase;
  calls: Map<string, number>;
}

function makeCtx(): TestCtx {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return { db, calls: new Map() };
}

function makeConfig(
  ctx: TestCtx,
  overrides: Partial<NodeAgentToolsConfig> = {}
): NodeAgentToolsConfig {
  const nodeExecutionRepo = new NodeExecutionRepository(ctx.db);
  const channelResolver = new ChannelResolver([]);
  const workflowRunId = 'run-registry-node-test';
  const record = (key: string) => {
    ctx.calls.set(key, (ctx.calls.get(key) ?? 0) + 1);
    return jsonResult({ success: true, key });
  };
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
    externalEventStore: {
      getById: () => null,
    } as unknown as NodeAgentToolsConfig['externalEventStore'],
    onSubscribeExternalEvent: async () => record('subscribe'),
    onUnsubscribeExternalEvent: async () => record('unsubscribe'),
    onListSubscriptions: async () => record('list_subscriptions'),
    onCreateStandaloneTask: async () => record('create_standalone_task'),
    onPublishTask: async () => record('publish_task'),
    onArchiveTask: async () => record('archive_task'),
    onApproveTask: async () => record('approve_task'),
    onSubmitForApproval: async () => record('submit_for_approval'),
    onMarkComplete: async () => record('mark_complete'),
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
    taskRepo: undefined,
    auditLogRepo: undefined,
    externalEventStore: undefined,
    onSubscribeExternalEvent: undefined,
    onUnsubscribeExternalEvent: undefined,
    onListSubscriptions: undefined,
    onCreateStandaloneTask: undefined,
    onPublishTask: undefined,
    onArchiveTask: undefined,
    onApproveTask: undefined,
    onSubmitForApproval: undefined,
    onMarkComplete: undefined,
    ...overrides,
  };
}

function keepCallbacks(ctx: TestCtx, keys: string[]): Partial<NodeAgentToolsConfig> {
  const all = makeConfig(ctx) as unknown as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, all[key]])) as Partial<NodeAgentToolsConfig>;
}

function makeStubEngine(executeCalls: string[]): WorkflowHookEngine {
  return {
    executeAction: async (methodName: string) => {
      executeCalls.push(methodName);
      return {
        decision: 'allow',
        stateUpdates: [],
        executionLog: [],
        userState: {},
        followUpRequests: [],
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
      name: 'list_sessions',
      family: 'space',
      safetyClass: 'read',
      description: 'Lists sessions in the space',
      paramsDoc: 'none',
      paramsSchema: z.object({}),
      handler: async () => [],
    }),
  ];
}

describe('createNodeRegistryEntries — composition', () => {
  test('builds the 22 node-family entries in typed-surface order with authored safety classes', () => {
    const ctx = makeCtx();
    try {
      const entries = createNodeRegistryEntries(makeConfig(ctx));
      expect(entries.map((entry) => [entry.name, entry.safetyClass])).toEqual(FULL_ENTRIES);
      for (const entry of entries) {
        expect(entry.family).toBe('node');
        expect(entry.description.length).toBeGreaterThan(0);
        expect(entry.paramsDoc.length).toBeGreaterThan(0);
      }
    } finally {
      ctx.db.close();
    }
  });

  test('shares the schema objects with the typed servers — one parse path', () => {
    const ctx = makeCtx();
    try {
      const entries = createNodeRegistryEntries(makeConfig(ctx));
      expect(entries).toHaveLength(FULL_ENTRIES.length);
      for (const entry of entries) {
        expect(entry.paramsSchema).toBe(NODE_SCHEMA_BY_NAME[entry.name]);
      }
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      expect(byName.get('approve_task')?.paramsSchema).toBe(TASK_AGENT_TOOL_SCHEMAS.approve_task);
      expect(byName.get('submit_for_approval')?.paramsSchema).toBe(
        TASK_AGENT_TOOL_SCHEMAS.submit_for_approval
      );
      expect(byName.get('mark_complete')?.paramsSchema).toBe(TASK_AGENT_TOOL_SCHEMAS.mark_complete);
    } finally {
      ctx.db.close();
    }
  });

  test('composes into a valid action registry', () => {
    const ctx = makeCtx();
    try {
      const registry = createActionRegistry(createNodeRegistryEntries(makeConfig(ctx)));
      expect(registry.entries).toHaveLength(FULL_ENTRIES.length);
      expect(registry.get('send_message')?.family).toBe('node');
      expect(registry.get('archive_task')?.safetyClass).toBe('destructive');
    } finally {
      ctx.db.close();
    }
  });

  test('archive_task requires autonomy clearance despite its destructive safety class', () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createNodeRegistryEntries(makeConfig(ctx)).map((entry) => [entry.name, entry])
      );
      expect(byName.get('archive_task')?.autonomyRequirement).toBe(4);
    } finally {
      ctx.db.close();
    }
  });
});

describe('createNodeRegistryEntries — conditional entries', () => {
  test('a bare config advertises only the always-on entries', () => {
    const ctx = makeCtx();
    try {
      const entries = createNodeRegistryEntries(makeBareConfig(ctx));
      expect(entries.map((entry) => entry.name)).toEqual(ALWAYS_ON_NAMES);
    } finally {
      ctx.db.close();
    }
  });

  test('the subscribe trio requires both subscribe and unsubscribe callbacks', () => {
    const ctx = makeCtx();
    try {
      const halfPair = createNodeRegistryEntries(
        makeBareConfig(ctx, { onSubscribeExternalEvent: async () => jsonResult({ success: true }) })
      );
      expect(halfPair.map((entry) => entry.name)).toEqual(ALWAYS_ON_NAMES);

      const fullPair = createNodeRegistryEntries(
        makeBareConfig(ctx, {
          onSubscribeExternalEvent: async () => jsonResult({ success: true }),
          onUnsubscribeExternalEvent: async () => jsonResult({ success: true }),
        })
      );
      expect(fullPair.map((entry) => entry.name)).toEqual([
        ...ALWAYS_ON_NAMES.slice(0, 4),
        'subscribe_external_event',
        'unsubscribe_external_event',
        'subscribe_pr_events',
        'restore_node_agent',
      ]);
    } finally {
      ctx.db.close();
    }
  });

  test('each absent dep keeps exactly its entries out', () => {
    const ctx = makeCtx();
    try {
      const full = new Set(createNodeRegistryEntries(makeConfig(ctx)).map((entry) => entry.name));
      const gated: ReadonlyArray<readonly [keyof NodeAgentToolsConfig, readonly string[]]> = [
        ['onListSubscriptions', ['list_subscriptions']],
        ['externalEventStore', ['get_external_event', 'list_deliveries']],
        ['artifactRepo', ['save_artifact', 'list_artifacts']],
        ['onCreateStandaloneTask', ['create_standalone_task']],
        ['onPublishTask', ['publish_task']],
        ['onArchiveTask', ['archive_task']],
        ['onApproveTask', ['approve_task']],
        ['onSubmitForApproval', ['submit_for_approval']],
        ['onMarkComplete', ['mark_complete']],
        ['taskRepo', ['list_tasks', 'get_task']],
        ['auditLogRepo', ['list_audit_entries']],
      ];
      const bareNames = new Set(ALWAYS_ON_NAMES);
      for (const [dep, names] of gated) {
        const present = new Set(
          createNodeRegistryEntries(makeBareConfig(ctx, { [dep]: makeConfig(ctx)[dep] })).map(
            (entry) => entry.name
          )
        );
        expect([...present].sort()).toEqual(
          [...bareNames, ...names.filter((name) => full.has(name))].sort()
        );
      }
    } finally {
      ctx.db.close();
    }
  });
});

describe('createNodeRegistryEntries — approve_task autonomy', () => {
  test('defaults to completion autonomy level 5 without a workflow', () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createNodeRegistryEntries(
          makeBareConfig(ctx, { onApproveTask: async () => jsonResult({ success: true }) })
        ).map((entry) => [entry.name, entry])
      );
      expect(byName.get('approve_task')?.autonomyRequirement).toBe(5);
    } finally {
      ctx.db.close();
    }
  });

  test('mirrors the workflow completionAutonomyLevel when declared', () => {
    const ctx = makeCtx();
    try {
      const workflow = { completionAutonomyLevel: 3 } as SpaceWorkflow;
      const byName = new Map(
        createNodeRegistryEntries(
          makeBareConfig(ctx, {
            workflow,
            onApproveTask: async () => jsonResult({ success: true }),
          })
        ).map((entry) => [entry.name, entry])
      );
      expect(byName.get('approve_task')?.autonomyRequirement).toBe(3);
    } finally {
      ctx.db.close();
    }
  });
});

describe('composeRoleActionEntries — approve_task collision resolution', () => {
  test('workflow_worker gets node-family precedence on colliding names', () => {
    const spaceApproveCalls: string[] = [];
    const nodeNames = ['list_peers', 'approve_task'];
    const composed = composeRoleActionEntries(
      'workflow_worker',
      makeSpaceEntries(spaceApproveCalls),
      nodeNames.map((name) =>
        defineAction({
          name,
          family: 'node',
          safetyClass: 'read',
          description: 'node entry',
          paramsDoc: 'none',
          paramsSchema: z.object({}),
          handler: async () => null,
        })
      )
    );
    expect(composed.map((entry) => entry.name)).toEqual([
      'list_peers',
      'approve_task',
      'list_sessions',
    ]);
    const registry = createActionRegistry(composed);
    expect(registry.get('approve_task')?.family).toBe('node');
    expect(registry.get('approve_task')?.paramsSchema).not.toBe(
      makeSpaceEntries([]).find((entry) => entry.name === 'approve_task')?.paramsSchema
    );
  });

  test('workflow_worker never falls back to the space approve_task entry', () => {
    const spaceApproveCalls: string[] = [];
    const composed = composeRoleActionEntries(
      'workflow_worker',
      makeSpaceEntries(spaceApproveCalls),
      [
        defineAction({
          name: 'list_peers',
          family: 'node',
          safetyClass: 'read',
          description: 'node entry',
          paramsDoc: 'none',
          paramsSchema: z.object({}),
          handler: async () => null,
        }),
      ]
    );
    expect(composed.map((entry) => entry.name)).toEqual(['list_peers', 'list_sessions']);
    const registry = createActionRegistry(composed);
    expect(registry.get('approve_task')).toBeUndefined();
  });

  test('coordinator, member, long-term, and non-space registries never include node family', () => {
    const nodeEntry = defineAction({
      name: 'list_peers',
      family: 'node',
      safetyClass: 'read',
      description: 'node entry',
      paramsDoc: 'none',
      paramsSchema: z.object({}),
      handler: async () => null,
    });
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
      expect(composed.map((entry) => entry.name)).toEqual(['approve_task', 'list_sessions']);
    }
  });

  test('composed worker registry keeps non-colliding space entries alongside node entries', () => {
    const ctx = makeCtx();
    try {
      const nodeEntries = createNodeRegistryEntries(makeBareConfig(ctx));
      const composed = composeRoleActionEntries(
        'workflow_worker',
        makeSpaceEntries([]),
        nodeEntries
      );
      const registry = createActionRegistry(composed);
      expect(registry.get('list_sessions')?.family).toBe('space');
      expect(registry.get('send_message')?.family).toBe('node');
      expect(registry.get('approve_task')).toBeUndefined();
      expect(registry.entries).toHaveLength(ALWAYS_ON_NAMES.length + 1);
    } finally {
      ctx.db.close();
    }
  });

  test('end-to-end: dispatched approve_task on a worker registry routes to the node handler', async () => {
    const ctx = makeCtx();
    try {
      const nodeEntries = createNodeRegistryEntries(
        makeBareConfig(ctx, keepCallbacks(ctx, ['onApproveTask']))
      );
      const spaceApproveCalls: string[] = [];
      const registry = createActionRegistry(
        composeRoleActionEntries(
          'workflow_worker',
          makeSpaceEntries(spaceApproveCalls),
          nodeEntries
        )
      );

      const outcome = await runDispatchAction(
        { registry },
        {
          actionName: 'approve_task',
          params: {},
          role: 'workflow_worker',
          spaceId: SPACE_ID,
          taskId: 'task-1',
          workflowRunId: 'run-registry-node-test',
          spaceLevel: 5,
        }
      );
      expect(outcome.action).toBe('dispatched');
      expect(ctx.calls.get('approve_task')).toBe(1);
      expect(spaceApproveCalls).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('end-to-end: default autonomy 5 denies approve_task below level 5 and allows at the workflow level', async () => {
    const ctx = makeCtx();
    try {
      const registry = createActionRegistry(
        composeRoleActionEntries(
          'workflow_worker',
          makeSpaceEntries([]),
          createNodeRegistryEntries(makeBareConfig(ctx, keepCallbacks(ctx, ['onApproveTask'])))
        )
      );
      const denied = await runDispatchAction(
        { registry },
        {
          actionName: 'approve_task',
          params: {},
          role: 'workflow_worker',
          spaceId: SPACE_ID,
          spaceLevel: 4,
        }
      );
      expect(denied).toEqual({
        action: 'denied',
        reason: 'autonomy_denied',
        message: expect.stringContaining('space autonomy level 4'),
      });
      expect(ctx.calls.get('approve_task')).toBeUndefined();

      const workflow = { completionAutonomyLevel: 3 } as SpaceWorkflow;
      const lowered = createActionRegistry(
        composeRoleActionEntries(
          'workflow_worker',
          makeSpaceEntries([]),
          createNodeRegistryEntries(
            makeBareConfig(ctx, {
              workflow,
              ...keepCallbacks(ctx, ['onApproveTask']),
            })
          )
        )
      );
      const allowed = await runDispatchAction(
        { registry: lowered },
        {
          actionName: 'approve_task',
          params: {},
          role: 'workflow_worker',
          spaceId: SPACE_ID,
          spaceLevel: 4,
        }
      );
      expect(allowed.action).toBe('dispatched');
    } finally {
      ctx.db.close();
    }
  });

  test('end-to-end: the coordinator registry dispatches the space approve_task, not the node one', async () => {
    const ctx = makeCtx();
    try {
      const spaceApproveCalls: string[] = [];
      const registry = createActionRegistry(
        composeRoleActionEntries(
          'coordinator',
          makeSpaceEntries(spaceApproveCalls),
          createNodeRegistryEntries(makeBareConfig(ctx))
        )
      );
      const outcome = await runDispatchAction(
        { registry },
        {
          actionName: 'approve_task',
          params: { task_id: 'task-9' },
          role: 'coordinator',
          spaceId: SPACE_ID,
        }
      );
      expect(outcome.action).toBe('dispatched');
      expect(spaceApproveCalls).toEqual(['space']);
      expect(ctx.calls.get('approve_task')).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });
});

describe('createNodeRegistryEntries — dispatcher audit chokepoint', () => {
  test('a dispatched mutating node action writes exactly one audit row', async () => {
    const ctx = makeCtx();
    try {
      const auditRepo = new McpAuditLogRepository(ctx.db);
      const registry = createActionRegistry(
        composeRoleActionEntries(
          'workflow_worker',
          makeSpaceEntries([]),
          createNodeRegistryEntries(
            makeConfig(ctx, {
              auditLogRepo: auditRepo,
              ...keepCallbacks(ctx, ['onApproveTask']),
            })
          )
        )
      );

      await runDispatchAction(
        { registry, auditLogRepo: auditRepo },
        {
          actionName: 'approve_task',
          params: {},
          role: 'workflow_worker',
          spaceId: SPACE_ID,
          taskId: 'task-1',
          workflowRunId: 'run-registry-node-test',
          spaceLevel: 5,
        }
      );

      const rows = auditRepo.listBySpace(SPACE_ID, 10, 0);
      expect(rows).toHaveLength(1);
      expect(rows[0].toolName).toBe('approve_task');
    } finally {
      ctx.db.close();
    }
  });
});

describe('createNodeRegistryEntries — end-node callbacks', () => {
  test('submit_for_approval and mark_complete invoke their config callbacks', async () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createNodeRegistryEntries(
          makeBareConfig(ctx, keepCallbacks(ctx, ['onSubmitForApproval', 'onMarkComplete']))
        ).map((entry) => [entry.name, entry])
      );
      const submit = byName.get('submit_for_approval');
      const mark = byName.get('mark_complete');
      if (!submit || !mark) throw new Error('end-node entries missing');
      await submit.handler({});
      await mark.handler({});
      expect(ctx.calls.get('submit_for_approval')).toBe(1);
      expect(ctx.calls.get('mark_complete')).toBe(1);
    } finally {
      ctx.db.close();
    }
  });

  test('a hook engine wraps the end-node callbacks without changing their outcomes', async () => {
    const ctx = makeCtx();
    try {
      const executeCalls: string[] = [];
      const byName = new Map(
        createNodeRegistryEntries(
          makeBareConfig(ctx, {
            hookEngine: makeStubEngine(executeCalls),
            ...keepCallbacks(ctx, ['onSubmitForApproval', 'onMarkComplete']),
          })
        ).map((entry) => [entry.name, entry])
      );
      const submit = byName.get('submit_for_approval');
      const mark = byName.get('mark_complete');
      if (!submit || !mark) throw new Error('end-node entries missing');
      const submitResult = (await submit.handler({})) as { content: Array<{ text: string }> };
      const markResult = (await mark.handler({})) as { content: Array<{ text: string }> };
      expect(JSON.parse(submitResult.content[0].text)).toEqual({
        success: true,
        key: 'submit_for_approval',
      });
      expect(JSON.parse(markResult.content[0].text)).toEqual({
        success: true,
        key: 'mark_complete',
      });
      expect(executeCalls).toEqual(['submit_for_approval', 'mark_complete']);
      expect(ctx.calls.get('submit_for_approval')).toBe(1);
      expect(ctx.calls.get('mark_complete')).toBe(1);
    } finally {
      ctx.db.close();
    }
  });
});
