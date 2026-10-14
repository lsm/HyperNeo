import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { requireNeoAskStalled } from '../../../../src/lib/neo/ask-stall.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const worker = { adapter: 'claude-desktop', id: 'idle' };
const sendTarget: NeoDriverTarget = { verb: 'send', ref: worker };

async function setup() {
  const db = await createTestDb();
  const operation = (name: string) =>
    defineOperation({
      name,
      description: name,
      inputSchema: z.record(z.string(), z.unknown()),
      resultSchema: z.unknown(),
      execute: async () => ({ ok: true, value: { ref: worker } }),
    });
  const registry = createOperationRegistry(['work.start', 'work.stop'].map(operation));
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  for (const id of ['a', 'b', 'c']) {
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
      sendTarget
    );
    service.askRecords.open(
      {
        id: `ask-${id}`,
        requestKey: `ask-${id}`,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: `m-${id}`,
        title: id,
        ask: id,
        doneWhen: id,
        doneSource: 'human',
      },
      [{ text: `Outcome ${id} merged`, check: null, deliveredBy: id }]
    );
  }
  expect(service.editDependencies('b', ['a'])).toMatchObject({ ok: true });
  const answer = () => {
    const item = service.askRecords.get('ask-a')!.doneItems![0];
    service.askRecords.tickItem(
      'ask-a',
      { ...item, state: 'met', evidence: 'The human answered: merged', metBy: 'human' },
      Date.now(),
      item,
      true
    );
  };
  return { db, service, answer };
}

describe('NeoService.cardWaits', () => {
  test('a blocked card names its prerequisite and unmet outcome until it is verified', async () => {
    const { db, service, answer } = await setup();
    try {
      const waitingFor = [
        {
          workId: 'a',
          title: 'Card a',
          reason: 'outcomes_unverified',
          items: [{ id: 'i1', text: 'Outcome a merged' }],
        },
      ];
      expect(service.cardWaits(['a', 'b', 'c'])).toEqual([
        { workId: 'b', waitingFor, autoStart: false, uncertain: false },
      ]);
      answer();
      expect(service.cardWaits(['a', 'b', 'c'])).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a blocked card starts automatically only when authorized and automatic dispatch is on', async () => {
    const { db, service } = await setup();
    try {
      const autoStart = () => service.cardWaits(['b'])[0]?.autoStart;
      db.updateGlobalSettings({ neo: { autoDispatch: true } });
      expect(autoStart()).toBe(false);
      service.askRecords.approve('ask-b', Date.now(), service.askRecords.get('ask-b')!.revision!);
      expect(autoStart()).toBe(true);
      db.updateGlobalSettings({ neo: { autoDispatch: false } });
      expect(autoStart()).toBe(false);
    } finally {
      db.close();
    }
  });

  test('a start that may have happened reads as uncertain, not as a prerequisite wait', async () => {
    const { db, service } = await setup();
    try {
      service.repo.transitionWork('c', service.repo.getWork('c')!, { status: 'failed' });
      service.driverTargets.recordStartInterrupted('c');
      expect(service.cardWaits(['c'])).toEqual([
        { workId: 'c', waitingFor: [], autoStart: false, uncertain: true },
      ]);
    } finally {
      db.close();
    }
  });

  test('the snapshot carries the waiting fields on the card', async () => {
    const { db, service } = await setup();
    try {
      const outcome = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        { all: true },
        { source: 'rpc', principal: 'local' }
      );
      const cards = (outcome as { value: { cards: { workId: string }[] } }).value.cards;
      expect(cards.find((card) => card.workId === 'b')).toMatchObject({
        waitingFor: [{ workId: 'a', reason: 'outcomes_unverified' }],
        autoStart: false,
      });
      expect(cards.find((card) => card.workId === 'c')).not.toHaveProperty('waitingFor');
    } finally {
      db.close();
    }
  });
});

describe('requireNeoAskStalled', () => {
  test('an ask whose card waits on prerequisites is never reported as stalled', () => {
    expect(
      requireNeoAskStalled(
        { status: 'open', updatedAt: 0 },
        { cards: [{ id: 'b', title: 'b', status: 'proposed', updatedAt: 0 }], session: true },
        10 * 60 * 60_000
      )
    ).toEqual({ reason: 'running' });
  });
});
