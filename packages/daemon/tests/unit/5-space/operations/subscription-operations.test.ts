import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentSubscriptionRepository } from '../../../../src/storage/repositories/space-agent-subscription-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import {
  createSubscriptionOperations,
  type SubscriptionDependencies,
  type SubscriptionSlot,
} from '../../../../src/lib/external-events/subscription-operations';
import type { OperationCaller, OperationDefinition } from '../../../../src/lib/operations/registry';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let nodeExecutions: NodeExecutionRepository;
let agents: SpaceLongHorizonAgentRepository;
let agentSubscriptions: SpaceAgentSubscriptionRepository;
let auditLogRepo: McpAuditLogRepository;
let operations: Map<string, OperationDefinition>;
let registered: Array<{ slot: SubscriptionSlot; topicPattern: string }>;
let unregistered: Array<{ slot: SubscriptionSlot; topicPattern: string }>;
let refreshed: Array<{ spaceId: string; subscriptionId: string }>;
let removed: Array<{ spaceId: string; subscriptionId: string }>;
let refreshOutcome: { success: boolean; error?: string };
let registerOutcome: { success: boolean; error?: string };
let registerThrows: Error | null;
let primaryLinkUrl: string;
let SPACE: string;
let OTHER_SPACE: string;
let RUN: string;
let TASK: string;
let AGENT: string;
let FOREIGN_AGENT: string;

const AGENT_TOPIC = 'github/acme/widgets/pull_request/*.review_*';

const LIST_RESULT = {
  workflowRunId: 'placeholder',
  nodeId: null,
  definitionResolved: true,
  declared: [],
  persisted: [],
  active: [],
  mismatches: { declaredNotActive: 0, persistedNotActive: 0, orphanActive: 0 },
};

function workerSession(
  id: string,
  options: { status?: 'active' | 'archived'; withExecution?: boolean } = {}
) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      status: options.status ?? 'active',
      context: { spaceId: SPACE, taskId: TASK },
    },
    { enforceWorkspaceOwnership: false }
  );
  if (options.withExecution !== false) {
    nodeExecutions.create({
      workflowRunId: RUN,
      workflowNodeId: 'node-a',
      agentName: 'coder',
      agentSessionId: id,
    });
  }
  return id;
}

function worker(sessionId: string): OperationCaller {
  return { source: 'mcp', sessionId, spaceId: SPACE, role: 'workflow_worker', agentName: 'coder' };
}

function memberSession(id: string) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'space_chat',
      status: 'active',
      context: { spaceId: SPACE },
    },
    { enforceWorkspaceOwnership: false }
  );
  return id;
}

function member(sessionId: string): OperationCaller {
  return {
    source: 'mcp',
    sessionId,
    spaceId: SPACE,
    role: 'long_term_agent',
    agentName: 'watcher',
  };
}

function run(name: string, input: unknown, caller: OperationCaller) {
  const operation = operations.get(name);
  if (!operation) throw new Error(`operation ${name} not registered`);
  return operation.execute(input, caller);
}

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  SPACE = new SpaceRepository(db).createSpace({
    name: 'Subs',
    slug: 'subs',
    workspacePath: '/repo',
  }).id;
  OTHER_SPACE = new SpaceRepository(db).createSpace({
    name: 'Other',
    slug: 'other',
    workspacePath: '/other',
  }).id;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId: SPACE, name: 'W' });
  RUN = new SpaceWorkflowRunRepository(db).createRun({
    spaceId: SPACE,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
  const taskRepo = new SpaceTaskRepository(db);
  TASK = taskRepo.createTask({ spaceId: SPACE, title: 'T', description: '' }).id;
  sessions = new SessionRepository(db);
  nodeExecutions = new NodeExecutionRepository(db);
  agents = new SpaceLongHorizonAgentRepository(db);
  AGENT = agents.create({ spaceId: SPACE, handle: 'watcher' }).id;
  FOREIGN_AGENT = agents.create({ spaceId: OTHER_SPACE, handle: 'outsider' }).id;
  agentSubscriptions = new SpaceAgentSubscriptionRepository(db, new SpaceAgentRepository(db));
  auditLogRepo = new McpAuditLogRepository(db);
  registered = [];
  unregistered = [];
  refreshed = [];
  removed = [];
  refreshOutcome = { success: true };
  registerOutcome = { success: true };
  registerThrows = null;
  primaryLinkUrl = '';
  const deps: SubscriptionDependencies = {
    subscriptionRepo: agentSubscriptions,
    refreshSubscription: (spaceId, subscriptionId) => {
      refreshed.push({ spaceId, subscriptionId });
      return refreshOutcome;
    },
    removeSubscription: (spaceId, subscriptionId) => {
      removed.push({ spaceId, subscriptionId });
    },
    auditLogRepo,
    registerSubscription: (slot, topicPattern) => {
      if (registerThrows) throw registerThrows;
      registered.push({ slot, topicPattern });
      return registerOutcome;
    },
    unregisterSubscription: (slot, topicPattern) => {
      unregistered.push({ slot, topicPattern });
      return { success: true };
    },
    listRunSubscriptions: (workflowRunId) => ({
      success: true,
      result: { ...LIST_RESULT, workflowRunId },
    }),
    resolvePrimaryLinkUrl: () => primaryLinkUrl,
    getSession: (id) => sessions.getSession(id),
    taskRepo,
    nodeExecutionRepo: nodeExecutions,
    longHorizonAgentRepo: agents,
  };
  operations = new Map(
    createSubscriptionOperations(deps).map((operation) => [operation.name, operation])
  );
});

afterEach(() => db.close());

describe('node external-event subscription operations', () => {
  test('subscribes with the slot resolved from the calling session', async () => {
    const caller = worker(workerSession('s-sub'));
    const result = await run(
      'event.external.subscribe',
      { topicPattern: 'github/acme/widgets/pull_request/*' },
      caller
    );
    expect(result).toEqual({ ok: true, topicPattern: 'github/acme/widgets/pull_request/*' });
    expect(registered).toHaveLength(1);
    expect(registered[0]!.slot).toEqual({
      workflowRunId: RUN,
      nodeId: 'node-a',
      agentName: 'coder',
      taskId: TASK,
    });
  });

  test('refuses an invalid topic glob without touching the runtime', async () => {
    const caller = worker(workerSession('s-bad'));
    const result = (await run('event.external.subscribe', { topicPattern: '///' }, caller)) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error.length).toBeGreaterThan(0);
    expect(registered).toEqual([]);
  });

  test('reports a runtime rejection as a result value', async () => {
    registerOutcome = { success: false, error: 'Workflow run not found: x' };
    const caller = worker(workerSession('s-reject'));
    expect(await run('event.external.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toEqual(
      {
        ok: false,
        error: 'Workflow run not found: x',
      }
    );
  });

  test('turns an interest-cap throw into a result value', async () => {
    registerThrows = new Error('cannot register more than 8 event interests');
    const caller = worker(workerSession('s-cap'));
    expect(await run('event.external.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toEqual(
      {
        ok: false,
        error: 'cannot register more than 8 event interests',
      }
    );
  });

  test('unsubscribes the same slot', async () => {
    const caller = worker(workerSession('s-unsub'));
    expect(
      await run('event.external.unsubscribe', { topicPattern: 'github/a/b/*' }, caller)
    ).toEqual({ ok: true, topicPattern: 'github/a/b/*' });
    expect(unregistered[0]!.topicPattern).toBe('github/a/b/*');
  });

  test('subscribe_pr_events derives the topic from the run primary link', async () => {
    primaryLinkUrl = 'https://github.com/acme/widgets/pull/42';
    const caller = worker(workerSession('s-pr'));
    expect(await run('subscribe_pr_events', {}, caller)).toEqual({
      ok: true,
      topicPattern: 'github/acme/widgets/pull_request/42.*',
    });
  });

  test('subscribe_pr_events prefers an explicit prUrl and reports an unparseable one', async () => {
    primaryLinkUrl = 'https://github.com/acme/widgets/pull/42';
    const caller = worker(workerSession('s-pr2'));
    expect(
      await run('subscribe_pr_events', { prUrl: 'https://github.com/acme/widgets/pull/7' }, caller)
    ).toEqual({ ok: true, topicPattern: 'github/acme/widgets/pull_request/7.*' });
    expect(await run('subscribe_pr_events', { prUrl: 'not-a-url' }, caller)).toEqual({
      ok: false,
      error: 'Could not parse GitHub PR URL: not-a-url',
    });
  });

  test('subscribe_pr_events rejects a label it would never have stored', () => {
    const schema = operations.get('subscribe_pr_events')!.inputSchema;
    expect(schema.safeParse({ prUrl: 'https://github.com/acme/widgets/pull/7' }).success).toBe(
      true
    );
    expect(schema.safeParse({ label: 'nightly' }).success).toBe(false);
  });

  test('subscribe_pr_events explains an unresolved run PR', async () => {
    const caller = worker(workerSession('s-pr3'));
    expect(await run('subscribe_pr_events', {}, caller)).toEqual({
      ok: false,
      error: 'No PR URL found for this workflow run. Open a PR first or pass prUrl explicitly.',
    });
  });

  test('reports node_unresolved for a space member with no node execution', async () => {
    const sessionId = workerSession('s-member', { withExecution: false });
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId,
      spaceId: SPACE,
      role: 'ad_hoc_member',
    };
    expect(await run('event.external.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'node_unresolved'
    );
    expect(registered).toEqual([]);
  });

  test('refuses a subscription from an archived session and changes nothing', async () => {
    const caller = worker(workerSession('s-archived', { status: 'archived' }));
    expect(await run('event.external.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'session_inactive'
    );
    expect(await run('event.external.unsubscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'session_inactive'
    );
    expect(registered).toEqual([]);
    expect(unregistered).toEqual([]);
  });

  test('rejects node_unresolved when no node execution backs the session', async () => {
    const caller = worker(workerSession('s-orphan', { withExecution: false }));
    expect(await run('event.external.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'node_unresolved'
    );
  });

  test('lists the run subscriptions resolved from the caller and accepts an explicit run', async () => {
    const caller = worker(workerSession('s-list'));
    expect(await run('event.external.subscription.list', {}, caller)).toEqual({
      ok: true,
      subscriptions: { ...LIST_RESULT, workflowRunId: RUN },
      scope: { spaceId: SPACE },
    });
    expect(
      await run('event.external.subscription.list', { workflowRunId: 'run-x' }, caller)
    ).toEqual({
      ok: true,
      subscriptions: { ...LIST_RESULT, workflowRunId: 'run-x' },
      scope: { spaceId: SPACE },
    });
  });

  test('an archived worker session may still list subscriptions', async () => {
    const caller = worker(workerSession('s-list-archived', { status: 'archived' }));
    expect(await run('event.external.subscription.list', {}, caller)).toEqual({
      ok: true,
      subscriptions: { ...LIST_RESULT, workflowRunId: RUN },
      scope: { spaceId: SPACE },
    });
  });
});

describe('subscribe and unsubscribe take a subject', () => {
  test('an explicit node subject still resolves the slot from the calling session', async () => {
    const caller = worker(workerSession('s-node-subject'));
    expect(
      await run(
        'event.external.subscribe',
        { topicPattern: 'github/a/b/*', subject: { type: 'node' } },
        caller
      )
    ).toEqual({ ok: true, topicPattern: 'github/a/b/*' });
    expect(registered[0]!.slot).toEqual({
      workflowRunId: RUN,
      nodeId: 'node-a',
      agentName: 'coder',
      taskId: TASK,
    });
  });

  test('an agent subject stores the subscription against that agent and refreshes the trie', async () => {
    const caller = member(memberSession('s-agent-sub'));
    const result = await run(
      'event.external.subscribe',
      { topicPattern: AGENT_TOPIC, label: 'reviews', subject: { type: 'agent', agentId: AGENT } },
      caller
    );
    expect(operations.get('event.external.subscribe')?.resultSchema.parse(result)).toMatchObject({
      ok: true,
      topicPattern: AGENT_TOPIC,
      subscription: { agentId: AGENT, source: 'github', topic: AGENT_TOPIC, status: 'active' },
    });
    const stored = agentSubscriptions.listSubscriptions(AGENT);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.filter).toEqual({ label: 'reviews' });
    expect(refreshed).toEqual([{ spaceId: SPACE, subscriptionId: stored[0]!.id }]);
    expect(registered).toEqual([]);
  });

  test('an agent subject echoes the stored topic, not the untrimmed input', async () => {
    const caller = member(memberSession('s-agent-trim'));
    const result = await run(
      'event.external.subscribe',
      { topicPattern: `  ${AGENT_TOPIC}  `, subject: { type: 'agent', agentId: AGENT } },
      caller
    );
    expect(operations.get('event.external.subscribe')?.resultSchema.parse(result)).toMatchObject({
      ok: true,
      topicPattern: AGENT_TOPIC,
      subscription: { topic: AGENT_TOPIC },
    });
  });

  test('an unlabelled agent subject stores an empty filter and upserts its route', async () => {
    const caller = member(memberSession('s-agent-upsert'));
    const subject = { type: 'agent', agentId: AGENT } as const;
    await run('event.external.subscribe', { topicPattern: AGENT_TOPIC, subject }, caller);
    expect(agentSubscriptions.listSubscriptions(AGENT)[0]!.filter).toEqual({});
    await run(
      'event.external.subscribe',
      { topicPattern: AGENT_TOPIC, label: 'second', subject },
      caller
    );
    const stored = agentSubscriptions.listSubscriptions(AGENT);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.filter).toEqual({ label: 'second' });
  });

  test('an agent subject unsubscribe is idempotent and rejects a bad agent or pattern', async () => {
    const caller = member(memberSession('s-agent-unsub-bad'));
    const subject = { type: 'agent', agentId: AGENT } as const;
    await run('event.external.subscribe', { topicPattern: AGENT_TOPIC, subject }, caller);
    expect(
      await run(
        'event.external.unsubscribe',
        { topicPattern: 'github/acme/widgets/issues/*', subject },
        caller
      )
    ).toEqual({ ok: true, topicPattern: 'github/acme/widgets/issues/*' });
    expect(agentSubscriptions.listSubscriptions(AGENT)).toHaveLength(1);
    expect(removed).toEqual([]);
    expect(
      await run(
        'event.external.unsubscribe',
        { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: FOREIGN_AGENT } },
        caller
      )
    ).toBe('agent_not_found');
    expect(
      await run('event.external.unsubscribe', { topicPattern: 'a/**/b', subject }, caller)
    ).toBe('invalid_pattern');
  });

  test('an agent subject unsubscribes the stored record and its live entry', async () => {
    const caller = member(memberSession('s-agent-unsub'));
    await run(
      'event.external.subscribe',
      { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: AGENT } },
      caller
    );
    const stored = agentSubscriptions.listSubscriptions(AGENT)[0]!;
    expect(
      await run(
        'event.external.unsubscribe',
        { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: AGENT } },
        caller
      )
    ).toEqual({ ok: true, topicPattern: AGENT_TOPIC });
    expect(agentSubscriptions.listSubscriptions(AGENT)).toEqual([]);
    expect(removed).toEqual([{ spaceId: SPACE, subscriptionId: stored.id }]);
    expect(unregistered).toEqual([]);
  });

  test('an agent subject succeeds for a caller with no node execution behind it', async () => {
    const caller = member(memberSession('s-agent-nonode'));
    expect(await run('event.external.subscribe', { topicPattern: AGENT_TOPIC }, caller)).toBe(
      'node_unresolved'
    );
    const result = (await run(
      'event.external.subscribe',
      { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: AGENT } },
      caller
    )) as { subscription: { agentId: string } };
    expect(result.subscription.agentId).toBe(AGENT);
  });

  test('rejects an unknown or cross-space agent subject', async () => {
    const caller = member(memberSession('s-agent-foreign'));
    expect(
      await run(
        'event.external.subscribe',
        { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: 'agent-none' } },
        caller
      )
    ).toBe('agent_not_found');
    expect(
      await run(
        'event.external.subscribe',
        { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: FOREIGN_AGENT } },
        caller
      )
    ).toBe('agent_not_found');
    expect(agentSubscriptions.listSubscriptions(AGENT)).toEqual([]);
  });

  test('reports invalid_pattern and refresh_failed for an agent subject', async () => {
    const caller = member(memberSession('s-agent-reject'));
    expect(
      await run(
        'event.external.subscribe',
        { topicPattern: 'nosource', subject: { type: 'agent', agentId: AGENT } },
        caller
      )
    ).toBe('invalid_pattern');
    expect(agentSubscriptions.listSubscriptions(AGENT)).toEqual([]);
    refreshOutcome = { success: false, error: 'trie unavailable' };
    expect(
      await run(
        'event.external.subscribe',
        { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: AGENT } },
        caller
      )
    ).toBe('refresh_failed');
  });

  test('audits an agent-subject mutation under the operation that was called', async () => {
    const sessionId = memberSession('s-agent-audit');
    await run(
      'event.external.subscribe',
      { topicPattern: AGENT_TOPIC, subject: { type: 'agent', agentId: AGENT } },
      member(sessionId)
    );
    expect(auditLogRepo.listBySession(sessionId)[0]!).toMatchObject({
      toolName: 'event.external.subscribe',
      agentName: 'watcher',
      spaceId: SPACE,
    });
  });

  test('denies an agent subject when the caller names another Space', async () => {
    const caller = member(memberSession('s-agent-space'));
    expect(
      await run(
        'event.external.subscribe',
        {
          topicPattern: AGENT_TOPIC,
          spaceId: OTHER_SPACE,
          subject: { type: 'agent', agentId: AGENT },
        },
        caller
      )
    ).toBe('caller_denied');
    expect(agentSubscriptions.listSubscriptions(AGENT)).toEqual([]);
  });
});

describe('node subscriptions optional Space scope', () => {
  test('RPC and internal lists use the trusted caller Space', async () => {
    for (const source of ['rpc', 'internal'] as const) {
      const result = await run(
        'event.external.subscription.list',
        { workflowRunId: RUN },
        { source, spaceId: SPACE }
      );
      expect(
        operations.get('event.external.subscription.list')?.resultSchema.parse(result)
      ).toMatchObject({
        ok: true,
        scope: { spaceId: SPACE },
        subscriptions: { workflowRunId: RUN },
      });
    }
  });
});
