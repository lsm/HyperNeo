import { describe, expect, test } from 'bun:test';
import {
  createReadWorkOperation,
  type ReadWorkDeps,
} from '../../../../src/lib/drivers/read-operation';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';

const turn = { messageId: 'm1', role: 'assistant', at: 10, text: 'opened PR #5650' };

async function invoke(deps: ReadWorkDeps, input: Record<string, unknown>) {
  const registry = createOperationRegistry([createReadWorkOperation(deps)]);
  const outcome = await invokeOperation(registry, 'work.read', input, {
    source: 'mcp',
    sessionId: 'neo:root',
  });
  return outcome.kind === 'completed' ? outcome.value : outcome;
}

describe('createReadWorkOperation', () => {
  const remoteCalls: Array<[string, string, unknown]> = [];
  const deps: ReadWorkDeps = {
    readTurns: (sessionId, around) =>
      sessionId === 's1' && (around === undefined || around === 'm1') ? [turn] : null,
    remote: {
      list: () => [],
      invoke: async (daemon, name, input) => {
        remoteCalls.push([daemon, name, input]);
        return { ok: true, value: { sessionId: 's9', turns: [turn] } };
      },
    },
    daemonName: 'imac',
  };

  test('reads local turns around a handle with default context', async () => {
    expect(await invoke(deps, { sessionId: 's1', around: 'm1' })).toEqual({
      ok: true,
      value: { sessionId: 's1', turns: [turn] },
    });
  });

  test('says not_found for a message that is not in the session', async () => {
    expect(await invoke(deps, { sessionId: 's1', around: 'zz' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  test('forwards a handle from another daemon without the daemon field', async () => {
    const reply = await invoke(deps, { sessionId: 's9', around: 'm1', daemon: 'laptop' });
    expect(reply).toEqual({ ok: true, value: { sessionId: 's9', turns: [turn] } });
    expect(remoteCalls).toEqual([
      ['laptop', 'work.read', { sessionId: 's9', around: 'm1', before: 2, after: 2 }],
    ]);
  });

  test('reads locally when the daemon named is this one', async () => {
    expect(await invoke(deps, { sessionId: 's1', daemon: 'imac' })).toMatchObject({ ok: true });
  });
});
