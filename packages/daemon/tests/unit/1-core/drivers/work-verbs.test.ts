import { describe, expect, test } from 'bun:test';
import {
  annotateUnreachable,
  SendWorkResultSchema,
  WorkStatusInputSchema,
  WorkStatusResultSchema,
  WorkAdaptersResultSchema,
  createWorkVerbOperations,
} from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter, WorkSummary, WorkDetail } from '../../../../src/lib/drivers/types';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

const place = { machine: 'imac', folder: '/focus/dolmen', name: 'dolmen' };

function summary(adapter: string, id: string): WorkSummary {
  return {
    ref: { adapter, id },
    title: 'loader',
    place,
    status: 'running',
    lastActivityAt: 1,
  };
}

let origin = 'chat';

const hyperneo: WorkAdapter = {
  id: 'hyperneo',
  capabilities: ['find', 'start', 'send', 'status', 'stop'],
  find: () => [],
  start: async (request) => ({
    ok: true,
    value: { ...summary('hyperneo', 's1'), title: request.title },
  }),
  send: async (ref, _message, context) =>
    ref.id === 'gone' || context.from !== origin
      ? { ok: false, reason: 'not_open', detail: 'archived' }
      : { ok: true, value: { delivered: true } },
  status: async (ref, since) => ({
    ok: true,
    value: {
      ...summary('hyperneo', ref.id),
      lastReply: since === undefined ? 'done' : `done since ${since}`,
    },
  }),
  stop: async () => ({ ok: true, value: { stopped: true } }),
};

const desktop: WorkAdapter = {
  id: 'claude-desktop',
  capabilities: ['find', 'send'],
  find: () => [],
  send: async () => ({ ok: true, value: { delivered: false } }),
};

type Invoke = (
  daemonId: string,
  name: string,
  input: unknown,
  options?: { timeoutMs?: number }
) => Promise<unknown>;

async function call(
  name: string,
  input: unknown,
  invoke: Invoke = async () => ({}),
  caller: OperationCaller = { source: 'rpc' },
  adapters: readonly WorkAdapter[] = [hyperneo, desktop]
) {
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => adapters,
      remote: { list: () => [{ daemonId: 'laptop' }], invoke },
      daemonName: 'imac',
    })
  );
  const outcome = await invokeOperation(registry, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value;
}

describe('work verb operations', () => {
  test('keeps messaging capabilities and delivery facts in driver result schemas', () => {
    expect(
      WorkAdaptersResultSchema.parse({
        ok: true,
        value: [{ id: 'codex-desktop', capabilities: ['steer', 'queue', 'withdraw'] }],
      })
    ).toEqual({
      ok: true,
      value: [{ id: 'codex-desktop', capabilities: ['steer', 'queue', 'withdraw'] }],
    });
    for (const fact of [{ queuedSubmissionId: 'q1' }, { steeredIntoTurnId: 't1' }]) {
      const result = { ok: true, value: { delivered: false, ...fact } };
      expect(SendWorkResultSchema.parse(result)).toEqual(result);
    }
  });

  test('runs each verb on the adapter named by the ref', async () => {
    expect(
      await call('work.send', { ref: { adapter: 'hyperneo', id: 's1' }, message: 'hi' })
    ).toEqual({
      ok: true,
      value: { delivered: true },
    });
    expect(await call('work.status', { ref: { adapter: 'hyperneo', id: 's1' } })).toMatchObject({
      ok: true,
      value: { ref: { id: 's1' }, lastReply: 'done' },
    });
    expect(await call('work.stop', { ref: { adapter: 'hyperneo', id: 's1' } })).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(
      await call('work.start', { adapter: 'hyperneo', place, title: 'font size', message: 'go' })
    ).toMatchObject({ ok: true, value: { title: 'font size' } });
  });

  test.each([true, false])(
    'preserves accepted input receipts locally and remotely: delivered=%s',
    async (delivered) => {
      const receipt = { executionId: 'opaque-execution', inputId: 'opaque-input' };
      const result = { ok: true as const, value: { delivered, receipt } };
      const adapter: WorkAdapter = { ...hyperneo, send: async () => result };
      const ref = { adapter: adapter.id, id: 'work' };
      expect(
        await call('work.send', { ref, message: 'next' }, undefined, undefined, [adapter])
      ).toEqual(result);
      const forwarded: unknown[] = [];
      expect(
        await call(
          'work.send',
          { ref: { ...ref, daemon: 'laptop' }, message: 'next' },
          async (daemon, name, input) => {
            forwarded.push({ daemon, name, input });
            return result;
          }
        )
      ).toEqual(result);
      expect(forwarded).toEqual([
        {
          daemon: 'laptop',
          name: 'work.send',
          input: { ref, message: 'next', from: 'chat' },
        },
      ]);
    }
  );

  test.each([
    { executionId: '', inputId: 'input' },
    { executionId: 'execution', inputId: '' },
    { executionId: 'execution' },
    { inputId: 'input' },
    null,
  ])('rejects malformed receipt %j rather than stripping it', (receipt) => {
    expect(
      SendWorkResultSchema.safeParse({ ok: true, value: { delivered: true, receipt } }).success
    ).toBe(false);
  });

  test('forwards preparation requirements with model and effort only to an opted-in adapter', async () => {
    const received: unknown[] = [];
    const capable: WorkAdapter = {
      ...hyperneo,
      supportsStartPreparation: true,
      supportsStartEffort: true,
      start: async (request) => {
        received.push(request);
        return { ok: true, value: summary('hyperneo', 's1') };
      },
    };
    const preparation = {
      pack: 'coding',
      parameters: { target: 'dev', prerequisiteCommits: ['a'.repeat(40)] },
    };
    const result = await call(
      'work.start',
      {
        adapter: capable.id,
        place,
        title: 't',
        message: 'm',
        preparation,
        model: 'sol 6.1',
        effort: 'medium',
      },
      undefined,
      undefined,
      [capable]
    );
    expect(result).toMatchObject({ ok: true });
    expect(received).toEqual([
      expect.objectContaining({ preparation, model: 'sol 6.1', effort: 'medium' }),
    ]);
  });

  test.each([false, undefined, 'remote'] as const)(
    'refuses unsupported preparation on route %s before any dispatch',
    async (support) => {
      let starts = 0;
      let forwards = 0;
      const adapter: WorkAdapter = {
        ...hyperneo,
        supportsStartPreparation: support === 'remote' ? true : support,
        start: async () => {
          starts++;
          return { ok: true, value: summary('hyperneo', 's1') };
        },
      };
      expect(
        await call(
          'work.start',
          {
            adapter: adapter.id,
            place: support === 'remote' ? { ...place, daemon: 'laptop' } : place,
            title: 't',
            message: 'm',
            preparation: { pack: 'coding', parameters: { target: 'dev' } },
          },
          async () => {
            forwards++;
            return { ok: true, value: summary('hyperneo', 's1') };
          },
          undefined,
          [adapter]
        )
      ).toMatchObject({ ok: false, reason: 'unsupported_preparation' });
      expect(starts).toBe(0);
      expect(forwards).toBe(0);
    }
  );

  test('passes explicit effort only to an opted-in local adapter and retains its receipt', async () => {
    const received: unknown[] = [];
    const capable: WorkAdapter = {
      ...hyperneo,
      id: 'codex-desktop',
      supportsStartEffort: true,
      start: async (request) => {
        received.push(request);
        return {
          ok: true,
          value: { ...summary('codex-desktop', 't1'), model: 'gpt-6.1-sol', effort: 'medium' },
        };
      },
    };
    expect(
      await call(
        'work.start',
        {
          adapter: capable.id,
          place,
          title: 't',
          message: 'm',
          model: 'sol 6.1',
          effort: ' medium ',
        },
        undefined,
        undefined,
        [capable]
      )
    ).toMatchObject({
      ok: true,
      value: { model: 'gpt-6.1-sol', effort: 'medium' },
    });
    expect(received).toEqual([expect.objectContaining({ model: 'sol 6.1', effort: 'medium' })]);
  });

  test.each([false, undefined])(
    'refuses effort before executing an adapter with support %s',
    async (supportsStartEffort) => {
      let starts = 0;
      const unsupported: WorkAdapter = {
        ...hyperneo,
        supportsStartEffort,
        start: async () => {
          starts++;
          return { ok: true, value: summary('hyperneo', 's1') };
        },
      };
      expect(
        await call(
          'work.start',
          {
            adapter: unsupported.id,
            place,
            title: 't',
            message: 'm',
            effort: 'medium',
          },
          undefined,
          undefined,
          [unsupported]
        )
      ).toMatchObject({ ok: false, reason: 'unsupported_effort' });
      expect(starts).toBe(0);
    }
  );

  test('refuses unverified remote effort without forwarding even when the local adapter supports it', async () => {
    let forwarded = 0;
    const remote: Invoke = async () => {
      forwarded++;
      return { ok: true, value: summary('codex-desktop', 't1') };
    };
    expect(
      await call(
        'work.start',
        {
          adapter: 'codex-desktop',
          place: { ...place, daemon: 'laptop' },
          title: 't',
          message: 'm',
          effort: 'medium',
        },
        remote,
        undefined,
        [{ ...hyperneo, id: 'codex-desktop', supportsStartEffort: true }]
      )
    ).toMatchObject({
      ok: false,
      reason: 'unsupported_effort',
    });
    expect(forwarded).toBe(0);
  });

  test.each([undefined, 'medium'])(
    'refuses an unverified remote model with effort %s before forwarding',
    async (effort) => {
      let forwarded = 0;
      let started = 0;
      const capable: WorkAdapter = {
        ...hyperneo,
        id: 'codex-desktop',
        supportsStartEffort: true,
        start: async () => {
          started++;
          return { ok: true, value: summary('codex-desktop', 'local') };
        },
      };
      expect(
        await call(
          'work.start',
          {
            adapter: capable.id,
            place: { ...place, daemon: 'laptop' },
            title: 't',
            message: 'm',
            model: 'gpt-6.1-sol',
            ...(effort ? { effort } : {}),
          },
          async () => {
            forwarded++;
            return { ok: true, value: summary('codex-desktop', 'remote') };
          },
          undefined,
          [capable]
        )
      ).toMatchObject({ ok: false, reason: 'unsupported_model' });
      expect(forwarded).toBe(0);
      expect(started).toBe(0);
    }
  );

  test('validates effort input before invoking the driver', async () => {
    let starts = 0;
    const capable: WorkAdapter = {
      ...hyperneo,
      supportsStartEffort: true,
      start: async () => {
        starts++;
        return { ok: true, value: summary('hyperneo', 's1') };
      },
    };
    for (const effort of [' ', 'x'.repeat(101), 42]) {
      await expect(
        call(
          'work.start',
          {
            adapter: capable.id,
            place,
            title: 't',
            message: 'm',
            effort,
          },
          undefined,
          undefined,
          [capable]
        )
      ).rejects.toThrow();
    }
    expect(starts).toBe(0);
  });

  test('tells the adapter who is sending', async () => {
    origin = 'session:neo%3Aroot';
    expect(
      await call(
        'work.send',
        { ref: { adapter: 'hyperneo', id: 's1' }, message: 'hi' },
        undefined,
        { source: 'mcp', sessionId: 'neo:root' }
      )
    ).toEqual({ ok: true, value: { delivered: true } });
    origin = 'chat';
  });

  test('carries the sender to another daemon and honors it only from the RPC door', async () => {
    const forwarded: unknown[] = [];
    await call(
      'work.send',
      { ref: { adapter: 'hyperneo', daemon: 'laptop', id: 's9' }, message: 'hi' },
      async (_daemonId, _name, input) => {
        forwarded.push(input);
        return { ok: true, value: { delivered: true } };
      },
      { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
    );
    expect(forwarded).toEqual([
      {
        ref: { adapter: 'hyperneo', id: 's9' },
        message: 'hi',
        from: 'daemon:imac::session:neo%3Aroot',
      },
    ]);
    origin = 'session:neo%3Aroot';
    const relayed = { ref: { adapter: 'hyperneo', id: 's1' }, message: 'hi', from: origin };
    expect(await call('work.send', relayed)).toEqual({ ok: true, value: { delivered: true } });
    origin = 'chat';
    expect(await call('work.send', { ...relayed, from: 'not an address' })).toEqual({
      ok: true,
      value: { delivered: true },
    });
    expect(
      await call('work.send', { ...relayed, from: 'chat' }, undefined, {
        source: 'mcp',
        sessionId: 'agent-1',
      })
    ).toMatchObject({ ok: false, reason: 'not_open' });
  });

  test('passes the adapter rejection through', async () => {
    expect(
      await call('work.send', { ref: { adapter: 'hyperneo', id: 'gone' }, message: 'hi' })
    ).toEqual({ ok: false, reason: 'not_open', detail: 'archived' });
  });

  test('lists each adapter with its verbs, here or on the named daemon', async () => {
    const asked: unknown[] = [];
    const laptop: Invoke = async (daemonId, name, input) => {
      asked.push([daemonId, name, input]);
      return { ok: true, value: [{ id: 'codex-desktop', capabilities: ['find', 'start'] }] };
    };

    expect(await call('work.adapters', {})).toEqual({
      ok: true,
      value: [
        { id: 'hyperneo', capabilities: ['find', 'start', 'send', 'status', 'stop'] },
        { id: 'claude-desktop', capabilities: ['find', 'send'] },
      ],
    });
    expect(await call('work.adapters', { daemon: 'laptop' }, laptop)).toEqual({
      ok: true,
      value: [{ id: 'codex-desktop', capabilities: ['find', 'start'] }],
    });
    expect(asked).toEqual([['laptop', 'work.adapters', {}]]);
  });

  test('rejects an adapter that is not registered or does not declare the verb', async () => {
    expect(await call('work.status', { ref: { adapter: 'oap', id: 'x' } })).toMatchObject({
      ok: false,
      reason: 'unknown_adapter',
    });
    expect(await call('work.stop', { ref: { adapter: 'claude-desktop', id: 'x' } })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });

  test.each(['unavailable', 'pending', 'observed'] as const)(
    'preserves receipt-scoped %s evidence locally and remotely',
    async (state) => {
      const receipt = { executionId: 'node-session', inputId: 'accepted-input' };
      const inputEvidence: NonNullable<WorkDetail['inputEvidence']> =
        state === 'observed'
          ? {
              receipt,
              state,
              exchange: [
                { at: 10, role: 'user', text: 'Own input' },
                { at: 11, role: 'agent', text: 'Own reply' },
              ],
              exchangeCut: false,
            }
          : { receipt, state };
      const ref = { adapter: 'hyperneo', id: 's1' };
      const result = {
        ok: true as const,
        value: {
          ...summary(ref.adapter, ref.id),
          lastReply: 'Unrelated latest reply',
          inputEvidence,
        },
      };
      const received: unknown[] = [];
      const adapter: WorkAdapter = {
        ...hyperneo,
        status: async (...args) => {
          received.push(args);
          return result;
        },
      };
      expect(
        await call('work.status', { ref, since: 5, receipt }, undefined, undefined, [adapter])
      ).toEqual(result);
      expect(received).toEqual([[ref, 5, receipt]]);
      const forwarded: unknown[] = [];
      expect(
        await call(
          'work.status',
          { ref: { ...ref, daemon: 'laptop' }, receipt },
          async (daemon, name, input) => {
            forwarded.push({ daemon, name, input });
            return result;
          }
        )
      ).toMatchObject({
        ok: true,
        value: {
          ref: { ...ref, daemon: 'laptop' },
          inputEvidence,
          lastReply: 'Unrelated latest reply',
        },
      });
      expect(forwarded).toEqual([
        { daemon: 'laptop', name: 'work.status', input: { ref, receipt } },
      ]);
    }
  );

  test('receipt queries keep legacy status replies explicitly without input evidence', async () => {
    const receipt = { executionId: 'execution', inputId: 'input' };
    for (const ref of [
      { adapter: 'hyperneo', id: 's1' },
      { adapter: 'hyperneo', id: 's1', daemon: 'laptop' },
    ]) {
      const result = await call('work.status', { ref, receipt }, async () => ({
        ok: true,
        value: summary('hyperneo', 's1'),
      }));
      expect(result).toMatchObject({ ok: true, value: { ref } });
      expect((result as { value: WorkDetail }).value.inputEvidence).toBeUndefined();
    }
  });

  test('rejects malformed receipt queries before calling a driver', async () => {
    const ref = { adapter: 'hyperneo', id: 's1' };
    for (const receipt of [null, {}, { executionId: 's1', inputId: '' }]) {
      expect(WorkStatusInputSchema.safeParse({ ref, receipt }).success).toBe(false);
      let calls = 0;
      await expect(
        call('work.status', { ref, receipt }, undefined, undefined, [
          {
            ...hyperneo,
            status: async () => {
              calls++;
              return { ok: true, value: summary('hyperneo', 's1') };
            },
          },
        ])
      ).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test('rejects invalid remote evidence instead of promoting latest reply', async () => {
    const receipt = { executionId: 'execution', inputId: 'input' };
    const entry = { at: 10, role: 'user', text: 'Own input' };
    for (const inputEvidence of [
      { receipt, state: 'observed', exchange: [] },
      { receipt, state: 'pending', exchange: [entry] },
      { receipt: { ...receipt, inputId: '' }, state: 'unavailable' },
      { receipt, state: 'observed', exchange: Array(41).fill(entry), exchangeCut: true },
    ]) {
      const result = { ok: true, value: { ...summary('hyperneo', 's1'), inputEvidence } };
      expect(WorkStatusResultSchema.safeParse(result).success).toBe(false);
      expect(
        await call(
          'work.status',
          {
            ref: { adapter: 'hyperneo', id: 's1', daemon: 'laptop' },
            receipt,
          },
          async () => result
        )
      ).toMatchObject({ ok: false });
    }
  });

  test('passes since to the adapter or the daemon that owns the work', async () => {
    expect(
      await call('work.status', { ref: { adapter: 'hyperneo', id: 's1' }, since: 5 })
    ).toMatchObject({ ok: true, value: { lastReply: 'done since 5' } });
    const calls: unknown[] = [];
    await call(
      'work.status',
      { ref: { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' }, since: 5 },
      async (daemonId, name, input) => {
        calls.push(input);
        return { ok: true, value: summary('codex-desktop', 't1') };
      }
    );
    expect(calls).toEqual([{ ref: { adapter: 'codex-desktop', id: 't1' }, since: 5 }]);
  });

  test('forwards a ref with a daemon to that daemon and stamps what comes back', async () => {
    const calls: unknown[] = [];
    const result = await call(
      'work.status',
      { ref: { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' } },
      async (daemonId, name, input) => {
        calls.push({ daemonId, name, input });
        return { ok: true, value: summary('codex-desktop', 't1') };
      }
    );
    expect(calls).toEqual([
      {
        daemonId: 'laptop',
        name: 'work.status',
        input: { ref: { adapter: 'codex-desktop', id: 't1' } },
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: { ref: { daemon: 'laptop' }, place: { daemon: 'laptop' } },
    });
  });

  test('starts work on the daemon that owns the place', async () => {
    const calls: unknown[] = [];
    await call(
      'work.start',
      { adapter: 'codex-desktop', place: { ...place, daemon: 'laptop' }, title: 't', message: 'm' },
      async (daemonId, name, input) => {
        calls.push({ daemonId, name, input });
        return { ok: true, value: summary('codex-desktop', 't2') };
      }
    );
    expect(calls).toEqual([
      {
        daemonId: 'laptop',
        name: 'work.start',
        input: { adapter: 'codex-desktop', place, title: 't', message: 'm', from: 'chat' },
      },
    ]);
  });

  test('gives a remote start time to create its session and warns it may have started', async () => {
    const timeouts: unknown[] = [];
    const result = await call(
      'work.start',
      { adapter: 'hyperneo', place: { ...place, daemon: 'laptop' }, title: 't', message: 'm' },
      async (_daemonId, _name, _input, options) => {
        timeouts.push(options);
        throw new Error('Request timeout');
      }
    );
    expect(timeouts).toEqual([{ timeoutMs: 360_000 }]);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect((result as { detail: string }).detail).toContain(
      'check work.find before starting it again'
    );
  });

  test('gives a remote send time to relay and warns it may have been delivered', async () => {
    const timeouts: unknown[] = [];
    const result = await call(
      'work.send',
      { ref: { adapter: 'claude-desktop', id: 's1', daemon: 'laptop' }, message: 'm' },
      async (_daemonId, _name, _input, options) => {
        timeouts.push(options);
        throw new Error('Request timeout');
      }
    );
    expect(timeouts).toEqual([{ timeoutMs: 180_000 }]);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect((result as { detail: string }).detail).toContain(
      'check work.status before sending it again'
    );
  });

  test('lets only Neo or the user change work on another daemon', async () => {
    let forwarded = 0;
    const invoke = async () => {
      forwarded++;
      return { ok: true, value: { stopped: true } };
    };
    const ref = { adapter: 'space', daemon: 'laptop', id: 't1' };
    expect(
      await call('work.stop', { ref }, invoke, {
        source: 'mcp',
        sessionId: 'w1',
        role: 'workflow_worker',
      })
    ).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(
      await call('work.stop', { ref }, invoke, {
        source: 'mcp',
        sessionId: 'neo:root',
        role: 'neo',
      })
    ).toEqual({ ok: true, value: { stopped: true } });
    expect(await call('work.stop', { ref }, invoke)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(forwarded).toBe(2);
  });

  test('reports a daemon that fails or answers with something unusable as unreachable', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    expect(
      await call('work.stop', { ref }, async () => {
        throw new Error('No attached daemon: laptop');
      })
    ).toEqual({ ok: false, reason: 'unreachable', detail: 'No attached daemon: laptop' });
    expect(await call('work.send', { ref, message: 'hi' }, async () => ({ nope: 1 }))).toEqual({
      ok: false,
      reason: 'unreachable',
      detail:
        'laptop sent an unusable reply. The message may still have been delivered; check work.status before sending it again.',
    });
  });
});

describe('annotateUnreachable', () => {
  test('adds the hint only to an unreachable rejection', () => {
    expect(
      annotateUnreachable(
        { ok: false, reason: 'unreachable', detail: 'timed out.' },
        'Check first.'
      )
    ).toEqual({ ok: false, reason: 'unreachable', detail: 'timed out. Check first.' });
    const notFound = { ok: false as const, reason: 'not_found' as const, detail: 'gone' };
    expect(annotateUnreachable(notFound, 'Check first.')).toBe(notFound);
  });
});
