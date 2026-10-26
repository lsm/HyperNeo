import { describe, expect, test } from 'bun:test';
import { createReadWorkOperation } from '../../../../src/lib/drivers/read-operation';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';

const identity = { adapter: 'codex-desktop', marker: '[worker-answer:exact]' };
const turn = {
  messageId: 'accepted-input',
  role: 'user',
  at: 1,
  text: `${identity.marker}\nAnswer`,
};
const caller = { source: 'mcp' as const, sessionId: 'neo:root', role: 'neo' as const };

describe('work.read exact input identity', () => {
  const local = {
    daemonName: 'owner',
    readTurns: () => [{ ...turn, messageId: 'unrelated', text: 'Newest input' }],
    readInput: async (sessionId: string, input: typeof identity) =>
      sessionId === 'worker' &&
      input.adapter === identity.adapter &&
      input.marker === identity.marker
        ? turn
        : null,
    remote: { list: () => [], invoke: async () => ({ ok: false, reason: 'unreachable' }) },
  };
  const invoke = async (input: Record<string, unknown>, deps = local) => {
    const outcome = await invokeOperation(
      createOperationRegistry([createReadWorkOperation(deps)]),
      'work.read',
      input,
      caller
    );
    return outcome.kind === 'completed' ? outcome.value : outcome;
  };

  test('returns the scoped exact user input instead of the latest history window', async () => {
    expect(await invoke({ sessionId: 'worker', input: identity })).toEqual({
      ok: true,
      value: { sessionId: 'worker', turns: [turn], matchedInput: identity },
    });
    for (const input of [
      { sessionId: 'other', input: identity },
      { sessionId: 'worker', input: { ...identity, adapter: 'claude-code' } },
      { sessionId: 'worker', input: { ...identity, marker: '[worker-answer:missing]' } },
    ])
      expect(await invoke(input)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test('does not silently ignore identity on an older peer', async () => {
    const deps = {
      ...local,
      remote: {
        list: () => [],
        invoke: async () => ({ ok: true, value: { sessionId: 'worker', turns: [turn] } }),
      },
    };
    expect(
      await invoke({ sessionId: 'worker', daemon: 'peer', input: identity }, deps)
    ).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  test('routes only to the named owner and preserves its identity acknowledgement', async () => {
    const requests: unknown[] = [];
    const deps = {
      ...local,
      remote: {
        list: () => [],
        invoke: async (daemon: string, name: string, input: unknown) => {
          requests.push({ daemon, name, input });
          return {
            ok: true,
            value: { sessionId: 'worker', turns: [turn], matchedInput: identity },
          };
        },
      },
    };
    expect(
      await invoke({ sessionId: 'worker', daemon: 'peer', input: identity }, deps)
    ).toMatchObject({ ok: true, value: { matchedInput: identity } });
    expect(requests).toEqual([
      {
        daemon: 'peer',
        name: 'work.read',
        input: { sessionId: 'worker', input: identity, before: 2, after: 2 },
      },
    ]);
  });

  test('refuses mixed identity and window selectors', async () => {
    for (const selector of [{ around: 'input' }, { cursor: { sessionId: 'worker', before: 1 } }]) {
      expect(await invoke({ sessionId: 'worker', input: identity, ...selector })).toMatchObject({
        kind: 'failed', code: 'invalid_input',
      });
    }
  });
});
