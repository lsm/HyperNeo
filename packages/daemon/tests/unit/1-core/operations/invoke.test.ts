import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  invokeOperation,
  resolveOperation,
  parseOperationInput,
  executeOperation,
  validateOperationResult,
} from '../../../../src/lib/operations/invoke';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';

const caller = { source: 'rpc' as const, sessionId: 'sender' };
function fixture() {
  const execute = mock(async (input: { content: string }) => ({ accepted: input.content }));
  const operation = defineOperation({
    name: 'message.send',
    description: 'Accept a message',
    inputSchema: z.object({ content: z.string().trim().min(1) }),
    resultSchema: z.object({ accepted: z.string() }),
    execute,
  });
  return { execute, operation, registry: createOperationRegistry([operation]) };
}

describe('operation invocation gates', () => {
  test('lookup rejects unknown names', () => {
    const { registry } = fixture();
    expect(resolveOperation(registry, 'missing')).toEqual({
      reason: { kind: 'failed', code: 'unknown_operation', message: 'Unknown operation: missing' },
    });
  });
  test('input parsing preserves transformations and rejects invalid content', async () => {
    const { operation } = fixture();
    expect(await parseOperationInput(operation, { content: ' hello ' })).toEqual({
      value: { operation, input: { content: 'hello' } },
    });
    expect(await parseOperationInput(operation, { content: '' })).toMatchObject({
      reason: { kind: 'failed', code: 'invalid_input' },
    });
  });
  test('execution passes caller context and maps rejection', async () => {
    const { operation, execute } = fixture();
    await executeOperation({ operation, input: { content: 'hello' } }, caller);
    expect(execute).toHaveBeenCalledWith({ content: 'hello' }, caller);
    execute.mockRejectedValue(new Error('unavailable'));
    expect(await executeOperation({ operation, input: {} }, caller)).toEqual({
      reason: { kind: 'failed', code: 'execution_failed', message: 'unavailable' },
    });
  });
  test('result validation rejects unexpected data', async () => {
    const { operation } = fixture();
    expect(await validateOperationResult({ operation, result: { accepted: 12 } })).toMatchObject({
      reason: { kind: 'failed', code: 'invalid_result' },
    });
  });
});

describe('shared operation invocation', () => {
  test('returns the result after parsing input and executes once', async () => {
    const { registry, execute } = fixture();
    expect(await invokeOperation(registry, 'message.send', { content: ' hello ' }, caller)).toEqual(
      {
        kind: 'completed',
        value: { accepted: 'hello' },
      }
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ content: 'hello' }, caller);
  });
  test.each([
    { name: 'missing', input: {}, code: 'unknown_operation' },
    { name: 'message.send', input: { content: '' }, code: 'invalid_input' },
  ])('halts before execution for $code', async ({ name, input, code }) => {
    const { registry, execute } = fixture();
    expect(await invokeOperation(registry, name, input, caller)).toMatchObject({
      kind: 'failed',
      code,
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test('does not retry a failed execution', async () => {
    const { registry, execute } = fixture();
    execute.mockRejectedValue(new Error('unavailable'));
    expect(await invokeOperation(registry, 'message.send', { content: 'hello' }, caller)).toEqual({
      kind: 'failed',
      code: 'execution_failed',
      message: 'unavailable',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('awaits asynchronous schemas and applies result transformations', async () => {
    const operation = defineOperation({
      name: 'example',
      description: 'Async schemas',
      inputSchema: z.string().refine(async (value) => value === 'valid'),
      resultSchema: z.string().transform(async (value) => value.toUpperCase()),
      execute: async (input) => input,
    });
    const registry = createOperationRegistry([operation]);
    expect(await invokeOperation(registry, 'example', 'valid', caller)).toEqual({
      kind: 'completed',
      value: 'VALID',
    });
    expect(await invokeOperation(registry, 'example', 'invalid', caller)).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
  });
  test('invalid output is a failure after execution, not a completed result', async () => {
    const { operation } = fixture();
    const registry = createOperationRegistry([{ ...operation, execute: async () => null }]);
    expect(
      await invokeOperation(registry, 'message.send', { content: 'hello' }, caller)
    ).toMatchObject({
      kind: 'failed',
      code: 'invalid_result',
    });
  });
  test.each(['input', 'result'] as const)(
    'normalizes throwing and rejecting %s schema callbacks',
    async (phase) => {
      for (const asynchronous of [false, true]) {
        const broken = z.string().transform(() => {
          if (asynchronous) return Promise.reject(new Error('schema callback failed'));
          throw new Error('schema callback failed');
        });
        const execute = mock(async () => 'value');
        const registry = createOperationRegistry([
          defineOperation({
            name: 'example',
            description: 'Broken schema',
            inputSchema: phase === 'input' ? broken : z.string(),
            resultSchema: phase === 'result' ? broken : z.string(),
            execute,
          }),
        ]);
        expect(await invokeOperation(registry, 'example', 'value', caller)).toEqual({
          kind: 'failed',
          code: phase === 'input' ? 'invalid_input' : 'invalid_result',
          message: 'schema callback failed',
        });
        expect(execute).toHaveBeenCalledTimes(phase === 'input' ? 0 : 1);
      }
    }
  );
});

describe('shared operation invocation audit hooks', () => {
  test('before sees the parsed input before execute, after sees the outcome after validation', async () => {
    const { registry, execute } = fixture();
    const order: string[] = [];
    execute.mockImplementation(async (input: { content: string }) => {
      order.push('execute');
      return { accepted: input.content };
    });
    const before = mock((prepared: { input: unknown }) => {
      order.push('before');
      expect(prepared.input).toEqual({ content: 'hello' });
    });
    const after = mock(() => order.push('after'));
    expect(
      await invokeOperation(registry, 'message.send', { content: ' hello ' }, caller, {
        before,
        after,
      })
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(order).toEqual(['before', 'execute', 'after']);
    expect(after.mock.calls[0][2]).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('absent audit is a no-op', async () => {
    const { registry } = fixture();
    expect(await invokeOperation(registry, 'message.send', { content: 'hello' }, caller)).toEqual({
      kind: 'completed',
      value: { accepted: 'hello' },
    });
  });
  test.each([
    { name: 'missing', input: {}, code: 'unknown_operation' },
    { name: 'message.send', input: { content: '' }, code: 'invalid_input' },
  ])('before is skipped when resolve or parse rejects ($code)', async ({ name, input }) => {
    const { registry } = fixture();
    const before = mock(() => {});
    await invokeOperation(registry, name, input, caller, { before });
    expect(before).not.toHaveBeenCalled();
  });
  test('after still runs for an execution_failed outcome', async () => {
    const { registry, execute } = fixture();
    execute.mockRejectedValue(new Error('unavailable'));
    const after = mock(() => {});
    const outcome = await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, {
      after,
    });
    expect(outcome).toEqual({ kind: 'failed', code: 'execution_failed', message: 'unavailable' });
    expect(after).toHaveBeenCalledTimes(1);
    const [prepared, callerArg, outcomeArg] = after.mock.calls[0];
    expect(prepared.input).toEqual({ content: 'hello' });
    expect(callerArg).toEqual(caller);
    expect(outcomeArg).toEqual(outcome);
  });
  test('a hook that throws leaves the invocation result unchanged', async () => {
    const { registry } = fixture();
    const audit = {
      before: () => {
        throw new Error('before boom');
      },
      after: () => {
        throw new Error('after boom');
      },
    };
    expect(
      await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, audit)
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('a mutating before hook cannot change what executeOperation runs', async () => {
    const { registry, execute } = fixture();
    const audit = {
      before: (
        prepared: { input: { content: string } },
        callerArg: { source: string; sessionId?: string }
      ) => {
        prepared.input.content = 'tampered';
        callerArg.source = 'internal';
        callerArg.sessionId = 'hijacked';
      },
    };
    await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, audit);
    expect(execute).toHaveBeenCalledWith({ content: 'hello' }, caller);
  });
  test('a mutating after hook cannot change the returned outcome', async () => {
    const { registry } = fixture();
    const audit = {
      after: (
        _prepared: unknown,
        _caller: unknown,
        outcome: { kind: string; value: { accepted: string } }
      ) => {
        outcome.kind = 'failed';
        outcome.value.accepted = 'tampered';
      },
    };
    expect(
      await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, audit)
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('a handler that mutates its input during execution does not change what after reports', async () => {
    const { operation } = fixture();
    const mutatingExecute = async (input: { content: string }) => {
      input.content = 'mutated-during-execution';
      return { accepted: 'ok' };
    };
    const registry = createOperationRegistry([{ ...operation, execute: mutatingExecute }]);
    const after = mock(() => {});
    await invokeOperation(registry, 'message.send', { content: 'original' }, caller, { after });
    expect(after.mock.calls[0][0].input).toEqual({ content: 'original' });
  });
  test('an async hook that rejects leaves the outcome unchanged and produces no unhandled rejection', async () => {
    let unhandled: unknown = null;
    const onUnhandled = (error: unknown) => {
      unhandled = error;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { registry } = fixture();
      const audit = {
        before: async () => {
          throw new Error('before rejected');
        },
        after: async () => {
          throw new Error('after rejected');
        },
      };
      const outcome = await invokeOperation(
        registry,
        'message.send',
        { content: 'hello' },
        caller,
        audit
      );
      expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  test('a before hook mutating a nested input field does not change what after records', async () => {
    const operation = defineOperation({
      name: 'message.send.nested',
      description: 'Accept a message with nested metadata',
      inputSchema: z.object({ content: z.string(), meta: z.object({ tag: z.string() }) }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let afterInput: unknown = null;
    const audit = {
      before: (prepared: { input: { meta: { tag: string } } }) => {
        prepared.input.meta.tag = 'redacted-by-before';
      },
      after: (prepared: { input: unknown }) => {
        afterInput = prepared.input;
      },
    };
    await invokeOperation(
      registry,
      'message.send.nested',
      { content: 'hello', meta: { tag: 'real' } },
      caller,
      audit
    );
    expect(afterInput).toEqual({ content: 'hello', meta: { tag: 'real' } });
  });
  test('an uncloneable input is still deeply isolated from a mutating before hook', async () => {
    const operation = defineOperation({
      name: 'message.send.uncloneable',
      description: 'Accept a message carrying a non-cloneable value',
      inputSchema: z.object({
        content: z.string(),
        meta: z.object({ tag: z.string() }),
        callback: z.any(),
      }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let afterInput: unknown = null;
    const audit = {
      before: (prepared: { input: { meta: { tag: string } } }) => {
        prepared.input.meta.tag = 'redacted-by-before';
      },
      after: (prepared: { input: unknown }) => {
        afterInput = prepared.input;
      },
    };
    const meta = { tag: 'real' };
    await invokeOperation(
      registry,
      'message.send.uncloneable',
      { content: 'hello', meta, callback: () => 'not cloneable' },
      caller,
      audit
    );
    expect(meta.tag).toBe('real');
    expect((afterInput as { meta: { tag: string } }).meta.tag).toBe('real');
  });
  test('an input that defeats both structured and JSON cloning is still isolated', async () => {
    const operation = defineOperation({
      name: 'message.send.compound',
      description: 'Accept a message that no standard clone can copy',
      inputSchema: z.object({
        content: z.string(),
        meta: z.object({ tag: z.string() }),
        callback: z.any(),
        big: z.any(),
      }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let afterInput: unknown = null;
    const audit = {
      before: (prepared: { input: { meta: { tag: string } } }) => {
        prepared.input.meta.tag = 'redacted-by-before';
      },
      after: (prepared: { input: unknown }) => {
        afterInput = prepared.input;
      },
    };
    const meta = { tag: 'real' };
    await invokeOperation(
      registry,
      'message.send.compound',
      { content: 'hello', meta, callback: () => 'not cloneable', big: BigInt(7) },
      caller,
      audit
    );
    expect(meta.tag).toBe('real');
    expect((afterInput as { meta: { tag: string } }).meta.tag).toBe('real');
  });
  test('a self-referencing uncloneable input does not hang the isolating copy', async () => {
    const operation = defineOperation({
      name: 'message.send.cyclic',
      description: 'Accept a message with a cycle and a callback',
      inputSchema: z.object({ content: z.string(), node: z.any(), callback: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const node: Record<string, unknown> = { tag: 'real' };
    node.self = node;
    let afterInput: unknown = null;
    const audit = {
      after: (prepared: { input: unknown }) => {
        afterInput = prepared.input;
      },
    };
    const outcome = await invokeOperation(
      registry,
      'message.send.cyclic',
      { content: 'hello', node, callback: () => 'not cloneable' },
      caller,
      audit
    );
    expect(outcome.kind).toBe('completed');
    const copied = (afterInput as { node: Record<string, unknown> }).node;
    expect(copied.tag).toBe('real');
    expect(copied.self).toBe(copied);
    expect(copied).not.toBe(node);
  });
  test('hooks never receive the registry operation definition', async () => {
    const { registry, operation } = fixture();
    let seen: { name: string; description: string } | null = null;
    await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, {
      before: (prepared: { operation: { name: string; description: string } }) => {
        seen = { ...prepared.operation };
        (prepared.operation as Record<string, unknown>).resultSchema = 'hijacked';
      },
    });
    expect(seen).toEqual({ name: operation.name, description: operation.description });
    expect((registry.get('message.send') as Record<string, unknown>).resultSchema).not.toBe(
      'hijacked'
    );
    const outcome = await invokeOperation(registry, 'message.send', { content: 'hi' }, caller);
    expect(outcome.kind).toBe('completed');
  });
  test('a snapshot that cannot be copied at all leaves the operation running', async () => {
    const operation = defineOperation({
      name: 'message.send.hostile',
      description: 'Accept a value that defeats every copy strategy',
      inputSchema: z.object({ content: z.string(), hostile: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const hostile = new Proxy(
      { callback: () => 'x' },
      {
        ownKeys() {
          throw new Error('ownKeys refuses');
        },
      }
    );
    let afterRan = false;
    const outcome = await invokeOperation(
      registry,
      'message.send.hostile',
      { content: 'hello', hostile },
      caller,
      {
        after: () => {
          afterRan = true;
        },
      }
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(afterRan).toBe(true);
  });
  test('a value no copy can represent is never handed to a hook live', async () => {
    const operation = defineOperation({
      name: 'message.send.opaque',
      description: 'Accept a value that defeats every copy strategy',
      inputSchema: z.object({ content: z.string(), opaque: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const opaque = new Proxy(
      { callback: () => 'x' },
      {
        ownKeys() {
          throw new Error('ownKeys refuses');
        },
      }
    );
    let seen: unknown = null;
    const outcome = await invokeOperation(
      registry,
      'message.send.opaque',
      { content: 'hello', opaque },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(seen).toEqual({ content: 'hello', opaque: '[unrepresentable]' });
    expect((seen as { opaque: unknown }).opaque).not.toBe(opaque);
  });
  test('a proxy trap never runs while the audit snapshot is taken', async () => {
    const operation = defineOperation({
      name: 'message.send.trapped',
      description: 'Accept a value whose traps record every reflection',
      inputSchema: z.object({ content: z.string(), trapped: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const trapsRun: string[] = [];
    const trapped = new Proxy(
      { safe: 'value' },
      {
        ownKeys(target) {
          trapsRun.push('ownKeys');
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          trapsRun.push('getOwnPropertyDescriptor');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          trapsRun.push('get');
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf(target) {
          trapsRun.push('getPrototypeOf');
          return Reflect.getPrototypeOf(target);
        },
      }
    );
    let seen: unknown = null;
    const outcome = await invokeOperation(
      registry,
      'message.send.trapped',
      { content: 'hello', trapped },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(trapsRun).toEqual([]);
    expect(seen).toEqual({ content: 'hello', trapped: '[unrepresentable]' });
  });
  test('operation metadata mutated by before does not reach after', async () => {
    const { registry } = fixture();
    let afterName: string | null = null;
    await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, {
      before: (prepared: { operation: { name: string } }) => {
        prepared.operation.name = 'rewritten-by-before';
      },
      after: (prepared: { operation: { name: string } }) => {
        afterName = prepared.operation.name;
      },
    });
    expect(afterName).toBe('message.send');
  });
  test('no snapshot work happens when no audit hook is installed', async () => {
    const probeOperation = defineOperation({
      name: 'message.send.probe',
      description: 'Accept a message carrying a probe object',
      inputSchema: z.object({ content: z.string(), probe: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([probeOperation]);
    const probe = { nested: 'value' };
    const originalDescriptors = Object.getOwnPropertyDescriptors;
    let copyCalls = 0;
    Object.getOwnPropertyDescriptors = ((target: object) => {
      if (target === probe) copyCalls += 1;
      return originalDescriptors(target);
    }) as typeof Object.getOwnPropertyDescriptors;
    const withProbe = { content: 'hello', probe };
    try {
      await invokeOperation(registry, 'message.send.probe', withProbe, caller);
      expect(copyCalls).toBe(0);
      await invokeOperation(registry, 'message.send.probe', withProbe, caller, {});
      expect(copyCalls).toBe(0);
      await invokeOperation(registry, 'message.send.probe', withProbe, caller, {
        before: () => {},
      });
      expect(copyCalls).toBeGreaterThan(0);
    } finally {
      Object.getOwnPropertyDescriptors = originalDescriptors;
    }
  });

  test('a hook set that changes between reads cannot disable snapshotting', async () => {
    const { registry } = fixture();
    let reads = 0;
    const shiftingAudit = {};
    let recorded: unknown = null;
    Object.defineProperty(shiftingAudit, 'before', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1
          ? undefined
          : (prepared: { input: { content: string } }) => {
              prepared.input.content = 'rewritten-by-before';
              recorded = prepared.input;
            };
      },
    });
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { content: 'hello' },
      caller,
      shiftingAudit
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(recorded).toBeNull();
  });

  test('a proxy-backed caller is recorded as undetermined rather than reflected over', async () => {
    const { registry } = fixture();
    const hostileCaller = new Proxy(
      { source: 'rpc' as const, sessionId: 'sender' },
      {
        ownKeys() {
          throw new Error('ownKeys refuses');
        },
      }
    );
    let seen: unknown = null;
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { content: 'hello' },
      hostileCaller,
      {
        after: (_prepared: unknown, callerArg: unknown) => {
          seen = callerArg;
        },
      }
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(seen).toEqual({});
  });

  test('a caller trap never runs because auditing is enabled', async () => {
    const { operation } = fixture();
    const trapsRun: string[] = [];
    const target = { source: 'rpc' as const, sessionId: 'sender' };
    const trappedCaller = new Proxy(target, {
      getOwnPropertyDescriptor(t, key) {
        trapsRun.push('getOwnPropertyDescriptor');
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      getPrototypeOf(t) {
        trapsRun.push('getPrototypeOf');
        return Reflect.getPrototypeOf(t);
      },
      ownKeys(t) {
        trapsRun.push('ownKeys');
        return Reflect.ownKeys(t);
      },
    });
    const registry = createOperationRegistry([
      { ...operation, execute: async () => ({ accepted: 'hello' }) },
    ]);

    await invokeOperation(registry, 'message.send', { content: 'hello' }, trappedCaller, {
      before: () => {},
      after: () => {},
    });

    expect(trapsRun).toEqual([]);
  });

  test('a non-enumerable input property stays out of the audit record', async () => {
    const operation = defineOperation({
      name: 'message.send.hidden',
      description: 'Accept a value carrying a hidden field',
      inputSchema: z.object({ content: z.string(), carrier: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const carrier = { visible: 'yes' };
    Object.defineProperty(carrier, 'secret', { enumerable: false, value: 'do-not-record' });
    let seen: unknown = null;
    await invokeOperation(registry, 'message.send.hidden', { content: 'hello', carrier }, caller, {
      after: (prepared: { input: unknown }) => {
        seen = prepared.input;
      },
    });
    const recorded = (seen as { carrier: Record<string, unknown> }).carrier;
    expect(recorded).toEqual({ visible: 'yes' });
    expect(Object.hasOwn(recorded, 'secret')).toBe(false);
  });

  test('an own __proto__ field stays an own field in the record', async () => {
    const operation = defineOperation({
      name: 'message.send.proto',
      description: 'Accept a value carrying an own __proto__ field',
      inputSchema: z.object({ content: z.string(), carrier: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const carrier: Record<string, unknown> = {};
    Object.defineProperty(carrier, '__proto__', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { injected: true },
    });
    let seen: unknown = null;
    await invokeOperation(registry, 'message.send.proto', { content: 'hello', carrier }, caller, {
      after: (prepared: { input: unknown }) => {
        seen = prepared.input;
      },
    });
    const recorded = (seen as { carrier: Record<string, unknown> }).carrier;
    expect(Object.hasOwn(recorded, '__proto__')).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(recorded)) as Record<string, unknown>;
    expect(Object.keys(roundTripped)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(roundTripped, '__proto__')?.value).toEqual({
      injected: true,
    });
  });

  test('a sparse array with a huge length does not scan its holes', async () => {
    const operation = defineOperation({
      name: 'message.send.sparse',
      description: 'Accept a sparse array',
      inputSchema: z.object({ content: z.string(), items: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const items: unknown[] = ['only'];
    items.length = 2 ** 30;
    let seen: unknown = null;
    const startedAt = Date.now();
    const outcome = await invokeOperation(
      registry,
      'message.send.sparse',
      { content: 'hello', items },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    const recorded = (seen as { items: unknown[] }).items;
    expect(recorded.length).toBe(2 ** 30);
    expect(recorded[0]).toBe('only');
  });

  test('a caller accessor is not consumed when no hook is installed', async () => {
    const { registry } = fixture();
    let reads = 0;
    const oneShotCaller = { sessionId: 'sender' } as unknown as typeof caller;
    Object.defineProperty(oneShotCaller, 'source', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'rpc' : 'internal';
      },
    });
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { content: 'hello' },
      oneShotCaller
    );
    expect(outcome.kind).toBe('completed');
    expect(reads).toBe(0);
  });

  test('a Date with an overridden getTime is copied without calling it', async () => {
    const operation = defineOperation({
      name: 'message.send.clock',
      description: 'Accept a value carrying a tampered Date',
      inputSchema: z.object({ content: z.string(), at: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const at = new Date(1000);
    let calls = 0;
    Object.defineProperty(at, 'getTime', {
      value: () => {
        calls += 1;
        return 999999;
      },
    });
    let seen: unknown = null;
    await invokeOperation(registry, 'message.send.clock', { content: 'hello', at }, caller, {
      after: (prepared: { input: unknown }) => {
        seen = prepared.input;
      },
    });
    expect(calls).toBe(0);
    expect((seen as { at: Date }).at.valueOf()).toBe(1000);
  });

  test('an array keeps its named fields and does not coerce lookalike keys', async () => {
    const operation = defineOperation({
      name: 'message.send.mixed',
      description: 'Accept an array carrying named fields',
      inputSchema: z.object({ content: z.string(), items: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const items: unknown[] = ['first'];
    (items as unknown as Record<string, unknown>).meta = 'kept';
    (items as unknown as Record<string, unknown>)['01'] = 'not-an-index';
    let seen: unknown = null;
    await invokeOperation(registry, 'message.send.mixed', { content: 'hello', items }, caller, {
      after: (prepared: { input: unknown }) => {
        seen = prepared.input;
      },
    });
    const recorded = (seen as { items: unknown[] & Record<string, unknown> }).items;
    expect(recorded[0]).toBe('first');
    expect(recorded.length).toBe(1);
    expect(recorded.meta).toBe('kept');
    expect(recorded['01']).toBe('not-an-index');
  });

  test('slot-based values are marked rather than recorded as empty objects', async () => {
    const operation = defineOperation({
      name: 'message.send.slots',
      description: 'Accept values whose contents live in internal slots',
      inputSchema: z.object({ content: z.string(), bag: z.any(), seen: z.any(), pattern: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let recorded: unknown = null;
    await invokeOperation(
      registry,
      'message.send.slots',
      {
        content: 'hello',
        bag: new Map([['k', 'v']]),
        seen: new Set([1, 2]),
        pattern: /abc/g,
      },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          recorded = prepared.input;
        },
      }
    );
    expect(recorded).toEqual({
      content: 'hello',
      bag: '[unrepresentable]',
      seen: '[unrepresentable]',
      pattern: '[unrepresentable]',
    });
  });

  test('a method-style hook keeps its own receiver', async () => {
    const { registry } = fixture();
    class Recorder {
      readonly seen: string[] = [];
      before(prepared: { operation: { name: string } }) {
        this.seen.push(prepared.operation.name);
      }
    }
    const recorder = new Recorder();
    await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, recorder);
    expect(recorder.seen).toEqual(['message.send']);
  });

  test('snapshotting never invokes an input accessor', async () => {
    const operation = defineOperation({
      name: 'message.send.accessor',
      description: 'Accept a value carrying a side-effecting getter',
      inputSchema: z.object({ content: z.string(), probe: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let getterCalls = 0;
    const probe = {};
    Object.defineProperty(probe, 'tripwire', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'side effect';
      },
    });
    let seen: unknown = null;
    const outcome = await invokeOperation(
      registry,
      'message.send.accessor',
      { content: 'hello', probe },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    expect(getterCalls).toBe(0);
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect((seen as { probe: { tripwire: string } }).probe.tripwire).toBe('[unrepresentable]');
  });

  test('an audit object whose hook lookup throws does not fail the operation', async () => {
    const { registry } = fixture();
    const hostileAudit = {};
    Object.defineProperty(hostileAudit, 'before', {
      enumerable: true,
      get() {
        throw new Error('hook discovery exploded');
      },
    });
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { content: 'hello' },
      caller,
      hostileAudit
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('enabling a hook never consumes a caller accessor the handler still has to read', async () => {
    const { operation } = fixture();
    const reads: string[] = [];
    const sources = ['rpc', 'mcp', 'internal'];
    const makeCaller = () => {
      let index = 0;
      return {
        get source() {
          reads.push('source');
          return sources[index++] as 'rpc';
        },
        sessionId: 'sender',
      };
    };
    const seenByHandler: string[] = [];
    const registry = createOperationRegistry([
      {
        ...operation,
        execute: async (input: { content: string }, callerArg: { source: string }) => {
          seenByHandler.push(callerArg.source);
          return { accepted: input.content };
        },
      },
    ]);

    await invokeOperation(registry, 'message.send', { content: 'hello' }, makeCaller(), undefined);
    const withoutAudit = seenByHandler.pop();

    await invokeOperation(registry, 'message.send', { content: 'hello' }, makeCaller(), {
      before: () => {},
      after: () => {},
    });
    const withAudit = seenByHandler.pop();

    expect(withAudit).toBe(withoutAudit);
  });
  test('an accessor-backed caller field is recorded as absent rather than invoked', async () => {
    const { registry } = fixture();
    let invoked = 0;
    const accessorCaller = {
      source: 'rpc' as const,
      get sessionId() {
        invoked += 1;
        return 'leaked';
      },
    };
    let seen: unknown = null;
    await invokeOperation(registry, 'message.send', { content: 'hello' }, accessorCaller, {
      after: (_prepared: unknown, callerArg: unknown) => {
        seen = callerArg;
      },
    });
    expect(seen).toEqual({ source: 'rpc' });
    expect(invoked).toBe(0);
  });
  test('a caller inheriting its fields as data still projects them', async () => {
    const { registry } = fixture();
    const inherited = Object.create({ source: 'mcp', sessionId: 'from-prototype' }) as {
      source: 'mcp';
    };
    let seen: unknown = null;
    await invokeOperation(registry, 'message.send', { content: 'hello' }, inherited, {
      after: (_prepared: unknown, callerArg: unknown) => {
        seen = callerArg;
      },
    });
    expect(seen).toEqual({ source: 'mcp', sessionId: 'from-prototype' });
  });
  test('one unreadable hook never discards the other', async () => {
    const { registry } = fixture();
    let beforeRan = false;
    const audit = {
      before: () => {
        beforeRan = true;
      },
      get after() {
        throw new Error('after refuses to be read');
      },
    };
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { content: 'hello' },
      caller,
      audit
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(beforeRan).toBe(true);
  });
  test('an unreadable before never hides a healthy after', async () => {
    const { registry } = fixture();
    let afterRan = false;
    const audit = {
      get before() {
        throw new Error('before refuses to be read');
      },
      after: () => {
        afterRan = true;
      },
    };
    await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, audit);
    expect(afterRan).toBe(true);
  });
  test('a counterfeit Date is projected as an ordinary object, never through Date internals', async () => {
    const operation = defineOperation({
      name: 'message.send.counterfeit',
      description: 'Accept a value that claims to be a Date without being one',
      inputSchema: z.object({ content: z.string(), when: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const when = Object.create(Date.prototype) as Date & { label?: string };
    when.label = 'not really a date';
    let seen: unknown = null;
    const outcome = await invokeOperation(
      registry,
      'message.send.counterfeit',
      { content: 'hello', when },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(seen).toEqual({ content: 'hello', when: { label: 'not really a date' } });
    expect((seen as { when: unknown }).when).not.toBeInstanceOf(Date);
  });
  test('an enumerable symbol-keyed field survives the snapshot', async () => {
    const tag = Symbol('tag');
    const operation = defineOperation({
      name: 'message.send.symbolic',
      description: 'Accept a value carrying a symbol-keyed field',
      inputSchema: z.object({ content: z.string(), payload: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const payload = { plain: 'kept', [tag]: 'also kept' };
    let seen: Record<string, unknown> | null = null;
    await invokeOperation(
      registry,
      'message.send.symbolic',
      { content: 'hello', payload },
      caller,
      {
        after: (prepared: { input: Record<string, unknown> }) => {
          seen = prepared.input;
        },
      }
    );
    const recorded = (seen as unknown as { payload: Record<string | symbol, unknown> }).payload;
    expect(recorded.plain).toBe('kept');
    expect(recorded[tag]).toBe('also kept');
    expect(recorded).not.toBe(payload);
  });
  test('an enumerable accessor on an array keeps its key with the marker', async () => {
    const operation = defineOperation({
      name: 'message.send.arrayaccessor',
      description: 'Accept an array carrying accessor properties',
      inputSchema: z.object({ content: z.string(), rows: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let indexReads = 0;
    let namedReads = 0;
    const rows: unknown[] = ['first'];
    Object.defineProperty(rows, '1', {
      enumerable: true,
      configurable: true,
      get() {
        indexReads += 1;
        return 'computed';
      },
    });
    Object.defineProperty(rows, 'label', {
      enumerable: true,
      configurable: true,
      get() {
        namedReads += 1;
        return 'computed';
      },
    });
    let seen: unknown = null;
    await invokeOperation(
      registry,
      'message.send.arrayaccessor',
      { content: 'hello', rows },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    const recorded = (seen as { rows: unknown[] & { label?: unknown } }).rows;
    expect(recorded[0]).toBe('first');
    expect(recorded[1]).toBe('[unrepresentable]');
    expect(recorded.label).toBe('[unrepresentable]');
    expect(indexReads).toBe(0);
    expect(namedReads).toBe(0);
  });
  test('a proxy in the prototype chain is never traversed while detecting Dates', async () => {
    const operation = defineOperation({
      name: 'message.send.proxyproto',
      description: 'Accept a value whose prototype is a proxy',
      inputSchema: z.object({ content: z.string(), carrier: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let prototypeTraps = 0;
    const proxyProto = new Proxy(
      {},
      {
        getPrototypeOf(target) {
          prototypeTraps += 1;
          return Reflect.getPrototypeOf(target);
        },
      }
    );
    const carrier = Object.create(proxyProto) as Record<string, unknown>;
    carrier.field = 'kept';

    await invokeOperation(
      registry,
      'message.send.proxyproto',
      { content: 'hello', carrier },
      caller,
      { before: () => {}, after: () => {} }
    );

    expect(prototypeTraps).toBe(0);
  });
  test('a Date carrying enumerable fields keeps them in the record', async () => {
    const operation = defineOperation({
      name: 'message.send.richdate',
      description: 'Accept a Date carrying its own fields',
      inputSchema: z.object({ content: z.string(), when: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    const when = new Date(1700000000000) as Date & { context?: unknown };
    when.context = { note: 'kept' };
    let seen: unknown = null;
    await invokeOperation(registry, 'message.send.richdate', { content: 'hello', when }, caller, {
      after: (prepared: { input: unknown }) => {
        seen = prepared.input;
      },
    });
    const recorded = (seen as { when: Date & { context?: { note: string } } }).when;
    expect(recorded).toBeInstanceOf(Date);
    expect(recorded.getTime()).toBe(1700000000000);
    expect(recorded.context).toEqual({ note: 'kept' });
    expect(recorded).not.toBe(when);
    expect(recorded.context).not.toBe(when.context);
  });
  test('a caller inheriting from a proxy never reaches that proxy traps', async () => {
    const { operation } = fixture();
    const trapsRun: string[] = [];
    const proxyAncestor = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(target, key) {
          trapsRun.push('getOwnPropertyDescriptor');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) {
          trapsRun.push('getPrototypeOf');
          return Reflect.getPrototypeOf(target);
        },
      }
    );
    const heir = Object.create(proxyAncestor) as { source: 'rpc' };
    heir.source = 'rpc';
    const registry = createOperationRegistry([
      { ...operation, execute: async () => ({ accepted: 'hello' }) },
    ]);
    let seen: unknown = null;

    await invokeOperation(registry, 'message.send', { content: 'hello' }, heir, {
      after: (_prepared: unknown, callerArg: unknown) => {
        seen = callerArg;
      },
    });

    expect(trapsRun).toEqual([]);
    expect(seen).toEqual({ source: 'rpc' });
  });
  test('a caller whose proxy ancestor returns itself as prototype does not hang', async () => {
    const { registry } = fixture();
    const selfReferential: { proxy?: object } = {};
    selfReferential.proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          return selfReferential.proxy as object;
        },
      }
    );
    const heir = Object.create(selfReferential.proxy) as { source: 'rpc' };
    heir.source = 'rpc';

    const outcome = await invokeOperation(registry, 'message.send', { content: 'hello' }, heir, {
      after: () => {},
    });

    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('a class instance keeps its own enumerable fields in the record', async () => {
    const operation = defineOperation({
      name: 'message.send.instance',
      description: 'Accept a class instance carrying public fields',
      inputSchema: z.object({ content: z.string(), payload: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let hiddenReads = 0;
    class Payload {
      readonly value: string;
      readonly nested: { deep: number };
      constructor(value: string) {
        this.value = value;
        this.nested = { deep: 1 };
      }
      get computed(): string {
        hiddenReads += 1;
        return 'never read';
      }
    }
    const payload = new Payload('kept');
    let seen: unknown = null;
    await invokeOperation(
      registry,
      'message.send.instance',
      { content: 'hello', payload },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    const recorded = (seen as { payload: { value: string; nested: { deep: number } } }).payload;
    expect(recorded).toEqual({ value: 'kept', nested: { deep: 1 } });
    expect(recorded.nested).not.toBe(payload.nested);
    expect(hiddenReads).toBe(0);
  });
  test('a platform object whose state lives in slots is marked, not flattened to an empty object', async () => {
    const operation = defineOperation({
      name: 'message.send.platform',
      description: 'Accept platform objects with slot-backed state',
      inputSchema: z.object({ content: z.string(), link: z.any(), query: z.any() }),
      resultSchema: z.object({ accepted: z.string() }),
      execute: async (input: { content: string }) => ({ accepted: input.content }),
    });
    const registry = createOperationRegistry([operation]);
    let seen: unknown = null;
    await invokeOperation(
      registry,
      'message.send.platform',
      {
        content: 'hello',
        link: new URL('https://example.com/a?b=1'),
        query: new URLSearchParams('a=1'),
      },
      caller,
      {
        after: (prepared: { input: unknown }) => {
          seen = prepared.input;
        },
      }
    );
    expect(seen).toEqual({
      content: 'hello',
      link: '[unrepresentable]',
      query: '[unrepresentable]',
    });
  });
  test('no operation metadata is read when no hook was captured', async () => {
    const { operation } = fixture();
    let metadataReads = 0;
    const shifty = {
      get name() {
        metadataReads += 1;
        return 'message.send';
      },
      get description() {
        metadataReads += 1;
        return 'shifting description';
      },
      inputSchema: operation.inputSchema,
      resultSchema: operation.resultSchema,
      execute: operation.execute,
    };
    const registry = {
      get: (name: string) => (name === 'message.send' ? shifty : undefined),
      list: () => [shifty],
    } as unknown as Parameters<typeof invokeOperation>[0];

    const outcome = await invokeOperation(registry, 'message.send', { content: 'hello' }, caller);

    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(metadataReads).toBe(0);
  });
  test('a throwing metadata accessor never rejects the invocation', async () => {
    const { operation } = fixture();
    const hostile = {
      get name(): string {
        throw new Error('name refuses to be read');
      },
      get description(): string {
        throw new Error('description refuses to be read');
      },
      inputSchema: operation.inputSchema,
      resultSchema: operation.resultSchema,
      execute: operation.execute,
    };
    const registry = {
      get: (name: string) => (name === 'message.send' ? hostile : undefined),
      list: () => [hostile],
    } as unknown as Parameters<typeof invokeOperation>[0];
    let seen: { name: string; description: string } | null = null;

    const outcome = await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, {
      after: (prepared: { operation: { name: string; description: string } }) => {
        seen = prepared.operation;
      },
    });

    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(seen).toEqual({
      name: '[unrepresentable]',
      description: '[unrepresentable]',
    });
  });
  test('a handler mutating its caller does not change what after records', async () => {
    const { operation } = fixture();
    const hijackingExecute = async (
      input: { content: string },
      callerArg: { source: string; sessionId?: string }
    ) => {
      callerArg.source = 'internal';
      callerArg.sessionId = 'hijacked';
      return { accepted: input.content };
    };
    const registry = createOperationRegistry([{ ...operation, execute: hijackingExecute }]);
    const localCaller = { source: 'rpc' as const, sessionId: 'sender' };
    let afterCaller: unknown = null;
    const audit = {
      after: (_prepared: unknown, callerArg: unknown) => {
        afterCaller = callerArg;
      },
    };
    await invokeOperation(registry, 'message.send', { content: 'hello' }, localCaller, audit);
    expect(afterCaller).toEqual({ source: 'rpc', sessionId: 'sender' });
  });
});
