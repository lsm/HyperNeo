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
import {
  claimReminderDelivery,
  reminderOccurrenceIsClaimed,
} from '../../../../src/lib/agents/reminder-delivery-registry';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';

let db: Database;
let agentRepo: SpaceLongHorizonAgentRepository;
let reminderRepo: SpaceAgentReminderRepository;
let spaceId: string;
let otherSpaceId: string;
let agent: SpaceLongHorizonAgent;
let stranger: SpaceLongHorizonAgent;
let sessions: Map<string, Session>;
let audited: Array<{ name: string; summary: Record<string, unknown> }>;
let occurrenceClaimed: boolean;

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
      occurrenceIsClaimed: () => occurrenceClaimed,
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
  occurrenceClaimed = false;
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

  test('a session carrying no Space is refused by admitAgentCaller inside the operation', async () => {
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
    expect(outcome.kind).toBe('completed');
    expect(outcome.value?.reason).toBe('agent_denied');
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

  test('a workflow worker reads the reminder list of an agent in its own Space', async () => {
    seed('worker visible', 1_000);
    const outcome = await run(
      'agent.reminders.list',
      { agentId: agent.id },
      memberCaller('workflow_worker')
    );
    expect(outcome.kind).toBe('completed');
    expect(outcome.value?.reminders?.map((entry) => entry.message)).toEqual(['worker visible']);
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

describe('the agent.reminders.cancel operation', () => {
  async function seed(remindAt = 1_000) {
    const created = await run('agent.reminders.create', {
      agentId: agent.id,
      message: 'Ship the release',
      remindAt,
    });
    audited = [];
    return created.value?.reminder?.id as string;
  }

  test('cancels a pending reminder and stops it coming due', async () => {
    const reminderId = await seed();
    expect(reminderRepo.listDueReminders(2_000)).toHaveLength(1);

    const outcome = await run('agent.reminders.cancel', { agentId: agent.id, reminderId });

    expect(outcome.value?.reminder).toMatchObject({ id: reminderId, state: 'cancelled' });
    expect(reminderRepo.listDueReminders(2_000)).toHaveLength(0);
    expect(reminderRepo.getReminder(reminderId)?.status).toBe('cancelled');
  });

  test('a cancelled reminder is reachable through the list state filter', async () => {
    const reminderId = await seed();
    await run('agent.reminders.cancel', { agentId: agent.id, reminderId });

    const listed = await run('agent.reminders.list', { agentId: agent.id, state: 'cancelled' });

    expect(listed.value?.reminders).toHaveLength(1);
    expect(listed.value?.reminders?.[0]).toMatchObject({ id: reminderId, state: 'cancelled' });
  });

  test('cancelling again succeeds without a second write or audit entry', async () => {
    const reminderId = await seed();
    await run('agent.reminders.cancel', { agentId: agent.id, reminderId });
    const updatedAt = reminderRepo.getReminder(reminderId)?.updatedAt;
    audited = [];

    const repeat = await run('agent.reminders.cancel', { agentId: agent.id, reminderId });

    expect(repeat.value?.reminder).toMatchObject({ id: reminderId, state: 'cancelled' });
    expect(reminderRepo.getReminder(reminderId)?.updatedAt).toBe(updatedAt as number);
    expect(audited).toEqual([]);
  });

  test('the audit entry names the operation and the reminder', async () => {
    const reminderId = await seed();
    await run('agent.reminders.cancel', { agentId: agent.id, reminderId });
    expect(audited).toEqual([
      { name: 'agent.reminders.cancel', summary: { agentId: agent.id, reminderId } },
    ]);
  });

  test('rejects a reminder that already fired', async () => {
    const reminderId = await seed();
    reminderRepo.advanceReminderAfterFire(reminderId, 1_000, {
      status: 'fired',
      nextRunAt: null,
      lastFiredAt: 1_000,
    });

    const outcome = await run('agent.reminders.cancel', { agentId: agent.id, reminderId });

    expect(outcome.value?.reason).toBe('reminder_not_cancellable');
    expect(reminderRepo.getReminder(reminderId)?.status).toBe('fired');
  });

  test('rejects a reminder whose delivery is already in flight', async () => {
    const reminderId = await seed();
    let release = () => {};
    claimReminderDelivery(
      reminderId,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const outcome = await run('agent.reminders.cancel', { agentId: agent.id, reminderId });

    expect(outcome.value?.reason).toBe('reminder_not_cancellable');
    expect(reminderRepo.getReminder(reminderId)?.status).toBe('active');
    release();
  });

  test('a caller that loses a cancel race still sees the reminder cancelled', async () => {
    const reminderId = await seed();
    const real = reminderRepo;
    reminderRepo = {
      ...real,
      getReminder: (id: string) => real.getReminder(id),
      listReminders: (id: string) => real.listReminders(id),
      createReminder: real.createReminder.bind(real),
      cancelReminder: (id: string) => {
        real.cancelReminder(id);
        return false;
      },
    } as unknown as SpaceAgentReminderRepository;

    const outcome = await run('agent.reminders.cancel', { agentId: agent.id, reminderId });

    expect(outcome.value?.reminder).toMatchObject({ id: reminderId, state: 'cancelled' });
    expect(outcome.value?.reason).toBeUndefined();
    reminderRepo = real;
  });

  test('rejects a reminder whose occurrence is already claimed for delivery', async () => {
    const reminderId = await seed();
    occurrenceClaimed = true;

    const outcome = await run('agent.reminders.cancel', { agentId: agent.id, reminderId });

    expect(outcome.value?.reason).toBe('reminder_not_cancellable');
    expect(reminderRepo.getReminder(reminderId)?.status).toBe('active');
  });

  test('rejects a reminder that belongs to another agent', async () => {
    const reminderId = await seed();
    const other = agentRepo.create({
      spaceId,
      handle: 'other',
      displayName: 'Other',
      instructions: '',
    });

    const outcome = await run('agent.reminders.cancel', { agentId: other.id, reminderId });

    expect(outcome.value?.reason).toBe('reminder_not_found');
    expect(reminderRepo.getReminder(reminderId)?.status).toBe('active');
  });

  test('denies a read-only caller before any write', async () => {
    const reminderId = await seed();

    const outcome = await run(
      'agent.reminders.cancel',
      { agentId: agent.id, reminderId },
      readOnlyCaller()
    );

    expect(outcome.value?.reason).toBe('agent_denied');
    expect(reminderRepo.getReminder(reminderId)?.status).toBe('active');
  });
});

describe('reminderOccurrenceIsClaimed', () => {
  const KEY = 'reminder:rem-1:1000';

  function reader(options: { jobs?: number; status?: string; consumedSeq?: boolean } = {}) {
    const queries: Array<{ queue: string; matchPayload: Record<string, unknown> }> = [];
    return {
      queries,
      getSDKMessageRepo: () => ({
        hasConsumptionEvidence: (_sessionId: string, messageId: string) =>
          options.consumedSeq === true && messageId === KEY,
      }),
      getJobQueueRepo: () => ({
        listActiveByPayload: (queue: string, matchPayload: Record<string, unknown>) => {
          queries.push({ queue, matchPayload });
          return new Array(options.jobs ?? 0).fill({});
        },
      }),
      getMessageByStatusAndUuid: (_sessionId: string, status: string, uuid: string) =>
        status === options.status && uuid === KEY ? {} : null,
    };
  }

  test('an active mailbox job alone claims the occurrence', () => {
    const db = reader({ jobs: 1 });
    expect(reminderOccurrenceIsClaimed(db, spaceId, agent.id, KEY)).toBe(true);
    expect(db.queries).toEqual([
      {
        queue: 'mailbox',
        matchPayload: {
          'to.sessionId': longTermAgentSessionId(spaceId, agent.id),
          messageUuid: KEY,
        },
      },
    ]);
  });

  test.each(['deferred', 'enqueued', 'submitted', 'consumed'] as const)(
    'a persisted %s message claims the occurrence',
    (status) => {
      expect(reminderOccurrenceIsClaimed(reader({ status }), spaceId, agent.id, KEY)).toBe(true);
    }
  );

  test('a failed message that was never consumed leaves the occurrence unclaimed', () => {
    expect(reminderOccurrenceIsClaimed(reader({ status: 'failed' }), spaceId, agent.id, KEY)).toBe(
      false
    );
  });

  test('a consumed message later failed inclusively still claims the occurrence', () => {
    const db = reader({ status: 'failed', consumedSeq: true });
    expect(reminderOccurrenceIsClaimed(db, spaceId, agent.id, KEY)).toBe(true);
  });

  test('no reader means nothing is claimed', () => {
    expect(reminderOccurrenceIsClaimed(null, spaceId, agent.id, KEY)).toBe(false);
  });
});
