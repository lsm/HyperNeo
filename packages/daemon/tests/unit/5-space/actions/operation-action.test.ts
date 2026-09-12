/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  runDispatchAction,
  type DispatchActionDeps,
} from '../../../../src/lib/space/actions/dispatcher-pipeline.ts';
import {
  createOperationActionHandler,
  invokeMappedOperation,
  mapActionParams,
} from '../../../../src/lib/space/actions/operation-action.ts';
import { createActionRegistry, defineAction } from '../../../../src/lib/space/actions/registry.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { OperationRegistry } from '../../../../src/lib/operations/registry.ts';

function extractText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

function exampleRegistry(
  execute = mock(async (input: { text: string }) => ({ echoed: input.text }))
) {
  return {
    execute,
    registry: createOperationRegistry([
      defineOperation({
        name: 'example',
        description: 'Example operation',
        inputSchema: z.object({ text: z.string() }),
        resultSchema: z.object({ echoed: z.string() }),
        execute,
      }),
    ]),
  };
}

describe('mapActionParams (gate)', () => {
  test('a plain mapped value continues with { mappedParams }', async () => {
    const result = await mapActionParams({ text: 'hi' }, (params) => ({
      text: (params as { text: string }).text,
    }));
    expect(result).toEqual({ value: { mappedParams: { text: 'hi' } } });
  });

  test('a { reject } mapped value halts with a formatted ToolResult reason', async () => {
    const result = await mapActionParams({}, () => ({ reject: 'nope' }));
    expect(result).toMatchObject({
      reason: { isError: true },
    });
    const reason = (result as { reason: { content: Array<{ text: string }> } }).reason;
    expect(JSON.parse(reason.content[0].text)).toEqual({ success: false, error: 'nope' });
  });

  test('awaits an async mapParams before deciding', async () => {
    const result = await mapActionParams({}, async () => ({ text: 'async' }));
    expect(result).toEqual({ value: { mappedParams: { text: 'async' } } });
  });
});

describe('invokeMappedOperation (gate)', () => {
  test('a completed outcome becomes jsonResult(value)', async () => {
    const { registry } = exampleRegistry();
    const result = await invokeMappedOperation(
      { mappedParams: { text: 'hi' } },
      registry,
      'example',
      { source: 'mcp' }
    );
    expect(JSON.parse(extractText(result))).toEqual({ echoed: 'hi' });
    expect(result.isError).toBeUndefined();
  });

  test('a failed outcome becomes an isError ToolResult with the code and message', async () => {
    const { registry } = exampleRegistry();
    const result = await invokeMappedOperation({ mappedParams: {} }, registry, 'missing', {
      source: 'mcp',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(extractText(result))).toMatchObject({ code: 'unknown_operation' });
  });
});

describe('createOperationActionHandler', () => {
  test('maps a completed outcome to jsonResult of the operation value', async () => {
    const { registry } = exampleRegistry();
    const handler = createOperationActionHandler(registry, { sessionId: 'sess-1' }, 'example');
    const result = (await handler({ text: 'hi' })) as { content: Array<{ text: string }> };
    expect(JSON.parse(extractText(result))).toEqual({ echoed: 'hi' });
    expect(result.isError).toBeUndefined();
  });

  test('applies mapParams before invoking and passes source: mcp plus sessionId', async () => {
    const { registry, execute } = exampleRegistry();
    const handler = createOperationActionHandler(
      registry,
      { sessionId: 'sess-1' },
      'example',
      (params) => ({ text: (params as { raw: string }).raw })
    );
    await handler({ raw: 'mapped' });
    expect(execute).toHaveBeenCalledWith(
      { text: 'mapped' },
      { source: 'mcp', sessionId: 'sess-1' }
    );
  });

  test('resolves a registry provider function per call', async () => {
    const first = exampleRegistry();
    const second = exampleRegistry(mock(async () => ({ echoed: 'second' })));
    const registries = [first.registry, second.registry];
    const provider = mock<() => OperationRegistry>(() => registries.shift() as OperationRegistry);
    const handler = createOperationActionHandler(provider, {}, 'example');
    await handler({ text: 'a' });
    const secondResult = (await handler({ text: 'b' })) as { content: Array<{ text: string }> };
    expect(provider).toHaveBeenCalledTimes(2);
    expect(JSON.parse(extractText(secondResult))).toEqual({ echoed: 'second' });
  });

  test.each([
    { code: 'unknown_operation', name: 'missing', params: {} },
    { code: 'invalid_input', name: 'example', params: { text: 42 } },
  ])(
    'maps $code failures to jsonResult({ code, message }) with isError',
    async ({ code, name, params }) => {
      const { registry } = exampleRegistry();
      const handler = createOperationActionHandler(registry, {}, name);
      const result = (await handler(params)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(JSON.parse(extractText(result)).code).toBe(code);
    }
  );

  test('awaits an async mapParams before invoking', async () => {
    const { registry, execute } = exampleRegistry();
    const handler = createOperationActionHandler(
      registry,
      { sessionId: 'sess-1' },
      'example',
      async (params) => ({ text: (params as { raw: string }).raw })
    );
    await handler({ raw: 'mapped-async' });
    expect(execute).toHaveBeenCalledWith(
      { text: 'mapped-async' },
      { source: 'mcp', sessionId: 'sess-1' }
    );
  });

  test.each([
    { label: 'sync', mapParams: () => ({ reject: 'not allowed' }) },
    { label: 'async', mapParams: async () => ({ reject: 'not allowed' }) },
  ])(
    'short-circuits on a $label mapParams rejection without invoking the operation',
    async ({ mapParams }) => {
      const { registry, execute } = exampleRegistry();
      const handler = createOperationActionHandler(registry, {}, 'example', mapParams);
      const result = (await handler({ text: 'hi' })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(JSON.parse(extractText(result))).toEqual({
        success: false,
        error: 'not allowed',
      });
      expect(execute).not.toHaveBeenCalled();
    }
  );

  test('passes through a mapped value that merely contains a reject key alongside others', async () => {
    const execute = mock(async (input: { text: string; reject: string }) => ({
      echoed: `${input.text}:${input.reject}`,
    }));
    const registry = createOperationRegistry([
      defineOperation({
        name: 'example',
        description: 'Example operation',
        inputSchema: z.object({ text: z.string(), reject: z.string() }),
        resultSchema: z.object({ echoed: z.string() }),
        execute,
      }),
    ]);
    const handler = createOperationActionHandler(registry, {}, 'example', () => ({
      text: 'hi',
      reject: 'not-a-rejection',
    }));
    const result = (await handler({})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      { text: 'hi', reject: 'not-a-rejection' },
      { source: 'mcp' }
    );
    expect(JSON.parse(extractText(result))).toEqual({ echoed: 'hi:not-a-rejection' });
  });

  test('maps execution_failed and invalid_result failures the same way', async () => {
    const throwing = exampleRegistry(
      mock(async () => {
        throw new Error('boom');
      })
    );
    const throwingHandler = createOperationActionHandler(throwing.registry, {}, 'example');
    const throwingResult = (await throwingHandler({ text: 'x' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(throwingResult.isError).toBe(true);
    expect(JSON.parse(extractText(throwingResult))).toEqual({
      code: 'execution_failed',
      message: 'boom',
    });

    const badResult = exampleRegistry(mock(async () => ({ echoed: 42 })));
    const badResultHandler = createOperationActionHandler(badResult.registry, {}, 'example');
    const invalidResult = (await badResultHandler({ text: 'x' })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(invalidResult.isError).toBe(true);
    expect(JSON.parse(extractText(invalidResult)).code).toBe('invalid_result');
  });
});

describe('operation-backed action dispatch', () => {
  test('dispatches through the same pipeline as call_action', async () => {
    const { registry } = exampleRegistry();
    const operationAction = defineAction({
      name: 'operation_example',
      family: 'tasks',
      safetyClass: 'read',
      description: 'Operation-backed example action',
      paramsDoc: '{ text: string }',
      paramsSchema: z.object({ text: z.string() }),
      handler: createOperationActionHandler(registry, { sessionId: 'sess-1' }, 'example'),
    });
    const deps: DispatchActionDeps = { registry: createActionRegistry([operationAction]) };
    const outcome = await runDispatchAction(deps, {
      actionName: 'operation_example',
      params: { text: 'hi' },
      role: 'coordinator',
      spaceId: 'space-1',
    });
    if (outcome.action !== 'dispatched') throw new Error('Expected dispatched outcome');
    expect(JSON.parse(extractText(outcome.result))).toEqual({ echoed: 'hi' });
  });
});
