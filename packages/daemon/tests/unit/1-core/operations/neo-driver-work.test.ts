import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  driverWorkCall,
  driverWorkCaller,
  readDriverOutcome,
  type NeoDriverTarget,
} from '../../../../src/lib/neo/driver-work.ts';
import { requireNeoExecutionChoice } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb } from '../../../helpers/database.ts';

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
  async function setup(reply: unknown) {
    const db = await createTestDb();
    const calls: Array<{ name: string; input: unknown; caller: OperationCaller }> = [];
    const operation = (name: string) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        execute: async (input, caller) => {
          calls.push({ name, input, caller });
          return reply;
        },
      });
    const registry = createOperationRegistry([operation('work.start'), operation('work.send')]);
    const service = new NeoService(
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
      expect(service.driverTargets.readRef('work-1')).toEqual(ref);
      await service.start('work-1');
      expect(calls).toHaveLength(1);
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
    const returned: string[] = [];
    Object.assign(service, {
      returnReport: async (failed: { id: string }) => {
        returned.push(failed.id);
      },
    });
    try {
      await service.start('work-1');
      expect(returned).toEqual(['work-1']);
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
