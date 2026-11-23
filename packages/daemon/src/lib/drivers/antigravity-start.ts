import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { JsonRpcRequestTimeoutError, ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { compactAntigravity } from './antigravity-compact.ts';
import {
  AntigravityConfig,
  antigravityIdentity,
  configureAntigravity,
} from './antigravity-configuration.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import type {
  StartRequest,
  WorkAdapter,
  WorkDelivery,
  WorkDetail,
  WorkRef,
  Rejected,
  Result,
  WorkStarted,
} from './types.ts';
import { reject } from './work-operations.ts';

const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;
const STOP_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MINUTES = 60;
const RETAINED_TURNS = 100;
const MAX_REPLY_CHARS = 16_000;
const AUTH_REQUIRED = -32000;
const SIGN_IN_DETAIL = 'Sign in to Antigravity CLI before starting a session.';
const Init = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({
    sessionCapabilities: z.object({ close: z.object({}), resume: z.object({}).nullish() }),
  }),
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
type Receipt = NonNullable<WorkDelivery['receipt']>;
type StopResult = Result<{ stopped: boolean }>;
type CancelPrompt = () => Promise<StopResult>;

function admitStart(request: StartRequest, closing: boolean): Gate<StartRequest> {
  if (closing)
    return { reason: reject('unreachable', 'The Antigravity driver is shutting down.', true) };
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

function saveSession(transport: ProcessJsonRpcTransport, sessionId: string): Promise<boolean> {
  return within(
    transport.sendRequest('session/close', { sessionId }),
    CLOSE_TIMEOUT_MS,
    'Antigravity could not confirm session persistence.'
  ).then(
    (closed) => 'result' in closed,
    () => false
  );
}

async function openSession(transport: ProcessJsonRpcTransport, cwd: string, resumeId?: string) {
  const initialized = await transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  if ('error' in initialized && initialized.error.code === AUTH_REQUIRED)
    return reject('unreachable', SIGN_IN_DETAIL, true);
  const init = Init.safeParse('result' in initialized ? initialized.result : undefined);
  if (!init.success) {
    return reject('unreachable', 'Antigravity must support ACP version 1 session close.', true);
  }
  if (resumeId && !init.data.agentCapabilities.sessionCapabilities.resume)
    return reject('not_supported', 'This Antigravity CLI does not support ACP resume.', true);
  const opened = await transport.sendRequest(resumeId ? 'session/resume' : 'session/new', {
    cwd,
    mcpServers: [],
    ...(resumeId ? { sessionId: resumeId } : {}),
  });
  if ('error' in opened) {
    return reject(
      'unreachable',
      opened.error.code === AUTH_REQUIRED
        ? SIGN_IN_DETAIL
        : `Antigravity rejected session ${resumeId ? 'resume' : 'creation'} (${opened.error.code}).`,
      true
    );
  }
  const config = AntigravityConfig.safeParse(opened.result);
  const id = resumeId ?? Session.safeParse(opened.result).data?.sessionId;
  return id && config.success
    ? { ok: true as const, value: { id, options: config.data.configOptions } }
    : reject('not_delivered', 'Antigravity did not confirm the session.', true);
}

export function createAntigravityStart(
  executable: string,
  machine: string,
  adapter: string,
  readOwnedFolder: (id: string) => Promise<string | undefined> = async () => undefined
) {
  const running = new Set<ProcessJsonRpcTransport>();
  const compactions = new Map<AbortController, ReturnType<typeof compactAntigravity>>();
  const activePrompts = new Map<string, CancelPrompt>();
  const sessions = new Map<string, WorkDetail>();
  const completed = new Set<string>();
  const reserved = new Set<string>();
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

  const connect = async (cwd: string, resumeId?: string) => {
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
        openSession(transport, cwd, resumeId),
        START_TIMEOUT_MS,
        resumeId
          ? 'Antigravity session resume timed out.'
          : 'Antigravity session creation timed out.'
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
    const { id, options } = opened.value;
    const collectReply = (collect: boolean) => {
      sessionId = collect ? id : undefined;
    };
    return { value: { id, cwd, transport, options, collectReply, close, readReply: () => reply } };
  };

  type Opened = NonNullable<Awaited<ReturnType<typeof connect>>['value']>;
  const configureOpened = async (opened: Opened, request: StartRequest): Promise<Gate<Opened>> => {
    if (request.model === undefined && request.effort === undefined) return { value: opened };
    const configured = await within(
      configureAntigravity(opened.transport, opened.id, opened.options, request),
      START_TIMEOUT_MS,
      'Antigravity session configuration timed out.'
    ).catch(() =>
      reject('unreachable', 'Antigravity could not confirm session configuration.', true)
    );
    if (configured.ok) return { value: { ...opened, options: configured.value } };
    await saveSession(opened.transport, opened.id);
    await opened.close();
    return { reason: configured };
  };

  const launchTurn = (
    opened: Opened,
    target: Pick<WorkDetail, 'title' | 'place'>,
    message: string,
    receipt?: Receipt
  ): WorkDetail => {
    const { id, cwd, transport, collectReply, close, readReply } = opened;
    const work: WorkDetail = {
      ref: { adapter, id },
      ...antigravityIdentity(opened.options),
      title: target.title,
      place: { ...target.place, folder: cwd },
      execution: { machine, directory: cwd },
      status: 'running',
      lastActivityAt: Date.now(),
      watchHint: 'Open this session in Antigravity CLI. HyperNeo shows the most recent owned turn.',
    };
    completed.delete(id);
    sessions.set(id, receipt ? { ...work, inputEvidence: { receipt, state: 'pending' } } : work);
    let promptEnded = false;
    const endPrompt = () => {
      promptEnded = true;
      collectReply(false);
    };
    const finish = async (status: WorkDetail['status'], detail: string) => {
      endPrompt();
      await close();
      const at = Date.now();
      const reply = readReply();
      let inputEvidence: WorkDetail['inputEvidence'];
      if (receipt)
        inputEvidence =
          status === 'done'
            ? {
                receipt,
                state: 'observed',
                transcriptState: 'completed',
                exchange: [
                  { at: work.lastActivityAt, role: 'user', text: message },
                  ...(reply ? [{ at, role: 'agent' as const, text: reply }] : []),
                ],
                exchangeCut: reply.length === MAX_REPLY_CHARS,
                ...(reply ? { replyAt: at } : {}),
              }
            : { receipt, state: 'unavailable' };
      sessions.set(id, {
        ...work,
        status,
        lastActivityAt: at,
        ...(reply ? { lastReply: reply, lastReplyAt: at } : {}),
        turnEnds: [
          { id: receipt?.inputId ?? id, at, startedAt: work.lastActivityAt, message: detail },
        ],
        ...(inputEvidence ? { inputEvidence } : {}),
      });
      activePrompts.delete(id);
      completed.add(id);
      if (completed.size > RETAINED_TURNS) {
        const oldest = completed.values().next().value!;
        completed.delete(oldest);
        sessions.delete(oldest);
      }
    };
    collectReply(true);
    const promptResult = transport
      .sendRequest(
        'session/prompt',
        { sessionId: id, prompt: [{ type: 'text', text: message }] },
        { onResponseFrame: endPrompt }
      )
      .then((response) => Completion.safeParse('result' in response ? response.result : undefined));
    void promptResult.then(
      async (result) => {
        const saved = await saveSession(transport, id);
        if (!saved) {
          return finish(
            'failed',
            'Antigravity did not confirm saved history. Check the CLI session before retrying.'
          );
        }
        if (result.success && result.data.stopReason === 'end_turn')
          return finish('done', readReply());
        if (result.success && result.data.stopReason === 'cancelled')
          return finish('stopped', readReply());
        return finish(
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
    );
    let stopResult: Promise<StopResult> | undefined;
    const cancelPrompt: CancelPrompt = () => {
      if (stopResult) return stopResult;
      if (!promptEnded && activePrompts.get(id) === cancelPrompt) {
        transport.sendNotification('session/cancel', { sessionId: id });
      }
      const detail = 'Antigravity did not confirm cancellation. Check work.status before retrying.';
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
    };
    activePrompts.set(id, cancelPrompt);
    return work;
  };

  const launch = async (opened: Opened, request: StartRequest): Promise<Result<WorkStarted>> => {
    const { id } = opened;
    if (closing || sessions.has(id) || reserved.has(id)) {
      await opened.close();
      return reject('not_delivered', 'Antigravity could not establish a new owned session.', true);
    }
    reserved.add(id);
    try {
      const configured = await configureOpened(opened, request);
      if ('reason' in configured) return configured.reason;
      if (closing) {
        await opened.close();
        return reject('unreachable', 'The Antigravity driver is shutting down.', true);
      }
      const work = launchTurn(
        configured.value,
        { title: request.sessionTitle ?? request.title, place: request.place },
        request.message
      );
      return { ok: true, value: work };
    } finally {
      reserved.delete(id);
    }
  };

  const launchStart = (superpipe({})('antigravity-start') as PipelineAPI)
    .input(['request', 'closing'])
    .pipe(admitStart, ['request', 'closing'], 'result:started')
    .pipe(selectFolder, 'started', 'result:started')
    .pipe(requireDirectory, 'started', 'result:started')
    .pipe((cwd: string) => connect(cwd), 'started', 'result:started')
    .pipe(launch, ['started', 'request'], 'started')
    .endAsync('started') as (
    request: StartRequest,
    closing: boolean
  ) => Promise<Result<WorkStarted>>;

  const ownedFolder = async (ref: WorkRef): Promise<Gate<string>> => {
    const cwd = ref.adapter === adapter ? await readOwnedFolder(ref.id) : undefined;
    return cwd
      ? { value: cwd }
      : { reason: reject('not_started_by_us', 'Choose a session started by HyperNeo.', true) };
  };

  const withIdleWorker = async <Value>(
    id: string,
    run: (previous: WorkDetail | undefined) => Promise<Result<Value>>
  ): Promise<Result<Value>> => {
    const previous = sessions.get(id);
    if (reserved.has(id) || previous?.status === 'running')
      return reject('busy', 'Antigravity is already working in this session.', true);
    if (closing) return reject('unreachable', 'The Antigravity driver is shutting down.', true);
    reserved.add(id);
    try {
      return await run(previous);
    } finally {
      reserved.delete(id);
    }
  };

  const resume = (ref: WorkRef, cwd: string, message: string) =>
    withIdleWorker<WorkDelivery>(ref.id, async (previous) => {
      const { id } = ref;
      const opened = await connect(cwd, id);
      if (!opened.value) return opened.reason;
      if (closing) {
        await opened.value.close();
        return reject('unreachable', 'The Antigravity driver is shutting down.', true);
      }
      const receipt = { executionId: id, inputId: crypto.randomUUID() };
      const target = previous ?? {
        title: 'Antigravity CLI session',
        place: { machine, name: basename(cwd) || cwd },
      };
      launchTurn(opened.value, target, message, receipt);
      return { ok: true, value: { delivered: false, unconfirmed: true, receipt } };
    });

  const send = (superpipe({})('antigravity-send') as PipelineAPI)
    .input(['ref', 'message'])
    .pipe(ownedFolder, 'ref', 'result:delivery')
    .pipe(requireDirectory, 'delivery', 'result:delivery')
    .pipe(resume, ['ref', 'delivery', 'message'], 'delivery')
    .endAsync('delivery') as (ref: WorkRef, message: string) => Promise<Result<WorkDelivery>>;

  const compactIdle = (ref: WorkRef, cwd: string) =>
    withIdleWorker<{ compacted: boolean }>(ref.id, async () => {
      const abort = new AbortController();
      const pending = compactAntigravity(executable, cwd, ref.id, abort.signal);
      compactions.set(abort, pending);
      try {
        return await pending;
      } finally {
        compactions.delete(abort);
      }
    });

  const compact = (superpipe({})('antigravity-compact') as PipelineAPI)
    .input(['ref'])
    .pipe(ownedFolder, 'ref', 'result:compaction')
    .pipe(requireDirectory, 'compaction', 'result:compaction')
    .pipe(compactIdle, ['ref', 'compaction'], 'compaction')
    .endAsync('compaction') as (ref: WorkRef) => ReturnType<typeof compactAntigravity>;

  const selectPrompt = (ref: WorkRef): Gate<CancelPrompt | null> =>
    ref.adapter === adapter && sessions.has(ref.id)
      ? { value: activePrompts.get(ref.id) ?? null }
      : {
          reason: reject(
            'not_found',
            'This daemon has no owned Antigravity turn for that session.',
            true
          ),
        };

  const stop = (superpipe({})('antigravity-stop') as PipelineAPI)
    .input(['ref'])
    .pipe(selectPrompt, 'ref', 'result:stopped')
    .pipe(
      (prompt: CancelPrompt | null): Promise<StopResult> | StopResult =>
        prompt ? prompt() : { ok: true, value: { stopped: false } },
      'stopped',
      'stopped'
    )
    .endAsync('stopped') as (ref: WorkRef) => Promise<StopResult>;

  const status: NonNullable<WorkAdapter['status']> = async (ref, _, receipt) => {
    const work = sessions.get(ref.id);
    if (!work || ref.adapter !== adapter)
      return reject(
        'not_found',
        'This daemon has no retained Antigravity turn for that session.',
        true
      );
    const evidence = work.inputEvidence;
    if (
      receipt &&
      (evidence?.receipt.inputId !== receipt.inputId ||
        evidence.receipt.executionId !== receipt.executionId)
    )
      return { ok: true, value: { ...work, inputEvidence: { receipt, state: 'unavailable' } } };
    return { ok: true, value: work };
  };

  return {
    start: (request: StartRequest) => launchStart(request, closing),
    send,
    status,
    stop,
    compact,
    async close() {
      closing = true;
      for (const abort of compactions.keys()) abort.abort();
      await Promise.all([
        ...[...running].map((transport) => transport.close()),
        ...compactions.values(),
      ]);
    },
  };
}
