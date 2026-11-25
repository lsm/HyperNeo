import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { JsonRpcRequestTimeoutError, ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import type {
  Rejected,
  Result,
  StartRequest,
  WorkDelivery,
  WorkDetail,
  WorkRef,
  WorkStarted,
} from './types.ts';
import { reject } from './work-operations.ts';

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MINUTES = 60;
const RETAINED_TURNS = 100;
const MAX_REPLY_CHARS = 16_000;
const AUTH_REQUIRED = -32000;
const SIGN_IN_DETAIL = 'Sign in to Cursor CLI with cursor-agent login before starting a session.';
const Init = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({ loadSession: z.boolean().optional() }),
});
const Session = z.object({ sessionId: z.string().min(1) });
const Update = Session.extend({
  update: z.object({
    sessionUpdate: z.literal('agent_message_chunk'),
    content: z.object({ type: z.literal('text'), text: z.string() }),
  }),
});
const Permission = z.object({
  options: z.array(z.object({ optionId: z.string(), kind: z.string() })),
});
const Completion = z.object({ stopReason: z.string() });
type Gate<Value> = { value: Value } | { reason: Rejected };
type Receipt = NonNullable<WorkDelivery['receipt']>;
type StopResult = Result<{ stopped: boolean }>;

export function cursorPermissionOutcome(params: unknown) {
  const allow = Permission.safeParse(params).data?.options.find(
    ({ kind }) => kind === 'allow_once'
  );
  return allow
    ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
    : { outcome: { outcome: 'cancelled' } };
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

async function openSession(
  transport: ProcessJsonRpcTransport,
  cwd: string,
  resumeId?: string
): Promise<Result<string>> {
  const initialized = await transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  if ('error' in initialized && initialized.error.code === AUTH_REQUIRED)
    return reject('unreachable', SIGN_IN_DETAIL, true);
  const init = Init.safeParse('result' in initialized ? initialized.result : undefined);
  if (!init.success) return reject('unreachable', 'Cursor CLI must support ACP version 1.', true);
  if (resumeId && !init.data.agentCapabilities.loadSession)
    return reject('not_supported', 'This Cursor CLI does not support ACP session loading.', true);
  const opened = await transport.sendRequest(resumeId ? 'session/load' : 'session/new', {
    cwd,
    mcpServers: [],
    ...(resumeId ? { sessionId: resumeId } : {}),
  });
  if ('error' in opened) {
    return reject(
      'unreachable',
      opened.error.code === AUTH_REQUIRED
        ? SIGN_IN_DETAIL
        : `Cursor CLI rejected session ${resumeId ? 'load' : 'creation'} (${opened.error.code}).`,
      true
    );
  }
  const id = resumeId ?? Session.safeParse(opened.result).data?.sessionId;
  return id
    ? { ok: true, value: id }
    : reject('not_delivered', 'Cursor CLI did not confirm the session.', true);
}

export function createCursorStart(
  executable: string,
  machine: string,
  adapter: string,
  readOwnedFolder: (id: string) => Promise<string | undefined> = async () => undefined
) {
  const running = new Set<ProcessJsonRpcTransport>();
  const activeStops = new Map<string, () => Promise<StopResult>>();
  const sessions = new Map<string, WorkDetail>();
  const completed = new Set<string>();
  const reserved = new Set<string>();
  let closing = false;

  const admitStart = (request: StartRequest): Gate<StartRequest> =>
    closing
      ? {
          reason: reject('unreachable', 'The Cursor CLI driver is shutting down.', true),
        }
      : { value: request };

  const selectFolder = (request: StartRequest): Gate<string> => {
    const selected = selectLocalStartFolder(
      request,
      {
        machine,
        homeDir: homedir(),
        folderExists: existsSync,
        makeFolder: mkdirSync,
      },
      'Cursor CLI needs a local workspace.'
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
            'Cursor CLI needs an absolute workspace directory.',
            true
          ),
        };

  const connect = async (cwd: string, resumeId?: string) => {
    let collecting: string | undefined;
    let reply = '';
    const transport: ProcessJsonRpcTransport = new ProcessJsonRpcTransport({
      command: executable,
      args: ['acp'],
      cwd,
      env: buildSafeProcessEnv(),
      replaceEnv: true,
      requestTimeoutMs: TURN_TIMEOUT_MINUTES * 60_000,
      onStderr: () => {},
      onRequest: ({ id, method, params }) => {
        if (method === 'session/request_permission')
          transport.sendResponse(id, cursorPermissionOutcome(params));
        else
          transport.sendErrorResponse(id, {
            code: -32601,
            message: 'Method not supported',
          });
      },
      onNotification: ({ method, params }) => {
        if (method !== 'session/update') return;
        const update = Update.safeParse(params);
        if (update.success && update.data.sessionId === collecting)
          reply += update.data.update.content.text.slice(0, MAX_REPLY_CHARS - reply.length);
      },
    });
    running.add(transport);
    const close = async () => {
      await transport.close();
      running.delete(transport);
    };
    const opened = await within(
      openSession(transport, cwd, resumeId),
      START_TIMEOUT_MS,
      resumeId ? 'Cursor CLI session load timed out.' : 'Cursor CLI session creation timed out.'
    ).catch((error: unknown) =>
      reject(
        'unreachable',
        error instanceof Error ? error.message : 'Cursor CLI could not start.',
        true
      )
    );
    if (!opened.ok) {
      await close();
      return { reason: opened };
    }
    const id = opened.value;
    return {
      value: {
        id,
        cwd,
        transport,
        close,
        collect: () => {
          collecting = id;
        },
        readReply: () => reply,
      },
    };
  };

  type Opened = NonNullable<Awaited<ReturnType<typeof connect>>['value']>;
  const launchTurn = (
    opened: Opened,
    target: Pick<WorkDetail, 'title' | 'place'>,
    message: string,
    receipt?: Receipt
  ): WorkDetail => {
    const { id, cwd, transport, close, collect, readReply } = opened;
    const work: WorkDetail = {
      ref: { adapter, id },
      title: target.title,
      place: { ...target.place, folder: cwd },
      execution: { machine, directory: cwd },
      status: 'running',
      lastActivityAt: Date.now(),
      watchHint: 'Open this session in Cursor CLI. HyperNeo shows the most recent owned turn.',
    };
    completed.delete(id);
    sessions.set(id, receipt ? { ...work, inputEvidence: { receipt, state: 'pending' } } : work);
    let promptEnded = false;
    const finish = async (status: WorkDetail['status'], detail: string) => {
      activeStops.delete(id);
      await close();
      const at = Date.now();
      const reply = status === 'failed' ? '' : readReply();
      sessions.set(id, {
        ...work,
        status,
        lastActivityAt: at,
        ...(reply ? { lastReply: reply, lastReplyAt: at } : {}),
        turnEnds: [
          {
            id: receipt?.inputId ?? id,
            at,
            startedAt: work.lastActivityAt,
            message: reply || detail,
          },
        ],
        ...(receipt
          ? {
              inputEvidence:
                status === 'done'
                  ? {
                      receipt,
                      state: 'observed' as const,
                      transcriptState: 'completed' as const,
                      exchange: [
                        {
                          at: work.lastActivityAt,
                          role: 'user' as const,
                          text: message,
                        },
                        ...(reply ? [{ at, role: 'agent' as const, text: reply }] : []),
                      ],
                      exchangeCut: reply.length === MAX_REPLY_CHARS,
                      ...(reply ? { replyAt: at } : {}),
                    }
                  : { receipt, state: 'unavailable' as const },
            }
          : {}),
      });
      completed.add(id);
      if (completed.size > RETAINED_TURNS) {
        const oldest = completed.values().next().value!;
        completed.delete(oldest);
        sessions.delete(oldest);
      }
    };
    collect();
    const promptResult = transport
      .sendRequest(
        'session/prompt',
        { sessionId: id, prompt: [{ type: 'text', text: message }] },
        {
          onResponseFrame: () => {
            promptEnded = true;
          },
        }
      )
      .then((response) => Completion.safeParse('result' in response ? response.result : undefined));
    void promptResult.then(
      (result) => {
        const reason = result.data?.stopReason;
        if (reason === 'end_turn') return finish('done', '');
        if (reason === 'cancelled') return finish('stopped', '');
        return finish(
          'failed',
          'Cursor CLI did not complete the turn. Check the session before retrying.'
        );
      },
      (error: unknown) =>
        finish(
          'failed',
          error instanceof JsonRpcRequestTimeoutError
            ? `The Cursor CLI turn exceeded the ${TURN_TIMEOUT_MINUTES}-minute limit. Check the session before retrying.`
            : 'Cursor CLI disconnected during the turn. Check the session before retrying.'
        )
    );
    let stopResult: Promise<StopResult> | undefined;
    activeStops.set(id, () => {
      if (stopResult) return stopResult;
      if (!promptEnded) transport.sendNotification('session/cancel', { sessionId: id });
      const detail = 'Cursor CLI did not confirm cancellation. Check work.status before retrying.';
      stopResult = within(promptResult, STOP_TIMEOUT_MS, detail).then(
        (result): StopResult => {
          const reason = result.data?.stopReason;
          return reason === 'cancelled' || reason === 'end_turn'
            ? { ok: true, value: { stopped: reason === 'cancelled' } }
            : reject('unreachable', detail);
        },
        () => reject('unreachable', detail)
      );
      return stopResult;
    });
    return work;
  };

  const launch = async (opened: Opened, request: StartRequest): Promise<Result<WorkStarted>> => {
    if (closing || sessions.has(opened.id) || reserved.has(opened.id)) {
      await opened.close();
      return reject('not_delivered', 'Cursor CLI could not establish a new owned session.', true);
    }
    const work = launchTurn(
      opened,
      { title: request.sessionTitle ?? request.title, place: request.place },
      request.message
    );
    return { ok: true, value: work };
  };

  const launchStart = (superpipe({})('cursor-start') as PipelineAPI)
    .input(['request'])
    .pipe(admitStart, 'request', 'result:started')
    .pipe(selectFolder, 'started', 'result:started')
    .pipe(requireDirectory, 'started', 'result:started')
    .pipe((cwd: string) => connect(cwd), 'started', 'result:started')
    .pipe(launch, ['started', 'request'], 'started')
    .endAsync('started') as (request: StartRequest) => Promise<Result<WorkStarted>>;

  const ownedFolder = async (ref: WorkRef): Promise<Gate<string>> => {
    const cwd = ref.adapter === adapter ? await readOwnedFolder(ref.id) : undefined;
    return cwd
      ? { value: cwd }
      : {
          reason: reject('not_started_by_us', 'Choose a session started by HyperNeo.', true),
        };
  };

  const resume = async (
    ref: WorkRef,
    cwd: string,
    message: string
  ): Promise<Result<WorkDelivery>> => {
    const { id } = ref;
    const previous = sessions.get(id);
    if (reserved.has(id) || previous?.status === 'running')
      return reject('busy', 'Cursor CLI is already working in this session.', true);
    if (closing) return reject('unreachable', 'The Cursor CLI driver is shutting down.', true);
    reserved.add(id);
    try {
      const opened = await connect(cwd, id);
      if (!opened.value) return opened.reason;
      if (closing) {
        await opened.value.close();
        return reject('unreachable', 'The Cursor CLI driver is shutting down.', true);
      }
      const receipt = { executionId: id, inputId: crypto.randomUUID() };
      const target = previous ?? {
        title: 'Cursor CLI session',
        place: { machine, name: basename(cwd) || cwd },
      };
      launchTurn(opened.value, target, message, receipt);
      return {
        ok: true,
        value: { delivered: false, unconfirmed: true, receipt },
      };
    } finally {
      reserved.delete(id);
    }
  };

  const send = (superpipe({})('cursor-send') as PipelineAPI)
    .input(['ref', 'message'])
    .pipe(ownedFolder, 'ref', 'result:delivery')
    .pipe(requireDirectory, 'delivery', 'result:delivery')
    .pipe(resume, ['ref', 'delivery', 'message'], 'delivery')
    .endAsync('delivery') as (ref: WorkRef, message: string) => Promise<Result<WorkDelivery>>;

  const selectStop = (ref: WorkRef): Gate<(() => Promise<StopResult>) | null> =>
    ref.adapter === adapter && sessions.has(ref.id)
      ? { value: activeStops.get(ref.id) ?? null }
      : {
          reason: reject(
            'not_found',
            'This daemon has no owned Cursor CLI turn for that session.',
            true
          ),
        };

  const stop = (superpipe({})('cursor-stop') as PipelineAPI)
    .input(['ref'])
    .pipe(selectStop, 'ref', 'result:stopped')
    .pipe(
      (cancel: (() => Promise<StopResult>) | null) =>
        cancel ? cancel() : { ok: true, value: { stopped: false } },
      'stopped',
      'stopped'
    )
    .endAsync('stopped') as (ref: WorkRef) => Promise<StopResult>;

  const status = async (
    ref: WorkRef,
    _since?: number,
    receipt?: Receipt
  ): Promise<Result<WorkDetail>> => {
    const work = ref.adapter === adapter ? sessions.get(ref.id) : undefined;
    if (!work)
      return reject(
        'not_found',
        'This daemon has no retained Cursor CLI turn for that session.',
        true
      );
    const evidence = work.inputEvidence;
    if (
      receipt &&
      (evidence?.receipt.inputId !== receipt.inputId ||
        evidence.receipt.executionId !== receipt.executionId)
    )
      return {
        ok: true,
        value: { ...work, inputEvidence: { receipt, state: 'unavailable' } },
      };
    return { ok: true, value: work };
  };

  return {
    start: (request: StartRequest) => launchStart(request),
    send,
    status,
    stop,
    async close() {
      closing = true;
      await Promise.all([...running].map((transport) => transport.close()));
    },
  };
}
