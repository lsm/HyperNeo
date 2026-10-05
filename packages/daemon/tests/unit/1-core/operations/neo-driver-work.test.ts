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
    status: () => unknown = () => ({ ok: false, reason: 'unreachable', detail: 'down' })
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
      startTarget
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

describe('readDriverSettlement', () => {
  const work = { updatedAt: 100 };
  const status = (value: Record<string, unknown>) => ({
    kind: 'completed' as const,
    value: { ok: true, value: { lastActivityAt: 200, ...value } },
  });

  test('settles finished, failed and stopped work that moved after it was handed over', () => {
    expect(readDriverSettlement(work, status({ status: 'done', lastReply: 'Shipped.' }))).toEqual({
      status: 'reported',
      report: 'Shipped.',
    });
    expect(readDriverSettlement(work, status({ status: 'done' }))).toEqual({
      status: 'reported',
      report: 'It finished without a written reply.',
    });
    expect(
      readDriverSettlement(work, status({ status: 'failed', lastReply: 'Tests broke.' }))
    ).toEqual({ status: 'failed', report: 'It failed. Tests broke.' });
    expect(readDriverSettlement(work, status({ status: 'stopped' }))).toEqual({
      status: 'failed',
      report: 'It stopped.',
    });
  });

  test('keeps waiting on running, stale, unreachable or unreadable status, and fails gone work', () => {
    expect(readDriverSettlement(work, status({ status: 'running' }))).toBeNull();
    expect(readDriverSettlement(work, status({ status: 'needs_you' }))).toBeNull();
    expect(readDriverSettlement(work, status({ status: 'done', lastActivityAt: 100 }))).toBeNull();
    expect(
      readDriverSettlement(work, {
        kind: 'completed',
        value: { ok: false, reason: 'unreachable', detail: 'laptop asleep' },
      })
    ).toBeNull();
    expect(readDriverSettlement(work, { kind: 'completed', value: 'nope' })).toBeNull();
    expect(
      readDriverSettlement(work, { kind: 'failed', code: 'execution_failed', message: 'boom' })
    ).toBeNull();
    expect(
      readDriverSettlement(work, {
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
      expect(await propose({ targetSessionId: null })).toMatchObject({
        value: { ok: false, reason: 'This request key belongs to another execution target.' },
      });
      expect(await propose({ work: startTarget })).toMatchObject({ value: { ok: false } });
    } finally {
      service.dispose();
      db.close();
    }
  });
});
