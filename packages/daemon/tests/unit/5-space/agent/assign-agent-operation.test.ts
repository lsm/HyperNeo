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
let memberAgentId: string;
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
    metadata: { promptProvenance: { source: 'test', hash: 'h', agentId: memberAgentId } },
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
        getReminder: () => null,
        cancelReminder: () => false,
        createReminder: () => {
          throw new Error('reminders are not exercised by this suite');
        },
        listReminders: () => [],
      },
      goalScopeRepo,
      getGoalSpace: (goalId) => readSpaceId('space_goals', goalId),
      getEvolutionScopeSpace: (scopeId) => readSpaceId('evolution_scopes', scopeId),
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
  memberAgentId = agentRepo.create({ spaceId, handle: 'member', sessionId: MEMBER_SESSION }).id;
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

describe('goal.owner.set admission', () => {
  test('a long-term agent with an active identity takes goal ownership', async () => {
    const outcome = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value).toEqual({ accepted: true, assigned: true });
    expect(agentRepo.listGoals(agent.id).map((entry) => entry.goalId)).toEqual([GOAL_ID]);
    expect(ownerChanges).toEqual([GOAL_ID]);
  });

  test('a human caller takes goal ownership without a Space agent identity', async () => {
    const outcome = await run(
      'goal.owner.set',
      { spaceId, agentId: agent.id, goalId: GOAL_ID, assigned: true },
      {
        source: 'rpc',
      }
    );
    expect(outcome.value).toEqual({ accepted: true, assigned: true });
    expect(agentRepo.listGoals(agent.id)).toHaveLength(1);
  });

  test('a caller presenting no agent identity may reassign goal ownership', async () => {
    const outcome = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
      caller('long_term_agent')
    );
    expect(outcome.value).toEqual({ accepted: true, assigned: true });
    expect(agentRepo.listGoals(agent.id).map((entry) => entry.goalId)).toEqual([GOAL_ID]);
  });

  test('any caller presenting an agent identity from another Space is denied', async () => {
    const stranger = agentRepo.create({
      spaceId: otherSpace(),
      handle: 'stranger',
      displayName: 'Stranger',
      instructions: '',
    });
    const outcome = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
      caller('long_term_agent', stranger.id)
    );
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('a caller whose own agent record is paused may not reassign ownership', async () => {
    agentRepo.update(agent.id, { status: 'paused' });
    const outcome = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('a goal in another Space is not found', async () => {
    seedGoal('goal-elsewhere', otherSpace());
    const outcome = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: 'goal-elsewhere', assigned: true },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value?.reason).toBe('goal_not_found');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('dropping the owner relationship reports assigned false', async () => {
    await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
      caller('long_term_agent', agent.id)
    );
    const outcome = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: false },
      caller('long_term_agent', agent.id)
    );
    expect(outcome.value).toEqual({ accepted: true, assigned: false });
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('an archived session in the owning Space may not reassign ownership', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
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
      'goal.owner.set',
      { spaceId, agentId: agent.id, goalId: GOAL_ID, assigned: true },
      readOnlyCaller()
    );
    expect(outcome.kind).toBe('completed');
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });
});

describe('evolution.scope.owner.set admission', () => {
  test('a Space agent may assign a Forge scope', async () => {
    const outcome = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: true },
      caller('long_term_agent')
    );
    expect(outcome.value).toEqual({ accepted: true, assigned: true });
    expect(agentRepo.listEvolutionScopes(agent.id).map((entry) => entry.scopeId)).toEqual([
      SCOPE_ID,
    ]);
  });

  test('assigning a Forge scope announces no goal ownership change', async () => {
    await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: true },
      caller('long_term_agent')
    );
    expect(ownerChanges).toEqual([]);
  });

  test('a scope in another Space is not found', async () => {
    seedScope('scope-elsewhere', otherSpace());
    const outcome = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: 'scope-elsewhere', assigned: true },
      caller('long_term_agent')
    );
    expect(outcome.value?.reason).toBe('scope_not_found');
    expect(agentRepo.listEvolutionScopes(agent.id)).toHaveLength(0);
  });

  test('dropping the scope routing reports assigned false', async () => {
    await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: true },
      caller('long_term_agent')
    );
    const outcome = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: false },
      caller('long_term_agent')
    );
    expect(outcome.value).toEqual({ accepted: true, assigned: false });
    expect(agentRepo.listEvolutionScopes(agent.id)).toHaveLength(0);
  });

  test('an archived session in the owning Space may not assign a Forge scope', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: true },
      caller('long_term_agent')
    );
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listEvolutionScopes(agent.id)).toHaveLength(0);
  });

  test('an agent of another Space is not found', async () => {
    const stranger = agentRepo.create({
      spaceId: otherSpace(),
      handle: 'stranger',
      displayName: 'Stranger',
      instructions: '',
    });
    const outcome = await run(
      'evolution.scope.owner.set',
      { agentId: stranger.id, scopeId: SCOPE_ID, assigned: true },
      caller('long_term_agent')
    );
    expect(outcome.value?.reason).toBe('agent_not_found');
    expect(agentRepo.listEvolutionScopes(stranger.id)).toHaveLength(0);
  });
});

describe('the goal.owner.set and evolution.scope.owner.set operations', () => {
  test('assigned reports the resulting state in both directions', async () => {
    const assigned = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
      caller('long_term_agent', agent.id)
    );
    expect(assigned.value).toEqual({ accepted: true, assigned: true });
    expect(agentRepo.listGoals(agent.id)).toHaveLength(1);

    const dropped = await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: false },
      caller('long_term_agent', agent.id)
    );
    expect(dropped.value).toEqual({ accepted: true, assigned: false });
    expect(agentRepo.listGoals(agent.id)).toHaveLength(0);
  });

  test('setting a goal owner announces the ownership change either way', async () => {
    await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: true },
      caller('long_term_agent', agent.id)
    );
    await run(
      'goal.owner.set',
      { agentId: agent.id, goalId: GOAL_ID, assigned: false },
      caller('long_term_agent', agent.id)
    );
    expect(ownerChanges).toHaveLength(2);
  });

  test('scope owner set routes and stops routing, and announces no goal change', async () => {
    const routed = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: true },
      caller('long_term_agent')
    );
    expect(routed.value).toEqual({ accepted: true, assigned: true });
    expect(agentRepo.listEvolutionScopes(agent.id).map((entry) => entry.scopeId)).toEqual([
      SCOPE_ID,
    ]);

    const stopped = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: false },
      caller('long_term_agent')
    );
    expect(stopped.value).toEqual({ accepted: true, assigned: false });
    expect(agentRepo.listEvolutionScopes(agent.id)).toHaveLength(0);
    expect(ownerChanges).toEqual([]);
  });

  test('dropping an assignment that is not there succeeds', async () => {
    const outcome = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: SCOPE_ID, assigned: false },
      caller('long_term_agent')
    );
    expect(outcome.value).toEqual({ accepted: true, assigned: false });
  });

  test('the target gates still apply to the merged door', async () => {
    seedScope('scope-elsewhere', otherSpace());
    const outcome = await run(
      'evolution.scope.owner.set',
      { agentId: agent.id, scopeId: 'scope-elsewhere', assigned: true },
      caller('long_term_agent')
    );
    expect(outcome.value?.reason).toBe('scope_not_found');
  });
});
