import { EventEmitter, on } from 'node:events';
import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OapHubClient } from './oap-hub-client.ts';
import type { OapQueryHub } from './oap-query.ts';

type Event = { type: string; run_id: string; [key: string]: unknown };
type Subscription = Awaited<ReturnType<OapHubClient['subscribe']>>;
type ListenerInput = Parameters<Parameters<OapHubClient['subscribe']>[1]>[0];
type Stream = {
  sessionId: string;
  runId?: string;
  subscription: Subscription;
  events: AsyncIterableIterator<[Event | Error]>;
  release(): Promise<void>;
  consumed(): void;
};

function textContent(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('OAP currently supports text input only');
  return content
    .map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') {
        throw new Error('OAP currently supports text input only');
      }
      return part.text;
    })
    .join('');
}

function envelope(
  id: string,
  type: string,
  sessionId: string,
  payload: Record<string, unknown>,
  runId?: string
) {
  return {
    protocol: 'open-agent-protocol',
    version: '0.1',
    profile: 'open-agent-protocol.agent-control-core',
    type,
    id,
    session_id: sessionId,
    ...(runId ? { run_id: runId } : {}),
    payload,
  };
}

function submitParameters(sessionId: string, id: string, content: string) {
  return {
    session_id: sessionId,
    request: envelope(id, 'session.message.submit.request', sessionId, {
      session_id: sessionId,
      delivery: 'auto',
      messages: [{ role: 'user', content }],
    }),
  };
}

const prepareSubmit = (superpipe({})('oap.query.submit') as PipelineAPI)
  .input(['sessionId', 'id', 'message'])
  .pipe(textContent, 'message', 'content')
  .pipe(submitParameters, ['sessionId', 'id', 'content'], 'request')
  .end('request') as (
  sessionId: string,
  id: string,
  message: SDKUserMessage
) => ReturnType<typeof submitParameters>;

function readEvent(frame: ListenerInput): Event | Error | undefined {
  if (frame instanceof Error) return frame;
  if (frame.event === 'oap-subscribed') return undefined;
  if (frame.event !== 'envelope') return new Error(`OAP hub ${frame.event}`);
  const value = frame.data.envelope;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return new Error('Invalid OAP hub event');
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string' || typeof event.run_id !== 'string') {
    return new Error('Invalid OAP hub event scope');
  }
  return event as Event;
}

function runId(response: unknown): string {
  if (!response || typeof response !== 'object') throw new Error('Invalid OAP submit response');
  const value = response as { type?: unknown; payload?: { accepted?: unknown; run_id?: unknown } };
  if (
    value.type !== 'session.message.submit.response' ||
    value.payload?.accepted !== true ||
    typeof value.payload.run_id !== 'string' ||
    !value.payload.run_id
  ) {
    throw new Error('OAP did not accept the submitted run');
  }
  return value.payload.run_id;
}

function cancellationAccepted(response: unknown, sessionId: string, runId: string): boolean {
  if (!response || typeof response !== 'object') return false;
  const value = response as {
    type?: unknown;
    payload?: { accepted?: unknown; session_id?: unknown; run_id?: unknown };
  };
  return (
    value.type === 'run.cancel.response' &&
    value.payload?.accepted === true &&
    value.payload.session_id === sessionId &&
    value.payload.run_id === runId
  );
}

export function createOapQueryHub(client: OapHubClient): OapQueryHub {
  let active: Stream | undefined;
  let starting = false;
  let closed = false;
  return {
    async submit(sessionId, message) {
      if (closed || active || starting)
        throw new Error('OAP query hub is not available for submission');
      starting = true;
      try {
        const parameters = prepareSubmit(sessionId, generateUUID(), message);
        const emitter = new EventEmitter();
        const events = on(emitter, 'event') as AsyncIterableIterator<[Event | Error]>;
        let queued = 0;
        let overflow = false;
        const subscription = await client.subscribe(sessionId, (frame) => {
          if (overflow) return;
          const value = readEvent(frame);
          if (!value) return;
          if (queued >= 64) {
            overflow = true;
            emitter.emit('event', new Error('OAP event buffer overflow'));
          } else {
            queued++;
            emitter.emit('event', value);
          }
        });
        let releasing: Promise<void> | undefined;
        const stream: Stream = {
          sessionId,
          subscription,
          events,
          consumed: () => queued--,
          release: () => {
            releasing ??= (async () => {
              if (active === stream) active = undefined;
              await events.return?.();
              await subscription.unsubscribe();
            })();
            return releasing;
          },
        };
        if (closed) {
          await stream.release();
          throw new Error('OAP query hub is closed');
        }
        active = stream;
        try {
          stream.runId = runId(await client.request('submit', parameters));
          return { runId: stream.runId };
        } catch (error) {
          await stream.release();
          throw error;
        }
      } finally {
        starting = false;
      }
    },
    async *events(sessionId, expectedRunId, signal) {
      const stream = active;
      if (!stream || stream.sessionId !== sessionId || stream.runId !== expectedRunId) {
        throw new Error('OAP run subscription is not active');
      }
      const abort = () => void stream.release().catch(() => {});
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        for await (const [value] of stream.events) {
          stream.consumed();
          if (value instanceof Error) throw value;
          if (value.run_id === expectedRunId) yield value;
        }
      } finally {
        signal.removeEventListener('abort', abort);
        await stream.release();
      }
    },
    async cancel(sessionId, currentRunId) {
      const response = await client.request('cancel', {
        session_id: sessionId,
        request: envelope(
          generateUUID(),
          'run.cancel.request',
          sessionId,
          {
            session_id: sessionId,
            run_id: currentRunId,
          },
          currentRunId
        ),
      });
      if (!cancellationAccepted(response, sessionId, currentRunId)) {
        throw new Error('OAP did not accept the requested cancellation');
      }
    },
    close() {
      closed = true;
      if (active) void active.release().catch(() => {});
    },
  };
}
