import { describe, expect, mock, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
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
        payload: { accepted: true, run_id: 'run-1' },
      };
    }
    return { type: 'run.cancel.response', payload: { accepted: true } };
  });
  const client = { subscribe, request } as unknown as OapHubClient;
  return { client, subscribe, request, unsubscribe, operations };
}

describe('OAP query hub transport', () => {
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
    hub.close?.();
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
    hub.close?.();
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
    hub.close?.();
    finishSubscription({ id: 3, unsubscribe: host.unsubscribe });
    await expect(submission).rejects.toThrow(/closed/i);
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
    expect(host.request).not.toHaveBeenCalled();
  });

  test('refuses non-text input instead of silently dropping it', async () => {
    const host = fixture();
    const hub = createOapQueryHub(host.client);
    const input = { ...prompt, message: { role: 'user', content: [{ type: 'image' }] } };
    await expect(hub.submit('synthetic-session', input as SDKUserMessage)).rejects.toThrow(/text/i);
    expect(host.operations).toEqual([]);
  });
});
