import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createAgentOperations } from '../../../../src/lib/agents/operations';
import { admitAgentCaller } from '../../../../src/lib/agents/operation-contracts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { resolveSessionCallerScope } from '../../../../src/lib/space/runtime/space-caller-scope';

let db: Database;
let agentRepo: SpaceLongHorizonAgentRepository;
let spaceId: string;
let otherSpaceId: string;
let agent: SpaceLongHorizonAgent;
let sessions: Map<string, Session>;

const MEMBER_SESSION = 'space:chat:member';
const READ_ONLY_SESSION = 'chat:read-only';

function memberCaller(role: OperationCallerRole = 'ad_hoc_member'): OperationCaller {
  return { source: 'mcp', sessionId: MEMBER_SESSION, spaceId, role };
}

function readOnlyCaller(): OperationCaller {
  const session = sessions.get(READ_ONLY_SESSION) as Session;
  return {
    source: 'mcp',
    sessionId: READ_ONLY_SESSION,
    ...resolveSessionCallerScope(session, { longHorizonAgentRepo: agentRepo }),
  };
}

function sessionRow(overrides: Partial<Session> & { id: string }): Session {
  return {
    title: 'Space chat',
    workspacePath: '/repo',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    type: 'space_chat',
    config: { model: 'm', provider: 'p', maxTokens: 1, temperature: 1 },
    metadata: {},
    context: { spaceId },
    ...overrides,
  } as unknown as Session;
}

function registry() {
  return createOperationRegistry(
    createAgentOperations({
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      longHorizonAgentRepo: agentRepo,
    })
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  agentRepo = new SpaceLongHorizonAgentRepository(db);
  const spaceRepo = new SpaceRepository(db);
  spaceId = spaceRepo.createSpace({ name: 'Home', slug: 'home', workspacePath: '/repo' }).id;
  otherSpaceId = spaceRepo.createSpace({
    name: 'Away',
    slug: 'away',
    workspacePath: '/other',
  }).id;
  agent = agentRepo.create({
    spaceId,
    handle: 'planner',
    displayName: 'Planner',
    instructions: 'Plan the work.',
    autonomyLevel: 2,
    model: 'sonnet',
    provider: 'anthropic',
  });
  agentRepo.create({
    spaceId,
    handle: 'retired',
    displayName: 'Retired',
    status: 'archived',
    instructions: '',
  });
  agentRepo.create({
    spaceId: otherSpaceId,
    handle: 'stranger',
    displayName: 'Stranger',
    instructions: '',
  });
  sessions = new Map([
    [MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION })],
    [
      READ_ONLY_SESSION,
      sessionRow({ id: READ_ONLY_SESSION, type: 'chat', context: {}, metadata: {} }),
    ],
  ]);
});

describe('the agent.list and agent.get operations', () => {
  test('agent.list returns only the caller Space agents', async () => {
    const outcome = await invokeOperation(registry(), 'agent.list', {}, memberCaller());
    expect(outcome.kind).toBe('completed');
    const value = outcome as { kind: 'completed'; value: { agents: SpaceLongHorizonAgent[] } };
    expect(value.value.agents.map((entry) => entry.handle).sort()).toEqual(['planner', 'retired']);
  });

  test('agent.list status filter keeps only agents in that lifecycle state', async () => {
    const outcome = await invokeOperation(
      registry(),
      'agent.list',
      { status: 'archived' },
      memberCaller()
    );
    const value = outcome as { kind: 'completed'; value: { agents: SpaceLongHorizonAgent[] } };
    expect(value.value.agents.map((entry) => entry.handle)).toEqual(['retired']);
  });

  test('agent.list compact drops the instruction and permission fields', async () => {
    const outcome = await invokeOperation(
      registry(),
      'agent.list',
      { compact: true },
      memberCaller()
    );
    const value = outcome as {
      kind: 'completed';
      value: { agents: Array<Record<string, unknown>> };
    };
    const planner = value.value.agents.find((entry) => entry.handle === 'planner');
    expect(planner).toBeDefined();
    expect(Object.keys(planner as Record<string, unknown>).sort()).toEqual([
      'displayName',
      'handle',
      'id',
      'model',
      'provider',
      'status',
      'templateKey',
      'thinkingLevel',
      'updatedAt',
    ]);
  });

  test('a read-only session carries no Space, so it is denied the agent catalog', async () => {
    expect(readOnlyCaller()).toEqual({
      source: 'mcp',
      sessionId: READ_ONLY_SESSION,
      role: 'universal_read',
    });
    const outcome = await invokeOperation(registry(), 'agent.list', { spaceId }, readOnlyCaller());
    expect(outcome).toEqual({
      kind: 'failed',
      code: 'forbidden',
      message: 'Operation agent.list is not available to this caller',
    });
  });

  test('a workflow worker is denied the agent catalog at the door', async () => {
    const outcome = await invokeOperation(
      registry(),
      'agent.list',
      {},
      memberCaller('workflow_worker')
    );
    expect(outcome).toEqual({
      kind: 'failed',
      code: 'forbidden',
      message: 'Operation agent.list is not available to this caller',
    });
  });

  test('the operation itself also denies a workflow worker calling it directly', async () => {
    const operation = registry().get('agent.list');
    const outcome = (await operation?.execute({}, memberCaller('workflow_worker'))) as {
      reason: string;
    };
    expect(outcome.reason).toBe('agent_denied');
  });

  test('an agent caller naming another Space is rejected rather than scoped to it', async () => {
    const outcome = await invokeOperation(
      registry(),
      'agent.list',
      { spaceId: otherSpaceId },
      memberCaller()
    );
    const value = outcome as { kind: 'completed'; value: { reason: string } };
    expect(value.value.reason).toBe('space_mismatch');
  });

  test('a human caller must name the Space', async () => {
    const outcome = await invokeOperation(registry(), 'agent.list', {}, { source: 'rpc' });
    const value = outcome as { kind: 'completed'; value: { reason: string } };
    expect(value.value.reason).toBe('space_required');
  });

  test('a human caller naming the Space reads its agents', async () => {
    const outcome = await invokeOperation(registry(), 'agent.list', { spaceId }, { source: 'rpc' });
    const value = outcome as { kind: 'completed'; value: { agents: SpaceLongHorizonAgent[] } };
    expect(value.value.agents.map((entry) => entry.handle).sort()).toEqual(['planner', 'retired']);
  });

  test('agent.get returns the full record', async () => {
    const outcome = await invokeOperation(
      registry(),
      'agent.get',
      { agentId: agent.id },
      memberCaller()
    );
    const value = outcome as { kind: 'completed'; value: { agent: SpaceLongHorizonAgent } };
    expect(value.value.agent.instructions).toBe('Plan the work.');
    expect(value.value.agent.autonomyLevel).toBe(2);
  });

  test('agent.get treats an agent of another Space as absent', async () => {
    const stranger = agentRepo
      .listBySpaceId(otherSpaceId)
      .find((entry) => entry.handle === 'stranger');
    const outcome = await invokeOperation(
      registry(),
      'agent.get',
      { agentId: stranger!.id },
      memberCaller()
    );
    const value = outcome as { kind: 'completed'; value: { reason: string } };
    expect(value.value.reason).toBe('agent_not_found');
  });
});

describe('admitAgentCaller', () => {
  const deps = () => ({
    getSession: (sessionId: string) => sessions.get(sessionId) ?? null,
    longHorizonAgentRepo: agentRepo,
  });

  test('a mutation from an active member session is admitted', () => {
    expect(admitAgentCaller({}, memberCaller(), deps(), 'mutate')).toEqual({ value: spaceId });
  });

  test('a mutation from an archived session in the owning Space is denied', () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = admitAgentCaller({}, memberCaller(), deps(), 'mutate');
    expect(outcome).toEqual({
      reason: {
        rejected: true,
        reason: 'agent_denied',
        message:
          'Agent operations require a human caller or an active Space member session in the owning Space.',
      },
    });
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(2);
  });

  test('a read-only session may not mutate', () => {
    const outcome = admitAgentCaller({ spaceId }, readOnlyCaller(), deps(), 'mutate');
    expect(outcome).toEqual({
      reason: {
        rejected: true,
        reason: 'agent_denied',
        message:
          'Agent operations require a human caller or an active Space member session in the owning Space.',
      },
    });
  });
});
