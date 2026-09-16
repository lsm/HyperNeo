import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createAgentOperations } from '../../../../src/lib/agents/operations';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

let db: Database;
let agentRepo: SpaceLongHorizonAgentRepository;
let spaceId: string;
let sessions: Map<string, Session>;
let published: string[];
let audited: Array<{ name: string; summary: Record<string, unknown> }>;

const MEMBER_SESSION = 'space:chat:member';

function memberCaller(
  role: OperationCallerRole = 'ad_hoc_member',
  agentId?: string
): OperationCaller {
  return { source: 'mcp', sessionId: MEMBER_SESSION, spaceId, role, agentId };
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
      publishAgentCreated: (agent) => published.push(agent.id),
      audit: (name, summary) => audited.push({ name, summary }),
    })
  );
}

async function create(input: Record<string, unknown>, caller: OperationCaller = memberCaller()) {
  return invokeOperation(registry(), 'agent.create', input, caller);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  agentRepo = new SpaceLongHorizonAgentRepository(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Home',
    slug: 'home',
    workspacePath: '/repo',
  }).id;
  sessions = new Map([[MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION })]]);
  published = [];
  audited = [];
});

describe('the agent.create operation', () => {
  test('creates the agent, slugifies its handle, and announces it', async () => {
    const outcome = await create({ name: 'Release Captain', description: 'Ships things' });
    const value = outcome as { kind: 'completed'; value: { agent: SpaceLongHorizonAgent } };
    expect(value.value.agent.handle).toBe('release-captain');
    expect(value.value.agent.displayName).toBe('Release Captain');
    expect(value.value.agent.spaceId).toBe(spaceId);
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(1);
    expect(published).toEqual([value.value.agent.id]);
    expect(audited).toEqual([
      { name: 'agent.create', summary: { name: 'Release Captain', tools: undefined } },
    ]);
  });

  test('a tool allowlist lands in toolPermissions', async () => {
    const outcome = await create({ name: 'Reader', tools: ['Read'] });
    const value = outcome as { kind: 'completed'; value: { agent: SpaceLongHorizonAgent } };
    expect(value.value.agent.toolPermissions).toEqual({ tools: ['Read'] });
  });

  test('an unknown tool is rejected and nothing is written', async () => {
    const outcome = await create({ name: 'Reader', tools: ['Telepathy'] });
    const value = outcome as { kind: 'completed'; value: { reason: string; message: string } };
    expect(value.value.reason).toBe('invalid_tools');
    expect(value.value.message).toContain('Telepathy');
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(0);
    expect(published).toEqual([]);
  });

  test('a blank name is rejected', async () => {
    const outcome = await create({ name: '   ' });
    const value = outcome as { kind: 'completed'; value: { reason: string } };
    expect(value.value.reason).toBe('invalid_name');
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(0);
  });

  test('a name already used by a live agent is rejected', async () => {
    await create({ name: 'Planner' });
    const outcome = await create({ name: 'planner' });
    const value = outcome as { kind: 'completed'; value: { reason: string } };
    expect(value.value.reason).toBe('invalid_name');
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(1);
  });

  test('a name freed by an archived agent may be reused', async () => {
    agentRepo.create({
      spaceId,
      handle: 'planner',
      displayName: 'Planner',
      status: 'archived',
      instructions: '',
    });
    const outcome = await create({ name: 'Planner' });
    const value = outcome as { kind: 'completed'; value: { agent: SpaceLongHorizonAgent } };
    expect(value.value.agent.displayName).toBe('Planner');
    expect(value.value.agent.handle).not.toBe('planner');
  });

  test('the new agent inherits the calling agent autonomy ceiling', async () => {
    const owner = agentRepo.create({
      spaceId,
      handle: 'owner',
      displayName: 'Owner',
      instructions: '',
      autonomyLevel: 4,
    });
    const outcome = await create({ name: 'Delegate' }, memberCaller('long_term_agent', owner.id));
    const value = outcome as { kind: 'completed'; value: { agent: SpaceLongHorizonAgent } };
    expect(value.value.agent.autonomyLevel).toBe(4);
  });

  test('a human caller creates without an autonomy ceiling', async () => {
    const outcome = await invokeOperation(
      registry(),
      'agent.create',
      { spaceId, name: 'Delegate' },
      { source: 'rpc' }
    );
    const value = outcome as { kind: 'completed'; value: { agent: SpaceLongHorizonAgent } };
    expect(value.value.agent.autonomyLevel).toBeNull();
  });

  test('a read-only session is refused at the door', async () => {
    const outcome = await create({ name: 'Planner' }, memberCaller('universal_read'));
    expect(outcome).toEqual({
      kind: 'failed',
      code: 'forbidden',
      message: 'Operation agent.create is not available to this caller',
    });
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(0);
  });

  test('the operation itself also denies a read-only session calling it directly', async () => {
    const operation = registry().get('agent.create');
    const outcome = (await operation?.execute(
      { name: 'Planner' },
      memberCaller('universal_read')
    )) as { reason: string };
    expect(outcome.reason).toBe('agent_denied');
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(0);
  });

  test('an archived session in the owning Space may not create agents', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await create({ name: 'Planner' });
    const value = outcome as { kind: 'completed'; value: { reason: string } };
    expect(value.value.reason).toBe('agent_denied');
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(0);
    expect(published).toEqual([]);
  });
});
