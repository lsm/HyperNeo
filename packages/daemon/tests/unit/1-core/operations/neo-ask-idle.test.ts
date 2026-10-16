import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { NEO_ASK_IDLE } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import {
  NEO_ASK_IDLE_MS,
  neoAskIdleSignature,
  requireNeoAskIdle,
  trackNeoAskIdle,
} from '../../../../src/lib/neo/ask-idle.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const item = (id: string, state: NeoAskItem['state'], removed = false): NeoAskItem => ({
  id,
  text: `item ${id}`,
  state,
  evidence: null,
  check: null,
  metBy: null,
  removed,
  addedAt: null,
});
const card = (
  status: 'proposed' | 'queued' | 'reported' | 'failed',
  progress = '0|-:0',
  awaited = false
) => ({
  id: 'w1',
  title: 'Fix login',
  status,
  progress,
  awaited,
});
const now = 10 * NEO_ASK_IDLE_MS;
const open = { status: 'open' as const, doneItems: [item('i1', 'pending'), item('i2', 'met')] };
const read = (cards: ReturnType<typeof card>[], since = now - NEO_ASK_IDLE_MS) => ({
  cards,
  session: true,
  since,
  signature: 'sig',
});

describe('requireNeoAskIdle', () => {
  test('wakes Neo for an open ask with pending items whose in-flight cards sat still 20 minutes', () => {
    expect(requireNeoAskIdle(open, read([card('queued')]), now)).toEqual({ value: 'idle:sig' });
    expect(requireNeoAskIdle(open, read([card('reported')]), now)).toEqual({ value: 'idle:sig' });
  });

  test('still wakes when one in-flight card is idle beside another waiting on its PR', () => {
    expect(
      requireNeoAskIdle(open, read([card('queued', '0|-:0', true), card('reported')]), now)
    ).toEqual({ value: 'idle:sig' });
  });

  test.each<
    [
      Extract<ReturnType<typeof requireNeoAskIdle>, { reason: unknown }>['reason'],
      Parameters<typeof requireNeoAskIdle>[0],
      ReturnType<typeof read>,
    ]
  >([
    ['moving', open, read([card('queued')], now - NEO_ASK_IDLE_MS + 1)],
    ['not_open', { ...open, status: 'waiting' as const }, read([card('queued')])],
    ['no_session', open, { ...read([card('queued')]), session: false }],
    [
      'no_pending',
      { ...open, doneItems: [item('i1', 'met'), item('i2', 'pending', true)] },
      read([card('queued')]),
    ],
    ['not_in_flight', open, read([card('proposed'), card('failed')])],
    ['awaiting_pr', open, read([card('queued', '0|-:0', true), card('reported', '0|-:0', true)])],
  ])('skips with %s', (reason, ask, input) => {
    expect(requireNeoAskIdle(ask, input, now)).toEqual({ reason });
  });
});

describe('neoAskIdleSignature', () => {
  test('changes with a card status, progress or continue, and with an item state', () => {
    const base = neoAskIdleSignature(open, [card('queued')]);
    expect(neoAskIdleSignature(open, [card('queued')])).toBe(base);
    for (const changed of [
      neoAskIdleSignature(open, [card('reported')]),
      neoAskIdleSignature(open, [card('queued', '1|-:0')]),
      neoAskIdleSignature(open, [card('queued', '0|-:1')]),
      neoAskIdleSignature({ doneItems: [item('i1', 'met'), item('i2', 'met')] }, [card('queued')]),
    ])
      expect(changed).not.toBe(base);
  });
});

describe('trackNeoAskIdle', () => {
  test('keeps the time a signature was first seen, restarts it on change, and drops settled asks', () => {
    const first = trackNeoAskIdle(new Map(), [{ id: 'a' }], new Map([['a', 's1']]), 100);
    expect(first.get('a')).toEqual({ signature: 's1', since: 100 });
    const same = trackNeoAskIdle(first, [{ id: 'a' }], new Map([['a', 's1']]), 900);
    expect(same.get('a')).toEqual({ signature: 's1', since: 100 });
    const changed = trackNeoAskIdle(same, [{ id: 'a' }], new Map([['a', 's2']]), 950);
    expect(changed.get('a')).toEqual({ signature: 's2', since: 950 });
    expect(trackNeoAskIdle(changed, [], new Map(), 999).size).toBe(0);
  });
});

describe('NeoService.refreshDriverWork', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let clock: number;
  const delivered: { messageId: string; content: string }[] = [];

  beforeEach(async () => {
    clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    delivered.length = 0;
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, {
      deliver: async (_sessionId: string, messageId: string, content: string) => {
        delivered.push({ messageId, content });
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  function stuckAsk(): { ask: NeoAsk; workId: string } {
    const ask = service.askRecords.open(
      {
        id: 'a-idle',
        requestKey: 'k-idle',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Login fix',
        ask: 'Fix login and merge it',
        doneWhen: '- merged',
        doneSource: 'human',
      },
      [{ text: 'merged', check: null }]
    )!;
    const work = service.repo.proposeWork({
      id: 'w-idle',
      requestKey: 'k-w-idle',
      projectId: null,
      originSessionId: 'neo:root',
      title: 'Fix login',
      instruction: 'Fix login.',
    });
    service.repo.transitionWork(work.id, work, { status: 'queued' });
    service.askRecords.link(ask.id, work.id);
    return { ask, workId: work.id };
  }

  const idleNotes = () => delivered.filter((note) => note.content.includes(NEO_ASK_IDLE));

  test('wakes Neo when a card under a pending ask makes no progress for 20 minutes', async () => {
    stuckAsk();
    await service.refreshDriverWork();
    clock += NEO_ASK_IDLE_MS - 1;
    await service.refreshDriverWork();
    expect(idleNotes()).toEqual([]);
    clock += 1;
    await service.refreshDriverWork();
    expect(idleNotes()).toHaveLength(1);
    expect(idleNotes()[0].content).toContain('"askId":"a-idle"');
  });

  test('restarts the 20 minutes when a card moves', async () => {
    const { workId } = stuckAsk();
    await service.refreshDriverWork();
    clock += NEO_ASK_IDLE_MS - 1;
    const queued = service.repo.getWork(workId)!;
    service.repo.transitionWork(workId, queued, { status: 'reported', report: 'Opened PR.' });
    await service.refreshDriverWork();
    clock += NEO_ASK_IDLE_MS - 1;
    await service.refreshDriverWork();
    expect(idleNotes()).toEqual([]);
  });
});
