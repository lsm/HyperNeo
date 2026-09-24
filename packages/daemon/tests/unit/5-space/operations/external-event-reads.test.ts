import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createExternalEventOperations } from '../../../../src/lib/external-events/operations';
import type { OperationCaller, OperationDefinition } from '../../../../src/lib/operations/registry';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let RUN: string;
let SPACE: string;
let OTHER_SPACE: string;
let db: Database;
let sessions: SessionRepository;
let nodeExecutions: NodeExecutionRepository;
let store: ExternalEventStore;
let operations: Map<string, OperationDefinition>;

function event(id: string, spaceId: string): ExternalEvent {
  return {
    id,
    spaceId,
    topic: `github/acme/widgets/pull_request/${id}`,
    occurredAt: 1000,
    ingestedAt: 1001,
    source: 'github',
    summary: `summary ${id}`,
    externalUrl: 'https://github.com/acme/widgets/pull/1',
    payload: { number: 1, nested: { ok: true } },
    dedupeKey: `dedupe-${id}`,
  };
}

function session(
  id: string,
  spaceId: string,
  extra: { status?: 'active' | 'archived'; taskId?: string } = {}
) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      status: extra.status ?? 'active',
      context: { spaceId, taskId: extra.taskId },
    },
    { enforceWorkspaceOwnership: false }
  );
  return id;
}

function worker(sessionId: string): OperationCaller {
  return { source: 'mcp', sessionId, spaceId: SPACE, role: 'workflow_worker', agentName: 'coder' };
}

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  const spaceRepo = new SpaceRepository(db);
  SPACE = spaceRepo.createSpace({ name: 'Events', slug: 'events', workspacePath: '/repo' }).id;
  OTHER_SPACE = spaceRepo.createSpace({ name: 'Other', slug: 'other', workspacePath: '/repo2' }).id;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId: SPACE, name: 'W' });
  RUN = new SpaceWorkflowRunRepository(db).createRun({
    spaceId: SPACE,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
  sessions = new SessionRepository(db);
  nodeExecutions = new NodeExecutionRepository(db);
  store = new ExternalEventStore(db);
  operations = new Map(
    createExternalEventOperations({
      eventStore: store,
      getSession: (id) => sessions.getSession(id),
      taskRepo: new SpaceTaskRepository(db),
      nodeExecutionRepo: nodeExecutions,
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
    }).map((operation) => [operation.name, operation])
  );
});

afterEach(() => db.close());

function run(name: string, input: unknown, caller: OperationCaller) {
  const operation = operations.get(name);
  if (!operation) throw new Error(`operation ${name} not registered`);
  return operation.execute(input, caller);
}

describe('createGetExternalEventOperation', () => {
  test('returns the stored event and state for a member of the owning space', async () => {
    store.store(event('evt-1', SPACE));
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: session('s-member', SPACE),
      spaceId: SPACE,
      role: 'ad_hoc_member',
    };
    const result = await run('event.external.get', { eventId: 'evt-1' }, caller);
    expect(result).toEqual({
      event: expect.objectContaining({ id: 'evt-1', summary: 'summary evt-1' }),
      state: 'published',
    });
  });

  test('rejects event_not_found when the event belongs to another space', async () => {
    store.store(event('evt-2', OTHER_SPACE));
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: session('s-member2', SPACE),
      spaceId: SPACE,
      role: 'ad_hoc_member',
    };
    expect(await run('event.external.get', { eventId: 'evt-2' }, caller)).toBe('event_not_found');
  });

  test('reads an event of its own space for a role outside the old read allowlist', async () => {
    store.store(event('evt-3', SPACE));
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: session('s-read', SPACE),
      spaceId: SPACE,
      role: 'universal_read',
    };
    expect(await run('event.external.get', { eventId: 'evt-3' }, caller)).toEqual({
      event: expect.objectContaining({ id: 'evt-3' }),
      state: 'published',
    });
  });

  test('rejects caller_denied when an MCP caller asks for another space explicitly', async () => {
    store.store(event('evt-4', OTHER_SPACE));
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: session('s-member3', SPACE),
      spaceId: SPACE,
      role: 'long_term_agent',
    };
    expect(
      await run('event.external.get', { eventId: 'evt-4', spaceId: OTHER_SPACE }, caller)
    ).toBe('caller_denied');
  });

  test('reads with the spaceId an RPC caller supplies and denies one that omits it', async () => {
    store.store(event('evt-5', SPACE));
    expect(
      await run('event.external.get', { eventId: 'evt-5', spaceId: SPACE }, { source: 'rpc' })
    ).toEqual({ event: expect.objectContaining({ id: 'evt-5' }), state: 'published' });
    expect(await run('event.external.get', { eventId: 'evt-5' }, { source: 'rpc' })).toBe(
      'caller_denied'
    );
  });
});

describe('createListDeliveriesOperation', () => {
  function delivery(eventId: string, nodeId: string, taskId: string) {
    store.store(event(eventId, SPACE));
    store.registerExpectedDelivery(eventId, `${eventId}:${nodeId}`, {
      workflowRunId: RUN,
      taskId,
      nodeId,
      agentName: 'coder',
    });
  }

  test('defaults to the workflow run resolved from the calling worker session', async () => {
    delivery('evt-d1', 'node-a', 'task-1');
    const sessionId = session('s-worker', SPACE, { taskId: 'task-1' });
    nodeExecutions.create({
      workflowRunId: RUN,
      workflowNodeId: 'node-a',
      agentName: 'coder',
      agentSessionId: sessionId,
    });
    const result = (await run('event.external.delivery.list', {}, worker(sessionId))) as {
      deliveries: Array<{ eventId: string; nodeId: string; state: string }>;
    };
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({
      eventId: 'evt-d1',
      nodeId: 'node-a',
      state: 'pending',
    });
  });

  test('rejects run_unresolved when no node execution backs the caller session', async () => {
    delivery('evt-d2', 'node-b', 'task-2');
    const sessionId = session('s-orphan', SPACE, { taskId: 'task-2' });
    expect(await run('event.external.delivery.list', {}, worker(sessionId))).toBe('run_unresolved');
  });

  test('lists a named run for a space member that is not a workflow worker', async () => {
    delivery('evt-d3', 'node-c', 'task-3');
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: session('s-member4', SPACE),
      spaceId: SPACE,
      role: 'ad_hoc_member',
    };
    const result = (await run('event.external.delivery.list', { workflowRunId: RUN }, caller)) as {
      deliveries: Array<{ eventId: string }>;
    };
    expect(result.deliveries.map((entry) => entry.eventId)).toContain('evt-d3');
  });

  test('a direct task worker lists the deliveries made to its own session', async () => {
    const sessionId = session('s-direct', SPACE);
    store.store(event('evt-s1', SPACE));
    store.registerExpectedDelivery('evt-s1', 'evt-s1:session', {
      workflowRunId: `session:${SPACE}`,
      taskId: 'sub-1',
      nodeId: sessionId,
      agentName: sessionId,
    });
    store.store(event('evt-s2', SPACE));
    store.registerExpectedDelivery('evt-s2', 'evt-s2:session', {
      workflowRunId: `session:${SPACE}`,
      taskId: 'sub-2',
      nodeId: 'someone-else',
      agentName: 'someone-else',
    });
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId,
      spaceId: SPACE,
      role: 'direct_task_worker',
    };
    const result = (await run('event.external.delivery.list', {}, caller)) as {
      deliveries: Array<{ eventId: string }>;
    };
    expect(result.deliveries.map((entry) => entry.eventId)).toEqual(['evt-s1']);
  });

  test('a long-horizon agent lists the deliveries made to its own record', async () => {
    const sessionId = session('s-agent', SPACE);
    sessions.updateSession(sessionId, {
      metadata: {
        ...sessions.getSession(sessionId)!.metadata,
        promptProvenance: { source: 'test', hash: 'h', agentId: 'agent-1' },
      },
    });
    store.store(event('evt-a1', SPACE));
    store.registerExpectedDelivery('evt-a1', 'evt-a1:agent', {
      workflowRunId: `long_horizon:${SPACE}`,
      taskId: 'sub-1',
      nodeId: 'agent-1',
      agentName: 'agent-1',
    });
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId,
      spaceId: SPACE,
      role: 'long_term_agent',
    };
    const result = (await run('event.external.delivery.list', {}, caller)) as {
      deliveries: Array<{ eventId: string }>;
    };
    expect(result.deliveries.map((entry) => entry.eventId)).toEqual(['evt-a1']);
  });

  test('filters by node id', async () => {
    delivery('evt-d4', 'node-d', 'task-4');
    delivery('evt-d5', 'node-e', 'task-4');
    const result = (await run(
      'event.external.delivery.list',
      { workflowRunId: RUN, nodeId: 'node-e', spaceId: SPACE },
      { source: 'rpc' }
    )) as { deliveries: Array<{ eventId: string }> };
    expect(result.deliveries.map((entry) => entry.eventId)).toEqual(['evt-d5']);
  });
});

describe('external event optional Space scope', () => {
  test('RPC and internal reads inherit the caller Space and empty deliveries report it', async () => {
    store.store(event('owned', SPACE));
    store.store(event('foreign', OTHER_SPACE));
    for (const source of ['rpc', 'internal'] as const) {
      const caller = { source, spaceId: SPACE };
      expect(await run('event.external.get', { eventId: 'owned' }, caller)).toMatchObject({
        event: { id: 'owned', spaceId: SPACE },
      });
      expect(await run('event.external.get', { eventId: 'foreign' }, caller)).toBe(
        'event_not_found'
      );
      const value = await run('event.external.delivery.list', { workflowRunId: RUN }, caller);
      expect(operations.get('event.external.delivery.list')?.resultSchema.parse(value)).toEqual({
        deliveries: [],
        scope: { spaceId: SPACE },
      });
    }
  });
});
