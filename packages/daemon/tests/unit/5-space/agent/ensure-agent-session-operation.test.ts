import type { EnsureAgentSessionOutcome } from '../../../../src/lib/session/ensure-agent-session';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createAgentOperations } from '../../../../src/lib/agents/operations';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

let db: Database;
let agentRepo: SpaceLongHorizonAgentRepository;
let spaceId: string;
let agent: SpaceLongHorizonAgent;
let sessions: Map<string, Session>;
let ensureCalls: Array<{ spaceId: string; agentId: string }>;
let ensureOutcome: EnsureAgentSessionOutcome;
let ensureFault: Error | undefined;

const MEMBER_SESSION = 'space:chat:member';

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
      reminderRepo: {
        createReminder: () => {
          throw new Error('reminders are not exercised by this suite');
        },
        listReminders: () => [],
      },
      ensureAgentSession: async (space, agentId) => {
        ensureCalls.push({ spaceId: space, agentId });
        if (ensureFault) throw ensureFault;
        return ensureOutcome;
      },
    })
  );
}

async function ensureSession(input: Record<string, unknown>, caller: OperationCaller) {
  const outcome = await invokeOperation(registry(), 'agent.ensureSession', input, caller);
  return outcome as { kind: string; value?: Record<string, unknown> };
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
    handle: 'task-manager',
    displayName: 'Task Manager',
    instructions: '',
  });
  sessions = new Map([[MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION })]]);
  ensureCalls = [];
  ensureFault = undefined;
  ensureOutcome = { getSessionData: () => ({ status: 'active' }) };
});

describe('the agent.ensureSession operation', () => {
  test('a human caller opens the first session of an agent that has never run', async () => {
    expect(agentRepo.getById(agent.id)?.sessionId).toBeNull();

    const outcome = await ensureSession({ spaceId, agentId: agent.id }, { source: 'rpc' });

    expect(outcome.value).toEqual({ sessionId: longTermAgentSessionId(spaceId, agent.id) });
    expect(ensureCalls).toEqual([{ spaceId, agentId: agent.id }]);
  });

  test('a second call returns the same session id for the same agent', async () => {
    const first = await ensureSession({ spaceId, agentId: agent.id }, { source: 'rpc' });
    const second = await ensureSession({ spaceId, agentId: agent.id }, { source: 'rpc' });

    expect(second.value).toEqual(first.value as Record<string, unknown>);
    expect(ensureCalls).toHaveLength(2);
  });

  test('an agent session caller acts in its own Space without naming it', async () => {
    const outcome = await ensureSession(
      { agentId: agent.id },
      { source: 'mcp', sessionId: MEMBER_SESSION, spaceId, role: 'ad_hoc_member' }
    );

    expect(outcome.value).toEqual({ sessionId: longTermAgentSessionId(spaceId, agent.id) });
  });

  test('an agent belonging to another Space is not found', async () => {
    const away = new SpaceRepository(db).createSpace({
      name: 'Away',
      slug: 'away',
      workspacePath: '/other',
    }).id;
    const stranger = agentRepo.create({
      spaceId: away,
      handle: 'stranger',
      displayName: 'Stranger',
      instructions: '',
    });

    const outcome = await ensureSession({ spaceId, agentId: stranger.id }, { source: 'rpc' });

    expect(outcome.value).toMatchObject({ rejected: true, reason: 'agent_not_found' });
    expect(ensureCalls).toEqual([]);
  });

  test('a runtime that declines to start a session reports session_unavailable', async () => {
    ensureOutcome = 'space_inactive';

    const outcome = await ensureSession({ spaceId, agentId: agent.id }, { source: 'rpc' });

    expect(outcome.value).toMatchObject({ rejected: true, reason: 'session_unavailable' });
    expect(ensureCalls).toEqual([{ spaceId, agentId: agent.id }]);
  });

  test('a provisioning fault remains an infrastructure failure', async () => {
    ensureFault = new Error('provider exploded');
    const outcome = await ensureSession({ spaceId, agentId: agent.id }, { source: 'rpc' });
    expect(outcome).toMatchObject({
      kind: 'failed',
      code: 'execution_failed',
      message: 'provider exploded',
    });
  });

  test('an agent that disappears during provisioning is reported as missing', async () => {
    ensureOutcome = 'agent_missing';
    const outcome = await ensureSession({ spaceId, agentId: agent.id }, { source: 'rpc' });
    expect(outcome.value).toMatchObject({ rejected: true, reason: 'agent_not_found' });
  });

  test('a human caller that names no Space is rejected', async () => {
    const outcome = await ensureSession({ agentId: agent.id }, { source: 'rpc' });

    expect(outcome.value).toMatchObject({ rejected: true, reason: 'space_required' });
    expect(ensureCalls).toEqual([]);
  });
});
