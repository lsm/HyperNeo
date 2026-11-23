import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { JsonRpcRequestTimeoutError, ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import type {
  StartRequest,
  WorkAdapter,
  WorkDetail,
  Rejected,
  Result,
  WorkStarted,
} from './types.ts';
import { reject } from './work-operations.ts';

const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;
const TURN_TIMEOUT_MINUTES = 60;
const RETAINED_TURNS = 100;
const MAX_REPLY_CHARS = 16_000;
const AUTH_REQUIRED = -32000;
const SIGN_IN_DETAIL = 'Sign in to Antigravity CLI before starting a session.';
const Init = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({ sessionCapabilities: z.object({ close: z.object({}) }) }),
});
const Session = z.object({ sessionId: z.string().min(1) });
const Update = Session.extend({
  update: z.object({
    sessionUpdate: z.literal('agent_message_chunk'),
    content: z.object({ type: z.literal('text'), text: z.string() }),
  }),
});
const Completion = z.object({ stopReason: z.string() });
type Gate<Value> = { value: Value } | { reason: Rejected };

function admitStart(request: StartRequest, closing: boolean): Gate<StartRequest> {
  if (closing)
    return { reason: reject('unreachable', 'The Antigravity driver is shutting down.', true) };
  if (request.model !== undefined || request.effort !== undefined) {
    return {
      reason: reject(
        request.model !== undefined ? 'unsupported_model' : 'unsupported_effort',
        'Choose the default Antigravity CLI configuration for this session.',
        true
      ),
    };
  }
  return { value: request };
}

async function within<T>(pending: Promise<T>, ms: number, detail: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, refuse) => {
    timer = setTimeout(() => refuse(new Error(detail)), ms);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function openSession(transport: ProcessJsonRpcTransport, cwd: string) {
  const initialized = await transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  if ('error' in initialized && initialized.error.code === AUTH_REQUIRED)
    return reject('unreachable', SIGN_IN_DETAIL, true);
  if (!('result' in initialized) || !Init.safeParse(initialized.result).success) {
    return reject('unreachable', 'Antigravity must support ACP version 1 session close.', true);
  }
  const opened = await transport.sendRequest('session/new', { cwd, mcpServers: [] });
  if ('error' in opened) {
    return reject(
      'unreachable',
      opened.error.code === AUTH_REQUIRED
        ? SIGN_IN_DETAIL
        : `Antigravity rejected session creation (${opened.error.code}).`,
      true
    );
  }
  const session = Session.safeParse(opened.result);
  return session.success
    ? { ok: true as const, value: session.data.sessionId }
    : reject('not_delivered', 'Antigravity did not confirm the new session.', true);
}

export function createAntigravityStart(executable: string, machine: string, adapter: string) {
  const running = new Set<ProcessJsonRpcTransport>();
  const sessions = new Map<string, WorkDetail>();
  const completed = new Set<string>();
  let closing = false;

  const selectFolder = (request: StartRequest): Gate<string> => {
    const selected = selectLocalStartFolder(
      request,
      {
        machine,
        homeDir: homedir(),
        folderExists: existsSync,
        makeFolder: mkdirSync,
      },
      'Antigravity needs a local workspace.'
    );
    if ('reason' in selected) return { reason: { ...selected.reason, notSent: true } };
    return selected;
  };

  const requireDirectory = (cwd: string): Gate<string> =>
    isAbsolute(cwd) && statSync(cwd, { throwIfNoEntry: false })?.isDirectory()
      ? { value: cwd }
      : {
          reason: reject(
            'invalid_place',
            'Antigravity needs an absolute workspace directory.',
            true
          ),
        };

  const connect = async (cwd: string) => {
    let sessionId: string | undefined;
    let reply = '';
    const transport = new ProcessJsonRpcTransport({
      command: executable,
      args: ['acp', '--sandbox', '--disable-telemetry'],
      cwd,
      env: buildSafeProcessEnv(),
      replaceEnv: true,
      requestTimeoutMs: TURN_TIMEOUT_MINUTES * 60_000,
      onStderr: () => {},
      onRequest: ({ id, method }) => {
        if (method === 'session/request_permission')
          transport.sendResponse(id, { outcome: { outcome: 'cancelled' } });
        else transport.sendErrorResponse(id, { code: -32601, message: 'Method not supported' });
      },
      onNotification: ({ method, params }) => {
        if (method !== 'session/update') return;
        const update = Update.safeParse(params);
        if (update.success && update.data.sessionId === sessionId)
          reply += update.data.update.content.text.slice(0, MAX_REPLY_CHARS - reply.length);
      },
    });
    running.add(transport);
    const close = async () => {
      await transport.close();
      running.delete(transport);
    };

    let opened: Awaited<ReturnType<typeof openSession>>;
    try {
      opened = await within(
        openSession(transport, cwd),
        START_TIMEOUT_MS,
        'Antigravity session creation timed out.'
      );
    } catch (error) {
      opened = reject(
        'unreachable',
        error instanceof Error ? error.message : 'Antigravity could not start.',
        true
      );
    }
    if (!opened.ok) {
      await close();
      return { reason: opened };
    }
    sessionId = opened.value;
    return { value: { id: sessionId, cwd, transport, close, readReply: () => reply } };
  };

  type Opened = NonNullable<Awaited<ReturnType<typeof connect>>['value']>;
  const launch = async (opened: Opened, request: StartRequest): Promise<Result<WorkStarted>> => {
    const { id, cwd, transport, close, readReply } = opened;
    if (closing || sessions.has(id)) {
      await close();
      return reject('not_delivered', 'Antigravity could not establish a new owned session.', true);
    }
    const work: WorkDetail = {
      ref: { adapter, id },
      title: request.sessionTitle ?? request.title,
      place: { ...request.place, folder: cwd },
      execution: { machine, directory: cwd },
      status: 'running',
      lastActivityAt: Date.now(),
      watchHint: 'Open this session in Antigravity CLI. HyperNeo shows the most recent owned turn.',
    };
    sessions.set(id, work);
    const finish = (status: WorkDetail['status'], detail: string) => {
      const at = Date.now();
      const reply = readReply();
      sessions.set(id, {
        ...work,
        status,
        lastActivityAt: at,
        ...(reply ? { lastReply: reply, lastReplyAt: at } : {}),
        turnEnds: [{ id, at, startedAt: work.lastActivityAt, message: detail }],
      });
      completed.add(id);
      if (completed.size > RETAINED_TURNS) {
        const oldest = completed.values().next().value!;
        completed.delete(oldest);
        sessions.delete(oldest);
      }
    };
    void transport
      .sendRequest('session/prompt', {
        sessionId: id,
        prompt: [{ type: 'text', text: request.message }],
      })
      .then(
        async (response) => {
          const result = Completion.safeParse('result' in response ? response.result : undefined);
          const saved = await within(
            transport.sendRequest('session/close', { sessionId: id }),
            CLOSE_TIMEOUT_MS,
            'Antigravity could not confirm session persistence.'
          ).then(
            (closed) => 'result' in closed,
            () => false
          );
          if (!saved) {
            finish(
              'failed',
              'Antigravity did not confirm saved history. Check the CLI session before retrying.'
            );
            return;
          }
          if (result.success && result.data.stopReason === 'end_turn') finish('done', readReply());
          else if (result.success && result.data.stopReason === 'cancelled')
            finish('stopped', readReply());
          else
            finish(
              'failed',
              'Antigravity did not complete the turn. Check the CLI session before retrying.'
            );
        },
        (error: unknown) =>
          finish(
            'failed',
            error instanceof JsonRpcRequestTimeoutError
              ? `The Antigravity turn exceeded the ${TURN_TIMEOUT_MINUTES}-minute limit. Check the CLI session before retrying.`
              : 'Antigravity disconnected during the turn. Check the CLI session before retrying.'
          )
      )
      .finally(close);
    return { ok: true, value: work };
  };

  const launchStart = (superpipe({})('antigravity-start') as PipelineAPI)
    .input(['request', 'closing'])
    .pipe(admitStart, ['request', 'closing'], 'result:started')
    .pipe(selectFolder, 'started', 'result:started')
    .pipe(requireDirectory, 'started', 'result:started')
    .pipe(connect, 'started', 'result:started')
    .pipe(launch, ['started', 'request'], 'started')
    .endAsync('started') as (
    request: StartRequest,
    closing: boolean
  ) => Promise<Result<WorkStarted>>;

  const status: NonNullable<WorkAdapter['status']> = async (ref) => {
    const work = sessions.get(ref.id);
    return work && ref.adapter === adapter
      ? { ok: true, value: work }
      : reject('not_found', 'This daemon has no retained Antigravity turn for that session.', true);
  };

  return {
    start: (request: StartRequest) => launchStart(request, closing),
    status,
    async close() {
      closing = true;
      await Promise.all([...running].map((transport) => transport.close()));
    },
  };
}
