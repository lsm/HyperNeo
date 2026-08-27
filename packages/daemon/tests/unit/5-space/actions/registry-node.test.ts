import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import type { NodeAgentToolsConfig } from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { NODE_AGENT_TOOL_SCHEMAS } from '../../../../src/lib/space/tools/node-agent-tool-schemas.ts';
import { jsonResult } from '../../../../src/lib/space/tools/tool-result.ts';
import { createActionRegistry } from '../../../../src/lib/space/actions/registry.ts';
import { createNodeRegistryEntries } from '../../../../src/lib/space/actions/registry-node.ts';
import type { z } from 'zod';

const SPACE_ID = 'space-registry-node-test';

const NODE_SCHEMA_BY_NAME = Object.fromEntries(
  Object.entries(NODE_AGENT_TOOL_SCHEMAS).map(([name, schema]) => [
    name,
    schema as z.ZodType<unknown>,
  ])
) as Record<string, z.ZodType<unknown>>;

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
];

const ALWAYS_ON_NAMES = [
  'list_peers',
  'list_reachable_agents',
  'list_channels',
  'send_message',
  'restore_node_agent',
];

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
    externalEventStore: {
      getById: () => null,
    } as unknown as NodeAgentToolsConfig['externalEventStore'],
    onSubscribeExternalEvent: async () => jsonResult({ success: true }),
    onUnsubscribeExternalEvent: async () => jsonResult({ success: true }),
    onListSubscriptions: async () => jsonResult({ success: true }),
    ...overrides,
  };
}

function makeBareConfig(
  ctx: TestCtx,
  overrides: Partial<NodeAgentToolsConfig> = {}
): NodeAgentToolsConfig {
  return {
    ...makeConfig(ctx),
    externalEventStore: undefined,
    onSubscribeExternalEvent: undefined,
    onUnsubscribeExternalEvent: undefined,
    onListSubscriptions: undefined,
    ...overrides,
  };
}

describe('createNodeRegistryEntries — composition', () => {
  test('builds the node-family entries in typed-surface order with authored safety classes', () => {
    const ctx = makeCtx();
    try {
      const entries = createNodeRegistryEntries(makeConfig(ctx));
      expect(entries.map((entry) => [entry.name, entry.safetyClass])).toEqual(FULL_ENTRIES);
      for (const entry of entries) {
        expect(entry.family).toBe('node');
        expect(entry.description.length).toBeGreaterThan(0);
        expect(entry.paramsDoc.length).toBeGreaterThan(0);
        expect(entry.autonomyRequirement).toBeUndefined();
      }
    } finally {
      ctx.db.close();
    }
  });

  test('shares the schema objects with the typed node-agent server — one parse path', () => {
    const ctx = makeCtx();
    try {
      const entries = createNodeRegistryEntries(makeConfig(ctx));
      expect(entries).toHaveLength(FULL_ENTRIES.length);
      for (const entry of entries) {
        expect(entry.paramsSchema).toBe(NODE_SCHEMA_BY_NAME[entry.name]);
      }
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
      expect(registry.get('subscribe_pr_events')?.safetyClass).toBe('mutate');
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
      const gated: ReadonlyArray<readonly [keyof NodeAgentToolsConfig, readonly string[]]> = [
        ['onListSubscriptions', ['list_subscriptions']],
        ['externalEventStore', ['get_external_event', 'list_deliveries']],
      ];
      for (const [dep, names] of gated) {
        const present = createNodeRegistryEntries(
          makeBareConfig(ctx, { [dep]: makeConfig(ctx)[dep] })
        );
        expect(present.map((entry) => entry.name)).toEqual([
          ...ALWAYS_ON_NAMES.slice(0, 4),
          ...names,
          'restore_node_agent',
        ]);
      }
    } finally {
      ctx.db.close();
    }
  });
});

describe('createNodeRegistryEntries — audit choke point', () => {
  test('registry-dispatched handlers write no legacy audit rows — audit belongs to the dispatcher', async () => {
    const ctx = makeCtx();
    try {
      const auditRows: Array<Record<string, unknown>> = [];
      const auditLogRepo = {
        createEntry: (entry: Record<string, unknown>) => {
          auditRows.push(entry);
        },
      } as unknown as NodeAgentToolsConfig['auditLogRepo'];
      const entries = createNodeRegistryEntries(makeConfig(ctx, { auditLogRepo }));
      const subscribe = entries.find((entry) => entry.name === 'subscribe_external_event');
      if (!subscribe) throw new Error('subscribe_external_event entry missing');
      const result = (await subscribe.handler({
        topicPattern: 'github/*/*/pull_request/*.*',
      })) as { content: Array<{ text: string }> };
      expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
      expect(auditRows).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });
});
