import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentReminderRepository } from '../../../../src/storage/repositories/space-agent-reminder-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
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
let reminderRepo: SpaceAgentReminderRepository;
let spaceId: string;
let otherSpaceId: string;
let agent: SpaceLongHorizonAgent;
let stranger: SpaceLongHorizonAgent;
let sessions: Map<string, Session>;
let audited: Array<{ name: string; summary: Record<string, unknown> }>;

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
      reminderRepo,
      publishAgentCreated: () => {},
      audit: (name, summary) => audited.push({ name, summary }),
    })
  );
}

async function run(name: string, input: Record<string, unknown>, caller = memberCaller()) {
  const outcome = await invokeOperation(registry(), name, input, caller);
  return outcome as {
    kind: string;
    code?: string;
    value?: { reminder?: Record<string, unknown>; reminders?: Array<Record<string, unknown>> } & {
      reason?: string;
    };
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  agentRepo = new SpaceLongHorizonAgentRepository(db);
  reminderRepo = new SpaceAgentReminderRepository(db, new SpaceAgentRepository(db));
  const spaceRepo = new SpaceRepository(db);
  spaceId = spaceRepo.createSpace({ name: 'Home', slug: 'home', workspacePath: '/repo' }).id;
  otherSpaceId = spaceRepo.createSpace({ name: 'Away', slug: 'away', workspacePath: '/other' }).id;
  agent = agentRepo.create({
    spaceId,
    handle: 'planner',
    displayName: 'Planner',
    instructions: '',
  });
  stranger = agentRepo.create({
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
  audited = [];
});

describe('the agent.reminders.create operation', () => {
  test('creates a one-shot reminder and returns it in agent-facing shape', async () => {
    const outcome = await run('agent.reminders.create', {
      agentId: agent.id,
      message: 'Ship the release',
      remindAt: 1_800_000,
    });
    expect(outcome.value?.reminder).toEqual({
      id: expect.any(String),
      agentId: agent.id,
      message: 'Ship the release',
      body: '',
      state: 'active',
      remindAt: 1_800_000,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    const stored = reminderRepo.listReminders(agent.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.triggerType).toBe('at');
    expect(stored[0]?.nextRunAt).toBe(1_800_000);
  });

  test('the creating session is recorded on the reminder', async () => {
    await run('agent.reminders.create', { agentId: agent.id, message: 'x', remindAt: 1 });
    expect(reminderRepo.listReminders(agent.id)[0]?.createdBySession).toBe(MEMBER_SESSION);
  });

  test('the audit entry names the operation and omits the message', async () => {
    await run('agent.reminders.create', {
      agentId: agent.id,
      message: 'secret plan',
      remindAt: 42,
    });
    expect(audited).toEqual([
      { name: 'agent.reminders.create', summary: { agentId: agent.id, remindAt: 42 } },
    ]);
  });

  test('an agent of another Space is absent, and nothing is written', async () => {
    const outcome = await run('agent.reminders.create', {
      agentId: stranger.id,
      message: 'x',
      remindAt: 1,
    });
    expect(outcome.value?.reason).toBe('agent_not_found');
    expect(reminderRepo.listReminders(stranger.id)).toHaveLength(0);
  });

  test('an archived session in the owning Space may not create reminders', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await run('agent.reminders.create', {
      agentId: agent.id,
      message: 'x',
      remindAt: 1,
    });
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(reminderRepo.listReminders(agent.id)).toHaveLength(0);
  });

  test('a read-only session is refused at the door', async () => {
    expect(readOnlyCaller()).toEqual({
      source: 'mcp',
      sessionId: READ_ONLY_SESSION,
      role: 'universal_read',
    });
    const outcome = await run(
      'agent.reminders.create',
      { spaceId, agentId: agent.id, message: 'x', remindAt: 1 },
      readOnlyCaller()
    );
    expect(outcome.kind).toBe('failed');
    expect(outcome.code).toBe('forbidden');
    expect(reminderRepo.listReminders(agent.id)).toHaveLength(0);
  });

  test('a human caller must name the Space', async () => {
    const outcome = await run(
      'agent.reminders.create',
      { agentId: agent.id, message: 'x', remindAt: 1 },
      { source: 'rpc' }
    );
    expect(outcome.value?.reason).toBe('space_required');
  });
});

describe('the agent.reminders.list operation', () => {
  function seed(message: string, remindAt: number, status?: 'fired' | 'cancelled') {
    return reminderRepo.createReminder({
      spaceId,
      agentId: agent.id,
      title: message,
      triggerType: 'at',
      runAt: remindAt,
      nextRunAt: remindAt,
      status: status ?? 'active',
    });
  }

  test('reminders come back soonest due first', async () => {
    seed('later', 3_000);
    seed('sooner', 1_000);
    seed('middle', 2_000);
    const outcome = await run('agent.reminders.list', { agentId: agent.id });
    expect(outcome.value?.reminders?.map((entry) => entry.message)).toEqual([
      'sooner',
      'middle',
      'later',
    ]);
  });

  test('a fired reminder reads as done', async () => {
    seed('done one', 1_000, 'fired');
    const outcome = await run('agent.reminders.list', { agentId: agent.id });
    expect(outcome.value?.reminders?.[0]?.state).toBe('done');
  });

  test('the state filter uses the agent-facing vocabulary', async () => {
    seed('live', 1_000);
    seed('fired one', 2_000, 'fired');
    seed('dropped', 3_000, 'cancelled');
    const done = await run('agent.reminders.list', { agentId: agent.id, state: 'done' });
    expect(done.value?.reminders?.map((entry) => entry.message)).toEqual(['fired one']);
    const cancelled = await run('agent.reminders.list', { agentId: agent.id, state: 'cancelled' });
    expect(cancelled.value?.reminders?.map((entry) => entry.message)).toEqual(['dropped']);
    const active = await run('agent.reminders.list', { agentId: agent.id, state: 'active' });
    expect(active.value?.reminders?.map((entry) => entry.message)).toEqual(['live']);
  });

  test('an agent of another Space is absent', async () => {
    const outcome = await run('agent.reminders.list', { agentId: stranger.id });
    expect(outcome.value?.reason).toBe('agent_not_found');
  });

  test('a workflow worker is denied the reminder list at the door', async () => {
    const outcome = await run(
      'agent.reminders.list',
      { agentId: agent.id },
      memberCaller('workflow_worker')
    );
    expect(outcome.kind).toBe('failed');
    expect(outcome.code).toBe('forbidden');
  });

  test('a human caller naming the Space reads the reminders', async () => {
    seed('visible', 1_000);
    const outcome = await run(
      'agent.reminders.list',
      { spaceId, agentId: agent.id },
      { source: 'rpc' }
    );
    expect(outcome.value?.reminders?.map((entry) => entry.message)).toEqual(['visible']);
  });
});
