import { afterEach, beforeEach, expect, test } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { createHyperneoAdapter } from '../../../../src/lib/drivers/hyperneo-adapter.ts';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let hub: MessageHub;
let events: ReturnType<typeof createDaemonInternalEventBus>;
const root = 'neo:10000000-0000-4000-8000-000000009095';
const ref = { adapter: 'hyperneo', id: 'worker' };
const error = 'Synthetic unknown query start failure';
const episode = { id: 'episode-one', failures: 3, retryAt: 0, error, failed: true };

beforeEach(async () => {
  db = await createTestDb();
  events = createDaemonInternalEventBus();
  hub = new MessageHub({ defaultSessionId: 'global' });
  await db.createSession(createTestSession(root));
  await db.createSession({
    ...createTestSession(ref.id),
    title: 'Synthetic worker',
    type: 'worker',
  });
  service = createNeoService(db, {} as never, hub, events);
  service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
});

afterEach(async () => {
  await service.dispose();
  hub.cleanup();
  await db.close();
});

async function persist(value: typeof episode | null) {
  const metadata = { ...db.getSession(ref.id)!.metadata, queryFailureEpisode: value };
  await db.updateSession(ref.id, { metadata });
}

function adapter() {
  return createHyperneoAdapter({
    db: () => db.getDatabase(),
    machine: 'synthetic',
    searchChats: async () => [],
    handoff: async () => ({ kind: 'enqueued', id: 'unused' }),
    sessions: {
      create: async () => {
        throw new Error('unused');
      },
      resolveModel: async () => null,
      model: () => null,
      chooseWorktree: async () => {},
      announce: () => {},
      interrupt: () => false,
    },
    neoFolder: () => '/synthetic/neo',
    folderExists: () => true,
    makeFolder: () => {},
    homeDir: '/synthetic',
  });
}

function terminalEvent(value = episode) {
  return events.publish('session.error', {
    sessionId: ref.id,
    error,
    details: { metadata: { queryFailureEpisode: value } },
  });
}

const wakes = () => db.getJobQueueRepo().listJobs({ queue: 'mailbox' });

test.each(['idle', 'processing', 'queued'])(
  'a persisted terminal episode is failed in status and discovery despite %s processing state',
  async (status) => {
    await persist(episode);
    db.getDatabase()
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run(JSON.stringify({ status }), ref.id);
    const driver = adapter();
    expect(await driver.status!(ref)).toMatchObject({
      ok: true,
      value: { status: 'failed', lastReply: error },
    });
    const found = await driver.find({ includeClosed: false, limit: 20 });
    expect(
      found.flatMap((place) => place.work).find((work) => work.ref.id === ref.id)
    ).toMatchObject({ status: 'failed' });
  }
);

test('an old successful result cannot hide a failed episode; a hard reset clears its evidence', async () => {
  await db.writeSDKMessage('saveSDKMessage', ref.id, {
    type: 'result',
    subtype: 'success',
    uuid: crypto.randomUUID(),
    session_id: ref.id,
    result: 'An older successful turn',
    is_error: false,
    parent_tool_use_id: null,
  } as never);
  await persist(episode);
  expect(await adapter().status!(ref)).toMatchObject({
    ok: true,
    value: { status: 'failed', lastReply: error },
  });
  await persist({ ...episode, id: 'reset-episode', failures: 0, failed: false });
  expect(await adapter().status!(ref)).toMatchObject({
    ok: true,
    value: { status: 'done', lastReply: 'An older successful turn' },
  });
});

test('terminal session.error wakes Neo once with the persisted original error', async () => {
  await persist(episode);
  await terminalEvent();
  await terminalEvent();
  expect(wakes()).toHaveLength(1);
  expect(wakes()[0].payload).toMatchObject({
    to: { kind: 'session', sessionId: root },
    message: { inputKind: 'system', neoWakeEvent: true },
  });
  expect(JSON.stringify(wakes()[0].payload)).toContain(error);
  expect(JSON.stringify(wakes()[0].payload)).toContain('Synthetic worker');
});

test('retrying, non-persisted and stale post-reset errors do not wake Neo', async () => {
  await terminalEvent();
  await persist({ ...episode, failures: 1, failed: false });
  await terminalEvent({ ...episode, failures: 1, failed: false });
  await persist({ ...episode, id: 'reset-episode', failures: 0, failed: false });
  await terminalEvent();
  expect(wakes()).toHaveLength(0);
});

test('a new failed episode after reset delivers its own wake', async () => {
  await persist(episode);
  await terminalEvent();
  const next = { ...episode, id: 'episode-two', error: 'A different start error' };
  await persist(next);
  await terminalEvent(next);
  expect(wakes()).toHaveLength(2);
  expect(JSON.stringify(wakes())).toContain(next.error);
});

test('archived sessions retain stopped status and do not wake on a late error', async () => {
  await persist(episode);
  db.getDatabase().prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(ref.id);
  expect(await adapter().status!(ref)).toMatchObject({ ok: true, value: { status: 'stopped' } });
  await terminalEvent();
  expect(wakes()).toHaveLength(0);
});
