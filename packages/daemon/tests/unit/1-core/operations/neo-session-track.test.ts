import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import { requireNeoDriverVerb } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  findNeoSessionNotice,
  isNeoAdoptOnlyAsk,
  keepNeoTrackedSessions,
  NEO_SESSION_TRACK_MS,
  requireNeoTrackRoot,
  requireNeoTrackableSession,
  requireNeoTrackedAdoption,
} from '../../../../src/lib/neo/session-track.ts';
import { neoSessionKey, type NeoSessionNotice } from '../../../../src/lib/neo/session-watch.ts';
import type { PlaceGroup, WorkStatus } from '../../../../src/lib/drivers/types.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const ref = { adapter: 'codex-desktop', id: 't1' };
const key = neoSessionKey(ref);
const notice = (overrides: Partial<NeoSessionNotice> = {}): NeoSessionNotice => ({
  key,
  ref,
  title: 'Quiet-model research',
  kind: 'failed',
  at: 1,
  ...overrides,
});

describe('isNeoAdoptOnlyAsk', () => {
  test('approves an ask only when the adopted card is its only work', () => {
    expect(isNeoAdoptOnlyAsk({ workIds: ['w1'] }, 'w1')).toBe(true);
    expect(isNeoAdoptOnlyAsk({ workIds: ['w1', 'w2'] }, 'w1')).toBe(false);
    expect(isNeoAdoptOnlyAsk({ workIds: ['w2'] }, 'w1')).toBe(false);
  });
});

describe('requireNeoTrackRoot', () => {
  test('refuses cleanly before Neo has a root session', () => {
    expect(requireNeoTrackRoot('neo:root')).toEqual({ value: 'neo:root' });
    expect(requireNeoTrackRoot(undefined)).toMatchObject({ reason: { ok: false } });
  });
});

describe('findNeoSessionNotice', () => {
  test('finds the latest notice for the key and refuses a key with no notice', () => {
    const later = notice({ at: 2, kind: 'needs_you' });
    expect(findNeoSessionNotice([notice(), later], key)).toEqual({ value: later });
    expect(findNeoSessionNotice([notice()], 'codex-desktop::other')).toMatchObject({
      reason: { ok: false },
    });
  });
});

describe('requireNeoTrackableSession', () => {
  test('refuses a session a Neo card already follows', () => {
    expect(requireNeoTrackableSession(notice(), [])).toEqual({ value: notice() });
    expect(requireNeoTrackableSession(notice(), [ref])).toEqual({
      reason: { ok: false, reason: 'A Neo card already follows this session.' },
    });
  });
});

describe('keepNeoTrackedSessions', () => {
  test('records the tap and drops taps older than the track window', () => {
    const kept = keepNeoTrackedSessions(new Map([['old', 0]]), key, NEO_SESSION_TRACK_MS);
    expect([...kept]).toEqual([[key, NEO_SESSION_TRACK_MS]]);
  });
});

describe('requireNeoTrackedAdoption', () => {
  test('says a card already follows the session instead of suggesting a send', () => {
    const adopt = { verb: 'adopt' as const, ref };
    expect(requireNeoTrackedAdoption(adopt, new Map(), [ref], 1_000, 'ok')).toEqual({
      reason: { ok: false, reason: 'A Neo card already follows this session.' },
    });
  });

  test('passes other verbs and adopts only a session tapped within the window', () => {
    const tracked = new Map([[key, 1_000]]);
    const send = { verb: 'send' as const, ref };
    const adopt = { verb: 'adopt' as const, ref };
    expect(requireNeoTrackedAdoption(send, new Map(), [], 1_000, 'ok')).toEqual({ value: 'ok' });
    expect(requireNeoTrackedAdoption(adopt, tracked, [], 2_000, 'ok')).toEqual({ value: 'ok' });
    expect(
      requireNeoTrackedAdoption(adopt, tracked, [], 1_000 + NEO_SESSION_TRACK_MS, 'ok')
    ).toMatchObject({ reason: { ok: false } });
    expect(requireNeoTrackedAdoption(adopt, new Map(), [], 1_000, 'ok')).toMatchObject({
      reason: { ok: false },
    });
  });
});

describe('requireNeoDriverVerb', () => {
  test('adopting needs an adapter that reads status, not one that sends', () => {
    const adopt = { verb: 'adopt' as const, ref };
    expect(
      requireNeoDriverVerb(adopt, [{ id: 'codex-desktop', capabilities: ['find', 'status'] }], 1)
    ).toEqual({ value: 1 });
    expect(
      requireNeoDriverVerb(adopt, [{ id: 'codex-desktop', capabilities: ['find', 'send'] }], 1)
    ).toMatchObject({ reason: { ok: false } });
  });
});

describe('neo.session.track', () => {
  const RUN_MS = 3 * 60_000;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let listed: PlaceGroup['work'];
  let status: { status: WorkStatus; lastActivityAt: number };
  const sent = mock(() => ({ ok: true, value: { delivered: true } }));
  const stopped = mock(() => ({ ok: true, value: { stopped: true } }));

  const work = (overrides: Partial<PlaceGroup['work'][number]> = {}) => ({
    ref,
    title: 'Quiet-model research',
    place: { machine: 'laptop', folder: '/repo', name: 'repo' },
    status: 'running' as WorkStatus,
    lastActivityAt: 0,
    link: 'codex://threads/t1',
    ...overrides,
  });

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('neo:root'));
    listed = [];
    status = { status: 'running', lastActivityAt: 0 };
    sent.mockClear();
    stopped.mockClear();
    const operation = (name: string, execute: () => unknown) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => execute(),
      });
    const registry = createOperationRegistry([
      operation('work.find', () => ({
        places: [
          {
            place: { machine: 'laptop', folder: '/repo', name: 'repo' },
            lastActivityAt: 0,
            openCount: listed.length,
            archivedCount: 0,
            adapters: ['codex-desktop'],
            work: listed,
          },
        ],
        unreachable: [],
      })),
      operation('work.status', () => ({ ok: true, value: status })),
      operation('work.send', sent),
      operation('work.stop', stopped),
    ]);
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', concernId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('asks Neo to adopt the session, and the adopted card follows it without sending', async () => {
    const human = { source: 'rpc' as const, principal: 'local' as const };
    const invoke = (input: unknown, caller: Parameters<typeof invokeOperation>[3] = human) =>
      invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.session.track',
        input,
        caller
      );
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      expect(service.trackableNotices.map((item) => item.key)).toContain(key);

      expect(
        await invoke({ key }, { source: 'mcp', sessionId: 'neo:root', role: 'neo' })
      ).toMatchObject({ value: { ok: false, reason: 'This action needs the user.' } });
      expect(await invoke({ key })).toMatchObject({ value: { ok: true } });
      expect(service.trackedSessions.get(key)).toBe(clock);
      expect(db.getGlobalSettings().neo?.trackedSessions).toEqual({ [key]: clock });
      expect(
        db
          .getJobQueueRepo()
          .listActiveByPayload('mailbox', { 'to.sessionId': 'neo:root' })
          .map((job) => JSON.stringify(job.payload))
          .join('\n')
      ).toContain('tapped Track');

      const proposed = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.work.propose',
        {
          requestKey: 'track',
          title: 'Quiet-model research',
          instruction: 'Follow the research session.',
          goal: 'Research quiet models',
          doneWhen: '- findings written up',
          work: { verb: 'adopt', ref },
        },
        {
          source: 'mcp',
          sessionId: 'neo:root',
          role: 'neo',
          neoTurn: { messageId: 'turn-1', human: false, isLive: () => true },
        }
      );
      expect(proposed).toMatchObject({ value: { ok: true } });
      const card = (proposed as { value: { work: { id: string } } }).value.work;
      expect(service.trackedSessions.has(key)).toBe(false);
      expect(service.askRecords.forWork(card.id)?.approvedAt).toBe(clock);
      expect(sent).not.toHaveBeenCalled();
      expect(service.repo.getWork(card.id)).toMatchObject({
        status: 'queued',
        report: expect.stringContaining('Tracking the codex-desktop session'),
      });
      expect(service.driverTargets.cardRefs(0)).toEqual([{ workId: card.id, ref }]);
      clock += 11 * 60_000;
      await service.refreshDriverWork();
      expect(service.repo.getWork(card.id)?.status).toBe('queued');
      expect(await invoke({ key })).toMatchObject({
        value: { ok: false, reason: 'A Neo card already follows this session.' },
      });

      await service.close(card.id, 'done');
      expect(service.repo.getWork(card.id)?.status).toBe('reported');
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      time.mockRestore();
    }
  });
});
