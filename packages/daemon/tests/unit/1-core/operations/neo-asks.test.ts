import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const neo: OperationCaller = {
  source: 'mcp',
  sessionId: 'root',
  role: 'neo',
  neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
};
const place = { machine: 'laptop', folder: '/Users/me/app', name: 'app' };
const opening = {
  requestKey: 'fix',
  title: 'Fix the login bug',
  ask: 'Fix the login bug and get it merged',
  doneWhen: '- merged to dev\n- CI green',
  doneSource: 'human',
};

describe('neo.ask operations', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('root'));
    service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function invoke(name: string, input: unknown) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      input,
      neo
    ) as Promise<{
      kind: string;
      value?: { ok: boolean; ask?: NeoAsk; asks?: NeoAsk[]; work?: { id: string } };
    }>;
  }

  async function openAsk(): Promise<string> {
    const opened = await invoke('neo.ask.open', opening);
    return opened.value!.ask!.id;
  }

  function propose(requestKey: string, askId: string) {
    return invoke('neo.work.propose', {
      requestKey,
      title: 'Fix it',
      instruction: 'Fix the login bug.',
      work: { verb: 'start', adapter: 'claude-desktop', place },
      askId,
    });
  }

  test('opens one ask per request key and shows its cards in the snapshot', async () => {
    const askId = await openAsk();
    expect(await invoke('neo.ask.open', opening)).toMatchObject({
      value: { ok: true, ask: { id: askId, originMessageId: 'ask-1', status: 'open' } },
    });
    for (const change of [{ ask: 'Something else' }, { doneWhen: '- PR open' }])
      expect(await invoke('neo.ask.open', { ...opening, ...change })).toMatchObject({
        value: { ok: false, reason: 'This request key already belongs to another ask.' },
      });

    const proposed = await propose('card-1', askId);
    const workId = proposed.value!.work!.id;
    const snapshot = await invoke('neo.snapshot', {});

    expect(snapshot.value?.asks).toEqual([
      expect.objectContaining({ id: askId, doneWhen: opening.doneWhen, workIds: [workId] }),
    ]);
  });

  test('refuses work under a missing or achieved ask, and settling is final', async () => {
    const askId = await openAsk();
    expect(await propose('card-1', 'nope')).toMatchObject({
      value: { ok: false, reason: 'ask_not_found' },
    });

    const settle = { id: askId, outcome: 'achieved', evidence: 'PR #12 merged, CI green.' };
    expect(await invoke('neo.ask.settle', settle)).toMatchObject({
      value: { ok: true, ask: { status: 'achieved', outcome: settle.evidence } },
    });
    expect(await invoke('neo.ask.settle', settle)).toMatchObject({ value: { ok: true } });
    expect(
      await invoke('neo.ask.settle', { ...settle, outcome: 'blocked', evidence: 'x' })
    ).toMatchObject({ value: { ok: false, reason: 'ask_settled: this ask is already achieved.' } });
    expect(await propose('card-2', askId)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('ask_settled') },
    });
  });

  test('refuses a retried request key under another ask', async () => {
    const first = await openAsk();
    const second = (await invoke('neo.ask.open', { ...opening, requestKey: 'other' })).value!.ask!
      .id;
    await propose('card-1', first);

    expect(await propose('card-1', second)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('another ask') },
    });
    expect(service.askRecords.get(second)?.workIds).toEqual([]);
    expect(await propose('card-1', first)).toMatchObject({ value: { ok: true } });
  });

  test('new work under a blocked ask reopens it', async () => {
    const askId = await openAsk();
    await invoke('neo.ask.settle', { id: askId, outcome: 'blocked', evidence: 'Which API?' });

    await propose('card-1', askId);

    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open', settledAt: null });
  });
});
