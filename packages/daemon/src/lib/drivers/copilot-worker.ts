import { workerWorkEnvironment, workerWorkLocationsBrief } from '../work-locations.ts';
import { CopilotClient, RuntimeConnection, type SessionEvent } from '@github/copilot-sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { isAbsolute } from 'node:path';
import { buildAcpSafeEnv } from '../acp/acp-command.ts';
import type { WorkDelivery } from './types.ts';
export class CopilotModelUnavailableError extends Error {}
type WorkInputReceipt = NonNullable<WorkDelivery['receipt']>;

type InputState = {
  state: 'pending' | 'observed';
  interactionId?: string;
  replyReport: string;
  outcome?: 'done' | 'stopped' | 'failed';
  replyAvailability: 'incomplete' | 'complete';
};
type WorkerState = {
  status: 'queued' | 'running' | 'needs_you' | 'done' | 'failed' | 'stopped' | 'unreachable';
  inputs: Record<string, InputState>;
};
type Session = Awaited<ReturnType<CopilotClient['createSession']>>;
export interface CopilotWorkerConfig {
  cliPath: string;
  expectedVersion: string;
  sessionId: string;
  cwd: string;
  stateDirectory: string;
  model: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  resume?: boolean;
  onInput?: (id: string, input: InputState) => void;
}

function projectEvent(state: WorkerState, event: SessionEvent): WorkerState {
  const next = structuredClone(state);
  if (event.agentId && event.type !== 'permission.requested') return next;
  switch (event.type) {
    case 'user.message': {
      const { messageId, interactionId } = event.data;
      if (!messageId) break;
      const input = next.inputs[messageId];
      if (input.state === 'observed') break;
      next.inputs = { ...next.inputs, [messageId]: { ...input, state: 'observed', interactionId } };
      if (!['failed', 'needs_you', 'stopped'].includes(next.status)) next.status = 'running';
      break;
    }
    case 'assistant.message': {
      const data = event.data;
      if (
        !data.interactionId ||
        data.parentToolCallId ||
        data.toolRequests?.length ||
        (data.phase && data.phase !== 'final_answer')
      )
        break;
      const matches = Object.values(next.inputs).filter(
        (input) => !input.outcome && input.interactionId === data.interactionId
      );
      if (matches.length === 1 && typeof data.content === 'string')
        matches[0].replyReport += data.content;
      break;
    }
    case 'session.idle':
      if (event.data.aborted) {
        next.status = 'stopped';
      } else if (
        Object.keys(next.inputs).length &&
        !['failed', 'needs_you', 'stopped'].includes(next.status)
      ) {
        for (const input of Object.values(next.inputs))
          if (input.state === 'observed' && input.replyReport && !input.outcome) {
            input.replyAvailability = 'complete';
            input.outcome = 'done';
          }
        next.status = Object.values(next.inputs).every((input) => input.outcome)
          ? 'done'
          : 'running';
      }
      break;
    case 'permission.requested':
      next.status = 'needs_you';
      break;
    case 'session.error':
      next.status = 'failed';
      break;
  }
  if (next.status === 'stopped' || next.status === 'failed')
    for (const input of Object.values(next.inputs)) if (!input.outcome) input.outcome = next.status;
  return next;
}

const applyEvent = (superpipe({})('copilot-worker-event') as PipelineAPI)
  .input(['state', 'event'])
  .pipe(projectEvent, ['state', 'event'], 'state')
  .end('state') as (state: WorkerState, event: SessionEvent) => WorkerState;

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Copilot worker timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function openCopilotWorker(config: CopilotWorkerConfig) {
  if (![config.cliPath, config.cwd, config.stateDirectory].every(isAbsolute))
    throw new Error('Copilot worker paths must be absolute');
  const timeoutMs = config.timeoutMs ?? 10_000;
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: config.cliPath,
      args: [
        '--no-remote',
        '--no-remote-export',
        '--disable-builtin-mcps',
        '--no-custom-instructions',
      ],
      env: { ...buildAcpSafeEnv(config.env), ...workerWorkEnvironment(config.cwd) },
    }),
    mode: 'empty',
    baseDirectory: config.stateDirectory,
    workingDirectory: config.cwd,
    logLevel: 'error',
  });
  let closing: Promise<void> | undefined;
  let unsubscribe = () => {};
  let closed = false;
  let state: WorkerState = { status: 'queued', inputs: {} };
  const seen = new Map<string, string | undefined>();
  const terminal = Promise.withResolvers<void>();
  const submitted = new Set<string>();
  const persisted = new Map<string, InputState>();
  const settled = new Set<string>();
  const pending: SessionEvent[] = [];
  let flush = () => {};
  let submitting = 0;
  const prune = () => {
    try {
      if (config.onInput)
        for (const id of submitted) {
          const input = state.inputs[id];
          const previous = persisted.get(id);
          if (
            previous &&
            previous.state === input.state &&
            previous.interactionId === input.interactionId &&
            previous.replyReport === input.replyReport &&
            previous.outcome === input.outcome &&
            previous.replyAvailability === input.replyAvailability
          )
            continue;
          config.onInput(id, input);
          persisted.set(id, { ...input });
        }
    } catch {
      state.status = 'unreachable';
      terminal.resolve();
      return;
    }
    for (const id of submitted) if (state.inputs[id].outcome) settled.add(id);
    while (settled.size > 64) {
      const id = settled.values().next().value!;
      delete state.inputs[id];
      submitted.delete(id);
      persisted.delete(id);
      settled.delete(id);
    }
    for (const [key, id] of seen) {
      if (seen.size <= 512) break;
      const input = id && Object.hasOwn(state.inputs, id) ? state.inputs[id] : undefined;
      if (!input || input.outcome) seen.delete(key);
    }
    if (seen.size > 512) {
      seen.clear();
      state.status = 'unreachable';
    }
  };
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      unsubscribe();
      state.status = 'unreachable';
      try {
        const errors = await bounded(client.stop(), timeoutMs);
        if (errors.length) await client.forceStop();
      } catch {
        await client.forceStop();
      }
    })());
  let session: Session;
  try {
    await bounded(client.start(), timeoutMs);
    const status = await bounded(client.getStatus(), timeoutMs);
    if (status.version !== config.expectedVersion)
      throw new Error('Unsupported Copilot worker runtime version');
    if (!(await bounded(client.getAuthStatus(), timeoutMs)).isAuthenticated)
      throw new Error('Copilot login required: run copilot login in your terminal.');
    if (!(await bounded(client.listModels(), timeoutMs)).some((model) => model.id === config.model))
      throw new CopilotModelUnavailableError('Unsupported Copilot model ID.');
    const policy = {
      systemMessage: { content: workerWorkLocationsBrief(config.cwd) },
      workingDirectory: config.cwd,
      model: config.model,
      availableTools: [],
      onPermissionRequest: () => ({ kind: 'reject' as const }),
    };
    session = await bounded(
      config.resume
        ? client.resumeSession(config.sessionId, { ...policy, continuePendingWork: false })
        : client.createSession({ ...policy, sessionId: config.sessionId }),
      timeoutMs
    );
    const receive = (event: SessionEvent) => {
      if (closed || state.status === 'unreachable' || !event.id || seen.has(event.id)) return;
      if (event.type === 'user.message' && !Object.hasOwn(state.inputs, event.data.messageId ?? ''))
        return;
      const messageKey =
        event.type === 'assistant.message'
          ? `message:${event.data.messageId}`
          : event.type === 'user.message' && event.data.messageId
            ? `user:${event.data.messageId}`
            : event.id;
      if (seen.has(messageKey)) return;
      const inputId =
        event.type === 'user.message'
          ? event.data.messageId
          : event.type === 'assistant.message'
            ? Object.keys(state.inputs).find(
                (id) => state.inputs[id].interactionId === event.data.interactionId
              )
            : undefined;
      seen.set(event.id, inputId);
      seen.set(messageKey, inputId);
      state = applyEvent(state, event);
      prune();
      if (['done', 'failed', 'stopped'].includes(state.status)) terminal.resolve();
    };
    flush = () => {
      for (const event of pending.splice(0)) receive(event);
    };
    unsubscribe = session.on((event) => {
      if (
        ![
          'user.message',
          'assistant.message',
          'session.idle',
          'session.error',
          'permission.requested',
        ].includes(event.type)
      )
        return;
      if (!submitting) receive(event);
      else if (pending.length < 512) pending.push(event);
      else state.status = 'unreachable';
    });
  } catch (error) {
    await close().catch((cleanup) => {
      if (error instanceof Error)
        error.cause =
          error.cause === undefined ? cleanup : new AggregateError([error.cause, cleanup]);
    });
    throw error;
  }
  const requireOpen = () => {
    if (closed || state.status === 'unreachable') throw new Error('Copilot worker is disconnected');
  };
  return {
    terminal: terminal.promise,
    async submit(prompt: string): Promise<WorkInputReceipt> {
      requireOpen();
      if (state.status === 'needs_you') throw new Error('Copilot worker is awaiting permission');
      if (submitting + Object.values(state.inputs).filter((input) => !input.outcome).length >= 64)
        throw new Error('Copilot worker has 64 unsettled inputs');
      if (['done', 'failed', 'stopped'].includes(state.status)) state.status = 'queued';
      submitting++;
      try {
        const inputId = await bounded(session.send({ prompt, mode: 'enqueue' }), timeoutMs);
        requireOpen();
        if (!inputId) throw new Error('Copilot did not return an input id');
        submitted.add(inputId);
        if (!Object.hasOwn(state.inputs, inputId))
          state.inputs = {
            ...state.inputs,
            [inputId]: {
              state: 'pending',
              replyReport: '',
              replyAvailability: 'incomplete',
            },
          };
        if (submitting === 1) flush();
        requireOpen();
        if (
          state.inputs[inputId].state === 'pending' &&
          !['running', 'needs_you', 'failed', 'stopped'].includes(state.status)
        )
          state.status = 'queued';
        prune();
        requireOpen();
        return { executionId: config.sessionId, inputId };
      } catch (error) {
        state.status = 'unreachable';
        throw error;
      } finally {
        submitting--;
      }
    },
    peekStatus(): WorkerState['status'] {
      return state.status;
    },
    async snapshot(): Promise<WorkerState> {
      if (!closed && ['queued', 'running', 'needs_you'].includes(state.status)) {
        try {
          await bounded(client.ping(), timeoutMs);
        } catch {
          state.status = 'unreachable';
        }
      }
      return structuredClone({
        ...state,
        inputs: Object.fromEntries(
          Object.entries(state.inputs).filter(([id]) => submitted.has(id))
        ),
      });
    },
    async abort() {
      requireOpen();
      try {
        await bounded(session.abort(), timeoutMs);
      } catch (error) {
        state.status = 'unreachable';
        throw error;
      }
    },
    close,
  };
}
