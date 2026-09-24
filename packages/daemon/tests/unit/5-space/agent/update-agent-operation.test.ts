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
let memberAgentId: string;
let agent: SpaceLongHorizonAgent;
let sessions: Map<string, Session>;
let updated: string[];
let clearedProviders: string[];
let refreshOutcome: { success: boolean; error?: string };

const MEMBER_SESSION = 'space:chat:member';

function memberCaller(role: OperationCallerRole = 'long_term_agent'): OperationCaller {
  return { source: 'mcp', sessionId: MEMBER_SESSION, spaceId, role };
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
    metadata: { promptProvenance: { source: 'test', hash: 'h', agentId: memberAgentId } },
    context: { spaceId },
    ...overrides,
  } as unknown as Session;
}

function registry() {
  return createOperationRegistry(
    createAgentOperations({
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      longHorizonAgentRepo: agentRepo,
      reminderRepo: {
        getReminder: () => null,
        cancelReminder: () => false,
        createReminder: () => {
          throw new Error('reminders are not exercised by this suite');
        },
        listReminders: () => [],
      },
      publishAgentCreated: () => {},
      publishAgentUpdated: (record) => updated.push(record.id),
      refreshAgentSubscriptions: () => refreshOutcome,
      clearAgentSessionProvider: async (_space, agentId) => {
        clearedProviders.push(agentId);
      },
      audit: () => {},
    })
  );
}

async function run(
  name: string,
  input: Record<string, unknown>,
  caller: OperationCaller = memberCaller()
) {
  const outcome = await invokeOperation(registry(), name, input, caller);
  return outcome as { kind: string; value: Record<string, unknown> };
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
  agent = agentRepo.create({
    spaceId,
    handle: 'planner',
    displayName: 'Planner',
    instructions: 'Plan.',
    model: 'sonnet',
    provider: 'anthropic',
  });
  memberAgentId = agentRepo.create({ spaceId, handle: 'member', sessionId: MEMBER_SESSION }).id;
  sessions = new Map([[MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION })]]);
  updated = [];
  clearedProviders = [];
  refreshOutcome = { success: true };
});

describe('the agent.update operation', () => {
  test('renames the agent and announces the change', async () => {
    const outcome = await run('agent.update', { agentId: agent.id, name: 'Chief Planner' });
    expect((outcome.value.agent as SpaceLongHorizonAgent).displayName).toBe('Chief Planner');
    expect(agentRepo.getById(agent.id)?.displayName).toBe('Chief Planner');
    expect(updated).toEqual([agent.id]);
  });

  test('an omitted field is left untouched', async () => {
    await run('agent.update', { agentId: agent.id, name: 'Chief Planner' });
    expect(agentRepo.getById(agent.id)?.model).toBe('sonnet');
  });

  test('a null prompt clears the instructions to empty rather than null', async () => {
    await run('agent.update', { agentId: agent.id, customPrompt: null });
    expect(agentRepo.getById(agent.id)?.instructions).toBe('');
  });

  test('tools set to null clears the allowlist', async () => {
    agentRepo.update(agent.id, { toolPermissions: { tools: ['Read'] } });
    await run('agent.update', { agentId: agent.id, tools: null });
    expect(agentRepo.getById(agent.id)?.toolPermissions).toEqual({});
  });

  test('clearing the provider also clears it from the live session', async () => {
    await run('agent.update', { agentId: agent.id, provider: null });
    expect(clearedProviders).toEqual([agent.id]);
  });

  test('a name already held by a live peer is rejected', async () => {
    agentRepo.create({ spaceId, handle: 'rival', displayName: 'Rival', instructions: '' });
    const outcome = await run('agent.update', { agentId: agent.id, name: 'Rival' });
    expect(outcome.value.reason).toBe('invalid_name');
    expect(agentRepo.getById(agent.id)?.displayName).toBe('Planner');
  });

  test('an agent may keep its own name', async () => {
    const outcome = await run('agent.update', { agentId: agent.id, name: 'Planner' });
    expect((outcome.value.agent as SpaceLongHorizonAgent).displayName).toBe('Planner');
  });

  test('reviving an archived agent re-checks its name against live peers', async () => {
    agentRepo.update(agent.id, { status: 'archived' });
    agentRepo.create({ spaceId, handle: 'planner-2', displayName: 'Planner', instructions: '' });
    const outcome = await run('agent.update', { agentId: agent.id, status: 'active' });
    expect(outcome.value.reason).toBe('invalid_name');
    expect(agentRepo.getById(agent.id)?.status).toBe('archived');
  });

  test('status paused parks the agent without touching its configuration', async () => {
    const outcome = await run('agent.update', { agentId: agent.id, status: 'paused' });
    expect((outcome.value.agent as SpaceLongHorizonAgent).status).toBe('paused');
    expect(agentRepo.getById(agent.id)?.instructions).toBe('Plan.');
    expect(agentRepo.getById(agent.id)?.model).toBe('sonnet');
  });

  test('status active revives a paused agent', async () => {
    await run('agent.update', { agentId: agent.id, status: 'paused' });
    const outcome = await run('agent.update', { agentId: agent.id, status: 'active' });
    expect((outcome.value.agent as SpaceLongHorizonAgent).status).toBe('active');
    expect(agentRepo.getById(agent.id)?.status).toBe('active');
  });

  test('status archived frees the display name for a new agent', async () => {
    const archived = await run('agent.update', { agentId: agent.id, status: 'archived' });
    expect((archived.value.agent as SpaceLongHorizonAgent).status).toBe('archived');
    const outcome = await run('agent.create', { name: 'Planner' });
    expect((outcome.value.agent as SpaceLongHorizonAgent).displayName).toBe('Planner');
  });

  test('an unknown tool is rejected and nothing is written', async () => {
    const outcome = await run('agent.update', { agentId: agent.id, tools: ['Telepathy'] });
    expect(outcome.value.reason).toBe('invalid_tools');
    expect(agentRepo.getById(agent.id)?.toolPermissions).toEqual({});
  });

  test('an agent of another Space is not found', async () => {
    const otherSpaceId = new SpaceRepository(db).createSpace({
      name: 'Away',
      slug: 'away',
      workspacePath: '/other',
    }).id;
    const stranger = agentRepo.create({
      spaceId: otherSpaceId,
      handle: 'stranger',
      displayName: 'Stranger',
      instructions: '',
    });
    const outcome = await run('agent.update', { agentId: stranger.id, name: 'Renamed' });
    expect(outcome.value.reason).toBe('agent_not_found');
    expect(agentRepo.getById(stranger.id)?.displayName).toBe('Stranger');
  });

  test('a failed subscription reload is reported instead of being swallowed', async () => {
    refreshOutcome = { success: false, error: 'bad pattern' };
    const outcome = await run('agent.update', { agentId: agent.id, name: 'Chief' });
    expect(outcome.value).toEqual({
      rejected: true,
      reason: 'runtime_refresh_failed',
      message: 'bad pattern',
    });
    expect(updated).toEqual([]);
  });

  test('a read-only session with an active Space session updates the agent', async () => {
    const outcome = await run(
      'agent.update',
      { agentId: agent.id, name: 'Chief' },
      memberCaller('universal_read')
    );
    expect(outcome.kind).toBe('completed');
    expect((outcome.value.agent as SpaceLongHorizonAgent).displayName).toBe('Chief');
    expect(agentRepo.getById(agent.id)?.displayName).toBe('Chief');
  });

  test('an archived session in the owning Space may not update an agent', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await run('agent.update', { agentId: agent.id, name: 'Chief' });
    expect(outcome.value.reason).toBe('agent_denied');
    expect(agentRepo.getById(agent.id)?.displayName).toBe('Planner');
    expect(updated).toEqual([]);
  });
});
