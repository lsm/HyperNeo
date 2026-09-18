import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceAgentGoalScopeRepository } from '../../../../src/storage/repositories/space-agent-goal-scope-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { createAgentOperations } from '../../../../src/lib/agents/operations';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { resolveSessionCallerScope } from '../../../../src/lib/space/runtime/space-caller-scope';

let db: Database;
let agentRepo: SpaceLongHorizonAgentRepository;
let goalScopeRepo: SpaceAgentGoalScopeRepository;
let spaceId: string;
let agent: SpaceLongHorizonAgent;
let sessions: Map<string, Session>;
let ownerChanges: string[];

const MEMBER_SESSION = 'space:chat:member';
const READ_ONLY_SESSION = 'chat:read-only';
const GOAL_ID = 'goal-1';
const SCOPE_ID = 'scope-1';

function caller(role: OperationCallerRole, agentId?: string): OperationCaller {
  return { source: 'mcp', sessionId: MEMBER_SESSION, spaceId, role, agentId };
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

function readSpaceId(table: 'space_goals' | 'evolution_scopes', id: string): string | null {
  const row = db.prepare(`SELECT space_id FROM ${table} WHERE id = ?`).get(id) as
    | { space_id: string }
    | undefined;
  return row?.space_id ?? null;
}

function seedGoal(id: string, owningSpaceId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_goals (id, space_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, owningSpaceId, 'Ship it', now, now);
}

function seedScope(id: string, owningSpaceId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO evolution_scopes (id, space_id, kind, name, objective, created_at, updated_at)
       VALUES (?, ?, 'project', ?, ?, ?, ?)`
  ).run(id, owningSpaceId, 'Scope', 'Improve', now, now);
}

function otherSpace(): string {
  return (
    new SpaceRepository(db).getSpaceBySlug?.('away')?.id ??
    new SpaceRepository(db).createSpace({ name: 'Away', slug: 'away', workspacePath: '/other' }).id
  );
}

function registry() {
  return createOperationRegistry(
    createAgentOperations({
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      longHorizonAgentRepo: agentRepo,
      reminderRepo: {
        createReminder: () => {
          throw new Error('reminders are not exercised by this suite');
        },
        listReminders: () => [],
      },
      goalScopeRepo,
      getGoalSpace: (goalId) => readSpaceId('space_goals', goalId),
      getForgeScopeSpace: (scopeId) => readSpaceId('evolution_scopes', scopeId),
      publishGoalOwnerChanged: (_space, goalId) => ownerChanges.push(goalId),
      publishAgentCreated: () => {},
      publishAgentUpdated: () => {},
      refreshAgentSubscriptions: () => ({ success: true }),
      clearAgentSessionProvider: async () => {},
      audit: () => {},
    })
  );
}

async function run(name: string, input: Record<string, unknown>, who: OperationCaller) {
  const outcome = await invokeOperation(registry(), name, input, who);
  return outcome as { kind: string; code?: string; value?: Record<string, unknown> };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  agentRepo = new SpaceLongHorizonAgentRepository(db);
  goalScopeRepo = new SpaceAgentGoalScopeRepository(db, new SpaceAgentRepository(db));
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Home',
    slug: 'home',
    workspacePath: '/repo',
  }).id;
  agent = agentRepo.create({
    spaceId,
    handle: 'planner',
    displayName: 'Planner',
    instructions: '',
  });
  sessions = new Map([
    [MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION })],
    [
      READ_ONLY_SESSION,
      sessionRow({ id: READ_ONLY_SESSION, type: 'chat', context: {}, metadata: {} }),
    ],
  ]);
  seedGoal(GOAL_ID, spaceId);
  seedScope(SCOPE_ID, spaceId);
  ownerChanges = [];
});

describe('the agent.assignGoal and agent.unassignGoal operations', () => {
  test('a long-term agent with an active identity takes goal ownership', async () => {
    const outcome = await run(
      'agent.assignGoal',
      { agentId: agent.id, goalId: GOAL_ID },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value).toEqual({ assigned: true });
    expect(agentRepo.listGoals(agent.id).map((entry) => entry.goalId)).toEqual([GOAL_ID]);
    expect(ownerChanges).toEqual([GOAL_ID]);
  });

  test('a human caller takes goal ownership without a Space agent identity', async () => {
    const outcome = await run(
      'agent.assignGoal',
      { spaceId, agentId: agent.id, goalId: GOAL_ID },
      {
        source: 'rpc',
      }
    );
    expect(outcome.value).toEqual({ assigned: true });
    expect(agentRepo.listGoals(agent.id)).toHaveLength(1);
  });

  test('an ad-hoc member session may not reassign goal ownership', async () => {
    const outcome = await run(
      'agent.assignGoal',
      { agentId: agent.id, goalId: GOAL_ID },
      caller('ad_hoc_member')
    );
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('a long-term agent whose own record is paused may not reassign ownership', async () => {
    agentRepo.update(agent.id, { status: 'paused' });
    const outcome = await run(
      'agent.assignGoal',
      { agentId: agent.id, goalId: GOAL_ID },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('a goal in another Space is not found', async () => {
    seedGoal('goal-elsewhere', otherSpace());
    const outcome = await run(
      'agent.assignGoal',
      { agentId: agent.id, goalId: 'goal-elsewhere' },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value?.reason).toBe('goal_not_found');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('agent.unassignGoal drops the owner relationship', async () => {
    await run(
      'agent.assignGoal',
      { agentId: agent.id, goalId: GOAL_ID },
      caller('long_term_agent', agent.id)
    );
    const outcome = await run(
      'agent.unassignGoal',
      { agentId: agent.id, goalId: GOAL_ID },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value).toEqual({ assigned: true });
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('an archived session in the owning Space may not reassign ownership', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await run(
      'agent.assignGoal',
      { agentId: agent.id, goalId: GOAL_ID },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
    expect(ownerChanges).toEqual([]);
  });

  test('a session carrying no Space is refused by admitAgentCaller inside the operation', async () => {
    expect(readOnlyCaller()).toEqual({
      source: 'mcp',
      sessionId: READ_ONLY_SESSION,
      role: 'universal_read',
    });
    const outcome = await run(
      'agent.assignGoal',
      { spaceId, agentId: agent.id, goalId: GOAL_ID },
      readOnlyCaller()
    );
    expect(outcome.kind).toBe('completed');
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });
});

describe('the agent.assignForgeScope and agent.unassignForgeScope operations', () => {
  test('an ad-hoc member may assign a Forge scope, unlike goal ownership', async () => {
    const outcome = await run(
      'agent.assignForgeScope',
      { agentId: agent.id, scopeId: SCOPE_ID },
      caller('ad_hoc_member')
    );
    expect(outcome.value).toEqual({ assigned: true });
    expect(agentRepo.listForgeScopes(agent.id).map((entry) => entry.scopeId)).toEqual([SCOPE_ID]);
  });

  test('assigning a Forge scope announces no goal ownership change', async () => {
    await run(
      'agent.assignForgeScope',
      { agentId: agent.id, scopeId: SCOPE_ID },
      caller('ad_hoc_member')
    );
    expect(ownerChanges).toEqual([]);
  });

  test('a scope in another Space is not found', async () => {
    seedScope('scope-elsewhere', otherSpace());
    const outcome = await run(
      'agent.assignForgeScope',
      { agentId: agent.id, scopeId: 'scope-elsewhere' },
      caller('ad_hoc_member')
    );
    expect(outcome.value?.reason).toBe('scope_not_found');
    expect(agentRepo.listForgeScopes(agent.id)).toHaveLength(0);
  });

  test('agent.unassignForgeScope removes the assignment', async () => {
    await run(
      'agent.assignForgeScope',
      { agentId: agent.id, scopeId: SCOPE_ID },
      caller('ad_hoc_member')
    );
    const outcome = await run(
      'agent.unassignForgeScope',
      { agentId: agent.id, scopeId: SCOPE_ID },
      caller('ad_hoc_member')
    );
    expect(outcome.value).toEqual({ assigned: true });
    expect(agentRepo.listForgeScopes(agent.id)).toHaveLength(0);
  });

  test('an archived session in the owning Space may not assign a Forge scope', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await run(
      'agent.assignForgeScope',
      { agentId: agent.id, scopeId: SCOPE_ID },
      caller('ad_hoc_member')
    );
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listForgeScopes(agent.id)).toHaveLength(0);
  });

  test('an agent of another Space is not found', async () => {
    const stranger = agentRepo.create({
      spaceId: otherSpace(),
      handle: 'stranger',
      displayName: 'Stranger',
      instructions: '',
    });
    const outcome = await run(
      'agent.assignForgeScope',
      { agentId: stranger.id, scopeId: SCOPE_ID },
      caller('ad_hoc_member')
    );
    expect(outcome.value?.reason).toBe('agent_not_found');
    expect(agentRepo.listForgeScopes(stranger.id)).toHaveLength(0);
  });
});
