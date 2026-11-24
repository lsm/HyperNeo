import { EventEmitter, on } from 'node:events';
import { generateUUID } from '@hyperneo/shared';
import { oxapSupportsImages } from '@hyperneo/shared/types/oxap-harnesses';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { OxapHubRequestError, type OxapHubClient } from './oxap-hub-client.ts';
import type { OxapQueryHub } from './oxap-query.ts';

type Event = { type: string; run_id: string; [key: string]: unknown };
type ListenerInput = Parameters<Parameters<OxapHubClient['subscribe']>[1]>[0];
type Stream = {
  owner: symbol;
  sessionId: string;
  runId?: string;
  events: AsyncIterableIterator<[Event | Error]>;
  release(): Promise<void>;
};

type SubmitBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image: { data: string; media_type: string } };

function messageContent(message: SDKUserMessage, images: boolean): string | SubmitBlock[] {
  const content: unknown = message.message.content;
  if (typeof content === 'string') return content;
  const invalidContent = () =>
    new OxapHubRequestError('invalid_submission', 'OAP currently supports text input only');
  if (!Array.isArray(content)) throw invalidContent();
  const blocks = content.map((part: unknown): SubmitBlock => {
    if (!part || typeof part !== 'object' || !('type' in part)) throw invalidContent();
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string')
      return { type: 'text', text: part.text };
    if (images && part.type === 'image' && 'source' in part) {
      const source = part.source as
        | { type?: unknown; data?: unknown; media_type?: unknown }
        | undefined;
      if (
        source?.type === 'base64' &&
        typeof source.data === 'string' &&
        typeof source.media_type === 'string'
      ) {
        return { type: 'image', image: { data: source.data, media_type: source.media_type } };
      }
    }
    throw invalidContent();
  });
  return blocks.some((part) => part.type === 'image')
    ? blocks
    : blocks
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
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

function submitParameters(
  sessionId: string,
  id: string,
  content: ReturnType<typeof messageContent>,
  modelId: string | undefined
) {
  return {
    session_id: sessionId,
    request: envelope(id, 'session.message.submit.request', sessionId, {
      session_id: sessionId,
      delivery: 'auto',
      messages: [{ role: 'user', content }],
      ...(modelId ? { model_id: modelId } : {}),
    }),
  };
}

const prepareSubmit = (superpipe({})('oap.query.submit') as PipelineAPI)
  .input(['sessionId', 'id', 'message', 'modelId', 'images'])
  .pipe(messageContent, ['message', 'images'], 'content')
  .pipe(submitParameters, ['sessionId', 'id', 'content', 'modelId'], 'request')
  .end('request') as (
  sessionId: string,
  id: string,
  message: SDKUserMessage,
  modelId: string | undefined,
  images: boolean
) => ReturnType<typeof submitParameters>;

export async function updateOxapReasoning(client: OxapHubClient, sessionId: string, level: string) {
  const response = (await client.request('settings', {
    session_id: sessionId,
    request: envelope(generateUUID(), 'session.settings.update.request', sessionId, {
      session_id: sessionId,
      reasoning_level: level,
    }),
  })) as { type?: unknown; payload?: { session_id?: unknown; reasoning_level?: unknown } };
  if (
    response?.type !== 'session.settings.update.response' ||
    response.payload?.session_id !== sessionId ||
    response.payload.reasoning_level !== level
  )
    throw new Error('OXAP did not confirm the selected thinking level');
}

async function bindDeepSeekModel(client: OxapHubClient, sessionId: string, modelId: string) {
  const response = (await client.request('session.model.switch', {
    session_id: sessionId,
    request: envelope(generateUUID(), 'session.model.switch.request', sessionId, {
      session_id: sessionId,
      model_id: modelId,
    }),
  })) as { type?: unknown; payload?: { session_id?: unknown; model_id?: unknown } };
  if (
    response?.type !== 'session.model.switch.response' ||
    response.payload?.session_id !== sessionId ||
    response.payload.model_id !== modelId
  ) {
    throw new Error('OXAP did not confirm the selected DeepSeek model');
  }
  return modelId;
}

function selectsModel(response: unknown): boolean {
  const level = (response as { payload?: { features?: Record<string, { level?: unknown }> } })
    ?.payload?.features?.['run.model_selection']?.level;
  return level === 'native' || level === 'emulated';
}

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

function decideResubmit(
  status: unknown,
  sessionId: string
): { kind: 'allow' | 'refuse' } | { kind: 'cancel'; runId: string } {
  if (!status || typeof status !== 'object') return { kind: 'refuse' };
  const work = status as {
    ref?: { session_id?: unknown };
    status?: unknown;
    held?: unknown;
    run_id?: unknown;
  };
  if (work.ref?.session_id !== sessionId) return { kind: 'refuse' };
  if (
    work.held === false ||
    (work.status === undefined && work.run_id === undefined) ||
    (typeof work.status === 'string' && ['done', 'failed', 'stopped'].includes(work.status))
  )
    return { kind: 'allow' };
  return work.status === 'needs_you' && typeof work.run_id === 'string' && work.run_id
    ? { kind: 'cancel', runId: work.run_id }
    : { kind: 'refuse' };
}

const planResubmit = (superpipe({})('oap.query.reconcileSubmit') as PipelineAPI)
  .input(['status', 'sessionId'])
  .pipe(decideResubmit, ['status', 'sessionId'], 'allowed')
  .end('allowed') as typeof decideResubmit;

export function createOxapQueryHub(
  client: OxapHubClient,
  model?: { adapter: string; id: () => string | undefined }
): OxapQueryHub {
  const uncertainSessions = new Set<string>();
  let selects: boolean | undefined;
  let active: Stream | undefined;
  let starting: { owner: symbol } | undefined;
  return {
    async submit(sessionId, message, owner = Symbol(), isLive) {
      if (active || starting) throw new Error('OAP query hub is not available for submission');
      const submission = { owner };
      starting = submission;
      try {
        if (uncertainSessions.has(sessionId)) {
          try {
            const status = await client.request('work.status', { session_id: sessionId });
            if (starting !== submission) throw new Error('OAP query hub submission was closed');
            let decision = planResubmit(status, sessionId);
            if (decision.kind === 'cancel') {
              await this.cancel(sessionId, decision.runId);
              const updated = await client.request('work.status', { session_id: sessionId });
              if (starting !== submission) throw new Error('OAP query hub submission was closed');
              decision = planResubmit(updated, sessionId);
            }
            if (decision.kind !== 'allow') throw new Error('unfinished or unconfirmed work');
          } catch (error) {
            throw new OxapHubRequestError(
              'run_active',
              `OAP previous submission outcome could not be confirmed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          uncertainSessions.delete(sessionId);
        }
        const selectedModel = model?.id();
        const deepSeek = model?.adapter === 'deepseek';
        let boundModel: string | undefined;
        if (deepSeek && selectedModel) {
          boundModel = await bindDeepSeekModel(client, sessionId, selectedModel);
        } else if (model && selects === undefined) {
          selects = selectsModel(await client.request('capabilities', { adapter: model.adapter }));
        }
        const parameters = prepareSubmit(
          sessionId,
          generateUUID(),
          message,
          selects ? selectedModel : undefined,
          deepSeek && oxapSupportsImages('oxap-deepseek', boundModel)
        );
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
        if (starting !== submission || (isLive && !isLive())) {
          await stream.release();
          if (isLive)
            throw new OxapHubRequestError(
              'invalid_submission',
              'OAP query hub submission was closed'
            );
          throw new Error('OAP query hub submission was closed');
        }
        active = stream;
        try {
          stream.runId = runId(await client.request('submit', parameters), sessionId);
          return { runId: stream.runId };
        } catch (error) {
          if (error instanceof OxapHubRequestError && error.code === 'timeout')
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
