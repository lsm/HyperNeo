import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { invokeOperationFromHandler } from '../../../../src/lib/operations/handler-invoker';
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
let operations: Map<string, OperationDefinition>;
let SPACE: string;
let OTHER_SPACE: string;
let AGENT: string;
let FOREIGN_AGENT: string;

const TOPIC = 'github/acme/widgets/pull_request/*.review_*';
const LIST = 'externalEvent.agent.listSubscriptions';

function seed(topic: string) {
  return subscriptionRepo.upsertSubscription({
    spaceId: SPACE,
    agentId: AGENT,
    source: topic.split('/')[0] ?? '',
    topic,
    filter: {},
    status: 'active',
  });
}

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
  const deps: AgentSubscriptionDependencies = {
    subscriptionRepo,
    refreshSubscription: () => ({ success: true }),
    removeSubscription: () => {},
    auditLogRepo: new McpAuditLogRepository(db),
    getSession: (id) => sessions.getSession(id),
    taskRepo: new SpaceTaskRepository(db),
    longHorizonAgentRepo: agents,
  };
  operations = new Map(
    createAgentSubscriptionOperations(deps).map((operation) => [operation.name, operation])
  );
});

afterEach(() => db.close());

describe('agent external-event subscription listing', () => {
  test('lists the agent subscriptions regardless of session activity', async () => {
    seed(TOPIC);
    seed('github/acme/widgets/issues/*');
    const archived = memberSession('s-list-archived', { status: 'archived' });
    const result = (await run(LIST, { agent_id: AGENT }, member(archived, 'ad_hoc_member'))) as {
      subscriptions: Array<{ topic: string; source: string; status: string }>;
    };
    expect(result.subscriptions.map((subscription) => subscription.topic).sort()).toEqual([
      'github/acme/widgets/issues/*',
      TOPIC,
    ]);
    expect(result.subscriptions.every((subscription) => subscription.status === 'active')).toBe(
      true
    );
  });

  test('admits a workflow_worker caller of the same Space', async () => {
    seed(TOPIC);
    const worker: OperationCaller = {
      source: 'mcp',
      sessionId: memberSession('s-worker'),
      spaceId: SPACE,
      role: 'workflow_worker',
    };
    const listed = (await run(LIST, { agent_id: AGENT }, worker)) as { subscriptions: unknown[] };
    expect(listed.subscriptions).toHaveLength(1);
  });

  test('serves a human RPC caller that passes spaceId explicitly', async () => {
    seed(TOPIC);
    const listed = (await run(
      LIST,
      { agent_id: AGENT, spaceId: SPACE },
      {
        source: 'rpc',
        principal: 'human',
      }
    )) as { subscriptions: Array<{ topic: string }> };
    expect(listed.subscriptions).toHaveLength(1);
    expect(listed.subscriptions[0]!.topic).toBe(TOPIC);
  });

  test('rejects unknown or cross-space agents', async () => {
    const sessionId = memberSession('s-list-bad');
    expect(await run(LIST, { agent_id: 'agent-none' }, member(sessionId))).toEqual({
      accepted: false,
      reason: 'agent_not_found',
    });
    expect(await run(LIST, { agent_id: FOREIGN_AGENT }, member(sessionId))).toEqual({
      accepted: false,
      reason: 'agent_not_found',
    });
  });
});

describe('agent subscriptions optional Space scope', () => {
  test('empty RPC and internal lists name the inherited Space', async () => {
    for (const source of ['rpc', 'internal'] as const) {
      const result = await run(LIST, { agent_id: AGENT }, { source, spaceId: SPACE });
      expect(operations.get(LIST)?.resultSchema.parse(result)).toEqual({
        subscriptions: [],
        scope: { spaceId: SPACE },
      });
    }
  });
});

test(`${LIST} exposes a recognized rejection through the operation door`, async () => {
  const input = { agent_id: AGENT };
  const outcome = await invokeOperation(operations, LIST, input, { source: 'rpc' });
  expect(outcome).toEqual({
    kind: 'completed',
    value: { accepted: false, reason: 'caller_denied' },
  });
  const mcp = createOperationMcpHandler(operations, () => ({ role: 'workflow_worker' }));
  const response = await mcp({ name: LIST, input });
  expect(response.isError).toBeUndefined();
  expect(JSON.parse(response.content[0].text)).toEqual(
    outcome.kind === 'completed' ? outcome.value : null
  );
  await expect(invokeOperationFromHandler(operations, LIST, input)).rejects.toThrow(
    `Operation ${LIST} was rejected without a message`
  );
});
