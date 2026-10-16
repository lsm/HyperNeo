import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { buildNeoCheckRegistry } from '../../../../src/lib/neo/packs/check-registry.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { neoOutcomeEligibility } from '../../../../src/lib/neo/work-admission.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const target: NeoDriverTarget = {
  verb: 'start',
  adapter: 'codex-desktop',
  place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' },
};
const startedReply = { ok: true, value: { ref: { adapter: 'codex-desktop', id: 't1' } } };

async function setup(reply: (input: unknown) => unknown = () => startedReply) {
  const db = await createTestDb();
  const starts: unknown[] = [];
  const operation = (name: string) =>
    defineOperation({
      name,
      description: name,
      inputSchema: z.record(z.string(), z.unknown()),
      resultSchema: z.unknown(),
      execute: async (input) => {
        if (name !== 'work.start') return { ok: true, value: { stopped: true } };
        starts.push(input);
        return reply(input);
      },
    });
  const registry = createOperationRegistry([operation('work.start'), operation('work.stop')]);
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  for (const id of ['a', 'b']) {
    service.driverTargets.propose(
      service.repo,
      {
        id,
        requestKey: `root:${id}`,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: `m-${id}`,
        title: `Card ${id}`,
        instruction: `Do ${id}.`,
      },
      target
    );
    service.askRecords.open(
      {
        id: `ask-${id}`,
        requestKey: `ask-${id}`,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: `m-${id}`,
        title: `Ask ${id}`,
        ask: id,
        doneWhen: id,
        doneSource: 'human',
      },
      [{ text: `Outcome ${id}`, check: null, deliveredBy: id }]
    );
    service.askRecords.approve(`ask-${id}`, Date.now(), 0);
  }
  const edit = service.dependencies.replace(
    { workId: 'b', dependsOn: ['a'], expectedRevision: 0 },
    new Set(['a', 'b']),
    Date.now()
  );
  service.askRecords.approve('ask-b', Date.now(), edit.revision);
  const tick = (metBy: NeoAskItem['metBy'], verify: boolean) => {
    const item = service.askRecords.get('ask-a')!.doneItems![0];
    service.askRecords.tickItem(
      'ask-a',
      { ...item, state: 'met', evidence: 'done', metBy },
      Date.now(),
      item,
      verify
    );
  };
  return { db, service, starts, tick };
}

describe('neoOutcomeEligibility', () => {
  const pack = {
    id: 'coding',
    checks: { 'coding.pr_merged': mock(), 'coding.reported': mock() },
    checkEvidence: { 'coding.pr_merged': { independent: true } },
  } as unknown as NeoPack;
  const eligible = neoOutcomeEligibility(buildNeoCheckRegistry([pack]));
  const ask = {} as NeoAsk;
  const item = (metBy: NeoAskItem['metBy'], check: string | null) =>
    ({ metBy, check }) as NeoAskItem;

  test('only human answers, independent daemon checks and published answers release dependents', () => {
    expect(eligible(ask, item('human', null))).toBe(true);
    expect(eligible(ask, { ...item('daemon', null), outcomeKind: 'answer' })).toBe(true);
    expect(eligible(ask, { ...item('neo', null), outcomeKind: 'answer' })).toBe(false);
    expect(eligible(ask, item('daemon', 'coding.pr_merged'))).toBe(true);
    expect(eligible(ask, item('daemon', 'coding.reported'))).toBe(false);
    expect(eligible(ask, item('daemon', 'legal.signed'))).toBe(false);
    expect(eligible(ask, item('daemon', null))).toBe(false);
    expect(eligible(ask, item('neo', 'coding.pr_merged'))).toBe(false);
    expect(
      neoOutcomeEligibility({ ok: false, reason: 'duplicate_pack: coding' })(
        ask,
        item('daemon', 'coding.pr_merged')
      )
    ).toBe(false);
  });
});

describe('NeoService.admitWork', () => {
  test('a self-attested prerequisite blocks the dependent with no worker effect', async () => {
    const { db, service, starts, tick } = await setup();
    try {
      tick('neo', false);
      expect(await service.admitWork('b', false)).toEqual({
        ok: false,
        reason: 'prerequisites_unmet',
        blockers: [{ workId: 'a', reason: 'outcomes_unverified', itemIds: ['i1'] }],
      });
      expect(starts).toHaveLength(0);
      expect(service.driverTargets.readCard('b')?.claimedAt).toBeNull();
      expect(service.repo.getWork('b')?.status).toBe('proposed');
    } finally {
      db.close();
    }
  });

  test('a recorded human answer releases the dependent exactly once', async () => {
    const { db, service, starts, tick } = await setup();
    try {
      tick('human', true);
      const [first, second] = await Promise.all([
        service.admitWork('b', false),
        service.admitWork('b', false),
      ]);
      expect([first, second]).toContainEqual({ ok: true, handoff: 'started' });
      expect([first, second]).toContainEqual({ ok: false, reason: 'already_claimed' });
      expect(starts).toHaveLength(1);
      expect(service.driverTargets.readRef('b')).toEqual({ adapter: 'codex-desktop', id: 't1' });
      expect(await service.admitWork('b', false)).toEqual({
        ok: false,
        reason: 'already_started',
      });
    } finally {
      db.close();
    }
  });

  test('a start already in flight shares the driver start, and a claim from before boot is uncertain', async () => {
    const { db, service, starts } = await setup();
    try {
      const [, admitted] = await Promise.all([service.start('a'), service.admitWork('a', true)]);
      expect(admitted).toEqual({ ok: true, handoff: 'started' });
      expect(starts).toHaveLength(1);
      service.repo.transitionWork('b', service.repo.getWork('b')!, { status: 'queued' });
      db.getDatabase()
        .prepare('UPDATE neo_work_driver_targets SET claimed_at = 1 WHERE work_id = ?')
        .run('b');
      expect(await service.admitWork('b', true)).toEqual({
        ok: false,
        reason: 'handoff_uncertain',
      });
      expect(starts).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('automatic admission needs the current approved revision; a human start does not', async () => {
    const { db, service, starts } = await setup();
    try {
      const ask = service.askRecords.get('ask-a')!;
      db.getDatabase()
        .prepare('UPDATE neo_asks SET revision = revision + 1 WHERE id = ?')
        .run(ask.id);
      expect(await service.admitWork('a', false)).toEqual({
        ok: false,
        reason: 'approval_stale',
      });
      db.getDatabase()
        .prepare('UPDATE neo_asks SET approved_at = NULL, approved_revision = NULL WHERE id = ?')
        .run(ask.id);
      expect(await service.admitWork('a', false)).toEqual({ ok: false, reason: 'not_approved' });
      db.getDatabase()
        .prepare('UPDATE neo_asks SET approved_at = 1, approved_revision = revision WHERE id = ?')
        .run(ask.id);
      expect(await service.admitWork('a', false)).toEqual({
        ok: true,
        handoff: 'started',
      });
      expect(starts).toHaveLength(1);
      expect(await service.admitWork('a', true)).toEqual({ ok: false, reason: 'already_started' });
      expect(starts).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('a refused start releases the claim and a thrown handoff stays blocked as uncertain', async () => {
    const { db, service, starts } = await setup(() => ({
      ok: false,
      reason: 'not_open',
      detail: 'gone',
    }));
    try {
      expect(await service.admitWork('a', true)).toEqual({ ok: true, handoff: 'not_started' });
      expect(service.repo.getWork('a')?.status).toBe('failed');
      expect(service.driverTargets.readCard('a')?.claimedAt).toBeNull();
      service.repo.transitionWork('a', service.repo.getWork('a')!, { status: 'proposed' });
      Object.assign(service, {
        startReservedWork: async () => {
          throw new Error('socket closed');
        },
      });
      await expect(service.admitWork('a', true)).rejects.toThrow('socket closed');
      expect(await service.admitWork('a', true)).toEqual({
        ok: false,
        reason: 'handoff_uncertain',
      });
      expect(starts).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
