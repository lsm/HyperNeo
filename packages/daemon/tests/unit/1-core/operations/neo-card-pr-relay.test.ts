import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { NEO_WORK_CLOSED_DONE, type NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  neoCardPrAttention,
  requireNeoCardPrRelay,
} from '../../../../src/lib/neo/card-pr-relay.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const url = 'https://github.com/lsm/HyperNeo/pull/1';
const pr = (fields: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url,
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...fields,
});

describe('neoCardPrAttention', () => {
  test('lists failing checks, requested changes, unresolved threads and conflicts per open PR', () => {
    expect(
      neoCardPrAttention([
        pr({
          checks: 'failing',
          review: 'changes_requested',
          blockers: ['2 unresolved review threads', 'merge conflicts with dev', 'behind dev'],
        }),
      ])
    ).toEqual({
      signature: `${url}:checks+review+threads+conflicts`,
      items: `- ${url}: CI checks are failing; a reviewer requested changes; 2 unresolved review threads; merge conflicts with dev`,
    });
  });

  test('stays quiet for a clean, pending, merged or closed PR', () => {
    expect(
      neoCardPrAttention([
        pr(),
        pr({ checks: 'pending', blockers: ['behind dev'] }),
        pr({ state: 'MERGED', checks: 'failing' }),
        pr({ state: 'CLOSED', review: 'changes_requested' }),
      ])
    ).toBeNull();
  });
});

describe('requireNeoCardPrRelay', () => {
  const attention = { signature: 's1', items: `- ${url}: CI checks are failing` };

  test('relays new PR news to a queued or reported card', () => {
    for (const status of ['queued', 'reported'] as const) {
      const relay = requireNeoCardPrRelay({ status, report: null }, attention, {});
      expect(relay).toMatchObject({ value: { signature: 's1' } });
      expect('value' in relay && relay.value.message).toContain(attention.items);
    }
    expect(
      requireNeoCardPrRelay({ status: 'queued', report: null }, attention, { signature: 's0' })
    ).toMatchObject({
      value: { signature: 's1' },
    });
    expect(
      requireNeoCardPrRelay({ status: 'queued', report: null }, attention, {
        lastMessage: 'something else',
      })
    ).toMatchObject({ value: { signature: 's1' } });
  });

  test.each([
    ['not_in_flight', { status: 'cancelled' as const, report: null }, attention, {}],
    ['not_in_flight', null, attention, {}],
    ['not_in_flight', { status: 'reported' as const, report: NEO_WORK_CLOSED_DONE }, attention, {}],
    ['clear', { status: 'queued' as const, report: null }, null, {}],
    ['told', { status: 'queued' as const, report: null }, attention, { signature: 's1' }],
  ] as const)('skips with %s', (reason, work, news, told) => {
    expect(requireNeoCardPrRelay(work, news, told)).toEqual({ reason });
  });

  test('treats the same message as the last continue as already told', () => {
    const relay = requireNeoCardPrRelay({ status: 'queued', report: null }, attention, {});
    const message = 'value' in relay ? relay.value.message : '';
    expect(
      requireNeoCardPrRelay({ status: 'queued', report: null }, attention, { lastMessage: message })
    ).toEqual({ reason: 'told' });
  });
});

describe('NeoService relayCardPr', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const sent: { id: string; message: string }[] = [];
  let refuse: string | null;

  beforeEach(async () => {
    sent.length = 0;
    refuse = null;
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, {
      continueWork: async (id: string, message: string) => {
        sent.push({ id, message });
        return refuse
          ? { ok: false, reason: refuse }
          : { ok: true, work: service.repo.getWork(id) };
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  const relay = (workId: string) =>
    (service as unknown as { relayCardPr(id: string): Promise<unknown> }).relayCardPr(workId);

  function queuedCard(): string {
    const work = service.repo.proposeWork({
      id: 'w-pr',
      requestKey: 'k-pr',
      concernId: null,
      originSessionId: 'neo:root',
      title: 'Fix login',
      instruction: 'Fix login.',
    });
    service.repo.transitionWork(work.id, work, { status: 'queued', report: null });
    return work.id;
  }

  test('sends each new PR problem to the card once, and again after it clears and returns', async () => {
    const workId = queuedCard();
    service.workPrs.record(workId, [pr({ checks: 'failing' })], 1);
    await relay(workId);
    await relay(workId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: workId });
    expect(sent[0].message).toContain(`${url}: CI checks are failing`);

    service.workPrs.record(workId, [pr({ checks: 'failing', review: 'changes_requested' })], 2);
    await relay(workId);
    expect(sent).toHaveLength(2);

    service.workPrs.record(workId, [pr()], 3);
    await relay(workId);
    service.workPrs.record(workId, [pr({ checks: 'failing', review: 'changes_requested' })], 4);
    await relay(workId);
    expect(sent).toHaveLength(3);
  });

  test('tries again on the next sweep when the continue is refused', async () => {
    const workId = queuedCard();
    service.workPrs.record(workId, [pr({ checks: 'failing' })], 1);
    refuse = 'This work is already being continued; wait for that first.';
    await relay(workId);
    refuse = null;
    await relay(workId);
    await relay(workId);
    expect(sent).toHaveLength(2);
  });

  test('after a restart, does not resend the problem its last continue already carried', async () => {
    const workId = queuedCard();
    service.workPrs.record(workId, [pr({ checks: 'failing' })], 1);
    await relay(workId);
    service.workContinues.record(workId, sent[0].message, 1, '0|-');
    Object.assign(service, { cardPrRelayed: new Map() });
    await relay(workId);
    expect(sent).toHaveLength(1);
  });

  test('leaves a cancelled card alone', async () => {
    const workId = queuedCard();
    service.repo.transitionWork(workId, service.repo.getWork(workId)!, { status: 'cancelled' });
    service.workPrs.record(workId, [pr({ checks: 'failing' })], 1);
    await relay(workId);
    expect(sent).toEqual([]);
  });
});
