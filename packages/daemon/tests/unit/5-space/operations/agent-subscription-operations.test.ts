import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentSubscriptionRepository } from '../../../../src/storage/repositories/space-agent-subscription-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import {
  type AgentSubscriptionDependencies,
  createAgentSubscriptionOperations,
} from '../../../../src/lib/external-events/agent-subscription-operations';
import type { OperationCaller, OperationDefinition } from '../../../../src/lib/operations/registry';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let agents: SpaceLongHorizonAgentRepository;
let subscriptionRepo: SpaceAgentSubscriptionRepository;
let auditLogRepo: McpAuditLogRepository;
let operations: Map<string, OperationDefinition>;
let refreshed: Array<{ spaceId: string; subscriptionId: string }>;
let removed: Array<{ spaceId: string; subscriptionId: string }>;
let refreshOutcome: { success: boolean; error?: string };
let SPACE: string;
let OTHER_SPACE: string;
let AGENT: string;
let FOREIGN_AGENT: string;

const TOPIC = 'github/acme/widgets/pull_request/*.review_*';

function memberSession(
  id: string,
  options: { status?: 'active' | 'archived'; spaceId?: string } = {}
) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'space_chat',
      status: options.status ?? 'active',
      context: { spaceId: options.spaceId ?? SPACE },
    },
    { enforceWorkspaceOwnership: false }
  );
  return id;
}

function member(
  sessionId: string,
  role: 'ad_hoc_member' | 'long_term_agent' = 'long_term_agent'
): OperationCaller {
  return { source: 'mcp', sessionId, spaceId: SPACE, role, agentName: 'watcher' };
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
    name: 'Home',
    slug: 'home',
    workspacePath: '/repo',
  }).id;
  OTHER_SPACE = new SpaceRepository(db).createSpace({
    name: 'Other',
    slug: 'other',
    workspacePath: '/other',
  }).id;
  agents = new SpaceLongHorizonAgentRepository(db);
  AGENT = agents.create({ spaceId: SPACE, handle: 'watcher' }).id;
  FOREIGN_AGENT = agents.create({ spaceId: OTHER_SPACE, handle: 'outsider' }).id;
  sessions = new SessionRepository(db);
  subscriptionRepo = new SpaceAgentSubscriptionRepository(db, new SpaceAgentRepository(db));
  auditLogRepo = new McpAuditLogRepository(db);
  refreshed = [];
  removed = [];
  refreshOutcome = { success: true };
  const deps: AgentSubscriptionDependencies = {
    subscriptionRepo,
    refreshSubscription: (spaceId, subscriptionId) => {
      refreshed.push({ spaceId, subscriptionId });
      return refreshOutcome;
    },
    removeSubscription: (spaceId, subscriptionId) => {
      removed.push({ spaceId, subscriptionId });
    },
    auditLogRepo,
    getSession: (id) => sessions.getSession(id),
    taskRepo: new SpaceTaskRepository(db),
    longHorizonAgentRepo: agents,
  };
  operations = new Map(
    createAgentSubscriptionOperations(deps).map((operation) => [operation.name, operation])
  );
});

afterEach(() => db.close());

describe('agent external-event subscription operations', () => {
  test('subscribes an agent and returns the stored record', async () => {
    const sessionId = memberSession('s-sub');
    const result = (await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC, label: 'reviews' },
      member(sessionId)
    )) as { subscription: { agentId: string; source: string; topic: string; status: string } };
    expect(result.subscription).toMatchObject({
      agentId: AGENT,
      source: 'github',
      topic: TOPIC,
      status: 'active',
    });
    const stored = subscriptionRepo.listSubscriptions(AGENT);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.filter).toEqual({ label: 'reviews' });
    expect(refreshed).toEqual([{ spaceId: SPACE, subscriptionId: stored[0]!.id }]);
  });

  test('subscribes without a label storing an empty filter', async () => {
    const sessionId = memberSession('s-nolabel');
    const result = (await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC },
      member(sessionId)
    )) as { subscription: { filter: Record<string, unknown> } };
    expect(result.subscription.filter).toEqual({});
  });

  test('upserts an existing route instead of duplicating it', async () => {
    const sessionId = memberSession('s-upsert');
    await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC, label: 'first' },
      member(sessionId)
    );
    await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC, label: 'second' },
      member(sessionId)
    );
    const stored = subscriptionRepo.listSubscriptions(AGENT);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.filter).toEqual({ label: 'second' });
  });

  test('rejects an invalid topic glob without persisting', async () => {
    const sessionId = memberSession('s-invalid');
    expect(
      await run(
        'externalEvent.agent.subscribe',
        { agent_id: AGENT, topic_pattern: 'nosource' },
        member(sessionId)
      )
    ).toBe('invalid_pattern');
    expect(subscriptionRepo.listSubscriptions(AGENT)).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  test('rejects an unknown or cross-space agent', async () => {
    const sessionId = memberSession('s-agent');
    expect(
      await run(
        'externalEvent.agent.subscribe',
        { agent_id: 'agent-none', topic_pattern: TOPIC },
        member(sessionId)
      )
    ).toBe('agent_not_found');
    expect(
      await run(
        'externalEvent.agent.subscribe',
        { agent_id: FOREIGN_AGENT, topic_pattern: TOPIC },
        member(sessionId)
      )
    ).toBe('agent_not_found');
    expect(subscriptionRepo.listSubscriptions(AGENT)).toEqual([]);
  });

  test('reports refresh_failed when the live trie cannot be refreshed', async () => {
    const sessionId = memberSession('s-refresh');
    refreshOutcome = { success: false, error: 'trie unavailable' };
    expect(
      await run(
        'externalEvent.agent.subscribe',
        { agent_id: AGENT, topic_pattern: TOPIC },
        member(sessionId)
      )
    ).toBe('refresh_failed');
    expect(subscriptionRepo.listSubscriptions(AGENT)).toHaveLength(1);
  });

  test('records an audit entry for a mutation', async () => {
    const sessionId = memberSession('s-audit');
    await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC },
      member(sessionId)
    );
    const entries = auditLogRepo.listBySession(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!).toMatchObject({
      toolName: 'externalEvent.agent.subscribe',
      agentName: 'watcher',
      spaceId: SPACE,
    });
    expect(JSON.parse(entries[0]!.paramsSummary!)).toMatchObject({
      agent_id: AGENT,
      topic_pattern: TOPIC,
    });
  });

  test('admits a workflow_worker caller of the same Space', async () => {
    const sessionId = memberSession('s-worker');
    const worker: OperationCaller = {
      source: 'mcp',
      sessionId,
      spaceId: SPACE,
      role: 'workflow_worker',
    };
    const subscribed = (await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC },
      worker
    )) as { subscription: { agentId: string; status: string } };
    expect(subscribed.subscription).toMatchObject({ agentId: AGENT, status: 'active' });
    const listed = (await run(
      'externalEvent.agent.listSubscriptions',
      { agent_id: AGENT },
      worker
    )) as { subscriptions: unknown[] };
    expect(listed.subscriptions).toHaveLength(1);
  });

  test('denies a caller that names another Space', async () => {
    const sessionId = memberSession('s-denied');
    expect(
      await run(
        'externalEvent.agent.subscribe',
        { agent_id: AGENT, topic_pattern: TOPIC, spaceId: OTHER_SPACE },
        member(sessionId)
      )
    ).toBe('caller_denied');
    expect(subscriptionRepo.listSubscriptions(AGENT)).toEqual([]);
  });

  test('rejects a writer whose session is not active in the Space', async () => {
    const sessionId = memberSession('s-inactive', { status: 'archived' });
    expect(
      await run(
        'externalEvent.agent.subscribe',
        { agent_id: AGENT, topic_pattern: TOPIC },
        member(sessionId)
      )
    ).toBe('session_inactive');
    expect(
      await run(
        'externalEvent.agent.unsubscribe',
        { agent_id: AGENT, topic_pattern: TOPIC },
        member(sessionId)
      )
    ).toBe('session_inactive');
    expect(subscriptionRepo.listSubscriptions(AGENT)).toEqual([]);
  });

  test('serves a human RPC caller that passes spaceId explicitly', async () => {
    const caller: OperationCaller = { source: 'rpc', principal: 'human' };
    const result = (await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC, spaceId: SPACE },
      caller
    )) as { subscription: { agentId: string } };
    expect(result.subscription.agentId).toBe(AGENT);
    const listed = (await run(
      'externalEvent.agent.listSubscriptions',
      { agent_id: AGENT, spaceId: SPACE },
      caller
    )) as { subscriptions: Array<{ topic: string }> };
    expect(listed.subscriptions).toHaveLength(1);
    expect(listed.subscriptions[0]!.topic).toBe(TOPIC);
  });

  test('unsubscribes an existing pattern from the store and the trie', async () => {
    const sessionId = memberSession('s-unsub');
    await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC },
      member(sessionId)
    );
    const stored = subscriptionRepo.listSubscriptions(AGENT);
    expect(stored).toHaveLength(1);
    expect(
      await run(
        'externalEvent.agent.unsubscribe',
        { agent_id: AGENT, topic_pattern: TOPIC },
        member(sessionId)
      )
    ).toEqual({ ok: true, topicPattern: TOPIC });
    expect(subscriptionRepo.listSubscriptions(AGENT)).toEqual([]);
    expect(removed).toEqual([{ spaceId: SPACE, subscriptionId: stored[0]!.id }]);
  });

  test('unsubscribing an unknown pattern succeeds without touching the trie', async () => {
    const sessionId = memberSession('s-idempotent');
    await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC },
      member(sessionId)
    );
    const stored = subscriptionRepo.listSubscriptions(AGENT);
    expect(
      await run(
        'externalEvent.agent.unsubscribe',
        { agent_id: AGENT, topic_pattern: 'github/acme/widgets/issues/*' },
        member(sessionId)
      )
    ).toEqual({ ok: true, topicPattern: 'github/acme/widgets/issues/*' });
    expect(subscriptionRepo.listSubscriptions(AGENT)).toHaveLength(1);
    expect(removed).toEqual([]);
    expect(stored).toHaveLength(1);
  });

  test('unsubscribe rejects unknown agents and invalid patterns', async () => {
    const sessionId = memberSession('s-unsub-bad');
    expect(
      await run(
        'externalEvent.agent.unsubscribe',
        { agent_id: FOREIGN_AGENT, topic_pattern: TOPIC },
        member(sessionId)
      )
    ).toBe('agent_not_found');
    expect(
      await run(
        'externalEvent.agent.unsubscribe',
        { agent_id: AGENT, topic_pattern: 'a/**/b' },
        member(sessionId)
      )
    ).toBe('invalid_pattern');
  });

  test('lists the agent subscriptions regardless of session activity', async () => {
    const sessionId = memberSession('s-list');
    await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: TOPIC },
      member(sessionId)
    );
    await run(
      'externalEvent.agent.subscribe',
      { agent_id: AGENT, topic_pattern: 'github/acme/widgets/issues/*' },
      member(sessionId, 'ad_hoc_member')
    );
    const archived = memberSession('s-list-archived', { status: 'archived' });
    const result = (await run(
      'externalEvent.agent.listSubscriptions',
      { agent_id: AGENT },
      member(archived)
    )) as { subscriptions: Array<{ topic: string; source: string; status: string }> };
    expect(result.subscriptions.map((subscription) => subscription.topic).sort()).toEqual([
      'github/acme/widgets/issues/*',
      TOPIC,
    ]);
    expect(result.subscriptions.every((subscription) => subscription.status === 'active')).toBe(
      true
    );
  });

  test('listing rejects unknown or cross-space agents', async () => {
    const sessionId = memberSession('s-list-bad');
    expect(
      await run(
        'externalEvent.agent.listSubscriptions',
        { agent_id: 'agent-none' },
        member(sessionId)
      )
    ).toBe('agent_not_found');
    expect(
      await run(
        'externalEvent.agent.listSubscriptions',
        { agent_id: FOREIGN_AGENT },
        member(sessionId)
      )
    ).toBe('agent_not_found');
  });
});
