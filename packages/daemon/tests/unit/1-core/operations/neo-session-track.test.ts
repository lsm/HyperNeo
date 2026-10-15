import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import { requireNeoDriverVerb } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  findNeoSessionNotice,
  isNeoAdoptOnlyAsk,
  isNeoTrackedFollowUp,
  keepNeoTrackedSessions,
  NEO_SESSION_TRACK_MS,
  requireNeoTrackRoot,
  requireNeoTrackableSession,
  requireNeoTrackedAdoption,
  reserveNeoAdoption,
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

describe('isNeoTrackedFollowUp', () => {
  const open = { workIds: ['w1', 'w2'], approvedAt: null, status: 'open' as const };
  const adopted = new Map([
    ['w1', { verb: 'adopt' as const, ref }],
    ['w2', null],
  ]);
  const other = { adapter: 'codex-desktop', id: 't2' };

  test('approves an ask that holds an adopted card, or whose new card continues a tracked session', () => {
    expect(isNeoTrackedFollowUp(open, adopted, undefined, [ref])).toBe(true);
    expect(isNeoTrackedFollowUp(open, adopted, undefined, [])).toBe(false);
    expect(isNeoTrackedFollowUp(open, new Map(), { verb: 'send', ref }, [ref])).toBe(true);
  });

  test('leaves other asks, approved ones and settled ones alone', () => {
    expect(isNeoTrackedFollowUp(open, new Map(), { verb: 'send', ref: other }, [ref])).toBe(false);
    expect(isNeoTrackedFollowUp(open, new Map(), undefined, [ref])).toBe(false);
    expect(isNeoTrackedFollowUp({ ...open, approvedAt: 5 }, adopted, undefined, [])).toBe(false);
    expect(isNeoTrackedFollowUp({ ...open, status: 'achieved' }, adopted, undefined, [])).toBe(
      false
    );
    expect(isNeoTrackedFollowUp(null, adopted, undefined, [ref])).toBe(false);
  });
});

describe('reserveNeoAdoption', () => {
  test('lets one adoption of a session run at a time', () => {
    const adopting = new Set<string>();
    const adopt = { verb: 'adopt' as const, ref };
    expect(reserveNeoAdoption(adopting, { verb: 'send', ref })).toEqual({ value: null });
    expect(reserveNeoAdoption(adopting, adopt)).toEqual({ value: key });
    expect(reserveNeoAdoption(adopting, adopt)).toMatchObject({ reason: { ok: false } });
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
  test('follows a named session from any Neo turn without a Track timer', () => {
    expect(requireNeoTrackedAdoption({ verb: 'adopt', ref }, [], 'ok')).toEqual({ value: 'ok' });
    expect(requireNeoTrackedAdoption({ verb: 'send', ref }, [ref], 'ok')).toEqual({ value: 'ok' });
  });
  test('keeps the duplicate-follow guard', () => {
    expect(requireNeoTrackedAdoption({ verb: 'adopt', ref }, [ref], 'ok')).toEqual({
      reason: { ok: false, reason: 'A Neo card already follows this session.' },
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
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('a restart mid-adoption finishes adopting instead of failing the card', async () => {
    const { work: card } = service.driverTargets.propose(
      service.repo,
      {
        id: 'w-adopt',
        requestKey: 'root:adopt',
        projectId: null,
        originSessionId: 'neo:root',
        title: 'Quiet-model research',
        instruction: 'Follow the research session.',
      },
      { verb: 'adopt', ref }
    );
    service.repo.transitionWork(card.id, card, { status: 'queued' });
    await service.recover();
    expect(service.repo.getWork(card.id)).toMatchObject({
      status: 'queued',
      report: expect.stringContaining('Tracking the codex-desktop session'),
    });
    expect(service.driverTargets.cardRefs(0)).toEqual([{ workId: card.id, ref }]);
    expect(sent).not.toHaveBeenCalled();
    expect(service.driverTargets.readSent(card.id)).toBeNull();
    Object.assign(service, { returnReport: async () => {} });
    status = { status: 'done', lastActivityAt: Date.now() + 10_000 };
    await service.refreshDriverWork();
    expect(service.repo.getWork(card.id)?.status).toBe('reported');
  });

  test('a follow-up card on a tracked session is approved, so Neo starts it without a Start click', async () => {
    const neo = {
      source: 'mcp' as const,
      sessionId: 'neo:root',
      role: 'neo' as const,
      neoTurn: { messageId: 'turn-2', human: true, isLive: () => true },
    };
    const registry = createOperationRegistry(createNeoOperations(service));
    expect(service.trackedSessions.size).toBe(0);
    const adopted = await invokeOperation(
      registry,
      'neo.work.propose',
      {
        requestKey: 'track',
        title: 'Quiet-model research',
        instruction: 'Follow the research session.',
        goal: 'Finish the quiet-model research',
        doneWhen: '- the research is written up',
        work: { verb: 'adopt', ref },
      },
      neo
    );
    expect(adopted).toMatchObject({ value: { ok: true } });
    expect(service.driverTargets.adoptedRefs(0)).toEqual([ref]);
    const propose = async (label: string, target: { adapter: string; id: string }) => {
      const proposed = await invokeOperation(
        registry,
        'neo.work.propose',
        {
          title: 'Finish the write-up',
          instruction: `Write up the findings (${label}).`,
          goal: 'A finished write-up',
          doneWhen: '- the write-up is in the thread',
          work: { verb: 'send', ref: target },
        },
        neo
      );
      const card = (proposed as { value: { work: { id: string } } }).value.work;
      return service.askRecords.forWork(card.id);
    };
    expect((await propose('follow-up', ref))?.approvedAt).not.toBeNull();
    expect(
      (await propose('elsewhere', { adapter: 'codex-desktop', id: 't9' }))?.approvedAt ?? null
    ).toBeNull();
    const card = service.repo.getWork(
      (adopted as { value: { work: { id: string } } }).value.work.id
    )!;
    service.repo.transitionWork(card.id, card, {
      status: 'reported',
      report: NEO_WORK_CLOSED_DONE,
    });
    expect(service.driverTargets.adoptedRefs(0)).toEqual([]);
    expect((await propose('after-close', ref))?.approvedAt ?? null).toBeNull();
  });

  test('Neo follows without a Track tap in a system turn but never approves the existing ask', async () => {
    const neo = {
      source: 'mcp' as const,
      sessionId: 'neo:root',
      role: 'neo' as const,
      neoTurn: { messageId: 'turn-1', human: false, isLive: () => true },
    };
    const registry = createOperationRegistry(createNeoOperations(service));
    expect(service.trackedSessions.size).toBe(0);
    const askId = service.askRecords.open(
      {
        id: crypto.randomUUID(),
        requestKey: 'neo:root:research',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'turn-0',
        title: 'Research',
        ask: 'Research quiet models',
        doneWhen: '- done',
        doneSource: 'human',
      },
      [{ text: 'done', check: null }]
    )!.id;
    const proposed = await invokeOperation(
      registry,
      'neo.work.propose',
      {
        requestKey: 'track',
        title: 'Quiet-model research',
        instruction: 'Follow the research session.',
        askId,
        delivers: [],
        work: { verb: 'adopt', ref },
      },
      neo
    );
    const card = (proposed as { value: { work: { id: string } } }).value.work;
    expect(service.repo.getWork(card.id)?.status).toBe('queued');
    expect(service.askRecords.get(askId)?.approvedAt ?? null).toBeNull();
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
