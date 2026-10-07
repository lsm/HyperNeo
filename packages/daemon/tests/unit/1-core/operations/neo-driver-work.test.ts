import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  driverWorkCall,
  driverWorkCaller,
  type NeoDriverTarget,
  readDriverNeedsYou,
  readDriverOutcome,
  readDriverSettlement,
} from '../../../../src/lib/neo/driver-work.ts';
import {
  createNeoOperations,
  requireNeoExecutionChoice,
} from '../../../../src/lib/neo/operations.ts';
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
const startTarget: NeoDriverTarget = { verb: 'start', adapter: 'codex-desktop', place };
const sendTarget: NeoDriverTarget = {
  verb: 'send',
  ref: { adapter: 'hyperneo', id: 's1' },
};
const work = { title: 'Bigger font', instruction: 'Raise the body font to 16px.' };

describe('requireNeoExecutionChoice', () => {
  const neo = { source: 'mcp' as const, sessionId: 'neo:root', role: 'neo' as const };

  test('accepts a drivers target as the explicit choice and refuses it next to a chat', () => {
    expect(requireNeoExecutionChoice({ work: sendTarget }, neo)).toEqual({ value: neo });
    expect(
      requireNeoExecutionChoice({ work: sendTarget, targetSessionId: 's1' }, neo)
    ).toMatchObject({ reason: { ok: false } });
  });

  test('refuses a start in a place with no folder or Space before a card exists', () => {
    const chats = { machine: 'laptop', name: 'Chats' };
    expect(
      requireNeoExecutionChoice({ work: { verb: 'start', adapter: 'hyperneo', place: chats } }, neo)
    ).toMatchObject({
      reason: {
        ok: false,
        reason: expect.stringContaining('ask the human where the work belongs'),
      },
    });
    expect(
      requireNeoExecutionChoice(
        { work: { verb: 'start', adapter: 'space', place: { ...chats, spaceId: 'sp1' } } },
        neo
      )
    ).toEqual({ value: neo });
    expect(requireNeoExecutionChoice({ work: startTarget }, neo)).toEqual({ value: neo });
  });
});

describe('driverWorkCall', () => {
  test('starts new work with the title and instruction, or sends the instruction', () => {
    expect(driverWorkCall(startTarget, work)).toEqual({
      name: 'work.start',
      input: {
        adapter: 'codex-desktop',
        place,
        title: 'Bigger font',
        message: 'Raise the body font to 16px.',
      },
    });
    expect(driverWorkCall(sendTarget, work)).toEqual({
      name: 'work.send',
      input: { ref: { adapter: 'hyperneo', id: 's1' }, message: 'Raise the body font to 16px.' },
    });
  });
});

describe('driverWorkCaller', () => {
  test('runs as Neo from the session that proposed the work', () => {
    expect(driverWorkCaller({ originSessionId: 'neo:root' })).toEqual({
      source: 'internal',
      sessionId: 'neo:root',
      role: 'neo',
    });
  });
});

describe('readDriverOutcome', () => {
  test('keeps the started ref, or the sent-to ref, and explains every failure', () => {
    const started = { ref: { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' }, title: 'x' };
    expect(
      readDriverOutcome(startTarget, { kind: 'completed', value: { ok: true, value: started } })
    ).toEqual({ ref: started.ref });
    expect(
      readDriverOutcome(sendTarget, {
        kind: 'completed',
        value: { ok: true, value: { delivered: false } },
      })
    ).toEqual({ ref: sendTarget.ref });
    expect(
      readDriverOutcome(sendTarget, {
        kind: 'completed',
        value: { ok: false, reason: 'not_open', detail: 'archived' },
      })
    ).toEqual({ failure: 'not_open: archived' });
    expect(
      readDriverOutcome(startTarget, { kind: 'failed', code: 'execution_failed', message: 'boom' })
    ).toEqual({ failure: 'boom' });
    expect(readDriverOutcome(startTarget, { kind: 'completed', value: 'nope' })).toEqual({
      failure: 'The work operation returned an unusable reply.',
    });
  });
});

describe('Neo work with a drivers target', () => {
  async function setup(
    reply: unknown,
    during?: (service: NeoService) => Promise<void>,
    status: () => unknown = () => ({ ok: false, reason: 'unreachable', detail: 'down' }),
    target: NeoDriverTarget = startTarget
  ) {
    const db = await createTestDb();
    const calls: Array<{ name: string; input: unknown; caller: OperationCaller }> = [];
    let service: NeoService;
    const operation = (name: string) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        execute: async (input, caller) => {
          calls.push({ name, input, caller });
          if (name === 'work.start') await during?.(service);
          if (name === 'work.status') return status();
          return name === 'work.stop' ? { ok: true, value: { stopped: true } } : reply;
        },
      });
    const registry = createOperationRegistry([
      operation('work.start'),
      operation('work.send'),
      operation('work.stop'),
      operation('work.status'),
    ]);
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    const proposed = service.driverTargets.propose(
      service.repo,
      {
        id: 'work-1',
        requestKey: 'root:font',
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: work.title,
        instruction: work.instruction,
      },
      target
    );
    return { db, service, calls, proposed };
  }

  test('starts the work through work.start as Neo and keeps the ref', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls, proposed } = await setup({ ok: true, value: { ref } });
    try {
      expect(proposed.target).toEqual(startTarget);
      await service.start('work-1');
      expect(calls).toEqual([
        {
          name: 'work.start',
          input: driverWorkCall(startTarget, work).input,
          caller: { source: 'internal', sessionId: 'neo:root', role: 'neo' },
        },
      ]);
      expect(service.repo.getWork('work-1')).toMatchObject({ status: 'queued', sessionId: null });
      expect(service.repo.getWork('work-1')?.report).toContain(
        `Follow up with work.status ${JSON.stringify({ ref })}`
      );
      expect(service.driverTargets.readRef('work-1')).toEqual(ref);
      await service.start('work-1');
      expect(calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('stops work that was cancelled while it was starting', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } }, (neo) =>
      neo.cancel('work-1')
    );
    try {
      await service.start('work-1');
      expect(calls.map((call) => [call.name, call.input])).toEqual([
        ['work.start', driverWorkCall(startTarget, work).input],
        ['work.stop', { ref }],
      ]);
      expect(service.repo.getWork('work-1')?.status).toBe('cancelled');
    } finally {
      db.close();
    }
  });

  test('stops started work when it is cancelled later', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } });
    try {
      await service.start('work-1');
      await service.cancel('work-1');
      expect(calls.map((call) => call.name)).toEqual(['work.start', 'work.stop']);
      expect(service.repo.getWork('work-1')?.status).toBe('cancelled');
    } finally {
      db.close();
    }
  });

  test('settles started work from work.status once it finishes and reports back', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    let reply: unknown = { ok: true, value: { status: 'running', lastActivityAt: 0 } };
    const { db, service, calls } = await setup(
      { ok: true, value: { ref } },
      undefined,
      () => reply
    );
    const returned: string[] = [];
    Object.assign(service, {
      returnReport: async (settled: { id: string }) => {
        returned.push(settled.id);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
      reply = {
        ok: true,
        value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Font is 16px.' },
      };
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'reported',
        report: 'Font is 16px.',
      });
      expect(returned).toEqual(['work-1']);
      expect(calls.filter((call) => call.name === 'work.status').map((call) => call.input)).toEqual(
        [{ ref }, { ref }]
      );
    } finally {
      db.close();
    }
  });

  test('keeps refreshing when returning one report fails and returns it again on recovery', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'failed', lastActivityAt: Date.now() + 1_000 },
    }));
    Object.assign(service, {
      returnReport: async () => {
        throw new Error('mailbox rejected');
      },
    });
    try {
      await service.start('work-1');
      await expect(service.refreshDriverWork()).resolves.toBeUndefined();
      expect(service.repo.getWork('work-1')?.status).toBe('failed');
      const returned: string[] = [];
      Object.assign(service, {
        returnReport: async (work: { id: string }) => {
          returned.push(work.id);
        },
      });
      await service.reconcile('work-1');
      expect(returned).toEqual(['work-1']);
    } finally {
      db.close();
    }
  });

  test('tells the proposing session once each time started work comes to need the user', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const at = (status: string, lastActivityAt: number) => ({
      ok: true,
      value: { status, lastActivityAt, lastReply: 'Approve the migration?' },
    });
    let reply: unknown = at('running', 0);
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    const notes: Array<[string, string]> = [];
    Object.assign(service, {
      deliver: async (target: string, messageId: string, content: string) => {
        notes.push([target, messageId]);
        expect(content).toContain('Approve the migration?');
      },
    });
    try {
      await service.start('work-1');
      reply = at('needs_you', 5);
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      reply = at('running', 6);
      await service.refreshDriverWork();
      reply = at('needs_you', 7);
      await service.refreshDriverWork();
      expect(notes).toEqual([
        ['neo:root', 'work-1:needs-you:5'],
        ['neo:root', 'work-1:needs-you:7'],
      ]);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      db.close();
    }
  });

  test('records the live status and link of sent work without settling it', async () => {
    const reply = {
      ok: true,
      value: { status: 'running', lastActivityAt: 1, link: 'codex://threads/s1' },
    };
    const { db, service } = await setup(
      { ok: true, value: { delivered: true } },
      undefined,
      () => reply,
      sendTarget
    );
    try {
      expect(service.driverTargets.receipts(['work-1'])).toEqual([
        { workId: 'work-1', adapter: 'hyperneo', daemon: null, status: null, link: null },
      ]);
      await service.start('work-1');
      let changes = 0;
      Object.assign(service, { notifyChanged: () => changes++ });
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      expect(changes).toBe(1);
      expect(service.driverTargets.receipts(['work-1', 'missing'])).toEqual([
        {
          workId: 'work-1',
          adapter: 'hyperneo',
          daemon: null,
          status: 'running',
          link: 'codex://threads/s1',
        },
      ]);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      db.close();
    }
  });

  test('leaves a message sent to existing work for Neo to follow up', async () => {
    const done = { ok: true, value: { status: 'done', lastActivityAt: Date.now() + 1_000 } };
    const { db, service, calls } = await setup(
      { ok: true, value: { delivered: false } },
      undefined,
      () => done,
      sendTarget
    );
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
      expect(calls.map((call) => call.name)).toEqual(['work.send', 'work.status']);
    } finally {
      db.close();
    }
  });

  test('fails queued work without a ref instead of starting it twice', async () => {
    const { db, service, calls } = await setup({ ok: true, value: { ref: null } });
    Object.assign(service, { returnReport: async () => {} });
    try {
      const proposed = service.repo.getWork('work-1');
      if (proposed) service.repo.transitionWork('work-1', proposed, { status: 'queued' });
      await service.start('work-1');
      expect(calls).toEqual([]);
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'failed',
        report: expect.stringContaining('check work.find'),
      });
    } finally {
      db.close();
    }
  });

  test('fails the work with the adapter reason when it cannot start', async () => {
    const { db, service } = await setup({
      ok: false,
      reason: 'invalid_place',
      detail: '/focus/dolmen does not exist.',
    });
    const delivered: Array<[string, string, string]> = [];
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, {
      open: async () => 'neo:root',
      deliver: async (target: string, messageId: string, _content: string, origin: string) => {
        delivered.push([target, messageId, origin]);
      },
    });
    try {
      await service.start('work-1');
      expect(delivered).toEqual([['neo:root', 'work-1', 'neo:root']]);
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'failed',
        report: 'Could not start the execution: invalid_place: /focus/dolmen does not exist.',
      });
      expect(service.driverTargets.readRef('work-1')).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('readDriverNeedsYou', () => {
  test('reads whether the work waits on the user, and ignores failures', () => {
    expect(
      readDriverNeedsYou({
        kind: 'completed',
        value: { ok: true, value: { status: 'needs_you', lastActivityAt: 9, lastReply: 'Allow?' } },
      })
    ).toEqual({ needsYou: true, since: 9, lastReply: 'Allow?' });
    expect(
      readDriverNeedsYou({
        kind: 'completed',
        value: { ok: true, value: { status: 'running', lastActivityAt: 9 } },
      })
    ).toMatchObject({ needsYou: false });
    expect(
      readDriverNeedsYou({
        kind: 'completed',
        value: { ok: false, reason: 'unreachable', detail: 'asleep' },
      })
    ).toBeNull();
    expect(
      readDriverNeedsYou({ kind: 'failed', code: 'execution_failed', message: 'boom' })
    ).toBeNull();
  });
});

describe('readDriverSettlement', () => {
  const work = { updatedAt: 100 };
  const status = (value: Record<string, unknown>) => ({
    kind: 'completed' as const,
    value: { ok: true, value: { lastActivityAt: 200, ...value } },
  });

  test('settles finished, failed and stopped work that moved after it was handed over', () => {
    const settle = (outcome: Parameters<typeof readDriverSettlement>[1], now = 150) =>
      readDriverSettlement(work, outcome, now);
    expect(settle(status({ status: 'done', lastReply: 'Shipped.' }))).toEqual({
      status: 'reported',
      report: 'Shipped.',
    });
    expect(settle(status({ status: 'done' }))).toEqual({
      status: 'reported',
      report: 'It finished without a written reply.',
    });
    expect(settle(status({ status: 'failed', lastReply: 'Tests broke.' }))).toEqual({
      status: 'failed',
      report: 'It failed. Tests broke.',
    });
    expect(settle(status({ status: 'stopped' }))).toEqual({
      status: 'failed',
      report: 'It stopped.',
    });
  });

  test('compares status with the start time the backend reported, on its own clock', () => {
    const work = { updatedAt: 100 };
    const done = {
      kind: 'completed' as const,
      value: { ok: true, value: { status: 'done', lastActivityAt: 250 } },
    };
    expect(readDriverSettlement(work, done, 150, 300)).toBeNull();
    expect(readDriverSettlement(work, done, 150, 200)).toMatchObject({ status: 'reported' });
  });

  test('keeps waiting on running, unreachable or unreadable status and briefly on stale status, and fails gone work', () => {
    const settle = (outcome: Parameters<typeof readDriverSettlement>[1], now = 150) =>
      readDriverSettlement(work, outcome, now);
    expect(settle(status({ status: 'running' }))).toBeNull();
    expect(settle(status({ status: 'needs_you' }))).toBeNull();
    expect(settle(status({ status: 'done', lastActivityAt: 100 }))).toBeNull();
    expect(settle(status({ status: 'done', lastActivityAt: 100 }), 100 + 10 * 60_000)).toEqual({
      status: 'reported',
      report: 'It finished without a written reply.',
    });
    expect(
      settle({
        kind: 'completed',
        value: { ok: false, reason: 'unreachable', detail: 'laptop asleep' },
      })
    ).toBeNull();
    expect(settle({ kind: 'completed', value: 'nope' })).toBeNull();
    expect(settle({ kind: 'failed', code: 'execution_failed', message: 'boom' })).toBeNull();
    expect(
      settle({
        kind: 'completed',
        value: { ok: false, reason: 'not_found', detail: 'thread deleted' },
      })
    ).toEqual({ status: 'failed', report: 'The work is gone: thread deleted' });
  });
});

describe('neo.work.propose with a drivers target', () => {
  test('keeps a request key bound to its drivers target', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('root'));
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
    const neo: OperationCaller = {
      source: 'mcp',
      sessionId: 'root',
      role: 'neo',
      neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
    };
    const propose = (target: Record<string, unknown>) =>
      invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.work.propose',
        { requestKey: 'font', title: work.title, instruction: work.instruction, ...target },
        neo
      );
    try {
      expect(await propose({ work: sendTarget })).toMatchObject({
        kind: 'completed',
        value: { ok: true },
      });
      expect(await propose({ work: sendTarget })).toMatchObject({ value: { ok: true } });
      expect(await propose({ targetSessionId: 'other' })).toMatchObject({
        value: { ok: false },
      });
      expect(await propose({ work: startTarget })).toMatchObject({ value: { ok: false } });
    } finally {
      service.dispose();
      db.close();
    }
  });
});
