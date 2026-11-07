import { describe, expect, mock, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import * as queryModule from '../../../../src/lib/oap/oap-query';
import type { OapQueryHub } from '../../../../src/lib/oap/oap-query';

const createOapQueryHub = (
  queryModule as unknown as { createOapQueryHub(client: OapHubClient): OapQueryHub }
).createOapQueryHub;
type Listener = Parameters<OapHubClient['subscribe']>[1];

const prompt = {
  type: 'user',
  session_id: 'synthetic-session',
  parent_tool_use_id: null,
  message: { role: 'user', content: 'synthetic prompt' },
} as SDKUserMessage;

function fixture(mode: 'text' | 'failed-stream' | 'refused-submit' = 'text') {
  const operations: string[] = [];
  let listener!: Listener;
  const unsubscribe = mock(async () => {});
  const subscribe = mock(async (sessionId: string, received: Listener) => {
    operations.push(`events:${sessionId}`);
    listener = received;
    return { id: 3, unsubscribe };
  });
  const request = mock(async (op: string, _parameters: Record<string, unknown>) => {
    operations.push(op);
    if (op === 'submit') {
      if (mode === 'refused-submit') throw new Error('synthetic submit refusal');
      if (mode === 'failed-stream') {
        listener({
          kind: 'event',
          id: 3,
          event: 'oap-stream-failed',
          data: { id: 3, event: 'oap-stream-failed', run_id: 'run-1' },
        });
      } else {
        for (const envelope of [
          {
            type: 'content.delta',
            id: 'delta-1',
            run_id: 'run-1',
            payload: { part: { type: 'text', text: 'synthetic reply' } },
          },
          { type: 'run.completed', id: 'end-1', run_id: 'run-1', payload: {} },
        ]) {
          listener({
            kind: 'event',
            id: 3,
            event: 'envelope',
            data: { id: 3, event: 'envelope', envelope },
          });
        }
      }
      return {
        type: 'session.message.submit.response',
        payload: { accepted: true, session_id: 'synthetic-session', run_id: 'run-1' },
      };
    }
    return {
      type: 'run.cancel.response',
      payload: { accepted: true, session_id: 'synthetic-session', run_id: 'run-1' },
    };
  });
  const client = { subscribe, request } as unknown as OapHubClient;
  return { client, subscribe, request, unsubscribe, operations };
}

function releaseHub(hub: OapQueryHub): void {
  (hub as unknown as { release(): void }).release();
}

describe('OAP query hub transport', () => {
  test.each([
    [
      new OapHubRequestError('timeout', 'submit timed out'),
      new OapHubRequestError('invalid_request', 'unsubscribe refused'),
    ],
    [
      new OapHubRequestError('invalid_request', 'submit refused'),
      new OapHubRequestError('timeout', 'unsubscribe timed out'),
    ],
  ])(
    'preserves the submit outcome when releasing its subscription also fails',
    async (submitError, cleanupError) => {
      const host = fixture();
      host.request.mockRejectedValueOnce(submitError);
      host.unsubscribe.mockRejectedValueOnce(cleanupError);
      await expect(createOapQueryHub(host.client).submit('synthetic-session', prompt)).rejects.toBe(
        submitError
      );
      expect(host.unsubscribe).toHaveBeenCalledTimes(1);
    }
  );

  test('rejects submit acceptance for another session', async () => {
    const host = fixture();
    host.request.mockImplementationOnce(async () => ({
      type: 'session.message.submit.response',
      payload: { accepted: true, session_id: 'other-session', run_id: 'run-1' },
    }));
    const hub = createOapQueryHub(host.client);
    await expect(hub.submit('synthetic-session', prompt)).rejects.toThrow(/accept|scope/i);
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('drops events scoped to a different session even when the run id matches', async () => {
    let listener!: Listener;
    const subscribe = mock(async (_sessionId: string, receive: Listener) => {
      listener = receive;
      return { id: 1, unsubscribe: async () => {} };
    });
    const request = mock(async () => {
      for (const [sessionId, id] of [
        ['other-session', 'foreign'],
        ['synthetic-session', 'own'],
      ]) {
        listener({
          kind: 'event',
          id: 1,
          event: 'envelope',
          data: {
            id: 1,
            event: 'envelope',
            envelope: {
              type: 'run.completed',
              session_id: sessionId,
              run_id: 'run-1',
              id,
              payload: {},
            },
          },
        });
      }
      return {
        type: 'session.message.submit.response',
        payload: { accepted: true, session_id: 'synthetic-session', run_id: 'run-1' },
      };
    });
    const hub = createOapQueryHub({ subscribe, request } as unknown as OapHubClient);
    const { runId } = await hub.submit('synthetic-session', prompt);
    const received: unknown[] = [];
    for await (const event of hub.events(
      'synthetic-session',
      runId,
      new AbortController().signal
    )) {
      received.push(event.id);
      break;
    }
    expect(received).toEqual(['own']);
  });

  test('subscribes before submitting so immediate text and terminal events are not lost', async () => {
    const host = fixture();
    const hub = createOapQueryHub(host.client);
    const { runId } = await hub.submit('synthetic-session', prompt);
    const received: unknown[] = [];
    for await (const event of hub.events(
      'synthetic-session',
      runId,
      new AbortController().signal
    )) {
      received.push(event);
      if (event.type === 'run.completed') break;
    }
    expect(host.operations).toEqual(['events:synthetic-session', 'submit']);
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.request).toHaveBeenCalledWith('submit', {
      session_id: 'synthetic-session',
      request: expect.objectContaining({
        protocol: 'open-agent-protocol',
        version: '0.1',
        profile: 'open-agent-protocol.agent-control-core',
        type: 'session.message.submit.request',
        session_id: 'synthetic-session',
        payload: {
          session_id: 'synthetic-session',
          delivery: 'auto',
          messages: [{ role: 'user', content: 'synthetic prompt' }],
        },
      }),
    });
    expect(received.map((event) => (event as { type: string }).type)).toEqual([
      'content.delta',
      'run.completed',
    ]);
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('keeps a session hub usable after a completed query is closed', async () => {
    const host = fixture();
    const hub = createOapQueryHub(host.client);
    for (let turn = 0; turn < 2; turn++) {
      const query = queryModule.createOapQuery({
        sessionId: 'synthetic-session',
        prompt: (async function* () {
          yield prompt;
        })(),
        hub,
      });
      const messages: string[] = [];
      for await (const message of query) messages.push(message.type);
      query.close();
      expect(messages).toEqual(['assistant', 'result']);
    }
    expect(host.operations.filter((op) => op === 'submit')).toHaveLength(2);
    expect(host.unsubscribe).toHaveBeenCalledTimes(2);
  });

  test('a retired attempt cannot release its successor subscription', async () => {
    const host = fixture();
    const hub = createOapQueryHub(host.client) as unknown as {
      submit(sessionId: string, message: SDKUserMessage, owner: symbol): Promise<{ runId: string }>;
      release(owner: symbol): void;
      events: OapQueryHub['events'];
    };
    const oldOwner = Symbol('old');
    const currentOwner = Symbol('current');
    const first = await hub.submit('synthetic-session', prompt, oldOwner);
    for await (const event of hub.events(
      'synthetic-session',
      first.runId,
      new AbortController().signal
    )) {
      if (event.type === 'run.completed') break;
    }
    const second = await hub.submit('synthetic-session', prompt, currentOwner);
    hub.release(oldOwner);
    const received: string[] = [];
    for await (const event of hub.events(
      'synthetic-session',
      second.runId,
      new AbortController().signal
    )) {
      received.push(event.type);
      if (event.type === 'run.completed') break;
    }
    expect(received).toEqual(['content.delta', 'run.completed']);
    expect(host.unsubscribe).toHaveBeenCalledTimes(2);
  });

  test('delivers a synchronous burst of 512 events and its terminal without dropping any', async () => {
    let receive!: Listener;
    const unsubscribe = mock(async () => {});
    const subscribe = mock(async (_session: string, listener: Listener) => {
      receive = listener;
      return { id: 3, unsubscribe };
    });
    const request = mock(async () => {
      for (let index = 0; index < 512; index++) {
        const envelope = {
          type: 'content.delta',
          id: `delta-${index}`,
          run_id: 'run-1',
          payload: { part: { type: 'text', text: String(index) } },
        };
        receive({
          kind: 'event',
          id: 3,
          event: 'envelope',
          data: { id: 3, event: 'envelope', envelope },
        });
      }
      const envelope = { type: 'run.completed', id: 'terminal', run_id: 'run-1', payload: {} };
      receive({
        kind: 'event',
        id: 3,
        event: 'envelope',
        data: { id: 3, event: 'envelope', envelope },
      });
      return {
        type: 'session.message.submit.response',
        payload: { accepted: true, session_id: 'synthetic-session', run_id: 'run-1' },
      };
    });
    const hub = createOapQueryHub({ subscribe, request } as unknown as OapHubClient);
    const { runId } = await hub.submit('synthetic-session', prompt);
    const ids: unknown[] = [];
    for await (const event of hub.events(
      'synthetic-session',
      runId,
      new AbortController().signal
    )) {
      ids.push(event.id);
      if (event.type === 'run.completed') break;
    }
    expect(ids).toEqual([
      ...Array.from({ length: 512 }, (_, index) => `delta-${index}`),
      'terminal',
    ]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('releasing a pending subscription lets a successor start without submitting the old one', async () => {
    let finishFirst!: (subscription: { id: number; unsubscribe(): Promise<void> }) => void;
    const firstSubscription = new Promise<{ id: number; unsubscribe(): Promise<void> }>(
      (resolve) => {
        finishFirst = resolve;
      }
    );
    const oldUnsubscribe = mock(async () => {});
    const newUnsubscribe = mock(async () => {});
    const subscribe = mock()
      .mockImplementationOnce(() => firstSubscription)
      .mockImplementationOnce(async () => ({ id: 4, unsubscribe: newUnsubscribe }));
    const request = mock(async () => ({
      type: 'session.message.submit.response',
      payload: { accepted: true, session_id: 'synthetic-session', run_id: 'run-2' },
    }));
    const hub = createOapQueryHub({ subscribe, request } as unknown as OapHubClient);
    const old = hub.submit('synthetic-session', prompt).catch((error: Error) => error);
    releaseHub(hub);
    const current = await hub.submit('synthetic-session', prompt);
    finishFirst({ id: 3, unsubscribe: oldUnsubscribe });
    expect(await old).toBeInstanceOf(Error);
    expect(current.runId).toBe('run-2');
    expect(request).toHaveBeenCalledTimes(1);
    expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
    releaseHub(hub);
    await Promise.resolve();
    expect(newUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test('joins text blocks into the plain string required by the Codex adapter', async () => {
    const host = fixture();
    const hub = createOapQueryHub(host.client);
    await hub.submit('synthetic-session', {
      ...prompt,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'first ' },
          { type: 'text', text: 'second' },
        ],
      },
    } as SDKUserMessage);
    expect(host.request).toHaveBeenCalledWith(
      'submit',
      expect.objectContaining({
        request: expect.objectContaining({
          payload: expect.objectContaining({
            messages: [{ role: 'user', content: 'first second' }],
          }),
        }),
      })
    );
    releaseHub(hub);
  });

  test('reports a stream failure without automatically resubmitting', async () => {
    const host = fixture('failed-stream');
    const hub = createOapQueryHub(host.client);
    const { runId } = await hub.submit('synthetic-session', prompt);
    const consume = async () => {
      for await (const event of hub.events(
        'synthetic-session',
        runId,
        new AbortController().signal
      ))
        void event;
    };
    await expect(consume()).rejects.toThrow(/stream.failed/i);
    expect(host.operations).toEqual(['events:synthetic-session', 'submit']);
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('releases the subscription if submission is refused', async () => {
    const host = fixture('refused-submit');
    const hub = createOapQueryHub(host.client);
    await expect(hub.submit('synthetic-session', prompt)).rejects.toThrow(
      'synthetic submit refusal'
    );
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('rejects an unaccepted or mis-scoped cancellation response', async () => {
    const host = fixture();
    const hub = createOapQueryHub(host.client);
    for (const payload of [
      { accepted: false, session_id: 'synthetic-session', run_id: 'run-1' },
      { accepted: true, session_id: 'another-session', run_id: 'run-1' },
      { accepted: true, session_id: 'synthetic-session', run_id: 'another-run' },
    ]) {
      host.request.mockImplementationOnce(async () => ({ type: 'run.cancel.response', payload }));
      await expect(hub.cancel('synthetic-session', 'run-1')).rejects.toThrow(/cancel/i);
    }
    await expect(hub.cancel('synthetic-session', 'run-1')).resolves.toBeUndefined();
    expect(host.request).toHaveBeenLastCalledWith('cancel', {
      session_id: 'synthetic-session',
      request: expect.objectContaining({
        type: 'run.cancel.request',
        session_id: 'synthetic-session',
        run_id: 'run-1',
        payload: { session_id: 'synthetic-session', run_id: 'run-1' },
      }),
    });
  });

  test('rejects an overlapping submission while the first subscription is starting', async () => {
    const host = fixture();
    let finishSubscription!: (subscription: { id: number; unsubscribe(): Promise<void> }) => void;
    const subscription = new Promise<{ id: number; unsubscribe(): Promise<void> }>((resolve) => {
      finishSubscription = resolve;
    });
    const subscribe = mock(() => subscription);
    const hub = createOapQueryHub({ subscribe, request: host.request } as unknown as OapHubClient);
    const first = hub.submit('synthetic-session', prompt).catch((error: Error) => error);
    const second = hub.submit('synthetic-session', prompt).then(
      () => 'accepted',
      () => 'rejected'
    );
    const outcome = await Promise.race([
      second,
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    finishSubscription({ id: 3, unsubscribe: host.unsubscribe });
    await first;
    await second;
    releaseHub(hub);
    expect(outcome).toBe('rejected');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  test('unsubscribes without submitting when closed during subscription startup', async () => {
    const host = fixture();
    let finishSubscription!: (subscription: { id: number; unsubscribe(): Promise<void> }) => void;
    const subscription = new Promise<{ id: number; unsubscribe(): Promise<void> }>((resolve) => {
      finishSubscription = resolve;
    });
    const hub = createOapQueryHub({
      subscribe: () => subscription,
      request: host.request,
    } as unknown as OapHubClient);
    const submission = hub.submit('synthetic-session', prompt);
    releaseHub(hub);
    finishSubscription({ id: 3, unsubscribe: host.unsubscribe });
    const failure = await submission.catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OapHubRequestError);
    expect((failure as Error).message).toMatch(/closed/i);
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
    expect(host.request).not.toHaveBeenCalled();
  });

  test('unsubscribes without submitting when the attempt expires during subscription startup', async () => {
    const host = fixture();
    const request = mock(async () => ({
      type: 'session.message.submit.response',
      payload: { accepted: true, session_id: 'synthetic-session', run_id: 'run-1' },
    }));
    let finishSubscription!: (subscription: { id: number; unsubscribe(): Promise<void> }) => void;
    const subscription = new Promise<{ id: number; unsubscribe(): Promise<void> }>((resolve) => {
      finishSubscription = resolve;
    });
    const hub = createOapQueryHub({
      subscribe: () => subscription,
      request,
    } as unknown as OapHubClient) as OapQueryHub & {
      submit(
        session: string,
        message: SDKUserMessage,
        owner: symbol,
        isLive: () => boolean
      ): Promise<{ runId: string }>;
    };
    let live = true;
    const submission = hub.submit('synthetic-session', prompt, Symbol('attempt'), () => live);
    live = false;
    finishSubscription({ id: 3, unsubscribe: host.unsubscribe });
    await expect(submission).rejects.toThrow(/closed|expired/i);
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  test('refuses non-text input instead of silently dropping it', async () => {
    const host = fixture();
    const hub = createOapQueryHub(host.client);
    const input = { ...prompt, message: { role: 'user', content: [{ type: 'image' }] } };
    await expect(hub.submit('synthetic-session', input as SDKUserMessage)).rejects.toThrow(/text/i);
    expect(host.operations).toEqual([]);
  });
});
