import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const neo: OperationCaller = {
  source: 'mcp',
  sessionId: 'neo:root',
  neoTurn: { messageId: 'm-a', human: false, isLive: () => true },
};
type Reply = (name: string, input: Record<string, unknown>) => unknown;
const started: Reply = () => ({ ok: true, value: { ref: { adapter: 'codex-desktop', id: 't1' } } });

async function setup(reply: Reply = started, target: NeoDriverTarget = startTargetOf()) {
  const db = await createTestDb();
  db.createSession(createTestSession('neo:root'));
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const operation = (name: string) =>
    defineOperation({
      name,
      description: name,
      inputSchema: z.record(z.string(), z.unknown()),
      resultSchema: z.unknown(),
      execute: async (input) => {
        calls.push({ name, input });
        return name === 'work.stop' ? { ok: true, value: { stopped: true } } : reply(name, input);
      },
    });
  const registry = createOperationRegistry(
    ['work.start', 'work.send', 'work.stop', 'work.status', 'work.find'].map(operation)
  );
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  Object.assign(service, { returnReport: async () => {}, deliver: async () => {} });
  service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  for (const id of ['a', 'b']) {
    service.driverTargets.propose(
      service.repo,
      {
        id,
        requestKey: `neo:root:${id}`,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: `m-${id}`,
        title: `Card ${id}`,
        instruction: `Do ${id}.`,
      },
      id === 'a' ? target : startTargetOf()
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
  const start = (id: string, caller = human) =>
    invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.work.start',
      { id },
      caller
    );
  return { db, service, calls, start };
}

function startTargetOf(): NeoDriverTarget {
  return { verb: 'start', adapter: 'codex-desktop', place };
}

const driverCalls = <Call extends { name: string }>(calls: Call[]) =>
  calls.filter((call) => ['work.start', 'work.send'].includes(call.name));

describe('neo.work.start', () => {
  test('a dependent whose prerequisite is only self-attested is refused with its blockers', async () => {
    const { db, service, calls, start } = await setup();
    try {
      const edit = service.dependencies.replace(
        { workId: 'b', dependsOn: ['a'], expectedRevision: 0 },
        new Set(['a', 'b']),
        Date.now()
      );
      service.askRecords.approve('ask-b', Date.now(), edit.revision);
      const item = service.askRecords.get('ask-a')!.doneItems![0];
      service.askRecords.tickItem(
        'ask-a',
        { ...item, state: 'met', evidence: 'Worker says done', metBy: 'neo' },
        Date.now(),
        item
      );
      expect(await start('b')).toEqual({
        kind: 'completed',
        value: {
          ok: false,
          reason: 'prerequisites_unmet',
          blockers: [{ workId: 'a', reason: 'outcomes_unverified', itemIds: ['i1'] }],
        },
      });
      expect(driverCalls(calls)).toHaveLength(0);
      expect(service.repo.getWork('b')?.status).toBe('proposed');
    } finally {
      db.close();
    }
  });

  test('Neo starting under an approval needs the current revision; the human does not', async () => {
    const { db, service, calls, start } = await setup();
    try {
      db.getDatabase()
        .prepare("UPDATE neo_asks SET revision = revision + 1 WHERE id = 'ask-a'")
        .run();
      expect(await start('a', neo)).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'approval_stale' },
      });
      expect(driverCalls(calls)).toHaveLength(0);
      expect(await start('a')).toMatchObject({
        value: { ok: true, work: { id: 'a', status: 'queued' } },
      });
      expect(service.driverTargets.readRef('a')).toEqual({ adapter: 'codex-desktop', id: 't1' });
      expect(await start('a')).toMatchObject({ value: { ok: true, work: { id: 'a' } } });
      expect(driverCalls(calls)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('an uncertain handoff stays blocked instead of launching another worker', async () => {
    const { db, service, calls, start } = await setup();
    try {
      service.driverTargets.recordStartInterrupted('a');
      expect(await start('a')).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'handoff_uncertain' },
      });
      service.repo.transitionWork('b', service.repo.getWork('b')!, { status: 'queued' });
      db.getDatabase()
        .prepare("UPDATE neo_work_driver_targets SET claimed_at = 1 WHERE work_id = 'b'")
        .run();
      expect(await start('b')).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'handoff_uncertain' },
      });
      expect(driverCalls(calls)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('a model or effort refusal fails the card with the driver reason and frees the claim', async () => {
    const { db, service, start } = await setup(() => ({
      ok: false,
      reason: 'unsupported_model',
      detail: 'codex-desktop cannot run that model',
    }));
    try {
      expect(await start('a')).toMatchObject({
        value: { ok: true, work: { id: 'a', status: 'failed' } },
      });
      expect(service.repo.getWork('a')?.report).toContain('unsupported_model');
      expect(service.driverTargets.readCard('a')?.claimedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  test('an archived send target proposes a replacement that needs its own question', async () => {
    const archived: WorkRef = { adapter: 'claude-desktop', id: 'archived' };
    const worker = (id: string) => ({
      ref: { ...archived, id },
      title: id,
      place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
      status: 'done',
      lastActivityAt: 100,
    });
    const found = (ids: string[]) => ({
      places: [
        {
          place: worker('x').place,
          lastActivityAt: 100,
          openCount: 1,
          archivedCount: 0,
          adapters: ['claude-desktop'],
          work: ids.map(worker),
        },
      ],
      unreachable: [],
    });
    const { db, service, calls, start } = await setup(
      (name, input) => {
        if (name === 'work.find') return found(input.id ? [String(input.id)] : ['fresh']);
        if (name === 'work.status') return { ok: true, value: { status: 'done' } };
        return (input.ref as WorkRef).id === 'archived'
          ? { ok: false, reason: 'not_open', detail: 'archived' }
          : { ok: true, value: { delivered: true } };
      },
      { verb: 'send', ref: archived }
    );
    try {
      expect(await start('a')).toMatchObject({
        value: { ok: true, work: { id: 'a', status: 'proposed' } },
      });
      expect(service.driverTargets.readRef('a')).toBeNull();
      expect(service.askRecords.forWork('a')?.doneItems?.at(-1)).toMatchObject({
        state: 'needs_you',
        question: '开始「Card a」？',
      });
      expect(await start('a')).toMatchObject({ value: { ok: false, reason: 'not_approved' } });
      expect(driverCalls(calls).map((call) => (call.input.ref as WorkRef).id)).toEqual([
        'archived',
      ]);
    } finally {
      db.close();
    }
  });

  test('an adopted session is tracked through admission without sending it anything', async () => {
    const ref: WorkRef = { adapter: 'hyperneo', id: 'adopted' };
    const { db, service, calls, start } = await setup(
      () => ({ ok: true, value: { status: 'running', lastActivityAt: 10 } }),
      { verb: 'adopt', ref }
    );
    try {
      expect(await start('a')).toMatchObject({
        value: { ok: true, work: { id: 'a', status: 'queued' } },
      });
      expect(service.driverTargets.readRef('a')).toEqual(ref);
      expect(driverCalls(calls)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
