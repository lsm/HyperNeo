import { describe, expect, mock, test } from 'bun:test';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { createOapQuery, OapQuery } from '../../../../src/lib/oap/oap-query';

describe('OapQuery', () => {
  test('keeps event message identities distinct when a restarted hub repeats event and run ids', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'explicit request' },
    } as SDKUserMessage;
    const identities: string[][] = [];
    for (let turn = 0; turn < 2; turn++) {
      const query = createOapQuery({
        sessionId: 's1',
        prompt: (async function* () {
          yield message;
        })(),
        hub: {
          submit: async () => ({ runId: 'reused-run' }),
          cancel: async () => {},
          events: async function* () {
            yield {
              type: 'content.delta',
              id: 'reused-text',
              payload: { part: { type: 'text', text: 'reply' } },
            };
            yield { type: 'run.completed', id: 'reused-terminal', payload: {} };
          },
        },
      });
      const current: string[] = [];
      for await (const result of query) current.push(result.uuid);
      identities.push(current);
    }
    expect(identities[0]).toHaveLength(2);
    expect(identities[1]).toHaveLength(2);
    expect(identities[0][0]).not.toBe(identities[1][0]);
    expect(identities[0][1]).not.toBe(identities[1][1]);
  });

  test('does not cancel a completed run while its terminal result is being handled', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    const cancel = mock(async () => {});
    const query = createOapQuery({
      sessionId: 's1',
      prompt: (async function* () {
        yield message;
      })(),
      hub: {
        submit: async () => ({ runId: 'r1' }),
        cancel,
        events: async function* () {
          yield { type: 'run.completed', id: 'end-1', payload: {} };
        },
      },
    });
    const iterator = query[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'result' });
    query.close();
    expect(cancel).not.toHaveBeenCalled();
    await iterator.return?.();
  });

  test('cancels a run accepted after its attempt loses ownership', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    let resolveSubmit!: (value: { runId: string }) => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let live = true;
    const cancel = mock(async () => {});
    const events = mock(async function* () {
      yield { type: 'run.completed', id: 'end-1', payload: {} };
    });
    const options = {
      sessionId: 's1',
      prompt: (async function* () {
        yield message;
      })(),
      hub: {
        submit: () => {
          started();
          return new Promise<{ runId: string }>((resolve) => {
            resolveSubmit = resolve;
          });
        },
        events,
        cancel,
      },
      translator: { translate: () => [{ type: 'result' } as SDKMessage] },
      isLive: () => live,
    };
    const query = new OapQuery(options);
    const next = query[Symbol.asyncIterator]().next();
    await submitted;
    live = false;
    resolveSubmit({ runId: 'r1' });
    expect((await next).done).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
    expect(events).not.toHaveBeenCalled();
  });

  test('drops late output after interruption but delivers one cancellation terminal', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    let release!: () => void;
    let listening!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listeningStarted = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const cancel = mock(async () => {
      release();
    });
    const query = createOapQuery({
      sessionId: 's1',
      prompt: (async function* () {
        yield message;
      })(),
      hub: {
        submit: async () => ({ runId: 'r1' }),
        cancel,
        events: async function* () {
          listening();
          await waiting;
          yield {
            type: 'content.delta',
            id: 'late',
            payload: { part: { type: 'text', text: 'late' } },
          };
          yield { type: 'run.cancelled', id: 'cancelled', payload: { reason: 'cancelled' } };
          yield { type: 'run.failed', id: 'duplicate', payload: {} };
        },
      },
    });
    const messages: SDKMessage[] = [];
    const running = (async () => {
      for await (const item of query) messages.push(item);
    })();
    await listeningStarted;
    await query.interrupt();
    await running;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'result', is_error: true });
  });

  test('cancels the active run if an event cannot be translated', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    const cancel = mock(async () => {});
    const query = createOapQuery({
      sessionId: 's1',
      prompt: (async function* () {
        yield message;
      })(),
      hub: {
        submit: async () => ({ runId: 'r1' }),
        cancel,
        events: async function* () {
          yield { type: 'content.delta', payload: {} };
        },
      },
    });
    const consume = async () => {
      for await (const item of query) void item;
    };
    await expect(consume()).rejects.toThrow('Invalid OAP event');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
  });

  test('the query factory translates text and terminal events afresh for each run', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    const prompt = (async function* () {
      yield message;
      yield message;
    })();
    const submit = mock(async () => ({ runId: `r${submit.mock.calls.length}` }));
    const query = createOapQuery({
      sessionId: 's1',
      prompt,
      hub: {
        submit,
        cancel: async () => {},
        events: async function* (_session, runId) {
          yield {
            type: 'content.delta',
            id: `${runId}-text`,
            payload: { part: { type: 'text', text: `reply ${runId}` } },
          };
          yield {
            type: 'run.completed',
            id: `${runId}-terminal`,
            payload: { final_response: { content: `reply ${runId}` } },
          };
        },
      },
    });
    expect(query).toBeInstanceOf(OapQuery);
    const messages: SDKMessage[] = [];
    for await (const item of query) messages.push(item);
    expect(messages.map((item) => item.type)).toEqual([
      'assistant',
      'result',
      'assistant',
      'result',
    ]);
    expect(messages[0]).toMatchObject({ message: { content: [{ text: 'reply r1' }] } });
    expect(messages[2]).toMatchObject({ message: { content: [{ text: 'reply r2' }] } });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  test('cancels unsupported free-text questions with a clear error instead of answering', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    const cancel = mock(async () => {});
    const translate = mock(() => []);
    const query = new OapQuery({
      sessionId: 's1',
      prompt: (async function* () {
        yield message;
      })(),
      hub: {
        submit: async () => ({ runId: 'r1' }),
        cancel,
        events: async function* () {
          yield {
            type: 'user.input.requested',
            payload: {
              interaction_id: 'input-1',
              title: 'Synthetic question',
              questions: [{ id: 'q1', prompt: 'Explain?', kind: 'text' }],
            },
          };
        },
      },
      translator: { translate },
    });
    const consume = async () => {
      for await (const item of query) void item;
    };
    await expect(consume()).rejects.toThrow('unsupported text question');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
    expect(translate).not.toHaveBeenCalled();
  });

  test('cancels a permission request until permission handling is wired', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    const cancel = mock(async () => {});
    const query = new OapQuery({
      sessionId: 's1',
      prompt: (async function* () {
        yield message;
      })(),
      hub: {
        submit: async () => ({ runId: 'r1' }),
        cancel,
        events: async function* () {
          yield { type: 'action.permission.requested' };
        },
      },
      translator: { translate: () => [] },
    });
    const consume = async () => {
      for await (const item of query) void item;
    };
    await expect(consume()).rejects.toThrow('permission requests are not supported');
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
  });

  test('yields messages returned by the injected translator in event order', async () => {
    const user = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    const translated = { type: 'result', subtype: 'success' } as SDKMessage;
    async function* prompt() {
      yield user;
    }
    const query = new OapQuery({
      sessionId: 's1',
      prompt: prompt(),
      hub: {
        submit: async () => ({ runId: 'r1' }),
        cancel: async () => {},
        events: async function* () {
          yield { type: 'run.completed' };
        },
      },
      translator: { translate: () => [translated] },
    });
    const messages: SDKMessage[] = [];
    for await (const item of query) messages.push(item);
    expect(messages).toEqual([translated]);
  });
  test('interrupt waits for an in-flight submit before cancelling its run', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    async function* prompt() {
      yield message;
    }
    let admit!: (value: { runId: string }) => void;
    let submitted!: () => void;
    const started = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const submit = mock(() => {
      submitted();
      return new Promise<{ runId: string }>((resolve) => {
        admit = resolve;
      });
    });
    const cancel = mock(async () => {});
    const query = new OapQuery({
      sessionId: 's1',
      prompt: prompt(),
      hub: {
        submit,
        cancel,
        events: async function* () {
          yield { type: 'run.cancelled' };
        },
      },
      translator: { translate: () => [] },
    });
    const running = (async () => {
      for await (const item of query) void item;
    })();
    await started;
    const interruption = query.interrupt();
    expect(cancel).not.toHaveBeenCalled();
    admit({ runId: 'r1' });
    await interruption;
    await running;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
  });
  test('translates each run before submitting the next prompt', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    async function* prompt() {
      yield message;
      yield message;
    }
    const submit = mock(async () => ({ runId: `r${submit.mock.calls.length}` }));
    const events = mock(async function* (_session: string, runId: string) {
      yield { type: 'run.completed', runId };
    });
    const translate = mock(() => []);
    const query = new OapQuery({
      sessionId: 's1',
      prompt: prompt(),
      hub: { submit, events, cancel: async () => {} },
      translator: { translate },
    });
    for await (const item of query) void item;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(events.mock.calls.map(([session, run]) => [session, run])).toEqual([
      ['s1', 'r1'],
      ['s1', 'r2'],
    ]);
    expect(translate).toHaveBeenCalledTimes(2);
  });
  test('close cancels the active run and ends a stalled event subscription', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    async function* prompt() {
      yield message;
    }
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = mock(async () => {});
    const events = async function* (_session: string, _run: string, signal: AbortSignal) {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    };
    const query = new OapQuery({
      sessionId: 's1',
      prompt: prompt(),
      hub: { submit: async () => ({ runId: 'r1' }), events, cancel },
      translator: { translate: () => [] },
    });
    const consume = async () => {
      for await (const item of query) void item;
    };
    const running = consume();
    await ready;
    query.close();
    query.close();
    await running;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
  });

  test('rejects a stream that ends before a terminal event', async () => {
    const message = {
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello' },
    } as SDKUserMessage;
    async function* prompt() {
      yield message;
    }
    const query = new OapQuery({
      sessionId: 's1',
      prompt: prompt(),
      hub: {
        submit: async () => ({ runId: 'r1' }),
        events: async function* () {
          yield { type: 'content.delta' };
        },
        cancel: async () => {},
      },
      translator: { translate: () => [] },
    });
    const consume = async () => {
      for await (const item of query) void item;
    };
    await expect(consume()).rejects.toThrow('OAP event stream ended before run terminal');
  });
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
    expect(submit).toHaveBeenCalledWith('s1', message, expect.anything());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('s1', 'r1');
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
