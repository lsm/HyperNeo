import { EventEmitter, on } from 'node:events';
import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { OapHubRequestError, type OapHubClient } from './oap-hub-client.ts';
import type { OapQueryHub } from './oap-query.ts';

type Event = { type: string; run_id: string; [key: string]: unknown };
type ListenerInput = Parameters<Parameters<OapHubClient['subscribe']>[1]>[0];
type Stream = {
  owner: symbol;
  sessionId: string;
  runId?: string;
  events: AsyncIterableIterator<[Event | Error]>;
  release(): Promise<void>;
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

function runId(response: unknown, sessionId: string): string {
  if (!response || typeof response !== 'object') throw new Error('Invalid OAP submit response');
  const value = response as {
    type?: unknown;
    payload?: { accepted?: unknown; session_id?: unknown; run_id?: unknown };
  };
  if (
    value.type !== 'session.message.submit.response' ||
    value.payload?.accepted !== true ||
    value.payload?.session_id !== sessionId ||
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

function decideResubmit(status: unknown, sessionId: string): boolean {
  if (!status || typeof status !== 'object') return false;
  const work = status as { ref?: { session_id?: unknown }; status?: unknown };
  return (
    work.ref?.session_id === sessionId &&
    typeof work.status === 'string' &&
    ['done', 'failed', 'stopped'].includes(work.status)
  );
}

const planResubmit = (superpipe({})('oap.query.reconcileSubmit') as PipelineAPI)
  .input(['status', 'sessionId'])
  .pipe(decideResubmit, ['status', 'sessionId'], 'allowed')
  .end('allowed') as typeof decideResubmit;

export function createOapQueryHub(client: OapHubClient): OapQueryHub {
  const uncertainSessions = new Set<string>();
  let active: Stream | undefined;
  let starting: { owner: symbol } | undefined;
  return {
    async submit(sessionId, message, owner = Symbol()) {
      if (active || starting) throw new Error('OAP query hub is not available for submission');
      const submission = { owner };
      starting = submission;
      try {
        if (uncertainSessions.has(sessionId)) {
          const status = await client
            .request('work.status', { session_id: sessionId })
            .catch((error: unknown) => {
              throw new OapHubRequestError(
                'run_active',
                `OAP previous submission outcome could not be confirmed: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          if (!planResubmit(status, sessionId))
            throw new OapHubRequestError(
              'run_active',
              'OAP previous submission outcome is unresolved or has unfinished work'
            );
          uncertainSessions.delete(sessionId);
        }
        const parameters = prepareSubmit(sessionId, generateUUID(), message);
        const emitter = new EventEmitter();
        const events = on(emitter, 'event') as AsyncIterableIterator<[Event | Error]>;
        const subscription = await client.subscribe(sessionId, (frame) => {
          const value = readEvent(frame);
          if (value) emitter.emit('event', value);
        });
        let releasing: Promise<void> | undefined;
        const stream: Stream = {
          owner,
          sessionId,
          events,
          release: () => {
            releasing ??= (async () => {
              if (active === stream) active = undefined;
              await events.return?.();
              await subscription.unsubscribe();
            })();
            return releasing;
          },
        };
        if (starting !== submission) {
          await stream.release();
          throw new Error('OAP query hub submission was closed');
        }
        active = stream;
        try {
          stream.runId = runId(await client.request('submit', parameters), sessionId);
          return { runId: stream.runId };
        } catch (error) {
          if (error instanceof OapHubRequestError && error.code === 'timeout')
            uncertainSessions.add(sessionId);
          await stream.release().catch(() => {});
          throw error;
        }
      } finally {
        if (starting === submission) starting = undefined;
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
          if (value instanceof Error) throw value;
          if (typeof value.session_id === 'string' && value.session_id !== sessionId) continue;
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
    release(owner) {
      if (!owner || starting?.owner === owner) starting = undefined;
      if (active && (!owner || active.owner === owner)) void active.release().catch(() => {});
    },
  };
}
