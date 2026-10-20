import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter } from '../../../../src/lib/drivers/types';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { driverWorkCall, driverWorkCaller } from '../../../../src/lib/neo/driver-work';

const neo: OperationCaller = { source: 'internal', role: 'neo', sessionId: 'neo:own-root' };
const place = { machine: 'laptop', folder: '/synthetic/repo', name: 'repo' };
const line = (id: string) =>
  `Report progress, questions or blockers to Neo at any time, mid-work, with: hyperneo send ${id} "<text>" (not SendMessage). Keep working after you send.`;

function harness(adapter: string) {
  const received: string[] = [];
  const backend: WorkAdapter = {
    id: adapter,
    capabilities: ['send', 'start', 'queue'],
    find: () => [],
    send: async (_ref, message) => {
      received.push(message);
      return { ok: true, value: { delivered: true } };
    },
    queue: async (_ref, message) => {
      received.push(message);
      return { ok: true, value: { delivered: false, queuedSubmissionId: 'queued' } };
    },
    start: async (input) => {
      received.push(input.message);
      return {
        ok: true,
        value: {
          ref: { adapter, id: 'new' },
          title: input.title,
          place,
          status: 'running',
          lastActivityAt: 1,
        },
      };
    },
  };
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [backend],
      daemonName: 'laptop',
      remote: { list: () => [], invoke: async () => ({}) },
    })
  );
  const call = async (name: string, input: unknown, caller = neo) => {
    const result = await invokeOperation(registry, name, input, caller);
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') expect(result.value).toMatchObject({ ok: true });
  };
  return { received, call };
}

describe('Neo external worker reply instructions', () => {
  test.each(['claude-code', 'claude-desktop', 'codex-desktop'])(
    'work sends and starts to %s append the sending Neo once',
    async (adapter) => {
      const { received, call } = harness(adapter);
      await call('work.send', {
        ref: { adapter, id: 'worker' },
        message: 'Build it.',
        from: 'session:forged',
      });
      await call('work.start', { adapter, place, title: 'Build', message: 'Build it.' });
      await call('work.send', { ref: { adapter, id: 'worker' }, message: received[0] });
      expect(received).toEqual(Array(3).fill(`Build it.\n\n${line('neo:own-root')}`));
    }
  );

  test.each(['claude-code', 'claude-desktop', 'codex-desktop'])(
    'todo sends and starts to %s keep the ask owner as the reply destination',
    async (adapter) => {
      const { received, call } = harness(adapter);
      const work = { title: 'Build', instruction: 'Ship the fix.' };
      for (const target of [
        { verb: 'send' as const, ref: { adapter, id: 'worker' } },
        { verb: 'start' as const, adapter, place },
      ]) {
        const delivery = driverWorkCall(target, work);
        await call(
          delivery.name,
          delivery.input,
          driverWorkCaller({ originSessionId: 'neo:ask-owner' })
        );
      }
      expect(received).toHaveLength(2);
      for (const message of received) {
        expect(message).toStartWith('Ship the fix.');
        expect(message).toEndWith(line('neo:ask-owner'));
      }
    }
  );

  test('leaves humans, other workers and unsupported backend kinds unchanged', async () => {
    for (const adapter of [
      'claude-code',
      'claude-desktop',
      'codex-desktop',
      'hyperneo',
      'space',
      'future',
    ]) {
      const { received, call } = harness(adapter);
      for (const caller of [
        { source: 'rpc' as const },
        { source: 'mcp' as const, sessionId: 'neo:spoofed', role: 'workflow_worker' as const },
      ])
        await call('work.send', { ref: { adapter, id: 'worker' }, message: 'Same text.' }, caller);
      if (!['claude-code', 'claude-desktop', 'codex-desktop'].includes(adapter))
        await call('work.send', { ref: { adapter, id: 'worker' }, message: 'Same text.' });
      expect(received.every((message) => message === 'Same text.')).toBe(true);
    }
  });

  test('queued Neo instructions also get the once-only reply line', async () => {
    const { received, call } = harness('codex-desktop');
    await call('work.queue', { ref: { adapter: 'codex-desktop', id: 'worker' }, message: 'Next.' });
    expect(received).toEqual([`Next.\n\n${line('neo:own-root')}`]);
  });
});
