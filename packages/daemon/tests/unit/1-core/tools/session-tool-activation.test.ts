import { describe, expect, test, mock } from 'bun:test';
import { createSessionToolActivationOperation } from '../../../../src/lib/tools/session-tool-activation.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

function fixture() {
  const write = mock(async () => ({
    ok: true as const,
    changed: true,
    selection: { version: 1 as const, choices: { 'mcp:browser': { selected: true } } },
  }));
  const applyToolChoice = mock(async () => ({ application: 'live' as const }));
  const operation = createSessionToolActivationOperation({
    write,
    getLiveSession: () => ({ applyToolChoice }),
    exclusive: async <T>(_id: string, run: () => Promise<T>) => run(),
  });
  const invoke = (
    input: unknown,
    caller: OperationCaller = { source: 'rpc', principal: 'local' }
  ) =>
    invokeOperation(createOperationRegistry([operation]), 'session.tools.setChoice', input, caller);
  return { write, applyToolChoice, operation, invoke };
}

describe('authorized session tool activation', () => {
  test('persists the canonical choice before applying and returns application disclosure', async () => {
    const f = fixture();
    expect(await f.invoke({ sessionId: 'worker', key: 'mcp:browser', selected: true })).toEqual({
      kind: 'completed',
      value: { ok: true, changed: true, application: 'live' },
    });
    expect(f.write).toHaveBeenCalledWith('worker', {
      kind: 'choice',
      key: 'mcp:browser',
      selected: true,
    });
    expect(f.applyToolChoice).toHaveBeenCalledWith('mcp:browser');
    expect(f.write.mock.invocationCallOrder[0]).toBeLessThan(
      f.applyToolChoice.mock.invocationCallOrder[0]
    );
  });

  test('never applies rejected writes', async () => {
    const f = fixture();
    f.write.mockResolvedValueOnce({ ok: false, reason: 'superseded' } as never);
    expect(await f.invoke({ sessionId: 'worker', key: 'mcp:browser', selected: true })).toEqual({
      kind: 'completed',
      value: { ok: false, reason: 'superseded' },
    });
    expect(f.applyToolChoice).not.toHaveBeenCalled();
  });

  test('a cold session records the choice for the next query without loading it', async () => {
    const f = fixture();
    const operation = createSessionToolActivationOperation({
      write: f.write,
      getLiveSession: () => null,
      exclusive: async <T>(_id: string, run: () => Promise<T>) => run(),
    });
    expect(
      await invokeOperation(
        createOperationRegistry([operation]),
        'session.tools.setChoice',
        { sessionId: 'cold', key: 'skill:guide', selected: false },
        { source: 'rpc', principal: 'local' }
      )
    ).toEqual({ kind: 'completed', value: { ok: true, changed: true, application: 'next_query' } });
    expect(f.applyToolChoice).not.toHaveBeenCalled();
  });

  test('only a local human may change session tool selection', async () => {
    const f = fixture();
    for (const caller of [
      { source: 'mcp', principal: '' },
      { source: 'rpc', principal: 'remote' },
    ] as const) {
      expect(
        await f.invoke({ sessionId: 'worker', key: 'mcp:browser', selected: true }, caller)
      ).toMatchObject({ kind: 'failed', code: 'forbidden' });
    }
    expect(f.write).not.toHaveBeenCalled();
  });

  test('refuses malformed keys before persistence', async () => {
    const f = fixture();
    expect(await f.invoke({ sessionId: 'worker', key: 'browser', selected: true })).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
    expect(f.write).not.toHaveBeenCalled();
  });
});
