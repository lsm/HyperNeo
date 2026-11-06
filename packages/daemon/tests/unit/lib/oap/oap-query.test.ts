import { describe, expect, mock, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
// @ts-expect-error The implementation follows this failing test.
import { OapQuery } from '../../../../src/lib/oap/oap-query';

describe('OapQuery', () => {
  test('submits each prompt once and cancels the active run once', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'synthetic prompt' },
    } as SDKUserMessage;
    async function* prompt() {
      yield message;
    }
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = mock(async () => ({ runId: 'r1' }));
    const cancel = mock(async () => {
      release();
    });
    const events = mock(async function* () {
      await waiting;
      yield { type: 'run.cancelled' };
    });
    const translate = mock(() => []);
    const query = new OapQuery({
      sessionId: 's1',
      prompt: prompt(),
      hub: { submit, cancel, events },
      translator: { translate },
    });
    const collected = (async () => {
      for await (const item of query) void item;
    })();
    while (events.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([query.interrupt(), query.interrupt()]);
    await collected;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('s1', message);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
